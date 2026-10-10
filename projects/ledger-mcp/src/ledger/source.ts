import { LIMITS } from "../env";
import type {
  ChainedEvent,
  DateRange,
  EventsPage,
  EventsQuery,
  LedgerHead,
  LedgerSummary,
  SeqRange,
  Snapshot,
  VerifyResult,
} from "./types";

/** Pluggable backend: the open-ledger HTTP API or the built-in demo dataset. */
export interface LedgerSource {
  readonly kind: "http" | "demo";
  /** Human-readable origin, shown in tool output (never includes secrets). */
  readonly label: string;
  head(ledgerId: string): Promise<LedgerHead>;
  events(ledgerId: string, query?: EventsQuery): Promise<EventsPage>;
  snapshots(ledgerId: string, range?: DateRange): Promise<{ snapshots: Snapshot[] }>;
  verify(ledgerId: string, range?: SeqRange): Promise<VerifyResult>;
  /** Optional: the HTTP API exposes a precomputed summary; the demo source computes locally. */
  summary?(ledgerId: string): Promise<LedgerSummary>;
}

export class LedgerSourceError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "LedgerSourceError";
  }
}

export function clampLimit(limit: number | undefined, max: number = LIMITS.eventsPerCall): number {
  if (limit === undefined || !Number.isFinite(limit)) return max;
  return Math.min(max, Math.max(1, Math.floor(limit)));
}

export interface CollectedEvents {
  events: ChainedEvent[];
  /** Cursor to continue from if `truncated`. */
  nextSince: number;
  /** True when `maxEvents` was reached before the ledger head. */
  truncated: boolean;
  pages: number;
  headSeq: number;
}

/**
 * Walk `events` pages in order until the ledger head (as of the first call) or `maxEvents`.
 * Stops on a non-advancing cursor to survive sources that apply the symbol filter after
 * paging, and never issues more than ceil(maxEvents / pageSize) + 1 subrequests.
 */
export async function collectEvents(
  source: LedgerSource,
  ledgerId: string,
  options: { since?: number; symbol?: string; maxEvents?: number; pageSize?: number } = {},
): Promise<CollectedEvents> {
  const maxEvents = options.maxEvents ?? LIMITS.pnlEvents;
  const pageSize = clampLimit(options.pageSize);
  const head = await source.head(ledgerId);
  const events: ChainedEvent[] = [];
  let since = options.since ?? 0;
  let pages = 0;
  const maxPages = Math.ceil(maxEvents / pageSize) + 1;

  while (since < head.seq && events.length < maxEvents && pages < maxPages) {
    const page = await source.events(ledgerId, {
      since,
      limit: Math.min(pageSize, maxEvents - events.length),
      symbol: options.symbol,
    });
    pages += 1;
    events.push(...page.events);
    if (page.nextSince <= since) break;
    since = page.nextSince;
  }
  const truncated = since < head.seq && events.length >= maxEvents;
  return { events, nextSince: since, truncated, pages, headSeq: head.seq };
}
