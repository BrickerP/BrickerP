import type { Deps, FillInfo } from "../types.js";
import { fetchJson, SourceError } from "./http.js";

/** Shape of the open-ledger public API (projects/open-ledger). */
interface LedgerHead {
  ledgerId: string;
  seq: number;
  count: number;
  headHash: string;
  updatedAt: string;
}

interface ChainedEvent {
  id: string;
  ts: string;
  type: string;
  symbol?: string;
  side?: "buy" | "sell";
  qty?: number;
  price?: number;
  seq: number;
  hash: string;
}

interface EventsPage {
  events: ChainedEvent[];
  nextSince?: number;
}

const LOOKBACK = 25;

export async function fetchLatestFill(deps: Deps, baseUrl: string, ledgerId: string): Promise<FillInfo> {
  const id = encodeURIComponent(ledgerId);
  const head = await fetchJson<LedgerHead>(deps, `${baseUrl}/v1/ledgers/${id}/head`);
  if (typeof head.seq !== "number") throw new SourceError("bad head");
  if (head.seq <= 0 || head.count === 0) throw new SourceError("empty ledger");

  const since = Math.max(0, head.seq - LOOKBACK);
  const page = await fetchJson<EventsPage>(deps, `${baseUrl}/v1/ledgers/${id}/events?since=${since}&limit=${LOOKBACK + 1}`);
  const events = Array.isArray(page.events) ? page.events : [];
  if (events.length === 0) throw new SourceError("no events");

  // Prefer the newest fill; fall back to the newest event of any type.
  const newestFirst = [...events].sort((a, b) => b.seq - a.seq);
  const pick = newestFirst.find((e) => e.type === "fill") ?? newestFirst[0];
  if (!pick) throw new SourceError("no events");

  return {
    ledgerId: head.ledgerId ?? ledgerId,
    seq: head.seq,
    count: head.count,
    headHash: head.headHash,
    type: pick.type,
    symbol: pick.symbol ?? null,
    side: pick.side === "buy" || pick.side === "sell" ? pick.side : null,
    qty: typeof pick.qty === "number" ? pick.qty : null,
    price: typeof pick.price === "number" ? pick.price : null,
    ts: pick.ts,
  };
}
