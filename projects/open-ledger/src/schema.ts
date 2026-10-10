/**
 * Shared contract (consumed by ledger-mcp — keep exact):
 *
 *   LedgerEvent  = { id: string; ts: string (ISO-8601 UTC); type: "fill" | "order" | "cancel" | "note";
 *                    symbol?: string; side?: "buy" | "sell"; qty?: number; price?: number;
 *                    orderId?: string; broker?: string; meta?: Record<string, unknown> }
 *   ChainedEvent = LedgerEvent & { seq: number; prevHash: string; hash: string }
 *
 * Validation is hand-written (no runtime dependency, predictable CPU cost).
 */

export const EVENT_TYPES = ["fill", "order", "cancel", "note"] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export const SIDES = ["buy", "sell"] as const;
export type Side = (typeof SIDES)[number];

export interface LedgerEvent {
  id: string;
  ts: string;
  type: EventType;
  symbol?: string;
  side?: Side;
  qty?: number;
  price?: number;
  orderId?: string;
  broker?: string;
  meta?: Record<string, unknown>;
}

export interface ChainedEvent extends LedgerEvent {
  seq: number;
  prevHash: string;
  hash: string;
}

export const LEDGER_ID_RE = /^[a-z0-9-]{1,64}$/;
export const MAX_EVENTS_PER_BATCH = 500;
export const MAX_META_BYTES = 16 * 1024;

/** ISO-8601 with explicit UTC designator: `2026-01-02T03:04:05Z`, optional fraction, or `+00:00`. */
const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]00:00)$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const KNOWN_KEYS = new Set([
  "id",
  "ts",
  "type",
  "symbol",
  "side",
  "qty",
  "price",
  "orderId",
  "broker",
  "meta",
]);

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string };

export function isLedgerId(value: string): boolean {
  return LEDGER_ID_RE.test(value);
}

export function isIsoDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  const d = new Date(value + "T00:00:00Z");
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function optionalString(
  raw: Record<string, unknown>,
  key: string,
  maxLen: number,
): ValidationResult<string | undefined> {
  const v = raw[key];
  if (v === undefined) return { ok: true, value: undefined };
  if (typeof v !== "string" || v.length === 0 || v.length > maxLen) {
    return { ok: false, error: `${key} must be a non-empty string (max ${maxLen} chars)` };
  }
  return { ok: true, value: v };
}

function optionalNumber(raw: Record<string, unknown>, key: string): ValidationResult<number | undefined> {
  const v = raw[key];
  if (v === undefined) return { ok: true, value: undefined };
  if (typeof v !== "number" || !Number.isFinite(v)) {
    return { ok: false, error: `${key} must be a finite number` };
  }
  return { ok: true, value: v };
}

/**
 * Validates and normalises a raw event. The returned object contains only the known
 * fields with defined values, in a fixed property order, so hashing it is reproducible
 * by any client that applies the same normalisation (drop undefined, sort keys).
 */
export function validateEvent(raw: unknown): ValidationResult<LedgerEvent> {
  if (!isPlainObject(raw)) return { ok: false, error: "event must be an object" };

  for (const key of Object.keys(raw)) {
    if (!KNOWN_KEYS.has(key)) {
      return { ok: false, error: `unknown field "${key}" (put custom data under meta)` };
    }
  }

  const id = raw.id;
  if (typeof id !== "string" || id.length === 0 || id.length > 256) {
    return { ok: false, error: "id must be a non-empty string (max 256 chars)" };
  }

  const ts = raw.ts;
  if (typeof ts !== "string" || !ISO_UTC_RE.test(ts) || Number.isNaN(Date.parse(ts))) {
    return { ok: false, error: "ts must be an ISO-8601 UTC timestamp, e.g. 2026-01-02T03:04:05Z" };
  }

  const type = raw.type;
  if (typeof type !== "string" || !(EVENT_TYPES as readonly string[]).includes(type)) {
    return { ok: false, error: `type must be one of ${EVENT_TYPES.join(", ")}` };
  }

  const symbol = optionalString(raw, "symbol", 64);
  if (!symbol.ok) return symbol;
  const orderId = optionalString(raw, "orderId", 256);
  if (!orderId.ok) return orderId;
  const broker = optionalString(raw, "broker", 64);
  if (!broker.ok) return broker;

  const side = raw.side;
  if (side !== undefined && (typeof side !== "string" || !(SIDES as readonly string[]).includes(side))) {
    return { ok: false, error: `side must be one of ${SIDES.join(", ")}` };
  }

  const qty = optionalNumber(raw, "qty");
  if (!qty.ok) return qty;
  const price = optionalNumber(raw, "price");
  if (!price.ok) return price;

  let meta: Record<string, unknown> | undefined;
  if (raw.meta !== undefined) {
    if (!isPlainObject(raw.meta)) return { ok: false, error: "meta must be a plain object" };
    // Size check via plain JSON.stringify; the canonical form is at most as long.
    let serialized: string;
    try {
      serialized = JSON.stringify(raw.meta);
    } catch {
      return { ok: false, error: "meta must be JSON-serialisable" };
    }
    if (serialized.length > MAX_META_BYTES) {
      return { ok: false, error: `meta too large (max ${MAX_META_BYTES} bytes)` };
    }
    meta = JSON.parse(serialized) as Record<string, unknown>;
  }

  if (type === "fill") {
    if (symbol.value === undefined || side === undefined) {
      return { ok: false, error: "fill events require symbol and side" };
    }
    if (qty.value === undefined || qty.value <= 0) {
      return { ok: false, error: "fill events require qty > 0" };
    }
    if (price.value === undefined || price.value < 0) {
      return { ok: false, error: "fill events require price >= 0" };
    }
  }

  const event: LedgerEvent = { id, ts, type: type as EventType };
  if (symbol.value !== undefined) event.symbol = symbol.value;
  if (side !== undefined) event.side = side as Side;
  if (qty.value !== undefined) event.qty = qty.value;
  if (price.value !== undefined) event.price = price.value;
  if (orderId.value !== undefined) event.orderId = orderId.value;
  if (broker.value !== undefined) event.broker = broker.value;
  if (meta !== undefined) event.meta = meta;
  return { ok: true, value: event };
}

export interface BatchError {
  index: number;
  error: string;
}

export function validateBatch(
  body: unknown,
): { ok: true; events: LedgerEvent[] } | { ok: false; error: string; index?: number } {
  if (!isPlainObject(body) || !Array.isArray(body.events)) {
    return { ok: false, error: 'body must be { "events": LedgerEvent[] }' };
  }
  const events = body.events as unknown[];
  if (events.length === 0) return { ok: false, error: "events must not be empty" };
  if (events.length > MAX_EVENTS_PER_BATCH) {
    return { ok: false, error: `at most ${MAX_EVENTS_PER_BATCH} events per call` };
  }
  const out: LedgerEvent[] = [];
  for (let i = 0; i < events.length; i++) {
    const r = validateEvent(events[i]);
    if (!r.ok) return { ok: false, error: `events[${i}]: ${r.error}`, index: i };
    out.push(r.value);
  }
  return { ok: true, events: out };
}
