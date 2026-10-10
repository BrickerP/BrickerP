import { SERVER_NAME, SERVER_VERSION } from "./env";

export interface LandingInfo {
  origin: string;
  mode: "demo" | "http";
  sourceLabel: string;
  marketConfigured: boolean;
  toolNames: readonly string[];
}

const escape = (value: string) => value.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);

export function landingHtml(info: LandingInfo): string {
  const mcpUrl = `${info.origin}/mcp`;
  const cursorConfig = JSON.stringify(
    { mcpServers: { "ledger-mcp": { url: mcpUrl, headers: { Authorization: "Bearer <MCP_API_KEY>" } } } },
    null,
    2,
  );
  const claudeConfig = JSON.stringify(
    { mcpServers: { "ledger-mcp": { command: "npx", args: ["-y", "mcp-remote", mcpUrl, "--header", "Authorization: Bearer <MCP_API_KEY>"] } } },
    null,
    2,
  );
  const tools = info.toolNames.map((name) => `<li><code>${escape(name)}</code></li>`).join("");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${SERVER_NAME}</title>
<style>
  :root { color-scheme: light dark; --fg: #111; --bg: #f4f0e3; --accent: #1457ff; --muted: #555; }
  @media (prefers-color-scheme: dark) { :root { --fg: #f4f0e3; --bg: #111; --accent: #63e2b7; --muted: #aaa; } }
  body { margin: 0 auto; max-width: 48rem; padding: 2.5rem 1.25rem 4rem; font: 16px/1.55 ui-sans-serif, system-ui, sans-serif; color: var(--fg); background: var(--bg); }
  h1 { font-size: 1.75rem; margin: 0 0 .25rem; } h2 { font-size: 1.15rem; margin: 2rem 0 .5rem; }
  code, pre { font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
  pre { padding: .9rem 1rem; overflow-x: auto; border: 1px solid color-mix(in srgb, var(--fg) 20%, transparent); border-radius: 6px; }
  .muted { color: var(--muted); } a { color: var(--accent); } ul { padding-left: 1.2rem; }
  .pill { display: inline-block; padding: .05rem .5rem; border: 1px solid var(--accent); border-radius: 999px; font-size: .8rem; color: var(--accent); }
</style>
</head>
<body>
<h1>${SERVER_NAME} <span class="muted">v${SERVER_VERSION}</span></h1>
<p>Remote <a href="https://modelcontextprotocol.io">MCP</a> server on Cloudflare Workers exposing a hash-chained trading execution ledger (Alpaca bracket-order fills) and optional market data.</p>
<p><span class="pill">mode: ${info.mode}</span> <span class="muted">source: ${escape(info.sourceLabel)} · market data: ${info.marketConfigured ? "Alpaca configured" : "not configured"}</span></p>

<h2>Endpoints</h2>
<ul>
  <li><code>POST ${escape(mcpUrl)}</code> — Streamable HTTP (recommended)</li>
  <li><code>GET ${escape(info.origin)}/sse</code> — legacy HTTP+SSE lane for older clients</li>
  <li><code>GET ${escape(info.origin)}/healthz</code> — liveness (no auth)</li>
</ul>
<p>Both MCP endpoints require <code>Authorization: Bearer &lt;MCP_API_KEY&gt;</code>. The key is a deployment secret (<code>wrangler secret put MCP_API_KEY</code>); it is never shown here.</p>

<h2>Cursor (<code>.cursor/mcp.json</code>)</h2>
<pre>${escape(cursorConfig)}</pre>

<h2>Claude Desktop (via <code>mcp-remote</code>)</h2>
<pre>${escape(claudeConfig)}</pre>

<h2>Inspector</h2>
<pre>npx @modelcontextprotocol/inspector@latest --transport http --server-url ${escape(mcpUrl)} --header "Authorization: Bearer &lt;MCP_API_KEY&gt;"</pre>

<h2>Tools</h2>
<ul>${tools}</ul>
<p class="muted">Resources: <code>ledger://about</code>, <code>ledger://{ledgerId}/head</code>, <code>ledger://{ledgerId}/summary</code>. Prompt: <code>daily_review</code>.</p>
<p class="muted">Source: <a href="https://github.com/BrickerP/BrickerP/tree/main/projects/ledger-mcp">github.com/BrickerP/BrickerP · projects/ledger-mcp</a> (MIT).</p>
</body>
</html>
`;
}
