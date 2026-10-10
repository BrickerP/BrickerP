# heartbeat

A dead-man's switch and p95 latency gate for cron jobs and bots, running on Cloudflare Workers
(free plan) with one SQLite-backed Durable Object per monitor. Jobs `POST` a beat after each
run; the service notices when a job **stops reporting** or when its **p95 duration crosses a
threshold**, opens an incident, pings Telegram / a webhook, and exposes JSON plus SVG badges
you can drop into a README.

```markdown
![scan-batch](https://heartbeat.<subdomain>.workers.dev/v1/monitors/scan-batch/badge.svg)
![scan-batch p95](https://heartbeat.<subdomain>.workers.dev/v1/monitors/scan-batch/sparkline.svg)
```

## Why

On 2026-10-08 a backfill cron started holding SQLite's write lock while the scan-batch job
was running. The job never failed — it just got slow: p95 went from roughly 2.4 s to 9.2 s
and stayed there for most of a day before anyone looked at a log. Uptime checks did not fire
(the job was still "up"), and exit-code monitoring did not fire (it still exited 0).

The two failure modes this service is built to catch:

1. **The job stops reporting** — crashed host, broken crontab, hung process, expired token.
   This is the classic dead-man's switch: silence past `expectEverySec + graceSec` means
   `down`.
2. **The job keeps reporting but gets slow** — a nearest-rank p95 over the last `windowSize`
   beats is compared against `p95ThresholdMs` on every beat, with hysteresis so a single
   slow run does not flap the badge.

## How it works

```
 cron / bot ──POST /v1/monitors/:id/beat──▶ Worker (router, auth, SVG rendering)
                                               │  RPC
                                               ▼
                                 Durable Object `Monitor` (one per monitor id)
                                   ├─ SQLite: config · beats ring buffer · incidents
                                   ├─ alarm at lastBeatAt + (expectEvery + grace)
                                   └─ fetch() ──▶ Telegram / JSON webhook
```

- **Worker** (`src/index.ts`) validates ids and bodies, resolves auth (admin token vs. beat
  token, constant-time compare), calls the Durable Object over RPC and renders SVG. JSON
  responses are `no-store`; SVGs carry an `ETag`, `public, max-age=60` and CORS headers.
- **Durable Object** (`src/monitor.ts`) owns all state for one monitor in SQLite:
  - `config` — thresholds, notification targets, the **sha256 of the beat token**, derived
    liveness, hysteresis streaks and the next deadline;
  - `beats` — a ring buffer trimmed to `windowSize` rows (default 200, max 5000);
  - `incidents` — one open incident per kind (`missed`, `p95`, `fail`) plus closed
    `recovered` records; the last 200 are kept, the last 20 are returned.
- **Alarms** replace cron triggers (the free plan allows five per account). Every beat re-arms
  the alarm at `now + (expectEverySec + graceSec)`. When it fires without a beat the monitor
  goes `down`, a `missed` incident opens, a notification is sent, and reminders follow with
  exponential backoff — `max(60 s, expectEverySec) × 2^(n−1)`, capped at 6 h — until a beat
  arrives, which closes the incident and sends `recovered`. The alarm handler catches every
  error and re-arms itself so a transient failure can never silence a monitor.

### States

| state      | meaning                                                                                   | badge colour |
| ---------- | ----------------------------------------------------------------------------------------- | ------------ |
| `up`       | last beat within `expectEverySec` and nothing else wrong                                  | green        |
| `late`     | past `expectEverySec` but still inside the grace window (derived, no alarm, no notification) | yellow    |
| `down`     | alarm fired with no beat: `missed` incident open, reminders active                        | red          |
| `degraded` | p95 above threshold for ≥ 3 consecutive beats, or the last beat reported `status: "fail"` | orange       |
| `unknown`  | created, never beaten                                                                     | grey         |

Liveness wins: a monitor that is both slow and silent shows `down`. The p95 gate degrades
after **three consecutive** beats whose running p95 is above the threshold and recovers after
**three consecutive** beats below it, so the badge cannot flap on a single outlier. Setting
`p95ThresholdMs: null` disables the gate and clears any open `p95` incident.

### Notifications

Each monitor may carry a Telegram target (`notify.telegram.botToken` + `chatId`) and/or a
JSON webhook (`notify.webhookUrl`). Both get the same event:

```json
{ "monitorId": "scan-batch", "name": "scan-batch", "kind": "missed", "state": "down",
  "p95Ms": 2380, "at": "2026-10-10T08:00:00.000Z",
  "detail": "No beat for 7m (expected every 5.0m, grace 2.0m). Next reminder in 5.0m",
  "url": "https://heartbeat.<subdomain>.workers.dev/v1/monitors/scan-batch" }
```

Rules: one open incident per kind; at most one notification per minute per monitor (events
that coincide in a single beat are coalesced, highest priority `missed > fail > p95 >
recovered`); outbound requests time out after 8 s and run in `waitUntil`, so a slow Telegram
API never delays a beat response.

## Quick start (local)

```bash
cd projects/heartbeat
npm ci
cp .dev.vars.example .dev.vars        # then put a real random value in ADMIN_TOKEN
npm run dev                           # http://localhost:8787
```

```bash
ADMIN=$(sed -n 's/^ADMIN_TOKEN=//p' .dev.vars)
HB=http://localhost:8787

# 1. create a monitor (returns the beat token exactly once)
curl -sS -X PUT $HB/v1/monitors/scan-batch \
  -H "Authorization: Bearer $ADMIN" -H 'content-type: application/json' \
  -d '{"expectEverySec":300,"graceSec":120,"p95ThresholdMs":5000}'

# 2. beat from the job
curl -sS -X POST $HB/v1/monitors/scan-batch/beat \
  -H "Authorization: Bearer hb_..." -H 'content-type: application/json' \
  -d '{"durationMs":2400}'

# 3. look
curl -sS $HB/v1/monitors/scan-batch | jq .state
curl -sS $HB/v1/monitors/scan-batch/badge.svg -o badge.svg
```

`npm test` runs the Worker/Durable Object suite inside workerd via
[`@cloudflare/vitest-plugin`](https://developers.cloudflare.com/workers/testing/vitest-integration/)
(the renamed successor of `@cloudflare/vitest-pool-workers`), `npm run typecheck` regenerates
`worker-configuration.d.ts` and type-checks `src/` and `test/`, and `npm run test:python`
runs the Python client against a stub HTTP server.

## API

Base path `/v1/monitors/:id`, ids match `[a-z0-9-]{1,64}`. Auth is `Authorization: Bearer …`.
`admin` means the `ADMIN_TOKEN` secret; `beat` means the monitor's own token (admin also
works). Reads on a **public** monitor (the default) need no token; on a private one
(`"public": false`) every `GET` needs the beat token or admin.

| method   | path             | auth           | purpose                                                      |
| -------- | ---------------- | -------------- | ------------------------------------------------------------ |
| `GET`    | `/`              | –              | landing page with these docs                                 |
| `PUT`    | `/`              | admin          | create or update a monitor (JSON body below) → `201` / `200` |
| `DELETE` | `/`              | admin          | delete monitor, beats, incidents and alarm                   |
| `GET`    | `/`              | public or beat | status JSON                                                  |
| `POST`   | `/beat`          | beat           | record a run; body optional                                  |
| `GET`    | `/badge.svg`     | public or beat | shields-style flat badge                                     |
| `GET`    | `/sparkline.svg` | public or beat | last `n` durations with the p95 threshold line (`?n=120&w=600&h=120`) |
| `GET`    | `/history`       | public or beat | newest beats first (`?limit=100`, max 5000)                  |

Errors are JSON `{ "error": "…" }` with `400` (invalid id/body), `401` (missing or wrong
token, with `www-authenticate: Bearer`), `404` (unknown monitor), `405`, `503` (admin route
called while `ADMIN_TOKEN` is unset).

### `PUT` body

```jsonc
{
  "name": "scan-batch",          // optional display name, ≤ 100 chars
  "expectEverySec": 300,         // required on create, 1 … 2592000
  "graceSec": 120,               // default 0
  "p95ThresholdMs": 5000,        // > 0, or null to disable the gate (default null)
  "windowSize": 200,             // beats kept and used for percentiles, 1 … 5000
  "public": true,                // false ⇒ GETs need the beat token
  "notify": {                    // optional, or null to clear
    "telegram": { "botToken": "123456:ABC…", "chatId": "-1001234567890" },
    "webhookUrl": "https://example.com/hooks/heartbeat"
  },
  "beatToken": "my-own-secret"   // optional; omit to have one generated (printable ASCII 16 … 256)
}
```

Response: `{ "ok": true, "created": true, "beatToken": "hb_…", "monitor": { …status… } }`.
The token is returned **only when the service generated it**, and only once — it is stored
as a sha256 hash. Sending `beatToken` on an update rotates it. Updates are partial: fields
you omit keep their values.

### `POST /beat` body (all optional)

```json
{ "durationMs": 2400, "status": "ok", "meta": { "rows": 1532, "host": "oakrelay" } }
```

`status` is `ok` (default) or `fail`; `meta` is any JSON ≤ 4 KB and shows up in `/history`
and in incident details (`error`, `message` and `exitCode` keys are quoted). Response:
`{ "ok": true, "state": "up", "p95Ms": 2380, "nextDeadline": "2026-10-10T08:07:00.000Z" }`.

### Status JSON

```json
{
  "id": "scan-batch", "name": "scan-batch", "state": "up", "public": true,
  "expectEverySec": 300, "graceSec": 120, "p95ThresholdMs": 5000, "windowSize": 200,
  "createdAt": "…", "lastBeatAt": "…", "nextDeadline": "…",
  "stats": { "count": 30, "p50Ms": 2400, "p95Ms": 2480, "p99Ms": 2500, "failRate": 0 },
  "incidents": [ { "id": 3, "kind": "recovered", "openedAt": "…", "closedAt": "…", "detail": "Beats resumed after 13m" } ]
}
```

## Clients

### curl

```bash
# plain beat (no duration → liveness only)
curl -fsS -m 10 -X POST "$HEARTBEAT_URL/beat" -H "Authorization: Bearer $HEARTBEAT_TOKEN"

# crontab: time the job, report duration + status, never fail the cron line because of the monitor
*/5 * * * * S=$(date +%s%3N); /opt/jobs/scan-batch; C=$?; \
  curl -fsS -m 10 -X POST "$HEARTBEAT_URL/beat" -H "Authorization: Bearer $HEARTBEAT_TOKEN" \
  -H 'content-type: application/json' \
  -d "{\"durationMs\":$(( $(date +%s%3N) - S )),\"status\":\"$([ $C -eq 0 ] && echo ok || echo fail)\",\"meta\":{\"exitCode\":$C}}" >/dev/null || true
```

### Shell: `clients/shell/hb`

Bash + curl, nothing else. Times a command and reports its duration and exit code; always exits
with the command's own code, even if the beat could not be delivered.

```bash
hb https://…/v1/monitors/scan-batch hb_… -- python scan_batch.py --since yesterday
HEARTBEAT_URL=… HEARTBEAT_TOKEN=… hb -- ./nightly.sh      # env-var form
hb https://…/v1/monitors/scan-batch hb_…                 # plain beat
```

Options via environment: `HEARTBEAT_TIMEOUT` (curl seconds, default 10), `HEARTBEAT_QUIET=1`,
`HEARTBEAT_VERBOSE=1`.

### Python: `clients/python/heartbeat.py`

Zero dependencies (urllib); copy the file next to the job. Every call has a timeout
(default 5 s) and **never raises for network or HTTP errors** — they are logged on the
`heartbeat` logger and `beat()` returns `None`.

```python
from heartbeat import beat, timed, span, Heartbeat

beat(URL, TOKEN, duration_ms=2400)                 # one-off

@timed(URL, TOKEN)                                  # sync or async def; exceptions → status=fail, then re-raised
def scan_batch(): ...

with span(URL, TOKEN) as s:                         # time a block
    s.meta["rows"] = 123
    if too_few_rows: s.fail("empty batch")

hb = Heartbeat()                                    # reads HEARTBEAT_URL / HEARTBEAT_TOKEN
hb.beat(duration_ms=12)
```

Also a CLI: `python heartbeat.py URL TOKEN --duration-ms 2400` or
`python heartbeat.py URL TOKEN -- <command>` (times the command, reports its exit code, exits
with it). Tests: `python3 -m unittest discover -s clients/python -p 'test_*.py' -v`.

## Badges

```markdown
![scan-batch](https://heartbeat.<subdomain>.workers.dev/v1/monitors/scan-batch/badge.svg)
![scan-batch latency](https://heartbeat.<subdomain>.workers.dev/v1/monitors/scan-batch/sparkline.svg?n=60&w=480&h=90)
```

Badge text by state: `up · p95 2.4s`, `late 2m`, `down 13m`, `degraded · p95 9.2s`,
`degraded · failing`, `unknown`. Both SVGs are served with `cache-control: public, max-age=60`
and an `ETag`; GitHub's camo proxy respects that, so a README badge lags reality by about a
minute. Append `?v=1` style query strings if you need to bust a stale cache.

## Deploy

### With wrangler

```bash
cd projects/heartbeat
npx wrangler login
npm run deploy                                   # creates the Durable Object class via migration v1
npx wrangler secret put ADMIN_TOKEN              # paste e.g. `openssl rand -hex 32`
```

`wrangler.jsonc` enables `workers_dev`, so the Worker answers at
`https://heartbeat.<account-subdomain>.workers.dev`. No KV, R2, queues or custom domains are
used; nothing in this project bills.

### With the REST API (no wrangler login)

```bash
npx wrangler deploy --dry-run --outdir=dist              # bundles to dist/index.js
cat > dist/metadata.json <<'EOF'
{ "main_module": "index.js", "compatibility_date": "2026-10-01",
  "bindings": [ { "type": "durable_object_namespace", "name": "MONITOR", "class_name": "Monitor" } ],
  "migrations": { "new_tag": "v1", "new_sqlite_classes": [ "Monitor" ] },
  "observability": { "enabled": true } }
EOF
A=https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/workers
curl -fsS -X PUT "$A/scripts/heartbeat" -H "Authorization: Bearer $CF_API_TOKEN" \
  -F 'metadata=@dist/metadata.json;type=application/json' \
  -F 'index.js=@dist/index.js;type=application/javascript+module'
curl -fsS -X POST "$A/scripts/heartbeat/subdomain" -H "Authorization: Bearer $CF_API_TOKEN" \
  -H 'content-type: application/json' -d '{"enabled":true,"previews_enabled":false}'
curl -fsS -X PUT "$A/scripts/heartbeat/secrets" -H "Authorization: Bearer $CF_API_TOKEN" \
  -H 'content-type: application/json' -d "{\"name\":\"ADMIN_TOKEN\",\"text\":\"$(openssl rand -hex 32)\",\"type\":\"secret_text\"}"
```

Later deploys must drop `migrations` from the metadata (the class already exists). Rotate the
admin token at any time with `npx wrangler secret put ADMIN_TOKEN` — beat tokens are per
monitor and unaffected.

## Free-tier budget

| resource                    | free limit               | this service                                                                 |
| --------------------------- | ------------------------ | ---------------------------------------------------------------------------- |
| Worker requests             | 100 000 / day            | one beat per job run; 20 monitors every 5 min ≈ 5 800/day, plus badge views |
| CPU per request             | 10 ms                    | a beat is a handful of SQLite statements and one sort of ≤ `windowSize` numbers; well under 1 ms |
| Cron triggers               | 5 / account              | none — Durable Object alarms instead                                         |
| Durable Object requests     | 1 M / month              | ≈ 1 per beat + 1 per alarm + 1 per read                                      |
| DO SQLite storage           | 5 GB                     | ≈ 60 bytes per beat × `windowSize`; a few hundred KB per monitor at most     |
| Durable Objects             | SQLite backend on free   | `new_sqlite_classes` migration — no `new_classes`                            |

Badge traffic counts as Worker requests; the 60 s cache keeps README traffic in check.

## Security notes

- Beat tokens are random 24-byte base64url strings prefixed `hb_`; only their sha256 is
  stored, and comparison is constant-time. Admin auth uses `crypto.subtle.timingSafeEqual`.
- `ADMIN_TOKEN` lives in a Worker secret (locally in the gitignored `.dev.vars`); the admin
  routes return `503` instead of silently opening up when it is missing.
- Private monitors (`public: false`) hide status, badges, history and sparklines behind the
  beat token.
- Bodies are capped at 64 KB, `meta` at 4 KB; Telegram bot tokens and chat ids are format
  checked, webhooks must be `http(s)` URLs.
- Notification bodies may contain the monitor name and the `detail` text, which quotes
  `meta.error` / `meta.message`. Do not put secrets in `meta`.

## Limitations and follow-ups

- Notifications are rate limited to one per minute per monitor **strictly**: a `recovered`
  event within 60 s of the `missed` alert is dropped (the incident record still closes).
- `late` is derived at read time only; nothing is sent until the grace window expires.
- The p95 gate needs `durationMs`; beats without it only feed liveness and `failRate`.
- Sparklines render ≤ 2000 points; history is bounded by `windowSize` (≤ 5000).
- No per-monitor retention beyond the ring buffer; export `/history` if you need archives.
- Ideas: a `/v1/monitors` list endpoint for admins, maintenance windows (silence a monitor
  until a timestamp), a Markdown status page, Slack/Discord formatters.

## Layout

```
projects/heartbeat/
├── src/            index.ts (router) · monitor.ts (Durable Object) · stats.ts · svg.ts · notify.ts · validate.ts · util.ts · landing.ts
├── test/           vitest suites run inside workerd (API, Durable Object alarms/hysteresis, stats, SVG)
├── clients/        python/heartbeat.py (+ unittest) · shell/hb
├── wrangler.jsonc  Worker + Durable Object + SQLite migration
└── .dev.vars.example
```

Licensed under the [MIT License](./LICENSE).
