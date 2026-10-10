/**
 * ledger-mcp — remote MCP server for a hash-chained trading ledger on Cloudflare Workers.
 *
 *   GET  /            landing page with setup instructions (no secrets)
 *   GET  /healthz     liveness + mode (no auth)
 *   POST /mcp         Streamable HTTP MCP (stateless, SDK v2 via agents/mcp/server)   [bearer]
 *   GET  /sse         legacy HTTP+SSE MCP lane (McpAgent Durable Object)              [bearer]
 *   POST /sse/message legacy SSE message endpoint                                     [bearer]
 */
import { createMcpHandler } from "agents/mcp/server";
import { authenticate, jsonError } from "./auth";
import { SERVER_NAME, SERVER_VERSION, type LedgerEnv } from "./env";
import { landingHtml } from "./landing";
import { LedgerMcp } from "./mcp/legacy-agent";
import { createLedgerServer } from "./mcp/server";

export { LedgerMcp };

export const TOOL_NAMES = ["ledger_head", "ledger_events", "ledger_summary", "ledger_pnl", "ledger_verify", "market_quote", "market_bars"] as const;

const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
};

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;

    if (pathname === "/mcp") {
      // CORS preflights carry no Authorization header; the handler answers them with headers only.
      if (request.method !== "OPTIONS") {
        const auth = authenticate(request, env.MCP_API_KEY);
        if (!auth.ok) return auth.response;
      }
      // A fresh handler per request keeps `env` in scope for the server factory; we use no
      // listen-stream notifications, so no handler state needs to outlive the request.
      const handler = createMcpHandler(() => createLedgerServer(env), { route: "/mcp" });
      return handler(request, env, ctx);
    }

    if (pathname === "/sse" || pathname.startsWith("/sse/")) {
      if (request.method !== "OPTIONS") {
        const auth = authenticate(request, env.MCP_API_KEY);
        if (!auth.ok) return auth.response;
      }
      return LedgerMcp.serveSSE("/sse", { binding: "MCP_OBJECT" }).fetch(request, env, ctx);
    }

    if (pathname === "/healthz") {
      return Response.json(
        { ok: true, name: SERVER_NAME, version: SERVER_VERSION, mode: env.LEDGER_BASE_URL ? "http" : "demo", marketData: Boolean(env.ALPACA_KEY_ID && env.ALPACA_SECRET_KEY) },
        { headers: SECURITY_HEADERS },
      );
    }

    if (pathname === "/" && (request.method === "GET" || request.method === "HEAD")) {
      const html = landingHtml({
        origin: url.origin,
        mode: env.LEDGER_BASE_URL ? "http" : "demo",
        sourceLabel: env.LEDGER_BASE_URL ? safeHost(env.LEDGER_BASE_URL) : "built-in demo dataset",
        marketConfigured: Boolean(env.ALPACA_KEY_ID && env.ALPACA_SECRET_KEY),
        toolNames: TOOL_NAMES,
      });
      return new Response(request.method === "HEAD" ? null : html, {
        headers: { "content-type": "text/html; charset=utf-8", ...SECURITY_HEADERS, "cache-control": "public, max-age=300" },
      });
    }

    return jsonError(404, "not_found", `no route for ${request.method} ${pathname}`);
  },
} satisfies ExportedHandler<LedgerEnv>;

function safeHost(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return "configured ledger";
  }
}
