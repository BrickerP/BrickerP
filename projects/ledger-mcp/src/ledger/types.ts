/**
 * open-ledger public HTTP contract (mirrored exactly; owned by projects/open-ledger).
 *
 *   GET /v1/ledgers/:ledgerId/head      → LedgerHead
 *   GET /v1/ledgers/:ledgerId/events    ?since=<seq>&limit=<n ≤ 1000>&symbol=<sym> → EventsPage
 *   GET /v1/ledgers/:ledgerId/snapshots ?from=YYYY-MM-DD&to=YYYY-MM-DD → { snapshots }
 *   GET /v1/ledgers/:ledgerId/verify    ?from=<seq>&to=<seq> → VerifyResult
 *   GET /v1/ledgers/:ledgerId/summary   → LedgerSummary
 *
 * The zod schemas double as runtime validation for upstream responses.
 */
import { z } from "zod";

export const EVENT_TYPES = ["fill", "order", "cancel", "note"] as const;
export const SIDES = ["buy", "sell"] as const;

export const LedgerEventSchema = z.object({
  id: z.string(),
  /** ISO-8601 UTC timestamp. */
  ts: z.string(),
  type: z.enum(EVENT_TYPES),
  symbol: z.string().optional(),
  side: z.enum(SIDES).optional(),
  qty: z.number().optional(),
  price: z.number().optional(),
  orderId: z.string().optional(),
  broker: z.string().optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
});
export type LedgerEvent = z.infer<typeof LedgerEventSchema>;

export const ChainedEventSchema = LedgerEventSchema.extend({
  seq: z.number().int(),
  prevHash: z.string().length(64),
  hash: z.string().length(64),
});
export type ChainedEvent = z.infer<typeof ChainedEventSchema>;

export const LedgerHeadSchema = z.object({
  ledgerId: z.string(),
  seq: z.number().int(),
  count: z.number().int(),
  headHash: z.string(),
  updatedAt: z.string(),
});
export type LedgerHead = z.infer<typeof LedgerHeadSchema>;

export const EventsPageSchema = z.object({
  events: z.array(ChainedEventSchema),
  nextSince: z.number().int(),
});
export type EventsPage = z.infer<typeof EventsPageSchema>;

export const SnapshotSchema = z.object({
  date: z.string(),
  seq: z.number().int(),
  count: z.number().int(),
  headHash: z.string(),
});
export type Snapshot = z.infer<typeof SnapshotSchema>;

export const SnapshotsResponseSchema = z.object({ snapshots: z.array(SnapshotSchema) });

export const VerifyResultSchema = z.object({
  ok: z.boolean(),
  checked: z.number().int(),
  from: z.number().int(),
  to: z.number().int(),
  headHash: z.string(),
});
export type VerifyResult = z.infer<typeof VerifyResultSchema>;

export const DaySummarySchema = z.object({
  date: z.string(),
  fills: z.number(),
  buyQty: z.number(),
  sellQty: z.number(),
  notional: z.number(),
});
export type DaySummary = z.infer<typeof DaySummarySchema>;

export const SymbolSummarySchema = z.object({
  symbol: z.string(),
  fills: z.number(),
  buyQty: z.number(),
  sellQty: z.number(),
  notional: z.number(),
});
export type SymbolSummary = z.infer<typeof SymbolSummarySchema>;

export const LedgerSummarySchema = z.object({
  byDay: z.array(DaySummarySchema),
  bySymbol: z.array(SymbolSummarySchema),
});
export type LedgerSummary = z.infer<typeof LedgerSummarySchema>;

export interface EventsQuery {
  /** Return events with `seq > since`. Omit (or 0) to start from the beginning. */
  since?: number;
  /** Page size, clamped to 1..1000 by sources. */
  limit?: number;
  /** Case-insensitive symbol filter. */
  symbol?: string;
}

export interface DateRange {
  /** YYYY-MM-DD inclusive. */
  from?: string;
  to?: string;
}

export interface SeqRange {
  from?: number;
  to?: number;
}
