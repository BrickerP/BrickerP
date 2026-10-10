import type { BeatInput, MonitorInput, NotifyConfig } from "./types";

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

export const MONITOR_ID_RE = /^[a-z0-9-]{1,64}$/;
export const MAX_WINDOW_SIZE = 5000;
export const DEFAULT_WINDOW_SIZE = 200;
const MAX_INTERVAL_SEC = 30 * 86_400;
const MAX_NAME_LEN = 100;
const MAX_META_BYTES = 4096;
const BEAT_TOKEN_RE = /^[\x21-\x7e]{16,256}$/;
const TELEGRAM_TOKEN_RE = /^\d+:[A-Za-z0-9_-]{20,}$/;
const TELEGRAM_CHAT_RE = /^(-?\d{1,20}|@[A-Za-z0-9_]{5,64})$/;

function fail(error: string): Parsed<never> {
	return { ok: false, error };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function intInRange(value: unknown, field: string, min: number, max: number): Parsed<number> {
	if (typeof value !== "number" || !Number.isInteger(value)) return fail(`${field} must be an integer`);
	if (value < min || value > max) return fail(`${field} must be between ${min} and ${max}`);
	return { ok: true, value };
}

function parseNotify(value: unknown): Parsed<NotifyConfig | null> {
	if (value === null) return { ok: true, value: null };
	if (!isRecord(value)) return fail("notify must be an object or null");
	const out: NotifyConfig = {};
	if (value["telegram"] !== undefined && value["telegram"] !== null) {
		const tg = value["telegram"];
		if (!isRecord(tg)) return fail("notify.telegram must be an object");
		const botToken = tg["botToken"];
		const chatIdRaw = tg["chatId"];
		const chatId = typeof chatIdRaw === "number" ? String(chatIdRaw) : chatIdRaw;
		if (typeof botToken !== "string" || !TELEGRAM_TOKEN_RE.test(botToken)) {
			return fail("notify.telegram.botToken must look like 123456:ABC-DEF...");
		}
		if (typeof chatId !== "string" || !TELEGRAM_CHAT_RE.test(chatId)) {
			return fail("notify.telegram.chatId must be a numeric chat id or @channel");
		}
		out.telegram = { botToken, chatId };
	}
	if (value["webhookUrl"] !== undefined && value["webhookUrl"] !== null) {
		const raw = value["webhookUrl"];
		if (typeof raw !== "string" || raw.length > 2048) return fail("notify.webhookUrl must be a URL string");
		let parsed: URL;
		try {
			parsed = new URL(raw);
		} catch {
			return fail("notify.webhookUrl is not a valid URL");
		}
		if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return fail("notify.webhookUrl must be http(s)");
		out.webhookUrl = raw;
	}
	return { ok: true, value: out };
}

export interface ParsedMonitorInput {
	input: MonitorInput;
	beatToken: string | null;
}

/** Validates the body of PUT /v1/monitors/:id. Unknown keys are ignored. */
export function parseMonitorInput(body: unknown): Parsed<ParsedMonitorInput> {
	if (!isRecord(body)) return fail("body must be a JSON object");
	const input: MonitorInput = {};

	if (body["name"] !== undefined) {
		if (typeof body["name"] !== "string") return fail("name must be a string");
		const name = body["name"].trim();
		if (name.length === 0 || name.length > MAX_NAME_LEN) return fail(`name must be 1-${MAX_NAME_LEN} characters`);
		input.name = name;
	}
	if (body["expectEverySec"] !== undefined) {
		const r = intInRange(body["expectEverySec"], "expectEverySec", 1, MAX_INTERVAL_SEC);
		if (!r.ok) return r;
		input.expectEverySec = r.value;
	}
	if (body["graceSec"] !== undefined) {
		const r = intInRange(body["graceSec"], "graceSec", 0, MAX_INTERVAL_SEC);
		if (!r.ok) return r;
		input.graceSec = r.value;
	}
	if (body["windowSize"] !== undefined) {
		const r = intInRange(body["windowSize"], "windowSize", 1, MAX_WINDOW_SIZE);
		if (!r.ok) return r;
		input.windowSize = r.value;
	}
	if (body["p95ThresholdMs"] !== undefined) {
		const v = body["p95ThresholdMs"];
		if (v === null) input.p95ThresholdMs = null;
		else if (typeof v !== "number" || !Number.isFinite(v) || v <= 0 || v > 1e9) {
			return fail("p95ThresholdMs must be a positive number of milliseconds or null");
		} else input.p95ThresholdMs = v;
	}
	if (body["public"] !== undefined) {
		if (typeof body["public"] !== "boolean") return fail("public must be a boolean");
		input.public = body["public"];
	}
	if (body["notify"] !== undefined) {
		const r = parseNotify(body["notify"]);
		if (!r.ok) return r;
		input.notify = r.value;
	}
	let beatToken: string | null = null;
	if (body["beatToken"] !== undefined) {
		const t = body["beatToken"];
		if (typeof t !== "string" || !BEAT_TOKEN_RE.test(t)) {
			return fail("beatToken must be 16-256 printable ASCII characters without spaces");
		}
		beatToken = t;
	}
	return { ok: true, value: { input, beatToken } };
}

/** Validates the (optional) body of POST /v1/monitors/:id/beat. */
export function parseBeatInput(body: unknown): Parsed<BeatInput> {
	if (body === undefined || body === null) return { ok: true, value: {} };
	if (!isRecord(body)) return fail("body must be a JSON object");
	const out: BeatInput = {};
	if (body["durationMs"] !== undefined && body["durationMs"] !== null) {
		const d = body["durationMs"];
		if (typeof d !== "number" || !Number.isFinite(d) || d < 0 || d > 1e10) {
			return fail("durationMs must be a non-negative finite number");
		}
		out.durationMs = d;
	}
	if (body["status"] !== undefined && body["status"] !== null) {
		if (body["status"] !== "ok" && body["status"] !== "fail") return fail('status must be "ok" or "fail"');
		out.status = body["status"];
	}
	if (body["meta"] !== undefined && body["meta"] !== null) {
		const serialized = JSON.stringify(body["meta"]);
		if (serialized === undefined || serialized.length > MAX_META_BYTES) {
			return fail(`meta must be JSON of at most ${MAX_META_BYTES} bytes`);
		}
		out.metaJson = serialized;
	}
	return { ok: true, value: out };
}
