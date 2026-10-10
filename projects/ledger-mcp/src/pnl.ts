/**
 * Realized PnL by FIFO lot matching over fills.
 *
 * - Long lots are opened by buys and closed by later sells (oldest lot first).
 * - Short lots are opened by sells with no long inventory and closed by later buys (cover).
 * - A fill larger than the open inventory closes everything and opens a lot on the other
 *   side with the remainder (a "flip").
 * - Fees, commissions, borrow costs and dividends are ignored: this is gross trading PnL.
 */
import type { LedgerEvent } from "./ledger/types";
import { isFill, roundTo } from "./summary";

export interface OpenLot {
  side: "long" | "short";
  qty: number;
  price: number;
  ts: string;
}

export interface SymbolPnl {
  symbol: string;
  fills: number;
  buyQty: number;
  sellQty: number;
  /** Quantity matched against an opposite-side lot (both legs count once). */
  closedQty: number;
  realizedPnl: number;
  /** Signed open position: > 0 long, < 0 short. */
  netPosition: number;
  openLots: OpenLot[];
  /** Volume-weighted price of the open lots, or null when flat. */
  avgOpenPrice: number | null;
  firstTs: string | null;
  lastTs: string | null;
}

export interface PnlReport {
  method: "fifo";
  feesIncluded: false;
  fills: number;
  closedQty: number;
  realizedPnl: number;
  symbols: SymbolPnl[];
}

interface Book {
  lots: OpenLot[];
  stats: SymbolPnl;
}

const EPS = 1e-9;

/** Match `qty` against FIFO lots of `side`; returns [unmatched remainder, realized PnL]. */
function consume(lots: OpenLot[], side: "long" | "short", qty: number, price: number): [number, number] {
  let remaining = qty;
  let realized = 0;
  while (remaining > EPS && lots.length > 0 && lots[0]!.side === side) {
    const lot = lots[0]!;
    const matched = Math.min(lot.qty, remaining);
    realized += side === "long" ? (price - lot.price) * matched : (lot.price - price) * matched;
    lot.qty -= matched;
    remaining -= matched;
    if (lot.qty <= EPS) lots.shift();
  }
  return [remaining, realized];
}

export function computeFifoPnl(events: readonly LedgerEvent[], symbolFilter?: string): PnlReport {
  const wanted = symbolFilter?.toUpperCase();
  const books = new Map<string, Book>();

  for (const event of events) {
    if (!isFill(event)) continue;
    const symbol = event.symbol.toUpperCase();
    if (wanted && symbol !== wanted) continue;
    let book = books.get(symbol);
    if (!book) {
      book = {
        lots: [],
        stats: { symbol, fills: 0, buyQty: 0, sellQty: 0, closedQty: 0, realizedPnl: 0, netPosition: 0, openLots: [], avgOpenPrice: null, firstTs: event.ts, lastTs: event.ts },
      };
      books.set(symbol, book);
    }
    const { stats, lots } = book;
    stats.fills += 1;
    stats.lastTs = event.ts;
    if (event.side === "buy") {
      stats.buyQty += event.qty;
      const [remaining, realized] = consume(lots, "short", event.qty, event.price);
      stats.realizedPnl += realized;
      stats.closedQty += event.qty - remaining;
      if (remaining > EPS) lots.push({ side: "long", qty: remaining, price: event.price, ts: event.ts });
    } else {
      stats.sellQty += event.qty;
      const [remaining, realized] = consume(lots, "long", event.qty, event.price);
      stats.realizedPnl += realized;
      stats.closedQty += event.qty - remaining;
      if (remaining > EPS) lots.push({ side: "short", qty: remaining, price: event.price, ts: event.ts });
    }
  }

  const symbols: SymbolPnl[] = [];
  let fills = 0;
  let closedQty = 0;
  let realizedPnl = 0;
  for (const { lots, stats } of books.values()) {
    const openQty = lots.reduce((sum, lot) => sum + lot.qty, 0);
    const sign = lots[0]?.side === "short" ? -1 : 1;
    stats.netPosition = roundTo(sign * openQty, 6);
    stats.openLots = lots.map((lot) => ({ ...lot, qty: roundTo(lot.qty, 6) }));
    stats.avgOpenPrice = openQty > EPS ? roundTo(lots.reduce((sum, lot) => sum + lot.qty * lot.price, 0) / openQty, 4) : null;
    stats.realizedPnl = roundTo(stats.realizedPnl, 4);
    stats.closedQty = roundTo(stats.closedQty, 6);
    stats.buyQty = roundTo(stats.buyQty, 6);
    stats.sellQty = roundTo(stats.sellQty, 6);
    fills += stats.fills;
    closedQty += stats.closedQty;
    realizedPnl += stats.realizedPnl;
    symbols.push(stats);
  }
  symbols.sort((a, b) => a.symbol.localeCompare(b.symbol));
  return { method: "fifo", feesIncluded: false, fills, closedQty: roundTo(closedQty, 6), realizedPnl: roundTo(realizedPnl, 4), symbols };
}
