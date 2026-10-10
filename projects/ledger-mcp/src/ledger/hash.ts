/**
 * Hash-chain primitives shared with open-ledger:
 *
 *   hash = sha256_hex(prevHash + "\n" + canonicalJSON(event))
 *   genesis prevHash = 64 zeros
 *   canonicalJSON = recursively key-sorted JSON, no whitespace, numbers as JSON
 *
 * `event` is the bare LedgerEvent: `seq`, `prevHash` and `hash` are never part of the
 * hashed payload, so a ChainedEvent can be passed straight in.
 */
import type { ChainedEvent, LedgerEvent } from "./types";

export const GENESIS_HASH = "0".repeat(64);

const CHAIN_KEYS = new Set(["seq", "prevHash", "hash"]);

/** Deterministic JSON: sorted object keys, no whitespace, JSON.stringify semantics for scalars. */
export function canonicalJSON(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") {
    // Numbers, strings, booleans; NaN/Infinity → "null" like JSON.stringify.
    return JSON.stringify(value) ?? "null";
  }
  if (typeof (value as { toJSON?: unknown }).toJSON === "function") {
    return canonicalJSON((value as { toJSON: () => unknown }).toJSON());
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJSON(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJSON(record[key])}`).join(",")}}`;
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Strip chain fields so hashing a ChainedEvent equals hashing its LedgerEvent. */
export function bareEvent(event: LedgerEvent | ChainedEvent): LedgerEvent {
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(event)) {
    if (!CHAIN_KEYS.has(key) && val !== undefined) out[key] = val;
  }
  return out as LedgerEvent;
}

export function hashPreimage(prevHash: string, event: LedgerEvent | ChainedEvent): string {
  return `${prevHash}\n${canonicalJSON(bareEvent(event))}`;
}

export function hashEvent(prevHash: string, event: LedgerEvent | ChainedEvent): Promise<string> {
  return sha256Hex(hashPreimage(prevHash, event));
}

export interface ChainCheck {
  ok: boolean;
  /** Number of events whose hash was recomputed. */
  checked: number;
  from: number;
  to: number;
  /** Hash of the last event in the range ("" when the range is empty). */
  headHash: string;
  /** First failing seq and why, when `ok` is false. */
  firstBadSeq?: number;
  reason?: string;
}

export interface ChainCheckOptions {
  /**
   * Seq of the very first event of the ledger. When the range starts there, its prevHash
   * must be the genesis hash. Leave undefined to skip that check.
   */
  firstSeq?: number;
}

/** Recompute every hash in a contiguous, ascending slice of the chain and check linkage. */
export async function verifyChain(events: readonly ChainedEvent[], options: ChainCheckOptions = {}): Promise<ChainCheck> {
  if (events.length === 0) return { ok: true, checked: 0, from: 0, to: 0, headHash: "" };
  const first = events[0]!;
  const last = events[events.length - 1]!;
  const base: Omit<ChainCheck, "ok"> = { checked: 0, from: first.seq, to: last.seq, headHash: "" };
  const fail = (seq: number, reason: string): ChainCheck => ({ ...base, ok: false, firstBadSeq: seq, reason });

  if (options.firstSeq !== undefined && first.seq === options.firstSeq && first.prevHash !== GENESIS_HASH) {
    return fail(first.seq, "first event's prevHash is not the genesis hash");
  }
  let prevHash = first.prevHash;
  let prevSeq = first.seq - 1;
  for (const event of events) {
    if (event.seq !== prevSeq + 1) return fail(event.seq, `seq gap: expected ${prevSeq + 1}`);
    if (event.prevHash !== prevHash) return fail(event.seq, "prevHash does not match previous hash");
    const expected = await hashEvent(prevHash, event);
    if (expected !== event.hash) return fail(event.seq, "hash mismatch");
    base.checked += 1;
    prevHash = event.hash;
    prevSeq = event.seq;
  }
  return { ...base, ok: true, headHash: prevHash };
}
