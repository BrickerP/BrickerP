// Browser twin of ../src/chain.ts (the dashboard has no build step, so it cannot import
// TypeScript). test/chain.test.ts asserts both implementations agree byte-for-byte.
//
//   hash = sha256_hex(prevHash + "\n" + canonicalJSON(event))
//   genesis prevHash = 64 ASCII zeros

export const GENESIS_HASH = "0".repeat(64);

export function canonicalJSON(value) {
  const out = serialize(value);
  if (out === undefined) throw new TypeError("canonicalJSON: top-level value is not JSON-serialisable");
  return out;
}

function serialize(value) {
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
    default:
      break;
  }
  if (typeof value.toJSON === "function") return serialize(value.toJSON());
  if (Array.isArray(value)) {
    return "[" + value.map((item) => serialize(item) ?? "null").join(",") + "]";
  }
  const keys = Object.keys(value).sort();
  const parts = [];
  for (const key of keys) {
    const v = serialize(value[key]);
    if (v !== undefined) parts.push(JSON.stringify(key) + ":" + v);
  }
  return "{" + parts.join(",") + "}";
}

const encoder = new TextEncoder();

export async function sha256Hex(input) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(input));
  const bytes = new Uint8Array(digest);
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, "0");
  return s;
}

export function hashPreimage(prevHash, event) {
  return prevHash + "\n" + canonicalJSON(event);
}

export function computeHash(prevHash, event) {
  return sha256Hex(hashPreimage(prevHash, event));
}

/** ChainedEvent -> LedgerEvent (drops seq/prevHash/hash before hashing). */
export function stripChain(chained) {
  const { seq, prevHash, hash, ...event } = chained;
  return event;
}

/**
 * Incrementally verifies ChainedEvents in seq order. Feed events one at a time via
 * `step()`; `result()` reports the outcome. `expectedPrev` must be GENESIS_HASH when
 * starting at seq 1, or the hash of the row just before the first one fed.
 */
export function createVerifier(expectedPrev = GENESIS_HASH, expectedSeq = 1) {
  let prev = expectedPrev;
  let seq = expectedSeq;
  let checked = 0;
  let failure = null;

  return {
    async step(chained) {
      if (failure) return false;
      if (chained.seq !== seq) {
        failure = { seq, reason: `expected seq ${seq}, got ${chained.seq}` };
        return false;
      }
      if (chained.prevHash !== prev) {
        failure = { seq: chained.seq, reason: "prevHash does not match previous hash" };
        return false;
      }
      const recomputed = await computeHash(prev, stripChain(chained));
      if (recomputed !== chained.hash) {
        failure = { seq: chained.seq, reason: "recomputed hash differs from stored hash" };
        return false;
      }
      prev = chained.hash;
      seq += 1;
      checked += 1;
      return true;
    },
    result() {
      return { ok: failure === null, checked, lastHash: checked > 0 ? prev : null, nextSeq: seq, failure };
    },
  };
}
