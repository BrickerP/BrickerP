import { SELF, env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { GENESIS_HASH, computeHash } from "../src/chain";
import type { ChainedEvent, LedgerEvent } from "../src/schema";
import type { Ledger } from "../src/ledger";
import { createVerifier } from "../public/chain.js";

const TOKEN = "test-ingest-token";
const BASE = "https://open-ledger.test";
const SYMBOLS = ["AAPL", "MSFT", "SPY", "NVDA"] as const;

function fill(i: number, overrides: Partial<LedgerEvent> = {}): LedgerEvent {
  const minute = String(i % 60).padStart(2, "0");
  return {
    id: `fill-${i}`,
    ts: `2026-03-02T14:${minute}:00Z`,
    type: "fill",
    symbol: SYMBOLS[i % SYMBOLS.length],
    side: i % 3 === 0 ? "sell" : "buy",
    qty: 10 + i,
    price: 100 + i / 4,
    orderId: `ord-${Math.floor(i / 2)}`,
    broker: "alpaca-paper",
    ...overrides,
  };
}

function fills(n: number, start = 1): LedgerEvent[] {
  return Array.from({ length: n }, (_, k) => fill(start + k));
}

async function post(ledgerId: string, body: unknown, token: string | null = TOKEN, raw = false) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token !== null) headers.authorization = `Bearer ${token}`;
  return SELF.fetch(`${BASE}/v1/ledgers/${ledgerId}/events`, {
    method: "POST",
    headers,
    body: raw ? (body as string) : JSON.stringify(body),
  });
}

async function get(path: string) {
  return SELF.fetch(`${BASE}${path}`);
}

async function expectedChain(events: LedgerEvent[], prev = GENESIS_HASH): Promise<string[]> {
  const hashes: string[] = [];
  for (const e of events) {
    prev = await computeHash(prev, e);
    hashes.push(prev);
  }
  return hashes;
}

describe("authentication", () => {
  it("rejects ingest without a token", async () => {
    const res = await post("auth-a", { events: fills(1) }, null);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("Bearer");
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("rejects a wrong token, a wrong scheme and a prefix of the token", async () => {
    expect((await post("auth-b", { events: fills(1) }, "nope")).status).toBe(401);
    expect((await post("auth-b", { events: fills(1) }, TOKEN.slice(0, -1))).status).toBe(401);
    const res = await SELF.fetch(`${BASE}/v1/ledgers/auth-b/events`, {
      method: "POST",
      headers: { authorization: `Basic ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ events: fills(1) }),
    });
    expect(res.status).toBe(401);
    // Nothing was created by the failed attempts.
    expect((await get("/v1/ledgers/auth-b/head")).status).toBe(404);
  });
});

describe("validation", () => {
  it("returns 400 for malformed JSON and bad envelopes", async () => {
    expect((await post("val", "{not json", TOKEN, true)).status).toBe(400);
    expect((await post("val", { nope: [] })).status).toBe(400);
    expect((await post("val", { events: [] })).status).toBe(400);
    const tooMany = await post("val", { events: fills(501) });
    expect(tooMany.status).toBe(400);
    expect(((await tooMany.json()) as { message: string }).message).toContain("500");
  });

  it("returns 400 with the offending index for schema errors", async () => {
    const cases: Array<[unknown, string]> = [
      [{ ...fill(1), ts: "2026-03-02 14:00:00" }, "ts"],
      [{ ...fill(1), ts: "2026-03-02T14:00:00+02:00" }, "ts"],
      [{ ...fill(1), type: "trade" }, "type"],
      [{ ...fill(1), side: "long" }, "side"],
      [{ ...fill(1), qty: "10" }, "qty"],
      [{ ...fill(1), price: null }, "price must be a finite number"],
      [{ ...fill(1), price: -1 }, "fill events require price >= 0"],
      [{ ...fill(1), qty: 0 }, "fill events require qty > 0"],
      [{ ...fill(1), extra: 1 }, 'unknown field "extra"'],
      [{ ...fill(1), meta: [1, 2] }, "meta"],
      [{ id: "x", ts: "2026-03-02T14:00:00Z", type: "fill" }, "fill events require"],
      [{ ts: "2026-03-02T14:00:00Z", type: "note" }, "id"],
    ];
    for (const [bad, needle] of cases) {
      const res = await post("val", { events: [fill(99), bad] });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string; message: string };
      expect(body.error).toBe("invalid_request");
      expect(body.message).toContain("events[1]");
      expect(body.message).toContain(needle);
    }
    // A rejected batch writes nothing at all.
    expect((await get("/v1/ledgers/val/head")).status).toBe(404);
  });

  it("rejects invalid ledger ids and query parameters", async () => {
    expect((await get("/v1/ledgers/Upper/head")).status).toBe(400);
    expect((await get(`/v1/ledgers/${"a".repeat(65)}/head`)).status).toBe(400);
    expect((await get("/v1/ledgers/ok_id/head")).status).toBe(400);
    await post("params", { events: fills(3) });
    expect((await get("/v1/ledgers/params/events?limit=0")).status).toBe(400);
    expect((await get("/v1/ledgers/params/events?limit=1001")).status).toBe(400);
    expect((await get("/v1/ledgers/params/events?since=-1")).status).toBe(400);
    expect((await get("/v1/ledgers/params/events?since=abc")).status).toBe(400);
    expect((await get("/v1/ledgers/params/snapshots?from=2026-13-01")).status).toBe(400);
    expect((await get("/v1/ledgers/params/snapshots?from=2026-02-02&to=2026-02-01")).status).toBe(400);
    expect((await get("/v1/ledgers/params/verify?from=5&to=2")).status).toBe(400);
    expect((await get("/v1/ledgers/params/verify?from=0")).status).toBe(400);
  });
});

describe("routing", () => {
  it("returns 404 for unknown ledgers on every GET endpoint", async () => {
    for (const action of ["head", "events", "snapshots", "verify", "summary", "export.ndjson"]) {
      const res = await get(`/v1/ledgers/never-created/${action}`);
      expect(res.status, action).toBe(404);
      expect(((await res.json()) as { error: string }).error).toBe("ledger_not_found");
    }
  });

  it("returns 404 for unknown routes and 405 for wrong methods", async () => {
    expect((await get("/v1/ledgers/x/unknown")).status).toBe(404);
    expect((await get("/v1/nothing")).status).toBe(404);
    const res = await SELF.fetch(`${BASE}/v1/ledgers/x/head`, { method: "POST" });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toContain("GET");
    expect((await SELF.fetch(`${BASE}/v1/ledgers/x/events`, { method: "DELETE" })).status).toBe(405);
  });

  it("serves an API index and CORS headers", async () => {
    const index = await get("/v1");
    expect(index.status).toBe(200);
    expect(((await index.json()) as { name: string }).name).toBe("open-ledger");
    expect(index.headers.get("access-control-allow-origin")).toBe("*");

    const preflight = await SELF.fetch(`${BASE}/v1/ledgers/x/events`, { method: "OPTIONS" });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-methods")).toContain("GET");
    expect(preflight.headers.get("access-control-allow-headers")).toContain("Authorization");

    const missing = await get("/v1/ledgers/never-created/head");
    expect(missing.headers.get("access-control-allow-origin")).toBe("*");
  });
});

describe("ingest", () => {
  it("appends a batch, chains hashes from genesis and reports the head", async () => {
    const events = fills(3);
    const res = await post("ingest-a", { events });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    const hashes = await expectedChain(events);
    expect(body).toEqual({ ledgerId: "ingest-a", accepted: 3, duplicates: 0, seq: 3, headHash: hashes[2] });

    const head = (await (await get("/v1/ledgers/ingest-a/head")).json()) as Record<string, unknown>;
    expect(head).toMatchObject({ ledgerId: "ingest-a", seq: 3, count: 3, headHash: hashes[2] });
    expect(typeof head.updatedAt).toBe("string");

    const list = (await (await get("/v1/ledgers/ingest-a/events")).json()) as { events: ChainedEvent[] };
    expect(list.events.map((e) => e.hash)).toEqual(hashes);
    expect(list.events.map((e) => e.prevHash)).toEqual([GENESIS_HASH, hashes[0], hashes[1]]);
    expect(list.events[0]).toEqual({ seq: 1, ...events[0], prevHash: GENESIS_HASH, hash: hashes[0] });
  });

  it("is idempotent on event.id: duplicates are counted and the chain is unchanged", async () => {
    const first = fills(4);
    const r1 = (await (await post("ingest-b", { events: first })).json()) as { headHash: string; seq: number };

    // Replay the same batch, with an in-batch duplicate and one genuinely new event.
    const replay = [...first, fill(2), fill(5), fill(5)];
    const r2 = (await (await post("ingest-b", { events: replay })).json()) as Record<string, unknown>;
    expect(r2).toMatchObject({ accepted: 1, duplicates: 6, seq: 5 });

    const hashes = await expectedChain([...first, fill(5)]);
    expect(r2.headHash).toBe(hashes[4]);
    const list = (await (await get("/v1/ledgers/ingest-b/events")).json()) as { events: ChainedEvent[] };
    expect(list.events).toHaveLength(5);
    expect(list.events.slice(0, 4).map((e) => e.hash)).toEqual(hashes.slice(0, 4));
    expect(list.events[3]!.hash).toBe(r1.headHash);

    // A replay with the same id but different content is still a duplicate (first write wins).
    const r3 = (await (await post("ingest-b", { events: [fill(1, { price: 1 })] })).json()) as Record<string, unknown>;
    expect(r3).toMatchObject({ accepted: 0, duplicates: 1, seq: 5, headHash: hashes[4] });
  });

  it("stores meta canonically and preserves optional fields", async () => {
    const note: LedgerEvent = {
      id: "note-1",
      ts: "2026-03-02T20:00:00.123Z",
      type: "note",
      meta: { z: 1, a: { nested: [1, "two", null, true] }, text: "reconcile ok ✓" },
    };
    const cancel: LedgerEvent = { id: "c-1", ts: "2026-03-02T20:00:01Z", type: "cancel", orderId: "ord-9" };
    await post("ingest-c", { events: [note, cancel] });
    const list = (await (await get("/v1/ledgers/ingest-c/events")).json()) as { events: ChainedEvent[] };
    expect(list.events[0]!.meta).toEqual(note.meta);
    expect(list.events[0]!.ts).toBe(note.ts);
    expect(list.events[1]).toMatchObject(cancel);
    expect("symbol" in list.events[1]!).toBe(false);
    const verify = (await (await get("/v1/ledgers/ingest-c/verify")).json()) as { ok: boolean };
    expect(verify.ok).toBe(true);
  });

  it("serialises concurrent batches so the chain stays consistent", async () => {
    const batches = [fills(20, 1), fills(20, 21), fills(20, 41)];
    const responses = await Promise.all(batches.map((events) => post("ingest-d", { events })));
    for (const r of responses) expect(r.status).toBe(200);
    const head = (await (await get("/v1/ledgers/ingest-d/head")).json()) as { seq: number };
    expect(head.seq).toBe(60);
    const verify = (await (await get("/v1/ledgers/ingest-d/verify")).json()) as { ok: boolean; checked: number };
    expect(verify).toMatchObject({ ok: true, checked: 60 });
  });
});

describe("pagination", () => {
  it("pages with since/limit and reports nextSince", async () => {
    await post("page", { events: fills(25) });
    const p1 = (await (await get("/v1/ledgers/page/events?limit=10")).json()) as {
      events: ChainedEvent[];
      nextSince: number;
    };
    expect(p1.events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(p1.nextSince).toBe(10);

    const p2 = (await (await get(`/v1/ledgers/page/events?limit=10&since=${p1.nextSince}`)).json()) as typeof p1;
    expect(p2.events.map((e) => e.seq)).toEqual([11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
    expect(p2.nextSince).toBe(20);

    const p3 = (await (await get(`/v1/ledgers/page/events?limit=10&since=${p2.nextSince}`)).json()) as typeof p1;
    expect(p3.events.map((e) => e.seq)).toEqual([21, 22, 23, 24, 25]);
    expect(p3.nextSince).toBe(25);

    const p4 = (await (await get(`/v1/ledgers/page/events?limit=10&since=${p3.nextSince}`)).json()) as typeof p1;
    expect(p4.events).toEqual([]);
    expect(p4.nextSince).toBe(25);
  });

  it("filters by symbol", async () => {
    await post("page-sym", { events: fills(12) });
    const res = (await (await get("/v1/ledgers/page-sym/events?symbol=MSFT&limit=2")).json()) as {
      events: ChainedEvent[];
      nextSince: number;
    };
    // fill(i).symbol = SYMBOLS[i % 4], so MSFT sits at seq 1, 5, 9.
    expect(res.events.map((e) => e.seq)).toEqual([1, 5]);
    expect(res.events.every((e) => e.symbol === "MSFT")).toBe(true);
    expect(res.nextSince).toBe(5);
    const rest = (await (await get(`/v1/ledgers/page-sym/events?symbol=MSFT&limit=2&since=${res.nextSince}`)).json()) as typeof res;
    expect(rest.events.map((e) => e.seq)).toEqual([9]);
    // Short page: cursor jumps to the head so pollers can resume from there.
    expect(rest.nextSince).toBe(12);
    const none = (await (await get("/v1/ledgers/page-sym/events?symbol=ZZZ")).json()) as typeof res;
    expect(none.events).toEqual([]);
    expect(none.nextSince).toBe(12);
  });
});

describe("verify", () => {
  it("verifies the whole chain and sub-ranges", async () => {
    await post("verify-ok", { events: fills(30) });
    const full = (await (await get("/v1/ledgers/verify-ok/verify")).json()) as Record<string, unknown>;
    const head = (await (await get("/v1/ledgers/verify-ok/head")).json()) as { headHash: string };
    expect(full).toMatchObject({ ok: true, checked: 30, from: 1, to: 30, headSeq: 30, headHash: head.headHash, lastHash: head.headHash });

    const part = (await (await get("/v1/ledgers/verify-ok/verify?from=11&to=20")).json()) as Record<string, unknown>;
    expect(part).toMatchObject({ ok: true, checked: 10, from: 11, to: 20 });

    const beyond = (await (await get("/v1/ledgers/verify-ok/verify?from=25&to=999")).json()) as Record<string, unknown>;
    expect(beyond).toMatchObject({ ok: true, checked: 6, from: 25, to: 30 });

    const past = (await (await get("/v1/ledgers/verify-ok/verify?from=31")).json()) as Record<string, unknown>;
    expect(past).toMatchObject({ ok: true, checked: 0 });
  });

  it("detects a row tampered with directly in Durable Object storage", async () => {
    await post("verify-tamper", { events: fills(10) });
    const stub = env.LEDGER.get(env.LEDGER.idFromName("verify-tamper"));
    await runInDurableObject(stub, async (_instance: Ledger, state) => {
      state.storage.sql.exec("UPDATE events SET price = price + 0.01 WHERE seq = 4");
    });

    const res = (await (await get("/v1/ledgers/verify-tamper/verify")).json()) as Record<string, unknown>;
    expect(res).toMatchObject({ ok: false, checked: 3, firstBadSeq: 4, reason: "hash mismatch" });

    // Ranges that do not include the tampered row still pass, ranges after it chain correctly.
    const before = (await (await get("/v1/ledgers/verify-tamper/verify?from=1&to=3")).json()) as { ok: boolean };
    expect(before.ok).toBe(true);
    const after = (await (await get("/v1/ledgers/verify-tamper/verify?from=5&to=10")).json()) as { ok: boolean };
    expect(after.ok).toBe(true);

    // The browser verifier reaches the same conclusion from the export.
    const text = await (await get("/v1/ledgers/verify-tamper/export.ndjson")).text();
    const verifier = createVerifier();
    for (const line of text.trim().split("\n")) await verifier.step(JSON.parse(line));
    expect(verifier.result().failure).toEqual({ seq: 4, reason: "recomputed hash differs from stored hash" });
  });

  it("detects a rewritten hash", async () => {
    await post("tamper-hash", { events: fills(6) });
    const stub = env.LEDGER.get(env.LEDGER.idFromName("tamper-hash"));
    await runInDurableObject(stub, async (_instance: Ledger, state) => {
      state.storage.sql.exec("UPDATE events SET hash = ? WHERE seq = 2", "f".repeat(64));
    });
    const res = (await (await get("/v1/ledgers/tamper-hash/verify")).json()) as Record<string, unknown>;
    expect(res).toMatchObject({ ok: false, checked: 1, firstBadSeq: 2, reason: "hash mismatch" });
    // Starting after the bad row: its stored hash is the anchor, so row 3 no longer links to it.
    const anchored = (await (await get("/v1/ledgers/tamper-hash/verify?from=3")).json()) as Record<string, unknown>;
    expect(anchored).toMatchObject({ ok: false, checked: 0, firstBadSeq: 3, reason: "prev_hash mismatch" });
  });

  it("detects a broken link", async () => {
    await post("tamper-link", { events: fills(6) });
    const stub = env.LEDGER.get(env.LEDGER.idFromName("tamper-link"));
    await runInDurableObject(stub, async (_instance: Ledger, state) => {
      state.storage.sql.exec("UPDATE events SET prev_hash = ? WHERE seq = 5", "e".repeat(64));
    });
    const res = (await (await get("/v1/ledgers/tamper-link/verify?from=3")).json()) as Record<string, unknown>;
    expect(res).toMatchObject({ ok: false, checked: 2, firstBadSeq: 5, reason: "prev_hash mismatch" });
  });

  it("detects a deleted row", async () => {
    await post("tamper-delete", { events: fills(6) });
    const stub = env.LEDGER.get(env.LEDGER.idFromName("tamper-delete"));
    await runInDurableObject(stub, async (_instance: Ledger, state) => {
      state.storage.sql.exec("DELETE FROM events WHERE seq = 4");
    });
    const gap = (await (await get("/v1/ledgers/tamper-delete/verify")).json()) as Record<string, unknown>;
    expect(gap).toMatchObject({ ok: false, checked: 3, firstBadSeq: 4, reason: "missing row" });
    const anchorMissing = (await (await get("/v1/ledgers/tamper-delete/verify?from=5")).json()) as Record<string, unknown>;
    expect(anchorMissing).toMatchObject({ ok: false, firstBadSeq: 4, reason: "missing row" });
    const truncated = (await (await get("/v1/ledgers/tamper-delete/verify?from=1&to=4")).json()) as Record<string, unknown>;
    expect(truncated).toMatchObject({ ok: false, checked: 3, firstBadSeq: 4, reason: "missing row" });
    // head/count disagree once a row is gone, which is itself a tamper signal.
    const head = (await (await get("/v1/ledgers/tamper-delete/head")).json()) as { seq: number; count: number };
    expect(head).toMatchObject({ seq: 6, count: 5 });
  });

  it("caps a single call at 2000 rows", async () => {
    await post("verify-cap", { events: fills(5) });
    const res = (await (await get("/v1/ledgers/verify-cap/verify?from=1&to=5000")).json()) as { to: number };
    expect(res.to).toBe(5);
    const stub = env.LEDGER.get(env.LEDGER.idFromName("verify-cap"));
    const capped = await stub.verify(1, 5000);
    expect(capped?.to).toBe(5);
    // The cap itself (independent of head) is visible through the clamp arithmetic.
    const { MAX_VERIFY_RANGE } = await import("../src/ledger");
    expect(MAX_VERIFY_RANGE).toBe(2000);
  });
});

describe("snapshots", () => {
  it("upserts one row per UTC day of appends inside the same transaction", async () => {
    await post("snap", { events: fills(3) });
    const today = new Date().toISOString().slice(0, 10);
    const head = (await (await get("/v1/ledgers/snap/head")).json()) as { seq: number; count: number; headHash: string };
    const snaps = (await (await get("/v1/ledgers/snap/snapshots")).json()) as { snapshots: unknown[] };
    expect(snaps.snapshots).toEqual([{ date: today, seq: 3, count: 3, headHash: head.headHash }]);

    await post("snap", { events: fills(2, 4) });
    const head2 = (await (await get("/v1/ledgers/snap/head")).json()) as { headHash: string };
    const snaps2 = (await (await get(`/v1/ledgers/snap/snapshots?from=${today}&to=${today}`)).json()) as {
      snapshots: unknown[];
    };
    expect(snaps2.snapshots).toEqual([{ date: today, seq: 5, count: 5, headHash: head2.headHash }]);

    const none = (await (await get("/v1/ledgers/snap/snapshots?from=2000-01-01&to=2000-01-02")).json()) as {
      snapshots: unknown[];
    };
    expect(none.snapshots).toEqual([]);
  });
});

describe("summary", () => {
  it("aggregates fills by day and by symbol with SQL", async () => {
    const events: LedgerEvent[] = [
      { id: "s1", ts: "2026-03-02T14:30:00Z", type: "fill", symbol: "AAPL", side: "buy", qty: 10, price: 100 },
      { id: "s2", ts: "2026-03-02T15:00:00Z", type: "fill", symbol: "AAPL", side: "sell", qty: 5, price: 110 },
      { id: "s3", ts: "2026-03-03T14:35:00Z", type: "fill", symbol: "MSFT", side: "buy", qty: 2, price: 200 },
      { id: "s4", ts: "2026-03-03T14:36:00Z", type: "order", symbol: "MSFT", side: "buy", qty: 2, price: 200 },
      { id: "s5", ts: "2026-03-03T23:59:59Z", type: "note", meta: { text: "eod reconcile ok" } },
    ];
    await post("summary", { events });
    const res = (await (await get("/v1/ledgers/summary/summary")).json()) as Record<string, unknown>;
    expect(res).toEqual({
      ledgerId: "summary",
      byDay: [
        { date: "2026-03-02", fills: 2, buyQty: 10, sellQty: 5, notional: 1550 },
        { date: "2026-03-03", fills: 1, buyQty: 2, sellQty: 0, notional: 400 },
      ],
      bySymbol: [
        { symbol: "AAPL", fills: 2, buyQty: 10, sellQty: 5, notional: 1550 },
        { symbol: "MSFT", fills: 1, buyQty: 2, sellQty: 0, notional: 400 },
      ],
    });
  });
});

describe("export", () => {
  it("streams NDJSON that re-verifies in the browser verifier", async () => {
    for (const [n, start] of [
      [500, 1],
      [500, 501],
      [203, 1001],
    ] as const) {
      expect((await post("export", { events: fills(n, start) })).status).toBe(200);
    }
    const res = await get("/v1/ledgers/export/export.ndjson");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/x-ndjson");
    const lines = (await res.text()).trim().split("\n");
    expect(lines).toHaveLength(1203);
    const verifier = createVerifier();
    for (const line of lines) {
      expect(await verifier.step(JSON.parse(line))).toBe(true);
    }
    const head = (await (await get("/v1/ledgers/export/head")).json()) as { headHash: string };
    expect(verifier.result()).toMatchObject({ ok: true, checked: 1203, lastHash: head.headHash });

    const since = await get("/v1/ledgers/export/export.ndjson?since=1200");
    const tail = (await since.text()).trim().split("\n").map((l) => JSON.parse(l) as ChainedEvent);
    expect(tail.map((e) => e.seq)).toEqual([1201, 1202, 1203]);

    const sym = await get("/v1/ledgers/export/export.ndjson?symbol=SPY&since=1195");
    const symRows = (await sym.text()).trim().split("\n").map((l) => JSON.parse(l) as ChainedEvent);
    expect(symRows.every((e) => e.symbol === "SPY" && e.seq > 1195)).toBe(true);
    expect(symRows.length).toBeGreaterThan(0);
  });
});

describe("dashboard assets", () => {
  it("serves the static dashboard outside /v1", async () => {
    const res = await get("/");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Verify chain in your browser");
    expect((await get("/chain.js")).status).toBe(200);
  });
});
