# open-ledger

A verifiable, append-only public ledger for trading fills (or any event stream), running on
Cloudflare Workers + Durable Objects (SQLite) within the **Workers Free plan**.

Every event is hash-chained to the one before it. The server publishes the chain; anyone can
download it and recompute every link in their browser. If a single stored row were ever edited,
reordered or deleted after the fact, the published head hash would stop matching.

This is the Cloudflare-native companion to an "S3 Parquet → CloudFront dashboard" pipeline: the
dashboard numbers come straight from a chain whose integrity the reader checks for themselves.

```
 local SQLite execution ledger ──open-ledger-publish tail──▶ POST /v1/ledgers/:id/events
                                                                    │  Bearer INGEST_TOKEN
                                                                    ▼
                                                 Worker (router, auth, validation, CORS)
                                                                    │  RPC
                                                                    ▼
                                        Durable Object "Ledger" (one per ledger id, SQLite)
                                        events(seq, id UNIQUE, …, prev_hash, hash)  snapshots(date, …)
                                                                    │
                            ┌───────────────────────────────────────┼─────────────────────────┐
                            ▼                                       ▼                         ▼
                 GET head / events / verify              GET export.ndjson           public/ dashboard
                 snapshots / summary (JSON)             (streamed NDJSON)      "Verify chain in your browser"
```

## Contents

- [API](#api) · [Shared contract](#shared-contract) · [Hash chain](#hash-chain) · [Snapshots](#snapshots)
- [Dashboard](#dashboard) · [Publisher CLI](#publisher-cli)
- [Local development](#local-development) · [Tests](#tests) · [Deploy](#deploy)
- [Free-tier budget](#free-tier-budget) · [Security notes](#security-notes) · [Limitations and follow-ups](#limitations-and-follow-ups)

## API

Base path `/v1`. All responses are JSON (except `export.ndjson`), `Cache-Control: no-store`, and
carry `Access-Control-Allow-Origin: *` so any page can read a ledger. Ledger ids match
`[a-z0-9-]{1,64}`; a ledger is created by its first successful ingest and GETs on a ledger that has
never received an event return `404 {"error":"ledger_not_found"}`.

| Method | Path | Notes |
| --- | --- | --- |
| `POST` | `/v1/ledgers/:ledgerId/events` | `Authorization: Bearer <INGEST_TOKEN>`. Body `{ "events": LedgerEvent[] }`, 1–500 events. Idempotent on `event.id`. → `{ ledgerId, accepted, duplicates, seq, headHash }` |
| `GET` | `/v1/ledgers/:ledgerId/head` | → `{ ledgerId, seq, count, headHash, updatedAt }` |
| `GET` | `/v1/ledgers/:ledgerId/events?since=<seq>&limit=<n≤1000>&symbol=<sym>` | Events with `seq > since`, ascending. → `{ ledgerId, events: ChainedEvent[], nextSince }` |
| `GET` | `/v1/ledgers/:ledgerId/snapshots?from=YYYY-MM-DD&to=YYYY-MM-DD` | → `{ ledgerId, snapshots: [{ date, seq, count, headHash }] }` |
| `GET` | `/v1/ledgers/:ledgerId/verify?from=<seq>&to=<seq>` | Server-side recomputation of `[from, to]`, **max 2000 rows per call** (default 1000). → `{ ledgerId, ok, checked, from, to, headSeq, headHash, lastHash, firstBadSeq?, reason? }` |
| `GET` | `/v1/ledgers/:ledgerId/export.ndjson?since=<seq>&symbol=<sym>` | Streamed NDJSON, one `ChainedEvent` per line, 500-row SQL pages |
| `GET` | `/v1/ledgers/:ledgerId/summary` | SQL aggregates over `type = "fill"`. → `{ ledgerId, byDay: [{ date, fills, buyQty, sellQty, notional }], bySymbol: [{ symbol, … }] }` |
| `GET` | `/v1` | Endpoint index |

Status codes: `400` schema/parameter errors (`{"error":"invalid_request","message":"events[3]: …"}`),
`401` missing or wrong bearer token, `404` unknown ledger/route, `405` wrong method, `413` body > 8 MB,
`503` when `INGEST_TOKEN` is not configured.

Pagination: pass `nextSince` back as `since`; stop when `events` is empty. When a page is short
(fewer than `limit` rows) `nextSince` is advanced to the current head seq, so symbol-filtered
pollers resume from the head instead of rescanning. `verify` is paginated the same way: loop with
`from = to + 1` until `to >= headSeq`; `lastHash` of the final page equals `headHash` when the whole
chain is intact.

### Validation rules

- `id`: non-empty string ≤ 256 chars, the idempotency key. A replayed id is counted in `duplicates`
  even if its content differs (first write wins) and never changes the chain.
- `ts`: ISO-8601 **UTC** (`2026-01-02T03:04:05Z`, optional fraction, or `+00:00`). Dates in
  `summary.byDay` are `substr(ts, 1, 10)`.
- `type`: `fill | order | cancel | note`. Fills additionally require `symbol`, `side`, `qty > 0`,
  `price >= 0`.
- Unknown top-level fields are rejected (`400`) so that the hashed object is exactly what you sent;
  put custom data under `meta` (plain object, ≤ 16 KB).

## Shared contract

Consumed by [`projects/ledger-mcp`](../ledger-mcp) — keep exact.

```ts
LedgerEvent  = { id: string; ts: string /* ISO-8601 UTC */; type: "fill" | "order" | "cancel" | "note";
                 symbol?: string; side?: "buy" | "sell"; qty?: number; price?: number;
                 orderId?: string; broker?: string; meta?: Record<string, unknown> }
ChainedEvent = LedgerEvent & { seq: number; prevHash: string; hash: string }
```

## Hash chain

```
hash      = sha256_hex( prevHash + "\n" + canonicalJSON(event) )
prevHash  = hash of the previous event; genesis prevHash = 64 ASCII zeros
canonicalJSON = recursively key-sorted JSON (default JS sort, UTF-16 code units), no whitespace,
                numbers/strings serialised exactly like JSON.stringify, undefined properties omitted
```

`event` is the `LedgerEvent` **without** `seq`, `prevHash` and `hash`, after validation
(only known fields with defined values). Worked example (also the hard-coded test vector in
`test/chain.test.ts`, computed independently with Node's `crypto`):

```
event     {"id":"evt-1","price":150.25,"qty":10,"side":"buy","symbol":"AAPL","ts":"2026-01-02T03:04:05Z","type":"fill"}
preimage  0000…0000 (64 zeros) + "\n" + the line above
hash      a0b815aadcc334983d6a38df46cd55c81e9ca7f81585368f63268757cc876d88
```

Verification (`GET /verify`, and `public/chain.js` in the browser) reads the raw columns back,
rebuilds the `LedgerEvent`, recomputes the hash and checks three things per row: `seq` is
contiguous, `prevHash` equals the previous row's `hash`, and the recomputed hash equals the stored
one. Editing any column, rewriting a hash, breaking a link or deleting a row is reported as
`firstBadSeq` + `reason` (`hash mismatch`, `prev_hash mismatch`, `missing row`).

Appends are transactional: the Worker validates the batch, the Durable Object serialises writes,
hashes the new rows off the current head, and inserts all rows plus the snapshot upsert inside one
`transactionSync`. Either the whole batch lands or none of it does.

## Snapshots

`snapshots` has one row per **UTC date on which an append was committed**, upserted inside the
same transaction as the events: "the ledger head as of the last append on that day". Because it is
written atomically with the chain it can never disagree with it, and no cron/alarm is needed (the
Free plan has only 5 cron triggers per account; DO alarms were the alternative). Days without
appends have no row. The date is the append date, not the event `ts`.

## Dashboard

`public/` is served by Workers Static Assets: `index.html`, `app.js`, `styles.css`, `chain.js` —
no framework, no build step. Open `/?ledger=<id>` (default `demo`). It shows the head hash, event
count, by-day bars, by-symbol totals, a paginated events table (newest first; symbol filter walks
oldest first with a cursor stack) and **Verify chain in your browser**, which streams
`export.ndjson`, recomputes every link with WebCrypto SHA-256 and prints OK or the first diverging
seq. `public/chain.js` is the browser twin of `src/chain.ts`; `test/chain.test.ts` asserts the two
agree byte-for-byte.

## Publisher CLI

`open-ledger-publish` (`publisher/bin.mjs`, Node 22, no native dependencies) tails a local SQLite
ledger with a user-supplied SQL query, maps rows to `LedgerEvent`s and POSTs them in batches with
retries, keeping a cursor file. Your real execution-ledger schema is unknown here, so the mapping is
**explicit in the SQL**: the query must return a monotonic `cursor` column plus columns named after
`LedgerEvent` fields; other columns become `meta`. Full contract and examples:
[`publisher/README.md`](publisher/README.md).

```sh
# deterministic demo data (300 fills + notes, seed 42) into ledger "demo"
INGEST_TOKEN=… npx open-ledger-publish demo --url https://open-ledger.<subdomain>.workers.dev
# or: npm run publish:demo -- --url …

# tail your own SQLite file
npx open-ledger-publish init                       # writes publisher.config.json
INGEST_TOKEN=… npx open-ledger-publish tail --config publisher.config.json --interval 5000
```

`node:sqlite` is used for SQLite access. It is flagged on Node 22.5–22.12 (`--experimental-sqlite`)
and unflagged from Node 22.13; the bin shim re-executes Node with the flag when the running version
needs it. `better-sqlite3` works too if you prefer a native driver — swap `openDatabase()` in
`publisher/lib/tail.mjs`.

## Local development

```sh
cd projects/open-ledger
npm ci
cp .dev.vars.example .dev.vars        # sets INGEST_TOKEN for wrangler dev
npm run dev                           # http://localhost:8787
INGEST_TOKEN=dev-ingest-token-change-me node publisher/bin.mjs demo --url http://127.0.0.1:8787
open http://localhost:8787/?ledger=demo
```

Requirements: Node ≥ 22.5 (repo pin: `.node-version`), Wrangler 4.x (installed locally).

## Tests

```sh
npm test          # vitest + @cloudflare/vitest-plugin (the Workers Vitest integration), runs in workerd
npm run typecheck # wrangler types && tsc --noEmit (src and test)
```

Covered: `canonicalJSON` determinism and `JSON.stringify` parity; hash chain against hard-coded
SHA-256 vectors; TS ↔ browser implementation parity; idempotent ingest (duplicates counted, chain
unchanged, in-batch duplicates, concurrent batches); pagination and symbol filter; `verify` catching
a tampered row (mutated directly through Durable Object storage), a rewritten hash, a broken link
and a deleted row; auth rejection; 400 schema errors; 404 unknown ledgers; snapshots; summary
aggregates; NDJSON export re-verified with the browser verifier; static dashboard.

## Deploy

### With Wrangler (normal path)

```sh
npx wrangler login
npx wrangler deploy                                    # creates the DO namespace (SQLite migration v1) + uploads public/
openssl rand -hex 32 | npx wrangler secret put INGEST_TOKEN
```

The Worker is served at `https://open-ledger.<your-subdomain>.workers.dev`. Rotate the token any
time with `npx wrangler secret put INGEST_TOKEN`.

### Without Wrangler login (REST API only)

Useful from an environment that only has an API token or an OAuth session (this is how the first
deployment was made). All calls are `https://api.cloudflare.com/client/v4/accounts/{account_id}/…`.

1. Build: `npx wrangler deploy --dry-run --outdir=dist` → `dist/index.js` (single ES module).
2. Static assets (optional — the dashboard): `POST workers/scripts/open-ledger/assets-upload-session`
   with `{ manifest: { "/index.html": { hash, size }, … } }` where `hash` is the first 32 hex chars of
   the SHA-256 of each file. Upload each returned bucket to `POST workers/assets/upload?base64=true`
   as multipart form-data (field name = file hash, base64 body) with `Authorization: Bearer <jwt from
   step 2>`; the last response returns a completion `jwt`.
3. Upload the script: `PUT workers/scripts/open-ledger` multipart with a `metadata` part
   ```json
   { "main_module": "index.js", "compatibility_date": "2026-10-01", "compatibility_flags": [],
     "bindings": [{ "type": "durable_object_namespace", "name": "LEDGER", "class_name": "Ledger" },
                  { "type": "assets", "name": "ASSETS" }],
     "migrations": { "new_tag": "v1", "new_sqlite_classes": ["Ledger"] },
     "assets": { "jwt": "<completion jwt>", "config": { "run_worker_first": ["/v1/*"] } },
     "observability": { "enabled": true } }
   ```
   and an `index.js` part with `Content-Type: application/javascript+module`. Omit the `assets`
   binding/config if you skipped step 2 (the API still works; only the dashboard is missing).
4. Enable the workers.dev route: `POST workers/scripts/open-ledger/subdomain`
   `{ "enabled": true, "previews_enabled": false }` (`GET workers/subdomain` tells you the subdomain).
5. Secret: `PUT workers/scripts/open-ledger/secrets` `{ "name": "INGEST_TOKEN", "text": "<random 32-byte hex>", "type": "secret_text" }`.

## Free-tier budget

| Resource | Free limit | How open-ledger stays inside it |
| --- | --- | --- |
| Worker requests | 100k / day | Public GETs are cheap JSON; `no-store` today, add edge caching if traffic grows |
| CPU per request | 10 ms | Validation is hand-written; SHA-256 via WebCrypto; `verify` capped at 2000 rows/call; export streams 500-row pages |
| Durable Objects | SQLite backend only | `new_sqlite_classes` migration; one object per ledger id; schema created lazily on first append (random ids never write storage) |
| DO storage | 5 GB total | A fill row is ~300 B → millions of events per ledger before this matters |
| Cron triggers | 5 / account | None used — snapshots are upserted in the append transaction |
| KV / D1 / Queues / R2 | — | Not used |

## Security notes

- Ingest is a single bearer secret compared in constant time (`crypto.subtle.timingSafeEqual`);
  reads are public by design. Keep the token out of the repo (`.dev.vars` is git-ignored).
- The chain proves *history was not rewritten after publication*, not that the publisher told the
  truth at ingest time. Anchor `headHash` externally (a tweet, a git commit, a timestamping service)
  to make the publisher accountable for a point in time; `snapshots` gives you the per-day values to anchor.
- The Durable Object is the only writer; there is no delete/update path in the API.

## Limitations and follow-ups

- No ledger listing endpoint (Durable Object namespaces cannot be enumerated); a registry object or
  a static list in the dashboard would fix that.
- `verify` covers ≤ 2000 rows per call; the dashboard verifies everything client-side instead.
- Timestamps must be UTC; the publisher converts epoch seconds/milliseconds and naive strings.
- Responses are `no-store`; immutable pages (`events?since` fully behind the head) could be cached
  at the edge to stretch the 100k requests/day budget.
- Ideas: external anchoring of daily snapshot hashes, per-ledger read tokens for private ledgers,
  Parquet/CSV export, a `since`-based webhook for downstream consumers.

## License

MIT © 2026 Yupeng Lu
