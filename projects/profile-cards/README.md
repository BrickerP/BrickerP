# profile-cards

Live SVG status cards for a GitHub profile README, rendered at the edge by a Cloudflare Worker.

A README image is static by nature. This Worker turns one `<img>` into a status strip that is re-rendered from live sources every few minutes: the latest fill from a trading ledger, the scan-batch p95 and heartbeat state of the bot, and the latest public commit. It is the literal version of the "A Profile With Memory" experiment in this repository: the profile has state.

```
GitHub README ──<img src=…/card.svg>──▶ camo ──▶ Cloudflare edge cache (Workers Cache)
                                                        │ miss / expired
                                                        ▼
                                                 profile-cards Worker
                                        ┌───────────────┼────────────────┐
                                        ▼               ▼                ▼
                                  GitHub events    open-ledger       heartbeat
                                  (last commit)    (last fill)    (p95 + state)
                                        └───────────────┼────────────────┘
                                                        ▼
                                              KV "MEMORY": last status +
                                              last-known-good per source
```

## What the card shows

| Tile | Source | Notes |
| --- | --- | --- |
| Last fill | [`projects/open-ledger`](../open-ledger) `GET /v1/ledgers/:id/head` + `/events` | symbol, side, qty @ price, age, ledger seq, head hash prefix |
| Scan p95 | [`projects/heartbeat`](../heartbeat) `GET /v1/monitors/:id` | p95, p50, beat count, threshold; red when over threshold |
| Heartbeat | same monitor | `UP` / `LATE` / `DOWN` / `DEGRADED`, last beat, next deadline |
| Last commit | GitHub public events (`PushEvent`) + commit detail | repo, branch, short SHA, first line of the message, age |

Every tile has four explicit states. **Live** data has a colored bar (mint, cobalt, red by meaning). **Stale** shows the last successful value with a yellow `STALE` tag and "last good … ago" when the live source fails. **Not wired** is rendered when a base URL variable is empty. **Offline** appears only when a source fails and nothing was ever remembered.

The palette, system font stack, crop marks and grain match the static Human Zine spreads in `assets/`. The card is 1200×400, uses no scripts, links, animations or remote resources, and escapes every piece of upstream text, so it is safe to embed through GitHub's image proxy.

## Endpoints

| Path | Description |
| --- | --- |
| `GET /card.svg` | The card. `Cache-Control: public, max-age=300` (60 s while any tile is degraded), weak `ETag`, `304` on `If-None-Match`. |
| `GET /status.json` | The same data as JSON, plus which sources are configured and whether the response came from memory or a live refresh. |
| `GET /` | Landing page with the live card and the embed snippet. |
| `GET /healthz` | `ok`. |

## How caching keeps this inside the free plan

1. **Workers Cache** (`"cache": { "enabled": true }` in `wrangler.jsonc`) lets Cloudflare serve `/card.svg` without executing the Worker while the response is fresh, and collapses concurrent misses. GitHub's camo proxy and browsers also honor the `Cache-Control` header.
2. **KV memory** gates upstream calls: the Worker stores the last computed status in KV with its timestamp and reuses it while it is younger than `CACHE_TTL_SECONDS`. Whatever the number of edge locations, the sources are polled about once per TTL.
3. **Last-known-good** values per source are kept in the same KV record, so an upstream outage or GitHub rate limit degrades the tile to *stale* instead of blanking it.

Budget at the default 5-minute TTL: ≈ 300 KV writes/day (limit 1,000), a few hundred KV reads, ≈ 600 GitHub API calls/day (two per refresh) against the 60/hour unauthenticated limit per egress IP — set `GITHUB_TOKEN` to move to 5,000/hour, which matters because Workers egress IPs are shared. Rendering is string templating only, far below the 10 ms CPU limit.

## Configuration

Variables live in `wrangler.jsonc`:

| Variable | Default | Meaning |
| --- | --- | --- |
| `GITHUB_USER` | `BrickerP` | Whose public events feed to read. |
| `GITHUB_FALLBACK_REPO` | `BrickerP/BrickerP` | Used when the feed has no push or is unavailable. |
| `LEDGER_BASE_URL` | *(empty)* | open-ledger origin, e.g. `https://open-ledger.brickerp.workers.dev`. Empty = tile not wired. |
| `LEDGER_ID` | `demo` | Ledger to read. |
| `HEARTBEAT_BASE_URL` | *(empty)* | heartbeat origin. Empty = tiles not wired. |
| `HEARTBEAT_MONITOR_ID` | `scan-batch` | Monitor to read. |
| `CACHE_TTL_SECONDS` | `300` | Freshness window, clamped to 30–3600. |
| `CARD_TITLE` | `FIELD NOTES · LIVE STATUS` | Header text. |

Secret (optional): `GITHUB_TOKEN` — `npx wrangler secret put GITHUB_TOKEN`. A fine-grained token with no permissions is enough for public data.

Fetching sibling Workers on the same `workers.dev` subdomain (heartbeat, open-ledger) needs the `global_fetch_strictly_public` compatibility flag, which `wrangler.jsonc` sets. Without it Cloudflare answers a Worker-to-Worker `fetch()` on the same zone with `404 error code: 1042`; the tile then reports `worker fetch blocked (1042)` in `/status.json` instead of a bare `http 404`. A service binding is the alternative if you prefer not to route through the public edge.

## Develop

```sh
npm install
cp .dev.vars.example .dev.vars   # optional GITHUB_TOKEN
npm run dev                      # http://127.0.0.1:8787/card.svg
npm test                         # vitest inside the Workers runtime
npm run typecheck                # wrangler types + tsc
```

Tests cover formatting, every source parser (including GitHub rate limiting and timeouts), the memory/stale fallback logic against a real KV binding, the renderer (escaping, palette, states) and the HTTP routes.

## Deploy

```sh
npm run deploy                   # wrangler deploy
npx wrangler secret put GITHUB_TOKEN
```

The KV namespace id in `wrangler.jsonc` belongs to the author's account; create your own with `npx wrangler kv namespace create MEMORY` and replace the id. The Worker was first deployed through the Cloudflare REST API (multipart script upload + `workers.dev` subdomain) from an agent session without Wrangler credentials; `wrangler deploy` is the normal path.

To embed:

```html
<img src="https://profile-cards.brickerp.workers.dev/card.svg" width="100%" alt="Live status card">
```

## Limitations

- GitHub's public events API omits commit lists, so the message needs a second request; if that one fails the tile still shows repo, SHA and age.
- The card is only as live as the slowest cache in front of it (Cloudflare, camo, the browser). Expect up to ~5 minutes of lag at the default TTL.
- KV is eventually consistent; two edge locations can briefly disagree about which status is current. This is harmless for a status card.
- `wrangler dev` runs KV locally, so local memory is separate from production memory.

## License

MIT © 2026 Yupeng Lu
