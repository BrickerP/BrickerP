import { describe, expect, it } from "vitest";
import { GENESIS_HASH, bareEvent, canonicalJSON, hashEvent, hashPreimage, sha256Hex, verifyChain } from "../src/ledger/hash";
import type { ChainedEvent, LedgerEvent } from "../src/ledger/types";

// Vectors computed independently with node:crypto; also listed under "Ledger contract" in ../README.md.
const EVENT_1: LedgerEvent = {
  id: "evt-000001",
  ts: "2026-09-01T13:31:07.000Z",
  type: "fill",
  symbol: "AAPL",
  side: "buy",
  qty: 10,
  price: 232.5,
  orderId: "ord-000001",
  broker: "alpaca-paper",
  meta: { strategy: "bracket", leg: "entry", session: "2026-09-01" },
};
const EVENT_2: LedgerEvent = {
  id: "evt-000002",
  ts: "2026-09-01T14:02:00.000Z",
  type: "fill",
  symbol: "AAPL",
  side: "sell",
  qty: 4,
  price: 233.1,
  orderId: "ord-000002",
  broker: "alpaca-paper",
  meta: { leg: "take_profit", strategy: "bracket", session: "2026-09-01" },
};
const CANON_1 =
  '{"broker":"alpaca-paper","id":"evt-000001","meta":{"leg":"entry","session":"2026-09-01","strategy":"bracket"},"orderId":"ord-000001","price":232.5,"qty":10,"side":"buy","symbol":"AAPL","ts":"2026-09-01T13:31:07.000Z","type":"fill"}';
const HASH_1 = "bbf66f7f877aa34b5dc6507cec9bc3b2a2b621dd29bbac9688bcf3c2a5107eb3";
const HASH_2 = "0cb7b0e09d09c28cfd541a7f7e7742e0ede588c4b077ac7bc37d4a04bb5ca108";

describe("canonicalJSON", () => {
  it("sorts keys recursively and strips whitespace", () => {
    expect(canonicalJSON({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: "x" } })).toBe('{"a":{"c":"x","d":[1,{"y":2,"z":1}]},"b":1}');
  });

  it("follows JSON.stringify semantics for scalars and undefined", () => {
    expect(canonicalJSON({ a: undefined, b: null, c: NaN, d: 1e21, e: 0.1 + 0.2, f: "é\n" })).toBe('{"b":null,"c":null,"d":1e+21,"e":0.30000000000000004,"f":"é\\n"}');
    expect(canonicalJSON([undefined, 1])).toBe("[null,1]");
    expect(canonicalJSON("s")).toBe('"s"');
    expect(canonicalJSON(undefined)).toBe("null");
  });

  it("matches the reference encoding of a ledger event", () => {
    expect(canonicalJSON(EVENT_1)).toBe(CANON_1);
  });
});

describe("hashing", () => {
  it("sha256Hex matches the well-known vector", async () => {
    expect(await sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("hashEvent uses prevHash + newline + canonical JSON", async () => {
    expect(hashPreimage(GENESIS_HASH, EVENT_1)).toBe(`${GENESIS_HASH}\n${CANON_1}`);
    expect(await hashEvent(GENESIS_HASH, EVENT_1)).toBe(HASH_1);
    expect(await hashEvent(HASH_1, EVENT_2)).toBe(HASH_2);
  });

  it("ignores seq/prevHash/hash when hashing a chained event", async () => {
    const chained: ChainedEvent = { ...EVENT_1, seq: 1, prevHash: GENESIS_HASH, hash: HASH_1 };
    expect(bareEvent(chained)).toEqual(EVENT_1);
    expect(await hashEvent(GENESIS_HASH, chained)).toBe(HASH_1);
  });
});

describe("verifyChain", () => {
  const chain: ChainedEvent[] = [
    { ...EVENT_1, seq: 1, prevHash: GENESIS_HASH, hash: HASH_1 },
    { ...EVENT_2, seq: 2, prevHash: HASH_1, hash: HASH_2 },
  ];

  it("accepts a valid chain and reports the head hash", async () => {
    expect(await verifyChain(chain, { firstSeq: 1 })).toEqual({ ok: true, checked: 2, from: 1, to: 2, headHash: HASH_2 });
    expect(await verifyChain([])).toEqual({ ok: true, checked: 0, from: 0, to: 0, headHash: "" });
  });

  it("detects a tampered payload", async () => {
    const tampered = [chain[0]!, { ...chain[1]!, qty: 5 }];
    const result = await verifyChain(tampered, { firstSeq: 1 });
    expect(result.ok).toBe(false);
    expect(result.firstBadSeq).toBe(2);
    expect(result.reason).toBe("hash mismatch");
    expect(result.checked).toBe(1);
  });

  it("detects broken linkage, seq gaps and a bad genesis", async () => {
    expect((await verifyChain([chain[0]!, { ...chain[1]!, prevHash: GENESIS_HASH }])).reason).toBe("prevHash does not match previous hash");
    expect((await verifyChain([chain[0]!, { ...chain[1]!, seq: 3 }])).reason).toBe("seq gap: expected 2");
    expect((await verifyChain([{ ...chain[0]!, prevHash: HASH_2 }], { firstSeq: 1 })).reason).toBe("first event's prevHash is not the genesis hash");
    // A slice that does not start at the ledger's first event may legitimately have a non-genesis prevHash.
    expect((await verifyChain([chain[1]!], { firstSeq: 1 })).ok).toBe(true);
  });
});
