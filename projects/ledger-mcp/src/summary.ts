import type { DateRange, LedgerEvent, LedgerSummary } from "./ledger/types";

/** Compares YYYY-MM-DD strings lexicographically; `undefined` bounds are open. */
export function inDateRange(date: string, range: DateRange | undefined): boolean {
  if (!range) return true;
  if (range.from && date < range.from) return false;
  if (range.to && date > range.to) return false;
  return true;
}

export function eventDate(event: Pick<LedgerEvent, "ts">): string {
  return event.ts.slice(0, 10);
}

export function isFill(event: LedgerEvent): event is LedgerEvent & { symbol: string; side: "buy" | "sell"; qty: number; price: number } {
  return event.type === "fill" && typeof event.symbol === "string" && (event.side === "buy" || event.side === "sell") && typeof event.qty === "number" && typeof event.price === "number";
}

export function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

interface Bucket {
  fills: number;
  buyQty: number;
  sellQty: number;
  notional: number;
}

function bump(map: Map<string, Bucket>, key: string, side: "buy" | "sell", qty: number, price: number) {
  const bucket = map.get(key) ?? { fills: 0, buyQty: 0, sellQty: 0, notional: 0 };
  bucket.fills += 1;
  if (side === "buy") bucket.buyQty += qty;
  else bucket.sellQty += qty;
  bucket.notional += qty * price;
  map.set(key, bucket);
}

/** Same shape as the open-ledger `/summary` endpoint, computed from fills only. */
export function computeSummary(events: readonly LedgerEvent[], range?: DateRange): LedgerSummary {
  const byDay = new Map<string, Bucket>();
  const bySymbol = new Map<string, Bucket>();
  for (const event of events) {
    if (!isFill(event)) continue;
    const date = eventDate(event);
    if (!inDateRange(date, range)) continue;
    bump(byDay, date, event.side, event.qty, event.price);
    bump(bySymbol, event.symbol.toUpperCase(), event.side, event.qty, event.price);
  }
  const finish = (bucket: Bucket) => ({
    fills: bucket.fills,
    buyQty: roundTo(bucket.buyQty, 6),
    sellQty: roundTo(bucket.sellQty, 6),
    notional: roundTo(bucket.notional, 2),
  });
  return {
    byDay: [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, bucket]) => ({ date, ...finish(bucket) })),
    bySymbol: [...bySymbol.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([symbol, bucket]) => ({ symbol, ...finish(bucket) })),
  };
}
