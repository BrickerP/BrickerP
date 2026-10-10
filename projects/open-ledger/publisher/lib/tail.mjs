// Tail a local SQLite ledger and publish new rows.
//
// The mapping from your schema to LedgerEvent is explicit: the SQL query in the config must
// return a monotonic `cursor` column plus columns named after LedgerEvent fields. Anything
// else becomes `meta`. See publisher/README.md for the full contract.

import { readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { publish } from "./client.mjs";

export const EXAMPLE_CONFIG = {
  $comment:
    "open-ledger-publish tail config. `query` must return a monotonic `cursor` column plus LedgerEvent columns (id, ts, type, symbol, side, qty, price, orderId, broker); other columns become meta. Use :cursor and :limit placeholders.",
  url: "http://127.0.0.1:8787",
  ledgerId: "live",
  tokenEnv: "INGEST_TOKEN",
  sqlite: "./demo.sqlite",
  cursorFile: "./.open-ledger-cursor.json",
  initialCursor: 0,
  batchSize: 200,
  query:
    "SELECT rowid AS cursor, fill_id AS id, filled_at AS ts, symbol, side, qty, price, order_id AS orderId, venue, fee FROM fills WHERE rowid > :cursor ORDER BY rowid LIMIT :limit",
  defaults: { type: "fill", broker: "alpaca-paper" },
  metaColumns: "rest",
};

const EVENT_FIELDS = ["id", "ts", "type", "symbol", "side", "qty", "price", "orderId", "broker"];
const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]00:00)$/;

export async function loadConfig(file) {
  let raw;
  try {
    raw = await readFile(file, "utf8");
  } catch (err) {
    throw new Error(`cannot read config ${file}: ${err.message} (run \`open-ledger-publish init\` to create one)`);
  }
  const config = JSON.parse(raw);
  for (const key of ["url", "ledgerId", "sqlite", "query"]) {
    if (typeof config[key] !== "string" || config[key].length === 0) throw new Error(`config.${key} is required`);
  }
  if (!config.query.includes(":cursor") || !config.query.includes(":limit")) {
    throw new Error("config.query must use the :cursor and :limit placeholders");
  }
  const dir = path.dirname(path.resolve(file));
  return {
    tokenEnv: "INGEST_TOKEN",
    cursorFile: "./.open-ledger-cursor.json",
    initialCursor: 0,
    batchSize: 200,
    defaults: {},
    metaColumns: "rest",
    ...config,
    sqlite: path.resolve(dir, config.sqlite),
    cursorFile: path.resolve(dir, config.cursorFile ?? "./.open-ledger-cursor.json"),
  };
}

export async function readCursor(file, initial) {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8"));
    return parsed.cursor ?? initial;
  } catch (err) {
    if (err.code === "ENOENT") return initial;
    throw err;
  }
}

export async function writeCursor(file, cursor) {
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify({ cursor, updatedAt: new Date().toISOString() }, null, 2) + "\n");
  await rename(tmp, file);
}

export function toIsoUtc(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    const ms = value > 1e12 ? value : value * 1000;
    return new Date(ms).toISOString();
  }
  if (typeof value === "string") {
    if (ISO_UTC_RE.test(value)) return value;
    const d = new Date(value.includes("T") || value.includes("Z") || /[+-]\d{2}:\d{2}$/.test(value) ? value : value.replace(" ", "T") + "Z");
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  throw new Error(`cannot interpret ts value ${JSON.stringify(value)} as a UTC timestamp`);
}

export function normalizeSide(value) {
  if (value === undefined || value === null) return undefined;
  const s = String(value).trim().toLowerCase();
  if (s === "buy" || s === "b" || s === "long") return "buy";
  if (s === "sell" || s === "s" || s === "short") return "sell";
  throw new Error(`cannot interpret side value ${JSON.stringify(value)}`);
}

/** Maps one SQL row (with a `cursor` column) to a LedgerEvent according to the config. */
export function mapRow(row, config) {
  if (!("cursor" in row)) throw new Error('query result has no "cursor" column');
  const event = {};
  const rest = {};
  for (const [column, value] of Object.entries(row)) {
    if (column === "cursor") continue;
    if (EVENT_FIELDS.includes(column)) {
      if (value !== null && value !== undefined) event[column] = value;
    } else if (value !== null && value !== undefined) {
      rest[column] = typeof value === "bigint" ? Number(value) : value;
    }
  }
  for (const [key, value] of Object.entries(config.defaults ?? {})) {
    if (event[key] === undefined) event[key] = value;
  }
  if (event.id !== undefined) event.id = String(event.id);
  if (event.ts !== undefined) event.ts = toIsoUtc(event.ts);
  if (event.side !== undefined) event.side = normalizeSide(event.side);
  for (const numeric of ["qty", "price"]) {
    if (event[numeric] !== undefined) {
      const n = typeof event[numeric] === "bigint" ? Number(event[numeric]) : Number(event[numeric]);
      if (!Number.isFinite(n)) throw new Error(`${numeric} is not numeric in row with cursor ${row.cursor}`);
      event[numeric] = n;
    }
  }
  for (const stringy of ["orderId", "broker", "symbol", "type"]) {
    if (event[stringy] !== undefined) event[stringy] = String(event[stringy]);
  }

  const metaColumns = config.metaColumns ?? "rest";
  let meta;
  if (metaColumns === "rest") meta = rest;
  else if (Array.isArray(metaColumns)) meta = Object.fromEntries(metaColumns.filter((c) => c in rest).map((c) => [c, rest[c]]));
  else meta = {};
  if (Object.keys(meta).length > 0) event.meta = meta;
  return event;
}

export async function openDatabase(file) {
  const { DatabaseSync } = await import("node:sqlite");
  try {
    return new DatabaseSync(file, { readOnly: true });
  } catch (err) {
    // Older Node 22 releases do not support the readOnly option.
    if (err?.code === "ERR_INVALID_ARG_TYPE" || /readOnly/.test(String(err?.message))) return new DatabaseSync(file);
    throw err;
  }
}

export async function tailOnce({ config, token, dryRun = false, log = () => {}, fetchImpl }) {
  const cursor = await readCursor(config.cursorFile, config.initialCursor);
  const db = await openDatabase(config.sqlite);
  let rows;
  try {
    const stmt = db.prepare(config.query);
    rows = stmt.all({ cursor, limit: config.batchSize });
  } finally {
    db.close();
  }
  if (rows.length === 0) return { rows: 0, accepted: 0, duplicates: 0, cursor };

  const events = rows.map((row) => mapRow(row, config));
  const nextCursor = rows.reduce((max, row) => {
    const c = typeof row.cursor === "bigint" ? Number(row.cursor) : row.cursor;
    return max === undefined || c > max ? c : max;
  }, undefined);

  if (dryRun) {
    for (const e of events) process.stdout.write(JSON.stringify(e) + "\n");
    log(`dry run: ${events.length} events mapped, cursor would advance ${JSON.stringify(cursor)} -> ${JSON.stringify(nextCursor)}`);
    return { rows: rows.length, accepted: 0, duplicates: 0, cursor };
  }

  const result = await publish({
    url: config.url,
    ledgerId: config.ledgerId,
    token,
    events,
    batchSize: config.batchSize,
    log,
    ...(fetchImpl ? { fetchImpl } : {}),
  });
  await writeCursor(config.cursorFile, nextCursor);
  return { rows: rows.length, ...result, cursor: nextCursor };
}
