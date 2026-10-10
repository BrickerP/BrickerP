/**
 * Hash-chain primitives shared by the Worker, the Durable Object and the tests.
 *
 * The browser dashboard ships an equivalent implementation in `public/chain.js`
 * (no build step there, so it cannot import this file). `test/chain.test.ts`
 * asserts the two implementations agree byte-for-byte.
 *
 *   hash = sha256_hex(prevHash + "\n" + canonicalJSON(event))
 *   genesis prevHash = 64 ASCII zeros
 */

import type { LedgerEvent } from "./schema";

export const GENESIS_HASH = "0".repeat(64);
export const HASH_RE = /^[0-9a-f]{64}$/;

/**
 * Deterministic JSON: object keys sorted (UTF-16 code unit order, i.e. the default
 * `Array.prototype.sort`), no whitespace, numbers/strings serialised exactly like
 * `JSON.stringify`. `undefined` properties are omitted (also like `JSON.stringify`);
 * `undefined` array items become `null`. Objects with `toJSON` (e.g. Date) are
 * serialised via `toJSON`, again mirroring `JSON.stringify`.
 */
export function canonicalJSON(value: unknown): string {
  const out = serialize(value);
  if (out === undefined) {
    throw new TypeError("canonicalJSON: top-level value is not JSON-serialisable");
  }
  return out;
}

function serialize(value: unknown): string | undefined {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "number":
      return Number.isFinite(value) ? JSON.stringify(value) : "null";
    case "boolean":
      return value ? "true" : "false";
    case "bigint":
      throw new TypeError("canonicalJSON: BigInt is not supported");
    case "undefined":
    case "function":
    case "symbol":
      return undefined;
    case "object":
      break;
  }
  const obj = value as Record<string, unknown> & { toJSON?: unknown };
  if (typeof obj.toJSON === "function") {
    return serialize((obj.toJSON as () => unknown)());
  }
  if (Array.isArray(obj)) {
    return "[" + obj.map((item) => serialize(item) ?? "null").join(",") + "]";
  }
  const keys = Object.keys(obj).sort();
  const parts: string[] = [];
  for (const key of keys) {
    const v = serialize(obj[key]);
    if (v !== undefined) parts.push(JSON.stringify(key) + ":" + v);
  }
  return "{" + parts.join(",") + "}";
}

const encoder = new TextEncoder();

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(input));
  return toHex(new Uint8Array(digest));
}

export function toHex(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) {
    s += bytes[i]!.toString(16).padStart(2, "0");
  }
  return s;
}

/** The exact byte string that gets hashed for an event. */
export function hashPreimage(prevHash: string, event: LedgerEvent): string {
  return prevHash + "\n" + canonicalJSON(event);
}

export function computeHash(prevHash: string, event: LedgerEvent): Promise<string> {
  return sha256Hex(hashPreimage(prevHash, event));
}
