import { describe, expect, it } from "vitest";
import { GENESIS_HASH, canonicalJSON, computeHash, hashPreimage, sha256Hex } from "../src/chain";
import * as browserChain from "../public/chain.js";
import { validateEvent } from "../src/schema";
import type { LedgerEvent } from "../src/schema";

// Vectors computed independently with Node's `crypto.createHash("sha256")`.
const VECTOR_EVENT: LedgerEvent = {
  id: "evt-1",
  ts: "2026-01-02T03:04:05Z",
  type: "fill",
  symbol: "AAPL",
  side: "buy",
  qty: 10,
  price: 150.25,
};
const VECTOR_CANONICAL =
  '{"id":"evt-1","price":150.25,"qty":10,"side":"buy","symbol":"AAPL","ts":"2026-01-02T03:04:05Z","type":"fill"}';
const VECTOR_HASH_1 = "a0b815aadcc334983d6a38df46cd55c81e9ca7f81585368f63268757cc876d88";
const VECTOR_EVENT_2: LedgerEvent = {
  type: "note",
  ts: "2026-01-02T03:04:06Z",
  id: "evt-2",
  meta: { venue: "NYSE", a: [1, 2, { z: true, b: null }] },
};
// preimage: VECTOR_HASH_1 + "\n" +
//   {"id":"evt-2","meta":{"a":[1,2,{"b":null,"z":true}],"venue":"NYSE"},"ts":"2026-01-02T03:04:06Z","type":"note"}
const VECTOR_HASH_2 = "58f975c4746e0da05099ffcf6b0c7d1b7d8126f699fb8b045cc0e516ee79dd59";

describe("canonicalJSON", () => {
  it("sorts keys recursively and emits no whitespace", () => {
    const a = { b: 1, a: { d: [3, { y: 1, x: 2 }], c: "x" } };
    const b = { a: { c: "x", d: [3, { x: 2, y: 1 }] }, b: 1 };
    expect(canonicalJSON(a)).toBe('{"a":{"c":"x","d":[3,{"x":2,"y":1}]},"b":1}');
    expect(canonicalJSON(a)).toBe(canonicalJSON(b));
  });

  it("is independent of property insertion order", () => {
    const shuffled: LedgerEvent = {
      price: 150.25,
      type: "fill",
      qty: 10,
      ts: "2026-01-02T03:04:05Z",
      side: "buy",
      id: "evt-1",
      symbol: "AAPL",
    };
    expect(canonicalJSON(shuffled)).toBe(VECTOR_CANONICAL);
    expect(canonicalJSON(VECTOR_EVENT)).toBe(VECTOR_CANONICAL);
  });

  it("matches JSON.stringify semantics for numbers, strings, undefined and toJSON", () => {
    expect(canonicalJSON({ n: 1e21, m: -0, k: 0.1 + 0.2, s: "é\n\"\u2028" })).toBe(
      '{"k":0.30000000000000004,"m":0,"n":1e+21,"s":"é\\n\\"\u2028"}',
    );
    expect(canonicalJSON({ a: undefined, b: [undefined, () => 1], c: NaN })).toBe('{"b":[null,null],"c":null}');
    expect(canonicalJSON(new Date(Date.UTC(2026, 0, 2, 3, 4, 5)))).toBe('"2026-01-02T03:04:05.000Z"');
    expect(() => canonicalJSON(undefined)).toThrow(TypeError);
  });

  it("round-trips through JSON.parse unchanged", () => {
    const value = { z: [1, { b: 2, a: [true, null, "x"] }], a: { c: 1.5, b: "y" } };
    const once = canonicalJSON(value);
    expect(canonicalJSON(JSON.parse(once))).toBe(once);
  });
});

describe("hash chain", () => {
  it("sha256Hex matches a known vector", async () => {
    expect(await sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("genesis prevHash is 64 zeros", () => {
    expect(GENESIS_HASH).toBe("0".repeat(64));
    expect(GENESIS_HASH).toHaveLength(64);
  });

  it("hash = sha256(prevHash + \\n + canonicalJSON(event)) against hard-coded vectors", async () => {
    expect(hashPreimage(GENESIS_HASH, VECTOR_EVENT)).toBe(GENESIS_HASH + "\n" + VECTOR_CANONICAL);
    const h1 = await computeHash(GENESIS_HASH, VECTOR_EVENT);
    expect(h1).toBe(VECTOR_HASH_1);
    const h2 = await computeHash(h1, VECTOR_EVENT_2);
    expect(h2).toBe(VECTOR_HASH_2);
  });

  it("hashing a validated (normalised) event equals hashing the raw input without undefineds", async () => {
    const validated = validateEvent({ ...VECTOR_EVENT, orderId: undefined });
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    expect(await computeHash(GENESIS_HASH, validated.value)).toBe(VECTOR_HASH_1);
  });
});

describe("browser implementation (public/chain.js) parity", () => {
  const samples: unknown[] = [
    VECTOR_EVENT,
    VECTOR_EVENT_2,
    { n: 1e21, m: -0, k: 0.1 + 0.2, s: "é\n\"\u2028", u: undefined, arr: [undefined, null, 1] },
    { nested: { deep: { deeper: [[1, [2, [3]]]] } }, "ünï": "cødé", "": "empty-key" },
    [],
    {},
    "plain string",
    42,
    true,
    null,
  ];

  it("canonicalJSON agrees on every sample", () => {
    for (const sample of samples) {
      expect(browserChain.canonicalJSON(sample)).toBe(canonicalJSON(sample));
    }
  });

  it("computeHash agrees and matches the known vectors", async () => {
    expect(browserChain.GENESIS_HASH).toBe(GENESIS_HASH);
    const h1 = await browserChain.computeHash(GENESIS_HASH, VECTOR_EVENT);
    expect(h1).toBe(VECTOR_HASH_1);
    expect(await browserChain.computeHash(h1, VECTOR_EVENT_2)).toBe(VECTOR_HASH_2);
  });

  it("createVerifier walks a valid chain and flags the first divergence", async () => {
    const chained1 = { seq: 1, ...VECTOR_EVENT, prevHash: GENESIS_HASH, hash: VECTOR_HASH_1 };
    const chained2 = { seq: 2, ...VECTOR_EVENT_2, prevHash: VECTOR_HASH_1, hash: VECTOR_HASH_2 };

    const good = browserChain.createVerifier();
    expect(await good.step(chained1)).toBe(true);
    expect(await good.step(chained2)).toBe(true);
    expect(good.result()).toEqual({ ok: true, checked: 2, lastHash: VECTOR_HASH_2, nextSeq: 3, failure: null });

    const tampered = browserChain.createVerifier();
    await tampered.step(chained1);
    expect(await tampered.step({ ...chained2, qty: 1 })).toBe(false);
    expect(tampered.result().ok).toBe(false);
    expect(tampered.result().failure).toEqual({ seq: 2, reason: "recomputed hash differs from stored hash" });
  });
});
