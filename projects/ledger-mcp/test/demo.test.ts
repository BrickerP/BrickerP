import { describe, expect, it } from "vitest";
import { DEMO_END, DEMO_LEDGER_ID, DEMO_START, DEMO_SYMBOLS, chainEvents, generateDemoEvents, getDemoChain, tradingDays } from "../src/demo/fixtures";
import { DemoLedgerSource } from "../src/demo/source";
import { GENESIS_HASH, verifyChain } from "../src/ledger/hash";
import { LedgerSourceError } from "../src/ledger/source";
import { computeFifoPnl } from "../src/pnl";

/**
 * Pinned identity of the demo fixture. Changing the generator (seed, state machine, price
 * model) changes every hash; update this constant deliberately when that happens.
 */
const PINNED_HEAD_HASH = "bdec9ebc6f127e13ed13f4cb0188be219cd80a85eaa5c9a349c86ed9a19cba55";
const PINNED_COUNT = 242;

describe("demo fixtures", () => {
  it("are deterministic", () => {
    expect(generateDemoEvents()).toEqual(generateDemoEvents());
    expect(generateDemoEvents(1)).not.toEqual(generateDemoEvents(2));
  });

  it("look like a realistic bracket-order ledger", () => {
    const events = generateDemoEvents();
    const fills = events.filter((e) => e.type === "fill");
    expect(fills.length).toBeGreaterThanOrEqual(150);
    expect(fills.length).toBeLessThanOrEqual(260);
    expect(new Set(fills.map((e) => e.symbol))).toEqual(new Set(DEMO_SYMBOLS));
    expect(events.some((e) => e.type === "order")).toBe(true);
    expect(events.some((e) => e.type === "cancel")).toBe(true);
    expect(events.some((e) => e.type === "note")).toBe(true);

    const days = new Set(tradingDays(DEMO_START, DEMO_END));
    for (const [index, event] of events.entries()) {
      expect(event.id).toBe(`evt-${String(index + 1).padStart(6, "0")}`);
      expect(days.has(event.ts.slice(0, 10))).toBe(true);
      if (index > 0) expect(event.ts >= events[index - 1]!.ts).toBe(true);
      if (event.type === "fill") {
        expect(event.qty).toBeGreaterThan(0);
        expect(Number.isInteger(event.qty)).toBe(true);
        expect(event.price).toBeGreaterThan(0);
        expect(event.orderId).toMatch(/^ord-\d{6}$/);
        expect(event.meta).toMatchObject({ strategy: "bracket" });
      }
    }
    // Trading days only: no weekends, Labor Day excluded.
    expect(days.has("2026-09-07")).toBe(false);
    expect(days.has("2026-09-05")).toBe(false);
  });

  it("produce non-trivial FIFO PnL (longs, shorts, flips)", () => {
    const events = generateDemoEvents();
    const report = computeFifoPnl(events);
    expect(report.symbols).toHaveLength(DEMO_SYMBOLS.length);
    expect(report.closedQty).toBeGreaterThan(0);
    expect(report.symbols.some((s) => s.realizedPnl > 0)).toBe(true);
    expect(report.symbols.some((s) => s.realizedPnl < 0)).toBe(true);
    const legs = new Set(events.filter((e) => e.type === "fill").map((e) => (e.meta as { leg: string }).leg));
    expect(legs).toContain("cover");
    expect(legs).toContain("flip");
    expect(legs).toContain("take_profit");
  });

  it("chain into a valid hash chain with a pinned head", async () => {
    const chain = await getDemoChain();
    expect(chain).toHaveLength(PINNED_COUNT);
    expect(chain[0]).toMatchObject({ seq: 1, prevHash: GENESIS_HASH });
    expect(chain[chain.length - 1]!.hash).toBe(PINNED_HEAD_HASH);
    expect(await verifyChain(chain, { firstSeq: 1 })).toMatchObject({ ok: true, checked: PINNED_COUNT, headHash: PINNED_HEAD_HASH });
    // Independent re-chaining yields the same hashes.
    const again = await chainEvents(generateDemoEvents());
    expect(again.map((e) => e.hash)).toEqual(chain.map((e) => e.hash));
  });
});

describe("DemoLedgerSource", () => {
  const source = new DemoLedgerSource();

  it("serves the head and rejects unknown ledgers", async () => {
    const head = await source.head(DEMO_LEDGER_ID);
    expect(head).toMatchObject({ ledgerId: "demo", seq: PINNED_COUNT, count: PINNED_COUNT, headHash: PINNED_HEAD_HASH });
    expect(head.updatedAt.startsWith(DEMO_END)).toBe(true);
    await expect(source.head("other")).rejects.toBeInstanceOf(LedgerSourceError);
    await expect(source.head("other")).rejects.toMatchObject({ status: 404 });
  });

  it("pages events with the since/nextSince contract", async () => {
    const first = await source.events(DEMO_LEDGER_ID, { limit: 100 });
    expect(first.events).toHaveLength(100);
    expect(first.events[0]!.seq).toBe(1);
    expect(first.nextSince).toBe(100);
    const second = await source.events(DEMO_LEDGER_ID, { since: first.nextSince, limit: 100 });
    expect(second.events[0]!.seq).toBe(101);
    const last = await source.events(DEMO_LEDGER_ID, { since: 200 });
    expect(last.events).toHaveLength(PINNED_COUNT - 200);
    expect(last.nextSince).toBe(PINNED_COUNT);
    const empty = await source.events(DEMO_LEDGER_ID, { since: PINNED_COUNT });
    expect(empty).toEqual({ events: [], nextSince: PINNED_COUNT });
    // limit is clamped to 1..1000
    expect((await source.events(DEMO_LEDGER_ID, { limit: 0 })).events).toHaveLength(1);
  });

  it("filters by symbol case-insensitively", async () => {
    const page = await source.events(DEMO_LEDGER_ID, { symbol: "aapl" });
    expect(page.events.length).toBeGreaterThan(0);
    expect(page.events.every((e) => e.symbol === "AAPL")).toBe(true);
    expect(page.nextSince).toBe(PINNED_COUNT);
  });

  it("exposes daily snapshots, verify and summary", async () => {
    const { snapshots } = await source.snapshots(DEMO_LEDGER_ID, { from: "2026-10-01", to: "2026-10-09" });
    expect(snapshots.map((s) => s.date)).toEqual(tradingDays("2026-10-01", "2026-10-09"));
    expect(snapshots[snapshots.length - 1]).toMatchObject({ seq: PINNED_COUNT, count: PINNED_COUNT, headHash: PINNED_HEAD_HASH });

    expect(await source.verify(DEMO_LEDGER_ID, { from: 10, to: 20 })).toMatchObject({ ok: true, checked: 11, from: 10, to: 20 });
    expect(await source.verify(DEMO_LEDGER_ID)).toMatchObject({ ok: true, checked: PINNED_COUNT, headHash: PINNED_HEAD_HASH });

    const summary = await source.summary(DEMO_LEDGER_ID);
    expect(summary.bySymbol.map((s) => s.symbol)).toEqual([...DEMO_SYMBOLS].sort());
    expect(summary.byDay.length).toBe(tradingDays(DEMO_START, DEMO_END).length);
    const totalFills = summary.bySymbol.reduce((n, s) => n + s.fills, 0);
    expect(totalFills).toBe(summary.byDay.reduce((n, d) => n + d.fills, 0));
  });
});
