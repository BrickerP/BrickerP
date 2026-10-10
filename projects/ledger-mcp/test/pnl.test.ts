import { describe, expect, it } from "vitest";
import type { LedgerEvent } from "../src/ledger/types";
import { computeFifoPnl } from "../src/pnl";

let counter = 0;
function fill(symbol: string, side: "buy" | "sell", qty: number, price: number): LedgerEvent {
  counter += 1;
  return { id: `f${counter}`, ts: `2026-09-01T13:${String(30 + counter).padStart(2, "0")}:00.000Z`, type: "fill", symbol, side, qty, price };
}

describe("computeFifoPnl", () => {
  it("closes a simple round trip", () => {
    const report = computeFifoPnl([fill("AAPL", "buy", 10, 100), fill("AAPL", "sell", 10, 110)]);
    expect(report).toMatchObject({ method: "fifo", feesIncluded: false, fills: 2, closedQty: 10, realizedPnl: 100 });
    expect(report.symbols[0]).toMatchObject({ symbol: "AAPL", netPosition: 0, openLots: [], avgOpenPrice: null, buyQty: 10, sellQty: 10 });
  });

  it("matches partial lots oldest-first and keeps the remainder open", () => {
    // Lots: 10 @100, 10 @120. Sell 15 @130 → 10×30 + 5×10 = 350. Open: 5 @120.
    const report = computeFifoPnl([fill("MSFT", "buy", 10, 100), fill("MSFT", "buy", 10, 120), fill("MSFT", "sell", 15, 130)]);
    expect(report.realizedPnl).toBe(350);
    expect(report.closedQty).toBe(15);
    const msft = report.symbols[0]!;
    expect(msft.netPosition).toBe(5);
    expect(msft.openLots).toEqual([{ side: "long", qty: 5, price: 120, ts: msft.openLots[0]!.ts }]);
    expect(msft.avgOpenPrice).toBe(120);
  });

  it("keeps symbols independent and sorts them", () => {
    const report = computeFifoPnl([
      fill("SPY", "buy", 2, 600),
      fill("AAPL", "buy", 1, 200),
      fill("SPY", "sell", 2, 590), // -20
      fill("AAPL", "sell", 1, 210), // +10
    ]);
    expect(report.symbols.map((s) => s.symbol)).toEqual(["AAPL", "SPY"]);
    expect(report.symbols.map((s) => s.realizedPnl)).toEqual([10, -20]);
    expect(report.realizedPnl).toBe(-10);
  });

  it("handles short → cover, including partial covers", () => {
    // Short 20 @50, cover 5 @55 (−25), cover 15 @40 (+150) → +125.
    const report = computeFifoPnl([fill("NVDA", "sell", 20, 50), fill("NVDA", "buy", 5, 55)]);
    expect(report.realizedPnl).toBe(-25);
    expect(report.symbols[0]).toMatchObject({ netPosition: -15, avgOpenPrice: 50 });
    expect(report.symbols[0]!.openLots).toMatchObject([{ side: "short", qty: 15, price: 50 }]);

    const closed = computeFifoPnl([fill("NVDA", "sell", 20, 50), fill("NVDA", "buy", 5, 55), fill("NVDA", "buy", 15, 40)]);
    expect(closed.realizedPnl).toBe(125);
    expect(closed.symbols[0]).toMatchObject({ netPosition: 0, closedQty: 20 });
  });

  it("flips from long to short when a sell exceeds the open inventory", () => {
    // Long 10 @100, sell 15 @110 → +100 realized, short 5 @110 open. Cover 5 @100 → +50.
    const flipped = computeFifoPnl([fill("AAPL", "buy", 10, 100), fill("AAPL", "sell", 15, 110)]);
    expect(flipped.realizedPnl).toBe(100);
    expect(flipped.symbols[0]).toMatchObject({ netPosition: -5, avgOpenPrice: 110 });
    const covered = computeFifoPnl([fill("AAPL", "buy", 10, 100), fill("AAPL", "sell", 15, 110), fill("AAPL", "buy", 5, 100)]);
    expect(covered.realizedPnl).toBe(150);
    expect(covered.symbols[0]!.netPosition).toBe(0);
  });

  it("ignores non-fill events and honours the symbol filter", () => {
    const events: LedgerEvent[] = [
      { id: "n1", ts: "2026-09-01T13:30:00.000Z", type: "note", meta: { kind: "session_open" } },
      fill("AAPL", "buy", 1, 100),
      { id: "o1", ts: "2026-09-01T13:40:00.000Z", type: "order", symbol: "AAPL", side: "buy", qty: 99, price: 1 },
      fill("AAPL", "sell", 1, 101),
      fill("SPY", "buy", 1, 600),
    ];
    const all = computeFifoPnl(events);
    expect(all.fills).toBe(3);
    expect(all.realizedPnl).toBe(1);
    const spy = computeFifoPnl(events, "spy");
    expect(spy.symbols.map((s) => s.symbol)).toEqual(["SPY"]);
    expect(spy.fills).toBe(1);
    expect(spy.realizedPnl).toBe(0);
  });

  it("rounds away float noise", () => {
    const report = computeFifoPnl([fill("AAPL", "buy", 3, 0.1), fill("AAPL", "sell", 3, 0.3)]);
    expect(report.realizedPnl).toBe(0.6);
  });
});
