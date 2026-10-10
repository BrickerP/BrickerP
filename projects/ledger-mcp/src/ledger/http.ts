import type { z } from "zod";
import { LedgerSourceError, clampLimit, type LedgerSource } from "./source";
import {
  EventsPageSchema,
  LedgerHeadSchema,
  LedgerSummarySchema,
  SnapshotsResponseSchema,
  VerifyResultSchema,
  type DateRange,
  type EventsQuery,
  type SeqRange,
} from "./types";

/** Short in-memory memo (per isolate / per Durable Object) — well under the 60 s budget. */
const DEFAULT_TTL_MS = 30_000;

interface MemoEntry {
  expiresAt: number;
  value: Promise<unknown>;
}

export interface HttpLedgerSourceOptions {
  fetch?: typeof fetch;
  ttlMs?: number;
  now?: () => number;
}

export class HttpLedgerSource implements LedgerSource {
  readonly kind = "http" as const;
  readonly label: string;
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly memo = new Map<string, MemoEntry>();

  constructor(baseUrl: string, options: HttpLedgerSourceOptions = {}) {
    // Avoid /\/+$/ on caller-controlled URLs (CodeQL js/polynomial-redos).
    let base = baseUrl;
    while (base.endsWith("/")) base = base.slice(0, -1);
    this.base = base;
    this.label = new URL(this.base).host;
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.now = options.now ?? (() => Date.now());
  }

  head(ledgerId: string) {
    return this.get(`/v1/ledgers/${enc(ledgerId)}/head`, {}, LedgerHeadSchema);
  }

  events(ledgerId: string, query: EventsQuery = {}) {
    return this.get(
      `/v1/ledgers/${enc(ledgerId)}/events`,
      {
        since: query.since ?? 0,
        limit: clampLimit(query.limit),
        symbol: query.symbol?.toUpperCase(),
      },
      EventsPageSchema,
    );
  }

  snapshots(ledgerId: string, range: DateRange = {}) {
    return this.get(`/v1/ledgers/${enc(ledgerId)}/snapshots`, { from: range.from, to: range.to }, SnapshotsResponseSchema);
  }

  verify(ledgerId: string, range: SeqRange = {}) {
    return this.get(`/v1/ledgers/${enc(ledgerId)}/verify`, { from: range.from, to: range.to }, VerifyResultSchema);
  }

  summary(ledgerId: string) {
    return this.get(`/v1/ledgers/${enc(ledgerId)}/summary`, {}, LedgerSummarySchema);
  }

  private get<S extends z.ZodType>(
    path: string,
    params: Record<string, string | number | undefined>,
    schema: S,
  ): Promise<z.output<S>> {
    const url = new URL(this.base + path);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== "") url.searchParams.set(key, String(value));
    }
    const key = url.toString();
    const now = this.now();
    const cached = this.memo.get(key);
    if (cached && cached.expiresAt > now) return cached.value as Promise<z.output<S>>;

    const value = this.request(url, schema);
    this.memo.set(key, { expiresAt: now + this.ttlMs, value });
    // Do not memoize failures.
    value.catch(() => this.memo.delete(key));
    if (this.memo.size > 256) this.sweep(now);
    return value;
  }

  private async request<S extends z.ZodType>(url: URL, schema: S): Promise<z.output<S>> {
    let response: Response;
    try {
      response = await this.fetchImpl(url.toString(), {
        headers: { accept: "application/json", "user-agent": "ledger-mcp/0.1" },
        signal: AbortSignal.timeout(8_000),
      });
    } catch (error) {
      throw new LedgerSourceError(`ledger upstream unreachable (${url.host}): ${(error as Error).message}`);
    }
    if (!response.ok) {
      const body = (await response.text().catch(() => "")).slice(0, 200);
      throw new LedgerSourceError(`ledger upstream ${response.status} for ${url.pathname}${body ? `: ${body}` : ""}`, response.status);
    }
    const json: unknown = await response.json().catch(() => {
      throw new LedgerSourceError(`ledger upstream returned non-JSON for ${url.pathname}`, response.status);
    });
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      throw new LedgerSourceError(`ledger upstream response for ${url.pathname} does not match the contract: ${parsed.error.issues[0]?.message ?? "invalid"}`);
    }
    return parsed.data;
  }

  private sweep(now: number) {
    for (const [key, entry] of this.memo) if (entry.expiresAt <= now) this.memo.delete(key);
  }
}

function enc(value: string): string {
  return encodeURIComponent(value);
}
