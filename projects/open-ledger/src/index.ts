import { Ledger, DEFAULT_VERIFY_RANGE, MAX_LIST_LIMIT } from "./ledger";
import { isIsoDate, isLedgerId, validateBatch } from "./schema";

export { Ledger };

const MAX_BODY_BYTES = 8 * 1024 * 1024;
const encoder = new TextEncoder();

const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "Authorization, Content-Type",
  "access-control-max-age": "86400",
};

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/v1")) {
      // Dashboard and other static files. Assets are normally served before the Worker
      // runs; this branch only handles misses (and environments without the binding).
      if (env.ASSETS) return env.ASSETS.fetch(request);
      return json({ error: "not_found" }, 404);
    }
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    let response: Response;
    try {
      response = await route(request, env, url);
    } catch (err) {
      console.error("unhandled error", err);
      response = json({ error: "internal_error" }, 500);
    }
    return withCors(response);
  },
} satisfies ExportedHandler<Env>;

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
  }
}

async function route(request: Request, env: Env, url: URL): Promise<Response> {
  try {
    if (url.pathname === "/v1" || url.pathname === "/v1/") {
      return json(apiIndex());
    }
    const match = url.pathname.match(/^\/v1\/ledgers\/([^/]+)\/([A-Za-z.]+)$/);
    if (!match) throw new HttpError(404, "not_found");
    const ledgerId = match[1]!;
    const action = match[2]!;
    if (!isLedgerId(ledgerId)) {
      throw new HttpError(400, "invalid_ledger_id", "ledger id must match [a-z0-9-]{1,64}");
    }
    const stub = env.LEDGER.get(env.LEDGER.idFromName(ledgerId));

    // `return await` keeps rejections inside this try so HttpErrors become proper responses.
    switch (action) {
      case "events":
        if (request.method === "POST") return await ingest(request, env, ledgerId, stub);
        requireGet(request);
        return await listEvents(url, ledgerId, stub);
      case "head":
        requireGet(request);
        return json(Object.assign({ ledgerId }, found(ledgerId, await stub.head())));
      case "snapshots":
        requireGet(request);
        return await snapshots(url, ledgerId, stub);
      case "verify":
        requireGet(request);
        return await verify(url, ledgerId, stub);
      case "export.ndjson":
        requireGet(request);
        return await exportNdjson(url, ledgerId, stub);
      case "summary":
        requireGet(request);
        return json(Object.assign({ ledgerId }, found(ledgerId, await stub.summary())));
      default:
        throw new HttpError(404, "not_found");
    }
  } catch (err) {
    if (err instanceof HttpError) {
      const body: Record<string, unknown> = { error: err.code };
      if (err.message !== err.code) body.message = err.message;
      const headers: Record<string, string> = {};
      if (err.status === 401) headers["www-authenticate"] = 'Bearer realm="open-ledger"';
      if (err.status === 405) headers["allow"] = "GET, OPTIONS";
      return json(body, err.status, headers);
    }
    throw err;
  }
}

type LedgerStub = DurableObjectStub<Ledger>;

async function ingest(request: Request, env: Env, ledgerId: string, stub: LedgerStub): Promise<Response> {
  if (!env.INGEST_TOKEN) {
    throw new HttpError(503, "ingest_disabled", "INGEST_TOKEN secret is not configured");
  }
  if (!bearerMatches(request.headers.get("authorization"), env.INGEST_TOKEN)) {
    throw new HttpError(401, "unauthorized");
  }
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > MAX_BODY_BYTES) throw new HttpError(413, "payload_too_large");

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new HttpError(400, "invalid_json");
  }
  const batch = validateBatch(body);
  if (!batch.ok) throw new HttpError(400, "invalid_request", batch.error);

  const result = await stub.append(batch.events);
  return json(Object.assign({ ledgerId }, result));
}

async function listEvents(url: URL, ledgerId: string, stub: LedgerStub): Promise<Response> {
  const since = intParam(url, "since", 0, 0, Number.MAX_SAFE_INTEGER);
  const limit = intParam(url, "limit", 100, 1, MAX_LIST_LIMIT);
  const symbol = symbolParam(url);
  const result = found(ledgerId, await stub.list({ since, limit, symbol }));
  return json(Object.assign({ ledgerId }, result));
}

async function snapshots(url: URL, ledgerId: string, stub: LedgerStub): Promise<Response> {
  const from = dateParam(url, "from");
  const to = dateParam(url, "to");
  if (from && to && from > to) throw new HttpError(400, "invalid_range", "from must be <= to");
  const rows = found(ledgerId, await stub.snapshots(from, to));
  return json({ ledgerId, snapshots: rows });
}

async function verify(url: URL, ledgerId: string, stub: LedgerStub): Promise<Response> {
  const from = intParam(url, "from", 1, 1, Number.MAX_SAFE_INTEGER);
  const toRaw = url.searchParams.get("to");
  const to = toRaw === null ? from + DEFAULT_VERIFY_RANGE - 1 : intParam(url, "to", from, 1, Number.MAX_SAFE_INTEGER);
  if (to < from) throw new HttpError(400, "invalid_range", "to must be >= from");
  const result = found(ledgerId, await stub.verify(from, to));
  return json(Object.assign({ ledgerId }, result));
}

async function exportNdjson(url: URL, ledgerId: string, stub: LedgerStub): Promise<Response> {
  const since = intParam(url, "since", 0, 0, Number.MAX_SAFE_INTEGER);
  const symbol = symbolParam(url);
  const response = found(ledgerId, await stub.exportNdjson({ since, symbol }));
  const headers = new Headers(response.headers);
  headers.set("cache-control", "no-store");
  headers.set("content-disposition", `inline; filename="${ledgerId}.ndjson"`);
  return new Response(response.body, { status: 200, headers });
}

// ------------------------------------------------------------------ helpers

function found<T>(ledgerId: string, value: T | null): T {
  if (value === null) throw new HttpError(404, "ledger_not_found", `no ledger named "${ledgerId}"`);
  return value;
}

function requireGet(request: Request): void {
  if (request.method !== "GET" && request.method !== "HEAD") {
    throw new HttpError(405, "method_not_allowed");
  }
}

function intParam(url: URL, name: string, fallback: number, min: number, max: number): number {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === "") return fallback;
  if (!/^\d+$/.test(raw)) throw new HttpError(400, "invalid_parameter", `${name} must be a non-negative integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new HttpError(400, "invalid_parameter", `${name} must be between ${min} and ${max}`);
  }
  return value;
}

function dateParam(url: URL, name: string): string | undefined {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === "") return undefined;
  if (!isIsoDate(raw)) throw new HttpError(400, "invalid_parameter", `${name} must be YYYY-MM-DD`);
  return raw;
}

function symbolParam(url: URL): string | undefined {
  const raw = url.searchParams.get("symbol");
  if (raw === null || raw === "") return undefined;
  if (raw.length > 64) throw new HttpError(400, "invalid_parameter", "symbol too long");
  return raw;
}

function bearerMatches(header: string | null, expected: string): boolean {
  if (!header) return false;
  const match = header.match(/^Bearer\s+(\S+)\s*$/i);
  if (!match) return false;
  const given = encoder.encode(match[1]!);
  const want = encoder.encode(expected);
  if (given.byteLength !== want.byteLength) return false;
  return crypto.subtle.timingSafeEqual(given, want);
}

function json(data: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...extraHeaders,
    },
  });
}

function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function apiIndex() {
  return {
    name: "open-ledger",
    docs: "https://github.com/BrickerP/BrickerP/tree/main/projects/open-ledger",
    endpoints: [
      "POST /v1/ledgers/:ledgerId/events  (Authorization: Bearer <INGEST_TOKEN>)",
      "GET  /v1/ledgers/:ledgerId/head",
      "GET  /v1/ledgers/:ledgerId/events?since=<seq>&limit=<n<=1000>&symbol=<sym>",
      "GET  /v1/ledgers/:ledgerId/snapshots?from=YYYY-MM-DD&to=YYYY-MM-DD",
      "GET  /v1/ledgers/:ledgerId/verify?from=<seq>&to=<seq>  (max 2000 rows per call)",
      "GET  /v1/ledgers/:ledgerId/export.ndjson?since=<seq>&symbol=<sym>",
      "GET  /v1/ledgers/:ledgerId/summary",
    ],
  };
}
