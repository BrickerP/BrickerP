import { landingHtml } from "./landing";
import { Monitor } from "./monitor";
import { badgeSpecFor, renderBadge, renderSparkline } from "./svg";
import type { AuthContext, DoError } from "./types";
import { clampInt, etagFor, generateBeatToken, sha256Hex, timingSafeEqualString } from "./util";
import { DEFAULT_WINDOW_SIZE, MAX_WINDOW_SIZE, MONITOR_ID_RE, parseBeatInput, parseMonitorInput } from "./validate";

export { Monitor };

const MAX_BODY_BYTES = 64 * 1024;
const SVG_CACHE = "public, max-age=60";
const CORS_HEADERS: Record<string, string> = {
	"access-control-allow-origin": "*",
	"access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
	"access-control-allow-headers": "authorization, content-type, if-none-match",
	"access-control-max-age": "86400",
};

export default {
	async fetch(request, env): Promise<Response> {
		try {
			return await handle(request, env);
		} catch (err) {
			console.error("heartbeat: unhandled error", err);
			return json({ error: "internal error" }, 500);
		}
	},
} satisfies ExportedHandler<Env>;

const ROUTE_RE = /^\/v1\/monitors\/([^/]+)(?:\/(beat|badge\.svg|sparkline\.svg|history))?\/?$/;

async function handle(request: Request, env: Env): Promise<Response> {
	const url = new URL(request.url);
	const method = request.method.toUpperCase();

	if (method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });

	if (url.pathname === "/" || url.pathname === "") {
		if (method !== "GET" && method !== "HEAD") return json({ error: "method not allowed" }, 405);
		return new Response(landingHtml(url.origin), {
			headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=300" },
		});
	}

	const match = ROUTE_RE.exec(url.pathname);
	if (!match) return json({ error: "not found" }, 404);
	const id = match[1] ?? "";
	const sub = match[2];
	if (!MONITOR_ID_RE.test(id)) return json({ error: "invalid monitor id: expected [a-z0-9-]{1,64}" }, 400);

	const auth = await resolveAuth(request, env);
	const stub = env.MONITOR.getByName(id);
	const now = Date.now();

	if (sub === undefined) {
		switch (method) {
			case "PUT": {
				const denied = requireAdmin(auth, env);
				if (denied) return denied;
				const body = await readJson(request);
				if (!body.ok) return json({ error: body.error }, 400);
				const parsed = parseMonitorInput(body.value);
				if (!parsed.ok) return json({ error: parsed.error }, 400);
				const generated = generateBeatToken();
				const result = await stub.configure({
					monitorId: id,
					input: parsed.value.input,
					providedTokenHash: parsed.value.beatToken ? await sha256Hex(parsed.value.beatToken) : null,
					generatedTokenHash: await sha256Hex(generated),
					baseUrl: url.origin,
					now,
				});
				if (!result.ok) return errorResponse(result);
				const { created, tokenGenerated, status } = result.value;
				return json(
					{ ok: true, created, ...(tokenGenerated ? { beatToken: generated } : {}), monitor: status },
					created ? 201 : 200,
				);
			}
			case "DELETE": {
				const denied = requireAdmin(auth, env);
				if (denied) return denied;
				const removed = await stub.remove();
				return removed ? json({ ok: true, deleted: id }) : json({ error: "monitor not found" }, 404);
			}
			case "GET":
			case "HEAD": {
				const result = await stub.status(auth, now);
				if (!result.ok) return errorResponse(result);
				return json(result.value);
			}
			default:
				return json({ error: "method not allowed" }, 405);
		}
	}

	if (sub === "beat") {
		if (method !== "POST") return json({ error: "method not allowed; use POST" }, 405);
		if (!auth.admin && !auth.tokenHash) return json({ error: "missing bearer token" }, 401, { "www-authenticate": "Bearer" });
		const body = await readJson(request, true);
		if (!body.ok) return json({ error: body.error }, 400);
		const parsed = parseBeatInput(body.value);
		if (!parsed.ok) return json({ error: parsed.error }, 400);
		const result = await stub.beat(auth, parsed.value, now);
		if (!result.ok) return errorResponse(result);
		return json(result.value);
	}

	if (method !== "GET" && method !== "HEAD") return json({ error: "method not allowed; use GET" }, 405);

	if (sub === "badge.svg") {
		const result = await stub.status(auth, now);
		if (!result.ok) return errorResponse(result);
		return svg(request, renderBadge(badgeSpecFor(result.value, now)));
	}

	if (sub === "sparkline.svg") {
		const n = clampInt(url.searchParams.get("n"), 120, 1, 2000);
		const w = clampInt(url.searchParams.get("w"), 600, 100, 2000);
		const h = clampInt(url.searchParams.get("h"), 120, 40, 1000);
		const result = await stub.sparkline(auth, n, now);
		if (!result.ok) return errorResponse(result);
		const data = result.value;
		return svg(
			request,
			renderSparkline({
				name: data.name,
				state: data.state,
				points: data.points,
				p95Ms: data.p95Ms,
				thresholdMs: data.p95ThresholdMs,
				width: w,
				height: h,
			}),
		);
	}

	// history
	const limit = clampInt(url.searchParams.get("limit"), Math.min(100, DEFAULT_WINDOW_SIZE), 1, MAX_WINDOW_SIZE);
	const result = await stub.history(auth, limit);
	if (!result.ok) return errorResponse(result);
	const { id: monitorId, count, beats } = result.value;
	return json({
		id: monitorId,
		count,
		beats: beats.map(({ metaJson, ...beat }) => ({ ...beat, meta: parseMeta(metaJson) })),
	});
}

function parseMeta(text: string | null): unknown {
	if (text == null) return null;
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

async function resolveAuth(request: Request, env: Env): Promise<AuthContext> {
	const header = request.headers.get("authorization");
	const match = header ? /^Bearer\s+(\S+)\s*$/i.exec(header) : null;
	const bearer = match?.[1];
	if (!bearer) return { admin: false, tokenHash: null };
	const admin = typeof env.ADMIN_TOKEN === "string" && env.ADMIN_TOKEN.length > 0 && timingSafeEqualString(bearer, env.ADMIN_TOKEN);
	return { admin, tokenHash: admin ? null : await sha256Hex(bearer) };
}

function requireAdmin(auth: AuthContext, env: Env): Response | null {
	if (!env.ADMIN_TOKEN) return json({ error: "ADMIN_TOKEN secret is not configured on this deployment" }, 503);
	if (!auth.admin) return json({ error: "admin token required" }, 401, { "www-authenticate": "Bearer" });
	return null;
}

type JsonBody = { ok: true; value: unknown } | { ok: false; error: string };

async function readJson(request: Request, optional = false): Promise<JsonBody> {
	const length = Number(request.headers.get("content-length") ?? "0");
	if (length > MAX_BODY_BYTES) return { ok: false, error: `body larger than ${MAX_BODY_BYTES} bytes` };
	const text = await request.text();
	if (text.length > MAX_BODY_BYTES) return { ok: false, error: `body larger than ${MAX_BODY_BYTES} bytes` };
	if (text.trim().length === 0) {
		return optional ? { ok: true, value: undefined } : { ok: false, error: "JSON body required" };
	}
	try {
		return { ok: true, value: JSON.parse(text) };
	} catch {
		return { ok: false, error: "body is not valid JSON" };
	}
}

function json(data: unknown, status = 200, extra: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...CORS_HEADERS, ...extra },
	});
}

function errorResponse(err: DoError): Response {
	return json({ error: err.error }, err.status, err.status === 401 ? { "www-authenticate": "Bearer" } : {});
}

function svg(request: Request, body: string): Response {
	const etag = etagFor(body);
	const headers = {
		"content-type": "image/svg+xml; charset=utf-8",
		"cache-control": SVG_CACHE,
		etag,
		...CORS_HEADERS,
	};
	if (request.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });
	return new Response(request.method === "HEAD" ? null : body, { headers });
}
