/**
 * Integration tests run inside workerd via @cloudflare/vitest-plugin: `SELF` is the Worker
 * from wrangler.jsonc (with the MCP_API_KEY test binding from vitest.config.ts). Real MCP SDK
 * clients — v1 (`@modelcontextprotocol/sdk`, legacy era) and v2 (`@modelcontextprotocol/client`,
 * stateless era) — talk to it over Streamable HTTP with a bearer header.
 */
import { Client as LegacyClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport as LegacyStreamableTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const BASE = "https://ledger-mcp.test";
const KEY = env.MCP_API_KEY as string;
const authHeaders = { Authorization: `Bearer ${KEY}` };
const viaSelf: typeof fetch = (input, init) => SELF.fetch(input, init);

// The v1 client types `callTool` as a union that still includes the pre-2025 `{ toolResult }` shape.
function text(result: { content?: unknown; toolResult?: unknown }): string {
  if (!Array.isArray(result.content)) throw new Error("expected a content array");
  const block = (result.content as Array<{ type: string; text?: string }>)[0];
  if (!block || block.type !== "text" || typeof block.text !== "string") throw new Error("expected a text content block");
  return block.text;
}

describe("HTTP surface", () => {
  it("serves the landing page without leaking the key", async () => {
    const response = await SELF.fetch(`${BASE}/`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    const html = await response.text();
    expect(html).toContain("ledger-mcp");
    expect(html).toContain("/mcp");
    expect(html).not.toContain(KEY);
  });

  it("reports liveness in demo mode", async () => {
    const response = await SELF.fetch(`${BASE}/healthz`);
    expect(await response.json()).toMatchObject({ ok: true, mode: "demo", marketData: false });
  });

  it("returns 401 JSON on /mcp and /sse without a valid bearer token", async () => {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
    const missing = await SELF.fetch(`${BASE}/mcp`, { method: "POST", headers, body });
    expect(missing.status).toBe(401);
    expect(missing.headers.get("www-authenticate")).toContain("Bearer");
    expect(await missing.json()).toMatchObject({ error: "unauthorized" });

    const wrong = await SELF.fetch(`${BASE}/mcp`, { method: "POST", headers: { ...headers, authorization: `Bearer ${KEY.slice(0, -1)}x` }, body });
    expect(wrong.status).toBe(401);

    const sse = await SELF.fetch(`${BASE}/sse`);
    expect(sse.status).toBe(401);
  });

  it("answers CORS preflight on /mcp without credentials", async () => {
    const response = await SELF.fetch(`${BASE}/mcp`, { method: "OPTIONS", headers: { origin: "http://localhost:6274" } });
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-headers")).toContain("Authorization");
  });

  it("404s unknown routes", async () => {
    const response = await SELF.fetch(`${BASE}/nope`);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: "not_found" });
  });

  it("opens the legacy SSE lane with a token", async () => {
    const response = await SELF.fetch(`${BASE}/sse`, { headers: authHeaders });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = response.body!.getReader();
    const { value } = await reader.read();
    expect(new TextDecoder().decode(value)).toMatch(/^event: endpoint\ndata: \/sse\/message\?sessionId=/);
    await reader.cancel();
  });
});

describe("MCP over Streamable HTTP — legacy (SDK v1) client", () => {
  it("lists tools and calls ledger_head / ledger_pnl on the demo ledger", async () => {
    const client = new LegacyClient({ name: "ledger-mcp-test-v1", version: "0.0.0" });
    const transport = new LegacyStreamableTransport(new URL(`${BASE}/mcp`), { requestInit: { headers: authHeaders }, fetch: viaSelf });
    await client.connect(transport);
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((t) => t.name).sort()).toEqual(["ledger_events", "ledger_head", "ledger_pnl", "ledger_summary", "ledger_verify", "market_bars", "market_quote"]);

      const head = JSON.parse(text(await client.callTool({ name: "ledger_head", arguments: { ledgerId: "demo" } })));
      expect(head).toMatchObject({ ledgerId: "demo", seq: 242, count: 242, source: { kind: "demo" } });
      expect(head.headHash).toMatch(/^[0-9a-f]{64}$/);

      const pnl = JSON.parse(text(await client.callTool({ name: "ledger_pnl", arguments: { ledgerId: "demo" } })));
      expect(pnl).toMatchObject({ method: "fifo", feesIncluded: false, symbolFilter: null, coverage: { events: 242, truncated: false } });
      expect(pnl.symbols.map((s: { symbol: string }) => s.symbol)).toEqual(["AAPL", "MSFT", "NVDA", "SPY"]);
      expect(typeof pnl.realizedPnl).toBe("number");

      const filtered = JSON.parse(text(await client.callTool({ name: "ledger_pnl", arguments: { ledgerId: "demo", symbol: "nvda" } })));
      expect(filtered.symbolFilter).toBe("NVDA");
      expect(filtered.symbols).toHaveLength(1);

      const quote = await client.callTool({ name: "market_quote", arguments: { symbol: "AAPL" } });
      expect(quote.isError).toBe(true);
      expect(text(quote)).toContain("not configured");

      const prompts = await client.listPrompts();
      expect(prompts.prompts.map((p) => p.name)).toEqual(["daily_review"]);
    } finally {
      await client.close();
    }
  });
});

describe("MCP over Streamable HTTP — stateless (SDK v2) client", () => {
  it("verifies the chain, reads resources and renders the prompt", async () => {
    const client = new Client({ name: "ledger-mcp-test-v2", version: "0.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { requestInit: { headers: authHeaders }, fetch: viaSelf });
    await client.connect(transport);
    try {
      const tools = await client.listTools();
      expect(tools.tools).toHaveLength(7);

      const verify = JSON.parse(text(await client.callTool({ name: "ledger_verify", arguments: { ledgerId: "demo", from: 100 } })));
      expect(verify).toMatchObject({ range: { from: 100, to: 242, clamped: false }, local: { ok: true, checked: 143, headMatchesLedgerHead: true }, remote: { ok: true, checked: 143 }, agree: true });
      expect(verify.local.headHash).toBe(verify.remote.headHash);

      const events = JSON.parse(text(await client.callTool({ name: "ledger_events", arguments: { ledgerId: "demo", since: 240, limit: 1 } })));
      expect(events).toMatchObject({ count: 1, nextSince: 241 });
      expect(events.events[0].seq).toBe(241);

      const summary = JSON.parse(text(await client.callTool({ name: "ledger_summary", arguments: { ledgerId: "demo", from: "2026-10-05", to: "2026-10-09" } })));
      expect(summary.source).toBe("computed");
      expect(summary.byDay.map((d: { date: string }) => d.date)).toEqual(["2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09"]);

      const unknown = await client.callTool({ name: "ledger_head", arguments: { ledgerId: "missing" } });
      expect(unknown.isError).toBe(true);
      expect(text(unknown)).toContain("unknown ledger");

      const resources = await client.listResources();
      expect(resources.resources.map((r) => r.uri)).toEqual(["ledger://about", "ledger://demo/head", "ledger://demo/summary"]);
      const templates = await client.listResourceTemplates();
      expect(templates.resourceTemplates.map((t) => t.uriTemplate)).toEqual(["ledger://{ledgerId}/head", "ledger://{ledgerId}/summary"]);

      const about = await client.readResource({ uri: "ledger://about" });
      expect((about.contents[0] as { text: string }).text).toContain("sha256_hex(prevHash");
      const head = await client.readResource({ uri: "ledger://demo/head" });
      expect(JSON.parse((head.contents[0] as { text: string }).text)).toMatchObject({ seq: 242 });

      const prompt = await client.getPrompt({ name: "daily_review", arguments: { ledgerId: "demo", date: "2026-10-09" } });
      expect(prompt.messages).toHaveLength(1);
      expect((prompt.messages[0]!.content as { text: string }).text).toContain('ledger_verify(ledgerId="demo")');
    } finally {
      await client.close();
    }
  });
});
