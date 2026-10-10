# ledger-mcp

A remote [Model Context Protocol](https://modelcontextprotocol.io) server on Cloudflare Workers that exposes a
hash-chained trading execution ledger — plus optional live market data — to MCP clients such as Cursor,
Claude Desktop and the MCP Inspector.

It runs on the **Workers Free plan**, needs no database of its own, and talks to a ledger service that
implements the [open-ledger HTTP contract](#ledger-contract). Without one it serves a built-in,
deterministic demo ledger (≈200 fills across AAPL / MSFT / SPY / NVDA, Sep–Oct 2026) with a real SHA-256 chain,
so every tool can be exercised end-to-end before any real data exists.

```
MCP client ──Bearer──▶ ledger-mcp (Worker) ──HTTP──▶ open-ledger  (LEDGER_BASE_URL)
                        │                   └──HTTP──▶ Alpaca Data v2 (optional)
                        └── demo mode: in-memory seeded ledger, no upstream at all
```

## Status

| Piece | State |
| --- | --- |
| Streamable HTTP endpoint `/mcp` (current spec) | done |
| Legacy SSE endpoint `/sse` (older clients) | done |
| Bearer auth, constant-time compare, 401 JSON | done |
| 7 tools, 3 resources, 1 prompt | done |
| Demo ledger, FIFO PnL, chain verification | done, unit-tested |
| Alpaca market data | done; tools error until credentials are set (never fabricated) |
| Deploy to `*.workers.dev` | wrangler config + REST recipe below |
| OAuth / Cloudflare Access | **not implemented** — see [Hardening](#hardening-oauth--access) |

## Tools, resources, prompt

All tools are read-only and idempotent (declared via MCP annotations). Results are JSON in a text block;
failures come back as MCP tool errors (`isError: true`), never as thrown protocol errors.

| Tool | Arguments | Returns |
| --- | --- | --- |
| `ledger_head` | `ledgerId` | `{ ledgerId, seq, count, headHash, updatedAt, source }` — call first |
| `ledger_events` | `ledgerId`, `since?`, `limit?` (1..1000), `symbol?` | one page of chained events + `nextSince` |
| `ledger_summary` | `ledgerId`, `from?`, `to?` (YYYY-MM-DD, UTC) | fills / bought / sold / notional per day and per symbol |
| `ledger_pnl` | `ledgerId`, `symbol?` | realized PnL by **FIFO lot matching** (long and short→cover), per symbol and total; fees ignored; `coverage.truncated` if more than 5000 events |
| `ledger_verify` | `ledgerId`, `from?`, `to?` (seq range ≤ 2000, default newest 2000) | local recompute of the chain **and** the ledger service's `/verify` answer, plus `agree` |
| `market_quote` | `symbol` | latest bid/ask from Alpaca Market Data v2 |
| `market_bars` | `symbol`, `timeframe?` (`1Min`…`1Month`, default `1Day`), `limit?` (≤1000, default 30) | OHLCV bars, oldest first |

| Resource | Content |
| --- | --- |
| `ledger://about` (static, `text/markdown`) | data source, chain definition, upstream contract |
| `ledger://{ledgerId}/head` (template, JSON) | same as `ledger_head` |
| `ledger://{ledgerId}/summary` (template, JSON) | same as `ledger_summary` without a date range |

| Prompt | Arguments | Purpose |
| --- | --- | --- |
| `daily_review` | `ledgerId`, `date?` | structured end-of-day review: fills, realized PnL, chain integrity, anomalies, follow-ups — tells the model which tools to call |

Caps (also enforced upstream): 1000 events per `ledger_events` call, 5000 events folded per `ledger_pnl` /
locally computed summary (paged internally, 1000 per page), 2000 events per `ledger_verify`.

## Quick start (local)

Requires Node 22 (repo root `.node-version`) and npm.

```bash
cd projects/ledger-mcp
npm ci
cp .dev.vars.example .dev.vars        # set MCP_API_KEY to any long random string
npm run dev                           # wrangler dev → http://localhost:8787
```

```bash
npm test                              # vitest + @cloudflare/vitest-plugin (runs inside workerd)
npm run typecheck                     # wrangler types → tsc --noEmit
npm run deploy                        # wrangler deploy (needs `wrangler login`; see Deploy)
```

Smoke-test with curl. Each call is one self-contained request; the reply is a single SSE-framed JSON-RPC
message (`event: message` / `data: {...}`), as the Streamable HTTP transport specifies:

```bash
export MCP_URL=http://localhost:8787/mcp MCP_API_KEY=...   # same value as in .dev.vars
mcp() { curl -s "$MCP_URL" -H "content-type: application/json" \
          -H "accept: application/json, text/event-stream" \
          -H "authorization: Bearer $MCP_API_KEY" -d "$1"; echo; }

mcp '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'
mcp '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
mcp '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"ledger_head","arguments":{"ledgerId":"demo"}}}'
mcp '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"ledger_verify","arguments":{"ledgerId":"demo","from":200}}}'
```

Or with the Inspector UI:

```bash
npx @modelcontextprotocol/inspector@latest --transport http --server-url http://localhost:8787/mcp \
  --header "Authorization: Bearer $MCP_API_KEY"
```

## Connect a client

Replace `<URL>` with `http://localhost:8787` or your deployed `https://ledger-mcp.<account>.workers.dev`.

**Cursor** — `.cursor/mcp.json` (project) or `~/.cursor/mcp.json` (global):

```json
{
  "mcpServers": {
    "ledger-mcp": {
      "url": "<URL>/mcp",
      "headers": { "Authorization": "Bearer <MCP_API_KEY>" }
    }
  }
}
```

**Claude Desktop** — `claude_desktop_config.json` (Claude Desktop only launches local stdio servers, so bridge
through [`mcp-remote`](https://www.npmjs.com/package/mcp-remote)):

```json
{
  "mcpServers": {
    "ledger-mcp": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "<URL>/mcp", "--header", "Authorization: Bearer <MCP_API_KEY>"]
    }
  }
}
```

Clients that only speak the 2024-11-05 HTTP+SSE transport can use `<URL>/sse` with the same header.

## Ledger contract

The Worker is a thin, cache-friendly client of a ledger service. Any service implementing these five routes
(the `open-ledger` project in this repository is the reference) can be plugged in with `LEDGER_BASE_URL`:

```
GET /v1/ledgers/:ledgerId/head                              → { ledgerId, seq, count, headHash, updatedAt }
GET /v1/ledgers/:ledgerId/events?since=&limit=&symbol=      → { events: ChainedEvent[], nextSince }      (limit ≤ 1000, seq > since)
GET /v1/ledgers/:ledgerId/snapshots?from=&to=               → { snapshots: [{ date, seq, count, headHash }] }
GET /v1/ledgers/:ledgerId/verify?from=&to=                  → { ok, checked, from, to, headHash, firstBadSeq?, reason? }
GET /v1/ledgers/:ledgerId/summary?from=&to=                 → { byDay: [{ date, fills, buyQty, sellQty, notional }],
                                                                bySymbol: [{ symbol, fills, buyQty, sellQty, notional }] }
```

Responses are validated with zod (`src/ledger/types.ts`); extra fields are tolerated and dropped, missing or
mistyped ones make the tool fail with "does not match the contract" rather than silently misreport.

```
LedgerEvent  = { id, ts (ISO-8601 UTC), type: "fill" | "order" | "cancel" | "note",
                 symbol?, side?: "buy" | "sell", qty?, price?, orderId?, broker?, meta? }
ChainedEvent = LedgerEvent & { seq, prevHash, hash }

hash          = sha256_hex(prevHash + "\n" + canonicalJSON(event))     // event = the bare LedgerEvent
genesis       = prevHash of seq 1 = 64 × "0"
canonicalJSON = recursively key-sorted JSON, no whitespace, JSON.stringify scalar semantics
```

Reference vectors (asserted in `test/hash.test.ts`; reproduce with `node:crypto` in a few lines):

```
canon #1  {"broker":"alpaca-paper","id":"evt-000001","meta":{"leg":"entry","session":"2026-09-01","strategy":"bracket"},"orderId":"ord-000001","price":232.5,"qty":10,"side":"buy","symbol":"AAPL","ts":"2026-09-01T13:31:07.000Z","type":"fill"}
hash #1   bbf66f7f877aa34b5dc6507cec9bc3b2a2b621dd29bbac9688bcf3c2a5107eb3     (prevHash = genesis)
canon #2  {"broker":"alpaca-paper","id":"evt-000002","meta":{"leg":"take_profit","session":"2026-09-01","strategy":"bracket"},"orderId":"ord-000002","price":233.1,"qty":4,"side":"sell","symbol":"AAPL","ts":"2026-09-01T14:02:00.000Z","type":"fill"}
hash #2   0cb7b0e09d09c28cfd541a7f7e7742e0ede588c4b077ac7bc37d4a04bb5ca108     (prevHash = hash #1)
```

`ledger_verify` is deliberately belt-and-braces: it re-downloads the range, recomputes every link locally, then
compares with the service's own `/verify` result and reports `agree`. A disagreement means either side is
lying or buggy — worth a look either way.

Demo mode pins the dataset: 242 events (196 fills), head seq 242, head hash
`bdec9ebc6f127e13ed13f4cb0188be219cd80a85eaa5c9a349c86ed9a19cba55` (`test/demo.test.ts` will fail loudly if
the generator ever changes).

## Architecture

```
src/
  index.ts              Worker entry: routing, bearer auth, landing page, /healthz
  auth.ts               constant-time bearer check, 401/503 JSON helpers
  env.ts                env typing, limits, server name/version
  landing.ts            GET / HTML (no secrets, client snippets)
  ledger/
    types.ts            zod schemas mirroring the contract
    hash.ts             canonicalJSON, sha256, hashEvent, verifyChain
    source.ts           LedgerSource interface, paging helper (collectEvents)
    http.ts             HttpLedgerSource: contract client with 30 s memoisation
  demo/
    fixtures.ts         seeded generator (mulberry32) + chainEvents
    source.ts           DemoLedgerSource
  pnl.ts                FIFO lot matching (long/short/flip)
  summary.ts            per-day / per-symbol aggregation
  market.ts             Alpaca Market Data v2 client
  mcp/
    definitions.ts      the single source of truth for tools/resources/prompt (SDK-agnostic)
    server.ts           /mcp — MCP SDK v2 McpServer factory (stateless)
    legacy-agent.ts     /sse — McpAgent Durable Object with MCP SDK v1
```

**Two lanes, one definition set.** `agents@0.28` ships the modern `createMcpHandler` (one server instance per
request, no Durable Object, MCP SDK v2) and keeps the older `McpAgent` class in a deprecated/feature-frozen state.
`/mcp` uses `createMcpHandler`; its default `legacy: "stateless"` mode also answers MCP SDK v1 clients over POST,
which is what Cursor and `mcp-remote` send. `/sse` is kept for clients that still open a long-lived SSE stream
and is served by `McpAgent.serveSSE`, which is why the config declares a `MCP_OBJECT` Durable Object binding
(`LedgerMcp`, SQLite backend — the only kind available on the Free plan). Both lanes register the same
`registerLedgerCapabilities()` so they cannot drift; the integration tests exercise both an SDK v1 and an SDK v2
client against the Worker.

**Auth.** Every `/mcp` and `/sse` request must carry `Authorization: Bearer <MCP_API_KEY>`; comparison is
constant-time; missing/invalid → `401 {"error":"unauthorized"}` with `WWW-Authenticate`; an unset secret → `503`
rather than an open server. CORS preflights pass without a token so browser-based inspectors work.

**Caching and budget.** `HttpLedgerSource` memoises successful upstream responses for 30 s per isolate (the spec
allows up to 60 s), so a `daily_review` that calls five tools costs the upstream a handful of requests, not dozens.
Nothing is persisted by this Worker; the DO exists only to hold SSE sessions.

## Deploy

### With wrangler (normal path)

```bash
cd projects/ledger-mcp
npx wrangler login
npm run deploy
npx wrangler secret put MCP_API_KEY           # paste a fresh 32-byte hex, e.g. `openssl rand -hex 32`
# optional:
npx wrangler secret put ALPACA_KEY_ID
npx wrangler secret put ALPACA_SECRET_KEY
# leave demo mode by adding "LEDGER_BASE_URL" to `vars` in wrangler.jsonc (or `wrangler secret put` it)
```

`wrangler.jsonc` already enables `workers_dev`, disables preview URLs, turns on observability and declares the
SQLite Durable Object migration (`v1`). No routes, DNS or zone settings are touched.

### With the REST API only (what the first deployment used)

Useful when no wrangler login/API token is available on the machine but an authenticated API client is (for
instance the Cloudflare MCP server). Build, then upload the module as a multipart `PUT`:

```bash
npx wrangler deploy --dry-run --outdir=dist           # produces dist/index.js
```

```
PUT /accounts/{account_id}/workers/scripts/ledger-mcp     (multipart/form-data)
  metadata (application/json):
    { "main_module": "index.js",
      "compatibility_date": "2026-10-01",
      "compatibility_flags": ["nodejs_compat"],
      "bindings": [
        { "type": "durable_object_namespace", "name": "MCP_OBJECT", "class_name": "LedgerMcp" },
        { "type": "plain_text", "name": "LEDGER_DEFAULT_ID", "text": "demo" } ],
      "migrations": { "new_tag": "v1", "new_sqlite_classes": ["LedgerMcp"] },
      "observability": { "enabled": true } }
  index.js (application/javascript+module)
POST /accounts/{account_id}/workers/scripts/ledger-mcp/subdomain   { "enabled": true, "previews_enabled": false }
PUT  /accounts/{account_id}/workers/scripts/ledger-mcp/secrets     { "name": "MCP_API_KEY", "text": "...", "type": "secret_text" }
```

Subsequent uploads must omit `migrations` (the DO class already exists) unless a new migration tag is intended.

### Free-plan budget

| Limit (Free) | This Worker |
| --- | --- |
| 100 000 requests/day | one MCP call = one request (plus one DO request on `/sse`) |
| 10 ms CPU per invocation | tool calls are JSON + SHA-256 over ≤ 2000 small events (≈ 1–3 ms); PnL over 5000 events stays well inside |
| 50 subrequests per request | worst case `ledger_pnl` = 1 head + 5 pages; `ledger_verify` = 1 head + 2 pages + 1 verify |
| 3 MB compressed script | ≈ 650 KB gzip (agents + two MCP SDKs + zod) |
| Durable Objects: SQLite backend only | `new_sqlite_classes`, used only for SSE sessions; zero storage writes |
| No R2 / paid add-ons | none used |

## Hardening: OAuth / Access

A static bearer token is the right size for a single-owner server, and it is what the spec asked for. Two
upgrades fit without changing the tools:

1. **Cloudflare Access in front of `/mcp`** — put the hostname behind an Access application and validate the
   `Cf-Access-Jwt-Assertion` header in `auth.ts` (issuer = team domain, audience = app AUD tag). Clients
   authenticate with their identity provider instead of a shared secret. Requires a custom hostname on a zone,
   which this deployment intentionally does not touch.
2. **MCP OAuth** — serve `/.well-known/oauth-protected-resource` and run `@cloudflare/workers-oauth-provider`
   (or delegate to an upstream IdP) so MCP clients obtain per-user tokens; `agents` and both MCP SDKs already
   support the client side. This also removes the need to paste the token into `mcp.json`.

Either way, keep the `401 + WWW-Authenticate` behaviour: clients use it to discover that auth is required.

## Notes

- `npm audit` reports advisories in the **MCP SDK's OAuth client flow**, which this server never invokes
  (it does no outbound OAuth). `agents` pins the two SDK versions exactly, so the fix lands with the next `agents`
  release; re-run `npm audit` after bumping it.
- `worker-configuration.d.ts` is generated by `npm run typecheck` and git-ignored on purpose.
- The Worker enforces `Content-Type: application/json` and `Accept: application/json, text/event-stream`
  exactly as the Streamable HTTP spec requires; curl without those headers gets `406` / `415` from the SDK, and
  a plain `GET /mcp` gets `405` (the stateless lane has no server-initiated stream). Not bugs.

## License

MIT © 2026 Yupeng Lu — see [LICENSE](./LICENSE).
