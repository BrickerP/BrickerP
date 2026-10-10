# open-ledger-publish

Node 22 CLI that publishes events to an open-ledger instance. No native dependencies: SQLite access
goes through the built-in `node:sqlite` module.

```
open-ledger-publish demo --url <base-url> [--ledger demo] [--token <t>] [--count 300]
                         [--seed 42] [--anchor YYYY-MM-DD] [--db ./demo.sqlite] [--dry-run]
open-ledger-publish tail --config publisher.config.json [--once] [--interval 5000] [--dry-run]
open-ledger-publish init [--out publisher.config.json] [--force]
```

The ingest token comes from `--token`, otherwise from the environment variable named by the config's
`tokenEnv` (default `INGEST_TOKEN`). It is never written to disk.

## `tail`: mapping your SQLite schema to LedgerEvents

Your execution-ledger schema is yours; the mapping lives in the SQL query of the config file, so it
is explicit and reviewable. The query must:

1. Return a **monotonic `cursor` column** (`rowid`, an autoincrement id, or an ISO timestamp as long
   as it only grows). The CLI remembers the largest cursor seen in `cursorFile` and passes it back as
   `:cursor`; use `WHERE cursor_expr > :cursor ORDER BY cursor_expr LIMIT :limit`.
2. Return columns named after `LedgerEvent` fields: `id`, `ts`, `type`, `symbol`, `side`, `qty`,
   `price`, `orderId`, `broker`. Alias your columns (`fill_id AS id`). Missing fields fall back to
   `defaults` from the config (for example `"type": "fill"`).
3. Any other column becomes `meta.<column>` when `metaColumns` is `"rest"` (default). Set
   `metaColumns` to an array to whitelist, or to `[]` for no meta.

Conversions applied after the query:

| Field | Accepted input | Result |
| --- | --- | --- |
| `id` | anything | `String(value)` — your fill-dedupe key is the natural choice |
| `ts` | ISO UTC string, epoch seconds, epoch milliseconds (> 1e12), or a naive `YYYY-MM-DD HH:MM:SS` (treated as UTC) | ISO-8601 UTC |
| `side` | `buy/sell`, `b/s`, `long/short`, any case | `buy` or `sell` |
| `qty`, `price` | number, integer, bigint, numeric string | `number` |
| `NULL` columns | — | field omitted |

Example config (`open-ledger-publish init` writes this):

```json
{
  "url": "https://open-ledger.<subdomain>.workers.dev",
  "ledgerId": "live",
  "tokenEnv": "INGEST_TOKEN",
  "sqlite": "./execution.sqlite",
  "cursorFile": "./.open-ledger-cursor.json",
  "initialCursor": 0,
  "batchSize": 200,
  "query": "SELECT rowid AS cursor, fill_id AS id, filled_at AS ts, symbol, side, qty, price, order_id AS orderId, venue, fee FROM fills WHERE rowid > :cursor ORDER BY rowid LIMIT :limit",
  "defaults": { "type": "fill", "broker": "alpaca" },
  "metaColumns": "rest"
}
```

`sqlite` and `cursorFile` are resolved relative to the config file. The database is opened
read-only. `batchSize` (≤ 500) is both the SQL `LIMIT` and the ingest batch size, so a pass that
returns a full page is followed immediately by another one until the table is drained.

Run `tail --dry-run` to print the mapped events without publishing or moving the cursor. Then
`tail --once` for a single pass, or `tail --interval 5000` to keep following the table (SIGINT stops
after the current pass). Because the ledger is idempotent on `id`, re-publishing after a crash or a
deleted cursor file is harmless: the server reports those rows as `duplicates`.

Mixing event types: use a `UNION ALL` over your fills/orders/cancels tables that yields a common
cursor (e.g. a `created_at` timestamp), or run one `tail` per table with separate config and cursor
files pointing at the same ledger.

## `demo`

Generates deterministic synthetic activity — by default 300 fills across AAPL, MSFT, NVDA, SPY, QQQ,
AMZN, GOOGL and TSLA over the last 20 weekdays ending at `--anchor` (default: today, UTC), plus one
genesis note and one end-of-day note per day — and publishes them to ledger `demo`. Same `--seed`
and `--anchor` ⇒ byte-identical events, so re-running is a no-op (`duplicates: 321`). Event ids do
not include the anchor; the first publish defines the demo ledger's content.

`--db ./demo.sqlite` additionally writes the fills into a local SQLite table named `fills` with the
columns used by the example config, so you can try the whole `init → tail` flow against fake data.
`--dry-run` prints the first events instead of publishing.

## Node versions

`node:sqlite` is behind `--experimental-sqlite` on Node 22.5–22.12 and unflagged from 22.13 (and
23.4+). `bin.mjs` probes for it and re-executes Node with the flag only when needed, and only for the
subcommands that touch SQLite. Node may print a one-line `ExperimentalWarning` on 22.x; pass
`--disable-warning=ExperimentalWarning` to Node to silence it. If you would rather use a native
driver, `better-sqlite3` exposes the same `prepare().all()` shape — replace `openDatabase()` in
`lib/tail.mjs`.
