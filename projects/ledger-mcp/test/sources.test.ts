import { describe, expect, it, vi } from "vitest";
import { GENESIS_HASH } from "../src/ledger/hash";
import { HttpLedgerSource } from "../src/ledger/http";
import { LedgerSourceError, collectEvents, type LedgerSource } from "../src/ledger/source";
import type { ChainedEvent } from "../src/ledger/types";
import { computeSummary } from "../src/summary";

function chained(seq: number, extra: Partial<ChainedEvent> = {}): ChainedEvent {
  return {
    id: `e${seq}`,
    ts: `2026-09-0${1 + (seq % 3)}T14:00:00.000Z`,
    type: "fill",
    symbol: seq % 2 ? "AAPL" : "SPY",
    side: seq % 4 < 2 ? "buy" : "sell",
    qty: 1,
    price: 100 + seq,
    seq,
    prevHash: GENESIS_HASH,
    hash: "a".repeat(64),
    ...extra,
  };
}

describe("HttpLedgerSource", () => {
  const head = { ledgerId: "live", seq: 2, count: 2, headHash: "b".repeat(64), updatedAt: "2026-10-09T20:00:00.000Z" };

  function fakeFetch(handler: (url: URL) => Response | Promise<Response>) {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      calls.push(url.pathname + url.search);
      return handler(url);
    }) as unknown as typeof fetch;
    return { fetchImpl, calls };
  }

  it("builds contract URLs and validates responses", async () => {
    const { fetchImpl, calls } = fakeFetch((url) => {
      if (url.pathname.endsWith("/head")) return Response.json(head);
      if (url.pathname.endsWith("/events")) return Response.json({ events: [chained(1), chained(2)], nextSince: 2 });
      if (url.pathname.endsWith("/verify")) return Response.json({ ok: true, checked: 2, from: 1, to: 2, headHash: "b".repeat(64) });
      if (url.pathname.endsWith("/snapshots")) return Response.json({ snapshots: [{ date: "2026-09-01", seq: 2, count: 2, headHash: "b".repeat(64) }] });
      if (url.pathname.endsWith("/summary")) return Response.json({ byDay: [], bySymbol: [] });
      return new Response("nope", { status: 404 });
    });
    const source = new HttpLedgerSource("https://ledger.example/", { fetch: fetchImpl });
    expect(source.kind).toBe("http");
    expect(source.label).toBe("ledger.example");

    expect(await source.head("live")).toEqual(head);
    expect((await source.events("live", { since: 10, limit: 5000, symbol: "aapl" })).events).toHaveLength(2);
    expect(await source.verify("live", { from: 1, to: 2 })).toMatchObject({ ok: true, checked: 2 });
    expect((await source.snapshots("live", { from: "2026-09-01" })).snapshots).toHaveLength(1);
    expect(await source.summary("live")).toEqual({ byDay: [], bySymbol: [] });

    expect(calls).toEqual([
      "/v1/ledgers/live/head",
      "/v1/ledgers/live/events?since=10&limit=1000&symbol=AAPL",
      "/v1/ledgers/live/verify?from=1&to=2",
      "/v1/ledgers/live/snapshots?from=2026-09-01",
      "/v1/ledgers/live/summary",
    ]);
  });

  it("memoizes identical requests for a short time and never caches failures", async () => {
    let now = 1_000_000;
    let status = 500;
    const { fetchImpl, calls } = fakeFetch(() => (status === 200 ? Response.json(head) : new Response("boom", { status })));
    const source = new HttpLedgerSource("https://ledger.example", { fetch: fetchImpl, ttlMs: 30_000, now: () => now });

    await expect(source.head("live")).rejects.toMatchObject({ status: 500 });
    status = 200;
    expect(await source.head("live")).toEqual(head);
    expect(await source.head("live")).toEqual(head);
    expect(calls).toHaveLength(2); // failure + one real fetch, second success served from memo
    now += 31_000;
    await source.head("live");
    expect(calls).toHaveLength(3);
  });

  it("rejects responses that violate the contract", async () => {
    const { fetchImpl } = fakeFetch(() => Response.json({ ledgerId: "live", seq: "two" }));
    const source = new HttpLedgerSource("https://ledger.example", { fetch: fetchImpl });
    await expect(source.head("live")).rejects.toThrow(/does not match the contract/);
    await expect(source.head("live")).rejects.toBeInstanceOf(LedgerSourceError);
  });
});

describe("collectEvents", () => {
  function fakeSource(total: number, pageCap = 1000): LedgerSource & { calls: number } {
    const all = Array.from({ length: total }, (_, i) => chained(i + 1));
    const source = {
      kind: "demo" as const,
      label: "fake",
      calls: 0,
      async head() {
        return { ledgerId: "x", seq: total, count: total, headHash: "c".repeat(64), updatedAt: "" };
      },
      async events(_id: string, q: { since?: number; limit?: number; symbol?: string } = {}) {
        source.calls += 1;
        const since = q.since ?? 0;
        const limit = Math.min(q.limit ?? 1000, pageCap);
        const page = all.filter((e) => e.seq > since && (!q.symbol || e.symbol === q.symbol)).slice(0, limit);
        return { events: page, nextSince: page.length ? page[page.length - 1]!.seq : total };
      },
      async snapshots() {
        return { snapshots: [] };
      },
      async verify() {
        return { ok: true, checked: 0, from: 0, to: 0, headHash: "" };
      },
    };
    return source;
  }

  it("walks pages until the head", async () => {
    const source = fakeSource(2500);
    const collected = await collectEvents(source, "x", { maxEvents: 5000 });
    expect(collected.events).toHaveLength(2500);
    expect(collected.truncated).toBe(false);
    expect(collected.pages).toBe(3);
    expect(collected.headSeq).toBe(2500);
    expect(source.calls).toBe(3);
  });

  it("stops at maxEvents and reports the cursor", async () => {
    const collected = await collectEvents(fakeSource(7000), "x", { maxEvents: 5000 });
    expect(collected.events).toHaveLength(5000);
    expect(collected.truncated).toBe(true);
    expect(collected.nextSince).toBe(5000);
    expect(collected.pages).toBe(5);
  });

  it("survives servers that page before filtering", async () => {
    const source = fakeSource(50, 10);
    const collected = await collectEvents(source, "x", { symbol: "AAPL", maxEvents: 5000 });
    expect(collected.events.every((e) => e.symbol === "AAPL")).toBe(true);
    expect(collected.events).toHaveLength(25);
    expect(collected.truncated).toBe(false);
  });
});

describe("computeSummary", () => {
  it("aggregates fills per day and symbol inside the date range", () => {
    const events = [
      chained(1, { ts: "2026-09-01T14:00:00.000Z", symbol: "AAPL", side: "buy", qty: 2, price: 100 }),
      chained(2, { ts: "2026-09-01T15:00:00.000Z", symbol: "AAPL", side: "sell", qty: 1, price: 110 }),
      chained(3, { ts: "2026-09-02T14:00:00.000Z", symbol: "SPY", side: "buy", qty: 3, price: 600 }),
      chained(4, { ts: "2026-09-02T14:30:00.000Z", type: "note", symbol: undefined, side: undefined, qty: undefined, price: undefined }),
    ];
    expect(computeSummary(events)).toEqual({
      byDay: [
        { date: "2026-09-01", fills: 2, buyQty: 2, sellQty: 1, notional: 310 },
        { date: "2026-09-02", fills: 1, buyQty: 3, sellQty: 0, notional: 1800 },
      ],
      bySymbol: [
        { symbol: "AAPL", fills: 2, buyQty: 2, sellQty: 1, notional: 310 },
        { symbol: "SPY", fills: 1, buyQty: 3, sellQty: 0, notional: 1800 },
      ],
    });
    expect(computeSummary(events, { from: "2026-09-02" }).bySymbol.map((s) => s.symbol)).toEqual(["SPY"]);
    expect(computeSummary(events, { to: "2026-09-01" }).byDay).toHaveLength(1);
  });
});
