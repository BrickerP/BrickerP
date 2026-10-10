import { verifyChain } from "../ledger/hash";
import { LedgerSourceError, clampLimit, type LedgerSource } from "../ledger/source";
import type { ChainedEvent, DateRange, EventsQuery, LedgerHead, LedgerSummary, SeqRange, Snapshot, VerifyResult } from "../ledger/types";
import { computeSummary, eventDate, inDateRange } from "../summary";
import { DEMO_LEDGER_ID, getDemoChain } from "./fixtures";

/** Serves the deterministic demo chain with the exact semantics of the HTTP contract. */
export class DemoLedgerSource implements LedgerSource {
  readonly kind = "demo" as const;
  readonly label = "built-in demo dataset";

  constructor(private readonly chain: () => Promise<ChainedEvent[]> = getDemoChain) {}

  private async load(ledgerId: string): Promise<ChainedEvent[]> {
    if (ledgerId !== DEMO_LEDGER_ID) {
      throw new LedgerSourceError(`unknown ledger "${ledgerId}": demo mode only serves ledgerId "${DEMO_LEDGER_ID}" (set LEDGER_BASE_URL to query a real open-ledger)`, 404);
    }
    return this.chain();
  }

  async head(ledgerId: string): Promise<LedgerHead> {
    const chain = await this.load(ledgerId);
    const last = chain[chain.length - 1];
    return {
      ledgerId,
      seq: last?.seq ?? 0,
      count: chain.length,
      headHash: last?.hash ?? "0".repeat(64),
      updatedAt: last?.ts ?? new Date(0).toISOString(),
    };
  }

  async events(ledgerId: string, query: EventsQuery = {}) {
    const chain = await this.load(ledgerId);
    const since = query.since ?? 0;
    const limit = clampLimit(query.limit);
    const symbol = query.symbol?.toUpperCase();
    const matching = chain.filter((event) => event.seq > since && (!symbol || event.symbol?.toUpperCase() === symbol));
    const events = matching.slice(0, limit);
    const headSeq = chain[chain.length - 1]?.seq ?? 0;
    // Exhausted filter → jump the cursor to the head so callers stop paging.
    const nextSince = events.length === 0 ? Math.max(since, headSeq) : events.length < matching.length ? events[events.length - 1]!.seq : headSeq;
    return { events, nextSince };
  }

  async snapshots(ledgerId: string, range: DateRange = {}): Promise<{ snapshots: Snapshot[] }> {
    const chain = await this.load(ledgerId);
    const byDate = new Map<string, Snapshot>();
    for (const [index, event] of chain.entries()) {
      const date = eventDate(event);
      if (!inDateRange(date, range)) continue;
      byDate.set(date, { date, seq: event.seq, count: index + 1, headHash: event.hash });
    }
    return { snapshots: [...byDate.values()] };
  }

  async verify(ledgerId: string, range: SeqRange = {}): Promise<VerifyResult> {
    const chain = await this.load(ledgerId);
    const firstSeq = chain[0]?.seq ?? 1;
    const lastSeq = chain[chain.length - 1]?.seq ?? 0;
    const from = Math.max(firstSeq, range.from ?? firstSeq);
    const to = Math.min(lastSeq, range.to ?? lastSeq);
    const slice = chain.filter((event) => event.seq >= from && event.seq <= to);
    const check = await verifyChain(slice, { firstSeq });
    return { ok: check.ok, checked: check.checked, from, to, headHash: check.headHash };
  }

  async summary(ledgerId: string): Promise<LedgerSummary> {
    return computeSummary(await this.load(ledgerId));
  }
}
