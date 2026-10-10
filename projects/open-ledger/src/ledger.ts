import { DurableObject } from "cloudflare:workers";
import { GENESIS_HASH, canonicalJSON, computeHash } from "./chain";
import type { ChainedEvent, LedgerEvent } from "./schema";

/** Maximum chain segment recomputed by one `verify` call (keeps CPU well under budget). */
export const MAX_VERIFY_RANGE = 2000;
export const DEFAULT_VERIFY_RANGE = 1000;
export const MAX_LIST_LIMIT = 1000;
const EXPORT_PAGE_SIZE = 500;
const ID_LOOKUP_CHUNK = 100;

export interface HeadInfo {
  seq: number;
  count: number;
  headHash: string;
  updatedAt: string | null;
}

export interface AppendResult {
  accepted: number;
  duplicates: number;
  seq: number;
  headHash: string;
}

export interface ListOptions {
  since: number;
  limit: number;
  symbol?: string;
}

export interface ListResult {
  events: ChainedEvent[];
  nextSince: number;
}

export interface SnapshotRow {
  date: string;
  seq: number;
  count: number;
  headHash: string;
}

export interface VerifyResult {
  ok: boolean;
  checked: number;
  from: number;
  to: number;
  headSeq: number;
  headHash: string;
  /** Hash of the last verified row (equals headHash once the whole chain is covered). */
  lastHash: string | null;
  firstBadSeq?: number;
  reason?: string;
}

export interface DaySummary {
  date: string;
  fills: number;
  buyQty: number;
  sellQty: number;
  notional: number;
}

export interface SymbolSummary {
  symbol: string;
  fills: number;
  buyQty: number;
  sellQty: number;
  notional: number;
}

export interface SummaryResult {
  byDay: DaySummary[];
  bySymbol: SymbolSummary[];
}

interface EventRow extends Record<string, SqlStorageValue> {
  seq: number;
  id: string;
  ts: string;
  type: string;
  symbol: string | null;
  side: string | null;
  qty: number | null;
  price: number | null;
  order_id: string | null;
  broker: string | null;
  meta_json: string | null;
  prev_hash: string;
  hash: string;
  inserted_at: string;
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS events (
  seq         INTEGER PRIMARY KEY,
  id          TEXT NOT NULL UNIQUE,
  ts          TEXT NOT NULL,
  type        TEXT NOT NULL,
  symbol      TEXT,
  side        TEXT,
  qty         REAL,
  price       REAL,
  order_id    TEXT,
  broker      TEXT,
  meta_json   TEXT,
  prev_hash   TEXT NOT NULL,
  hash        TEXT NOT NULL,
  inserted_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_symbol_seq ON events(symbol, seq);
CREATE TABLE IF NOT EXISTS snapshots (
  date      TEXT PRIMARY KEY,
  seq       INTEGER NOT NULL,
  count     INTEGER NOT NULL,
  head_hash TEXT NOT NULL
);
`;

const INSERT_EVENT_SQL = `INSERT INTO events
  (seq, id, ts, type, symbol, side, qty, price, order_id, broker, meta_json, prev_hash, hash, inserted_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

// One row per UTC day on which an append was committed: "head of the ledger as of the
// last append on that day". Upserted inside the same transaction as the events, so it can
// never disagree with the chain. No alarms needed.
const UPSERT_SNAPSHOT_SQL = `INSERT INTO snapshots (date, seq, count, head_hash) VALUES (?, ?, ?, ?)
  ON CONFLICT(date) DO UPDATE SET seq = excluded.seq, count = excluded.count, head_hash = excluded.head_hash`;

const EVENT_COLUMNS =
  "seq, id, ts, type, symbol, side, qty, price, order_id, broker, meta_json, prev_hash, hash, inserted_at";

export function rowToEvent(row: EventRow): LedgerEvent {
  const event: LedgerEvent = { id: row.id, ts: row.ts, type: row.type as LedgerEvent["type"] };
  if (row.symbol !== null) event.symbol = row.symbol;
  if (row.side !== null) event.side = row.side as LedgerEvent["side"];
  if (row.qty !== null) event.qty = row.qty;
  if (row.price !== null) event.price = row.price;
  if (row.order_id !== null) event.orderId = row.order_id;
  if (row.broker !== null) event.broker = row.broker;
  if (row.meta_json !== null) event.meta = JSON.parse(row.meta_json) as Record<string, unknown>;
  return event;
}

export function rowToChained(row: EventRow): ChainedEvent {
  return { seq: row.seq, ...rowToEvent(row), prevHash: row.prev_hash, hash: row.hash };
}

/**
 * One Durable Object instance per ledger id. All state lives in the object's SQLite
 * database; the hash chain makes the stored history tamper-evident.
 */
export class Ledger extends DurableObject<Env> {
  private readonly sql: SqlStorage;
  private schemaReady = false;
  // Appends are serialised through this promise chain so the head hash read at the start
  // of a batch is still the head when the batch commits (hashing awaits WebCrypto, during
  // which other requests could otherwise be delivered to the object).
  private writeChain: Promise<unknown> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
  }

  // ---------------------------------------------------------------- writes

  async append(events: LedgerEvent[]): Promise<AppendResult> {
    const run = () => this.appendNow(events);
    const result = this.writeChain.then(run, run);
    this.writeChain = result.catch(() => undefined);
    return result;
  }

  private async appendNow(events: LedgerEvent[]): Promise<AppendResult> {
    this.ensureSchema();
    const head = this.readHead();
    const seen = this.findExistingIds(events.map((e) => e.id));

    let prevHash = head.headHash;
    let seq = head.seq;
    let duplicates = 0;
    const pending: Array<{ seq: number; event: LedgerEvent; prevHash: string; hash: string }> = [];

    for (const event of events) {
      if (seen.has(event.id)) {
        duplicates += 1;
        continue;
      }
      seen.add(event.id);
      const hash = await computeHash(prevHash, event);
      seq += 1;
      pending.push({ seq, event, prevHash, hash });
      prevHash = hash;
    }

    if (pending.length > 0) {
      const insertedAt = new Date().toISOString();
      const date = insertedAt.slice(0, 10);
      const count = head.count + pending.length;
      this.ctx.storage.transactionSync(() => {
        for (const p of pending) {
          const e = p.event;
          this.sql.exec(
            INSERT_EVENT_SQL,
            p.seq,
            e.id,
            e.ts,
            e.type,
            e.symbol ?? null,
            e.side ?? null,
            e.qty ?? null,
            e.price ?? null,
            e.orderId ?? null,
            e.broker ?? null,
            e.meta === undefined ? null : canonicalJSON(e.meta),
            p.prevHash,
            p.hash,
            insertedAt,
          );
        }
        this.sql.exec(UPSERT_SNAPSHOT_SQL, date, seq, count, prevHash);
      });
    }

    return { accepted: pending.length, duplicates, seq, headHash: prevHash };
  }

  // ----------------------------------------------------------------- reads

  async head(): Promise<HeadInfo | null> {
    if (!this.hasEvents()) return null;
    return this.readHead();
  }

  async list(opts: ListOptions): Promise<ListResult | null> {
    if (!this.hasEvents()) return null;
    const limit = Math.max(1, Math.min(MAX_LIST_LIMIT, Math.floor(opts.limit)));
    const since = Math.max(0, Math.floor(opts.since));
    const rows =
      opts.symbol === undefined
        ? this.sql
            .exec<EventRow>(
              `SELECT ${EVENT_COLUMNS} FROM events WHERE seq > ? ORDER BY seq LIMIT ?`,
              since,
              limit,
            )
            .toArray()
        : this.sql
            .exec<EventRow>(
              `SELECT ${EVENT_COLUMNS} FROM events WHERE symbol = ? AND seq > ? ORDER BY seq LIMIT ?`,
              opts.symbol,
              since,
              limit,
            )
            .toArray();
    const events = rows.map(rowToChained);
    // A short page means everything after `since` was scanned, so the cursor can jump to
    // the head (useful for symbol-filtered polling). Otherwise continue after the last row.
    let nextSince: number;
    if (rows.length < limit) {
      nextSince = Math.max(since, this.readHead().seq);
    } else {
      nextSince = rows[rows.length - 1]!.seq;
    }
    return { events, nextSince };
  }

  async snapshots(from?: string, to?: string): Promise<SnapshotRow[] | null> {
    if (!this.hasEvents()) return null;
    const rows = this.sql
      .exec<{ date: string; seq: number; count: number; head_hash: string }>(
        "SELECT date, seq, count, head_hash FROM snapshots WHERE date >= ? AND date <= ? ORDER BY date",
        from ?? "0000-01-01",
        to ?? "9999-12-31",
      )
      .toArray();
    return rows.map((r) => ({ date: r.date, seq: r.seq, count: r.count, headHash: r.head_hash }));
  }

  /**
   * Recomputes the chain for seq in [from, to] (inclusive) straight from the stored
   * columns and compares with the stored prev_hash/hash. The range is capped at
   * MAX_VERIFY_RANGE rows per call; clients walk the ledger with from = to + 1.
   */
  async verify(fromArg?: number, toArg?: number): Promise<VerifyResult | null> {
    if (!this.hasEvents()) return null;
    const head = this.readHead();
    const from = Math.max(1, Math.floor(fromArg ?? 1));
    let to = Math.floor(toArg ?? from + DEFAULT_VERIFY_RANGE - 1);
    if (to > head.seq) to = head.seq;
    if (to - from + 1 > MAX_VERIFY_RANGE) to = from + MAX_VERIFY_RANGE - 1;

    const base = { from, to, headSeq: head.seq, headHash: head.headHash };
    const bad = (seq: number, reason: string, checked: number, lastHash: string | null): VerifyResult => ({
      ok: false,
      checked,
      ...base,
      lastHash,
      firstBadSeq: seq,
      reason,
    });

    if (from > to) return { ok: true, checked: 0, ...base, lastHash: null };

    let prevHash: string;
    if (from === 1) {
      prevHash = GENESIS_HASH;
    } else {
      const prevRows = this.sql.exec<{ hash: string }>("SELECT hash FROM events WHERE seq = ?", from - 1).toArray();
      if (prevRows.length === 0) return bad(from - 1, "missing row", 0, null);
      prevHash = prevRows[0]!.hash;
    }

    const rows = this.sql
      .exec<EventRow>(`SELECT ${EVENT_COLUMNS} FROM events WHERE seq >= ? AND seq <= ? ORDER BY seq`, from, to)
      .toArray();

    let expectedSeq = from;
    let checked = 0;
    let lastHash: string | null = null;
    for (const row of rows) {
      if (row.seq !== expectedSeq) return bad(expectedSeq, "missing row", checked, lastHash);
      if (row.prev_hash !== prevHash) return bad(row.seq, "prev_hash mismatch", checked, lastHash);
      let recomputed: string;
      try {
        recomputed = await computeHash(prevHash, rowToEvent(row));
      } catch {
        return bad(row.seq, "row is not decodable", checked, lastHash);
      }
      if (recomputed !== row.hash) return bad(row.seq, "hash mismatch", checked, lastHash);
      prevHash = row.hash;
      lastHash = row.hash;
      checked += 1;
      expectedSeq += 1;
    }
    if (expectedSeq !== to + 1) return bad(expectedSeq, "missing row", checked, lastHash);
    return { ok: true, checked, ...base, lastHash };
  }

  async summary(): Promise<SummaryResult | null> {
    if (!this.hasEvents()) return null;
    const byDay = this.sql
      .exec<{ date: string; fills: number; buyQty: number; sellQty: number; notional: number }>(
        `SELECT substr(ts, 1, 10) AS date,
                COUNT(*) AS fills,
                COALESCE(SUM(CASE WHEN side = 'buy' THEN qty ELSE 0 END), 0) AS buyQty,
                COALESCE(SUM(CASE WHEN side = 'sell' THEN qty ELSE 0 END), 0) AS sellQty,
                COALESCE(SUM(qty * price), 0) AS notional
         FROM events WHERE type = 'fill'
         GROUP BY date ORDER BY date`,
      )
      .toArray();
    const bySymbol = this.sql
      .exec<{ symbol: string; fills: number; buyQty: number; sellQty: number; notional: number }>(
        `SELECT symbol,
                COUNT(*) AS fills,
                COALESCE(SUM(CASE WHEN side = 'buy' THEN qty ELSE 0 END), 0) AS buyQty,
                COALESCE(SUM(CASE WHEN side = 'sell' THEN qty ELSE 0 END), 0) AS sellQty,
                COALESCE(SUM(qty * price), 0) AS notional
         FROM events WHERE type = 'fill'
         GROUP BY symbol ORDER BY symbol`,
      )
      .toArray();
    return {
      byDay: byDay.map((r) => ({ ...r })),
      bySymbol: bySymbol.map((r) => ({ ...r })),
    };
  }

  /** Streams every ChainedEvent after `since` as NDJSON, one SQL page at a time. */
  async exportNdjson(opts: { since: number; symbol?: string }): Promise<Response | null> {
    if (!this.hasEvents()) return null;
    const encoder = new TextEncoder();
    const sql = this.sql;
    let cursor = Math.max(0, Math.floor(opts.since));
    const symbol = opts.symbol;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        const rows =
          symbol === undefined
            ? sql
                .exec<EventRow>(
                  `SELECT ${EVENT_COLUMNS} FROM events WHERE seq > ? ORDER BY seq LIMIT ?`,
                  cursor,
                  EXPORT_PAGE_SIZE,
                )
                .toArray()
            : sql
                .exec<EventRow>(
                  `SELECT ${EVENT_COLUMNS} FROM events WHERE symbol = ? AND seq > ? ORDER BY seq LIMIT ?`,
                  symbol,
                  cursor,
                  EXPORT_PAGE_SIZE,
                )
                .toArray();
        if (rows.length === 0) {
          controller.close();
          return;
        }
        let chunk = "";
        for (const row of rows) chunk += JSON.stringify(rowToChained(row)) + "\n";
        controller.enqueue(encoder.encode(chunk));
        cursor = rows[rows.length - 1]!.seq;
      },
    });
    return new Response(stream, {
      headers: { "content-type": "application/x-ndjson; charset=utf-8" },
    });
  }

  // --------------------------------------------------------------- helpers

  private ensureSchema(): void {
    if (this.schemaReady) return;
    this.sql.exec(SCHEMA_SQL);
    this.schemaReady = true;
  }

  /** True once at least one event has been committed (unknown ledgers never create tables). */
  private hasEvents(): boolean {
    if (!this.schemaReady) {
      const tables = this.sql
        .exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'events'")
        .toArray();
      if (tables.length === 0) return false;
      this.schemaReady = true;
    }
    return this.sql.exec("SELECT 1 AS present FROM events LIMIT 1").toArray().length > 0;
  }

  private readHead(): HeadInfo {
    const rows = this.sql
      .exec<{ seq: number; hash: string; inserted_at: string }>(
        "SELECT seq, hash, inserted_at FROM events ORDER BY seq DESC LIMIT 1",
      )
      .toArray();
    const count = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM events").one().n;
    const top = rows[0];
    if (!top) return { seq: 0, count: 0, headHash: GENESIS_HASH, updatedAt: null };
    return { seq: top.seq, count, headHash: top.hash, updatedAt: top.inserted_at };
  }

  private findExistingIds(ids: string[]): Set<string> {
    const found = new Set<string>();
    for (let i = 0; i < ids.length; i += ID_LOOKUP_CHUNK) {
      const chunk = ids.slice(i, i + ID_LOOKUP_CHUNK);
      const placeholders = chunk.map(() => "?").join(",");
      const rows = this.sql
        .exec<{ id: string }>(`SELECT id FROM events WHERE id IN (${placeholders})`, ...chunk)
        .toArray();
      for (const r of rows) found.add(r.id);
    }
    return found;
  }
}
