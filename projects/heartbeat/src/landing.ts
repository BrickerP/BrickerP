import { escapeXml } from "./svg";

const CSS = `
:root{color-scheme:light dark;--fg:#1f2328;--muted:#59636e;--bg:#fff;--card:#f6f8fa;--line:#d0d7de;--accent:#0969da}
@media(prefers-color-scheme:dark){:root{--fg:#e6edf3;--muted:#9198a1;--bg:#0d1117;--card:#161b22;--line:#30363d;--accent:#4493f8}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 -apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif}
main{max-width:860px;margin:0 auto;padding:40px 20px 64px}h1{font-size:28px;margin:0 0 4px}h2{font-size:18px;margin:32px 0 10px}
p.lead{color:var(--muted);margin:0 0 24px}code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px}
pre{background:var(--card);border:1px solid var(--line);border-radius:6px;padding:12px 14px;overflow-x:auto}
table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid var(--line);padding:8px 6px;text-align:left;vertical-align:top}
th{color:var(--muted);font-weight:600;font-size:13px}a{color:var(--accent)}.pill{display:inline-block;border:1px solid var(--line);border-radius:999px;padding:0 8px;font-size:12px;color:var(--muted)}
.states span{display:inline-block;margin:0 10px 6px 0}.sw{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:5px;vertical-align:-1px}
`;

export function landingHtml(origin: string): string {
	const o = escapeXml(origin);
	const m = `${o}/v1/monitors/scan-batch`;
	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>heartbeat</title><link rel="icon" href="data:,"><style>${CSS}</style></head>
<body><main>
<h1>heartbeat <span class="pill">Workers + Durable Objects</span></h1>
<p class="lead">A dead-man's switch and p95 latency gate for cron jobs and bots. Each monitor is one SQLite-backed Durable Object with its own alarm, so a job that stops reporting, or whose p95 duration crosses a threshold, flips a badge and sends a notification.</p>

<h2>States</h2>
<p class="states">
<span><i class="sw" style="background:#4c1"></i><code>up</code> beating on time</span>
<span><i class="sw" style="background:#dfb317"></i><code>late</code> past <code>expectEverySec</code>, still within grace</span>
<span><i class="sw" style="background:#fe7d37"></i><code>degraded</code> p95 above threshold for 3 beats, or last beat failed</span>
<span><i class="sw" style="background:#e05d44"></i><code>down</code> grace exhausted</span>
<span><i class="sw" style="background:#9f9f9f"></i><code>unknown</code> no beat yet</span>
</p>

<h2>API</h2>
<table>
<tr><th>Method</th><th>Path</th><th>Auth</th><th>Purpose</th></tr>
<tr><td>PUT</td><td><code>/v1/monitors/:id</code></td><td>admin</td><td>Create or update. Returns the beat token once on create.</td></tr>
<tr><td>POST</td><td><code>/v1/monitors/:id/beat</code></td><td>beat token</td><td>Report a run: <code>{ durationMs?, status?: "ok"|"fail", meta? }</code></td></tr>
<tr><td>GET</td><td><code>/v1/monitors/:id</code></td><td>public*</td><td>Status JSON: state, stats (p50/p95/p99, fail rate), last 20 incidents</td></tr>
<tr><td>GET</td><td><code>/v1/monitors/:id/badge.svg</code></td><td>public*</td><td>shields-style badge, cached 60s</td></tr>
<tr><td>GET</td><td><code>/v1/monitors/:id/sparkline.svg?n=120&amp;w=600&amp;h=120</code></td><td>public*</td><td>Recent durations with the p95 threshold line</td></tr>
<tr><td>GET</td><td><code>/v1/monitors/:id/history?limit=100</code></td><td>public*</td><td>Raw beats, newest first</td></tr>
<tr><td>DELETE</td><td><code>/v1/monitors/:id</code></td><td>admin</td><td>Remove the monitor and its data</td></tr>
</table>
<p class="lead" style="margin-top:8px">* monitors created with <code>"public": false</code> require the beat token (or admin token) for every GET. Monitor ids match <code>[a-z0-9-]{1,64}</code>.</p>

<h2>Create a monitor</h2>
<pre>curl -sS -X PUT ${m} \\
  -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' \\
  -d '{"name":"scan-batch","expectEverySec":300,"graceSec":120,"p95ThresholdMs":5000}'</pre>

<h2>Send a beat</h2>
<pre>curl -sS -X POST ${m}/beat \\
  -H "Authorization: Bearer $BEAT_TOKEN" -H 'Content-Type: application/json' \\
  -d '{"durationMs":2400,"status":"ok"}'</pre>

<h2>Embed the badge</h2>
<pre>![scan-batch](${m}/badge.svg)
![scan-batch p95](${m}/sparkline.svg?n=120&amp;w=600&amp;h=120)</pre>
</main></body></html>`;
}
