/**
 * The MCP surface (tools, resources, prompt) defined once and registered against either
 * MCP SDK generation through the small `Registrar` adapter:
 *
 *   - SDK v2 `McpServer` (`@modelcontextprotocol/server`) behind the stateless `/mcp` route
 *   - SDK v1 `McpServer` (`@modelcontextprotocol/sdk`) inside the legacy `McpAgent` for `/sse`
 */
import { z } from "zod";
import { DemoLedgerSource } from "../demo/source";
import { LIMITS, SERVER_NAME, SERVER_VERSION, defaultLedgerId, type LedgerEnv } from "../env";
import { GENESIS_HASH, verifyChain, type ChainCheck } from "../ledger/hash";
import { HttpLedgerSource } from "../ledger/http";
import { LedgerSourceError, clampLimit, collectEvents, type LedgerSource } from "../ledger/source";
import type { ChainedEvent, VerifyResult } from "../ledger/types";
import { AlpacaMarketData, BAR_TIMEFRAMES, MARKET_NOT_CONFIGURED, MarketDataError, marketCredentials } from "../market";
import { computeFifoPnl } from "../pnl";
import { computeSummary } from "../summary";

// ---------------------------------------------------------------------------------------------
// Adapter types

/** Structurally compatible with `CallToolResult` of both SDK generations (type alias on purpose). */
export type TextResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

/** Parsed tool / prompt arguments for a raw zod shape. */
export type ArgsOf<S extends z.ZodRawShape> = z.output<z.ZodObject<S>>;

export interface ToolDef<S extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  title: string;
  description: string;
  input: S;
  readOnly: boolean;
  /** True when the tool reaches outside the ledger (market data). */
  openWorld: boolean;
  run(args: ArgsOf<S>): Promise<TextResult>;
}

export interface ResourceDef {
  name: string;
  uri: string;
  title: string;
  description: string;
  mimeType: string;
  read(uri: URL): Promise<string>;
}

export interface ResourceTemplateDef {
  name: string;
  uriTemplate: string;
  title: string;
  description: string;
  mimeType: string;
  list?: () => Array<{ uri: string; name: string; description?: string; mimeType?: string }>;
  read(uri: URL, variables: Record<string, string | string[]>): Promise<string>;
}

export interface PromptMessage {
  role: "user" | "assistant";
  content: { type: "text"; text: string };
}

export interface PromptDef<S extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  title: string;
  description: string;
  args: S;
  get(args: ArgsOf<S>): Promise<{ description?: string; messages: PromptMessage[] }>;
}

/**
 * Erased definitions handed to the SDK adapters. `run`/`get` are method signatures, so a
 * `ToolDef<{ ledgerId: ZodString }>` is assignable here while keeping precise types where the
 * tools are written.
 */
export type AnyToolDef = ToolDef<z.ZodRawShape>;
export type AnyPromptDef = PromptDef<z.ZodRawShape>;

export interface Registrar {
  tool(def: AnyToolDef): void;
  resource(def: ResourceDef): void;
  resourceTemplate(def: ResourceTemplateDef): void;
  prompt(def: AnyPromptDef): void;
}

// ---------------------------------------------------------------------------------------------
// Dependencies

export interface LedgerDeps {
  source: LedgerSource;
  market: AlpacaMarketData | null;
  defaultLedgerId: string;
}

export function createDeps(env: LedgerEnv): LedgerDeps {
  const source: LedgerSource = env.LEDGER_BASE_URL ? new HttpLedgerSource(env.LEDGER_BASE_URL) : new DemoLedgerSource();
  const creds = marketCredentials(env);
  return { source, market: creds ? new AlpacaMarketData(creds) : null, defaultLedgerId: defaultLedgerId(env) };
}

export const SERVER_INSTRUCTIONS = [
  `${SERVER_NAME} exposes a hash-chained trading execution ledger (Alpaca bracket-order fills) and optional market data.`,
  "Start with ledger_head to learn the ledger size, then ledger_events / ledger_summary / ledger_pnl.",
  "ledger_verify recomputes the SHA-256 hash chain locally and compares it with the ledger service's own verification.",
  "Realized PnL is FIFO lot matching over fills and ignores fees. Market tools return an error unless Alpaca credentials are configured — nothing is fabricated.",
  "Use the daily_review prompt for a structured end-of-day review.",
].join(" ");

// ---------------------------------------------------------------------------------------------
// Schemas

const ledgerIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9._-]+$/, "ledgerId may contain letters, digits, dot, underscore and dash")
  .describe('Ledger identifier (the demo dataset is "demo").');
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");
const symbolSchema = z.string().min(1).max(12).describe("Ticker symbol, e.g. AAPL (case-insensitive).");

// ---------------------------------------------------------------------------------------------
// Helpers

function json(value: unknown, pretty = true): TextResult {
  return { content: [{ type: "text", text: pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value) }] };
}

function toolError(tool: string, error: unknown): TextResult {
  const message = error instanceof Error ? error.message : String(error);
  const prefix = error instanceof LedgerSourceError ? "ledger source error" : error instanceof MarketDataError ? "market data error" : "error";
  return { isError: true, content: [{ type: "text", text: `${tool}: ${prefix}: ${message}` }] };
}

function describeSource(source: LedgerSource) {
  return { kind: source.kind, label: source.label };
}

function define<S extends z.ZodRawShape>(def: ToolDef<S>): ToolDef<S> {
  const run = def.run;
  return { ...def, run: (args) => run(args).catch((error) => toolError(def.name, error)) };
}

// ---------------------------------------------------------------------------------------------
// Tool implementations (shared by resources and the prompt)

async function summaryFor(source: LedgerSource, ledgerId: string, range?: { from?: string; to?: string }) {
  if (!range?.from && !range?.to && source.summary) {
    try {
      const summary = await source.summary(ledgerId);
      return { ledgerId, ...summary, source: "remote" as const, origin: describeSource(source) };
    } catch (error) {
      if (error instanceof LedgerSourceError && error.status === 404 && source.kind === "demo") throw error;
      // Fall back to a local computation when the upstream summary is unavailable.
      const collected = await collectEvents(source, ledgerId, { maxEvents: LIMITS.pnlEvents });
      return {
        ledgerId,
        ...computeSummary(collected.events),
        source: "computed" as const,
        origin: describeSource(source),
        fallbackReason: error instanceof Error ? error.message : String(error),
        coverage: coverage(collected),
      };
    }
  }
  const collected = await collectEvents(source, ledgerId, { maxEvents: LIMITS.pnlEvents });
  return {
    ledgerId,
    range: { from: range?.from ?? null, to: range?.to ?? null },
    ...computeSummary(collected.events, range),
    source: "computed" as const,
    origin: describeSource(source),
    coverage: coverage(collected),
  };
}

function coverage(collected: { events: ChainedEvent[]; truncated: boolean; nextSince: number; pages: number; headSeq: number }) {
  return {
    events: collected.events.length,
    fromSeq: collected.events[0]?.seq ?? null,
    toSeq: collected.events[collected.events.length - 1]?.seq ?? null,
    headSeq: collected.headSeq,
    truncated: collected.truncated,
    nextSince: collected.truncated ? collected.nextSince : null,
    pages: collected.pages,
  };
}

export interface VerifyReport {
  ledgerId: string;
  range: { from: number; to: number; requested: { from: number | null; to: number | null }; clamped: boolean };
  local: ChainCheck & { headMatchesLedgerHead: boolean | null };
  remote: VerifyResult | { error: string };
  agree: boolean | null;
  genesisHash: string;
}

async function verifyRange(source: LedgerSource, ledgerId: string, requested: { from?: number; to?: number }): Promise<VerifyReport> {
  const head = await source.head(ledgerId);
  const firstSeq = head.seq - head.count + 1;
  const to = Math.min(head.seq, requested.to ?? head.seq);
  let from = Math.max(firstSeq, requested.from ?? to - LIMITS.verifyRange + 1);
  let clamped = false;
  if (to - from + 1 > LIMITS.verifyRange) {
    from = to - LIMITS.verifyRange + 1;
    clamped = true;
  }

  const events: ChainedEvent[] = [];
  let since = from - 1;
  while (since < to && events.length < LIMITS.verifyRange) {
    const page = await source.events(ledgerId, { since, limit: clampLimit(to - since) });
    for (const event of page.events) if (event.seq >= from && event.seq <= to) events.push(event);
    if (page.nextSince <= since) break;
    since = page.nextSince;
  }
  const local = await verifyChain(events, { firstSeq });
  const headMatchesLedgerHead = to === head.seq && local.ok && local.checked > 0 ? local.headHash === head.headHash : null;

  let remote: VerifyReport["remote"];
  try {
    remote = await source.verify(ledgerId, { from, to });
  } catch (error) {
    remote = { error: error instanceof Error ? error.message : String(error) };
  }
  const agree = "error" in remote ? null : remote.ok === local.ok && remote.headHash === local.headHash && remote.checked === local.checked;

  return {
    ledgerId,
    range: { from, to, requested: { from: requested.from ?? null, to: requested.to ?? null }, clamped },
    local: { ...local, headMatchesLedgerHead },
    remote,
    agree,
    genesisHash: GENESIS_HASH,
  };
}

// ---------------------------------------------------------------------------------------------
// Registration

export function registerLedgerCapabilities(registrar: Registrar, deps: LedgerDeps): void {
  const { source, market } = deps;

  registrar.tool(
    define({
      name: "ledger_head",
      title: "Ledger head",
      description: "Current head of a ledger: last sequence number, event count, head hash and last update time. Call this first.",
      input: { ledgerId: ledgerIdSchema },
      readOnly: true,
      openWorld: false,
      run: async ({ ledgerId }) => json({ ...(await source.head(ledgerId)), source: describeSource(source) }),
    }),
  );

  registrar.tool(
    define({
      name: "ledger_events",
      title: "Ledger events",
      description: `Page through chained ledger events (fills, orders, cancels, notes) in sequence order. Returns at most ${LIMITS.eventsPerCall} events per call; pass the returned nextSince to continue.`,
      input: {
        ledgerId: ledgerIdSchema,
        since: z.number().int().min(0).optional().describe("Return events with seq > since (default 0 = from the beginning)."),
        limit: z.number().int().min(1).max(LIMITS.eventsPerCall).optional().describe(`Page size, 1..${LIMITS.eventsPerCall} (default ${LIMITS.eventsPerCall}).`),
        symbol: symbolSchema.optional(),
      },
      readOnly: true,
      openWorld: false,
      run: async ({ ledgerId, since, limit, symbol }) => {
        const page = await source.events(ledgerId, { since, limit, symbol });
        return json({ ledgerId, count: page.events.length, nextSince: page.nextSince, events: page.events, source: describeSource(source) }, false);
      },
    }),
  );

  registrar.tool(
    define({
      name: "ledger_summary",
      title: "Ledger summary",
      description: `Fills, bought/sold quantity and notional per day and per symbol. Uses the ledger service's /summary when available and no date range is given; otherwise computed locally from up to ${LIMITS.pnlEvents} events.`,
      input: {
        ledgerId: ledgerIdSchema,
        from: dateSchema.optional().describe("Inclusive start date (UTC) YYYY-MM-DD."),
        to: dateSchema.optional().describe("Inclusive end date (UTC) YYYY-MM-DD."),
      },
      readOnly: true,
      openWorld: false,
      run: async ({ ledgerId, from, to }) => json(await summaryFor(source, ledgerId, { from, to })),
    }),
  );

  registrar.tool(
    define({
      name: "ledger_pnl",
      title: "Realized PnL (FIFO)",
      description: `Realized PnL by FIFO lot matching over fills (long and short→cover), per symbol and in total. Fees, commissions and dividends are ignored. Folds at most ${LIMITS.pnlEvents} events (paged internally); the response says if it was truncated.`,
      input: { ledgerId: ledgerIdSchema, symbol: symbolSchema.optional() },
      readOnly: true,
      openWorld: false,
      run: async ({ ledgerId, symbol }) => {
        const collected = await collectEvents(source, ledgerId, { symbol, maxEvents: LIMITS.pnlEvents });
        const report = computeFifoPnl(collected.events, symbol);
        return json({
          ledgerId,
          symbolFilter: symbol?.toUpperCase() ?? null,
          ...report,
          note: "Gross PnL from fills only: fees, commissions, borrow costs and dividends are not included.",
          coverage: coverage(collected),
          source: describeSource(source),
        });
      },
    }),
  );

  registrar.tool(
    define({
      name: "ledger_verify",
      title: "Verify hash chain",
      description: `Re-fetch a range of events, recompute the SHA-256 hash chain locally (hash = sha256(prevHash + "\\n" + canonicalJSON(event))) and compare with the ledger service's /verify result. Ranges are capped at ${LIMITS.verifyRange} events; defaults to the newest ${LIMITS.verifyRange}.`,
      input: {
        ledgerId: ledgerIdSchema,
        from: z.number().int().min(0).optional().describe("First seq to check (inclusive)."),
        to: z.number().int().min(0).optional().describe("Last seq to check (inclusive, default = head)."),
      },
      readOnly: true,
      openWorld: false,
      run: async ({ ledgerId, from, to }) => json(await verifyRange(source, ledgerId, { from, to })),
    }),
  );

  registrar.tool(
    define({
      name: "market_quote",
      title: "Latest quote",
      description: "Latest NBBO-style bid/ask for a US equity from Alpaca Market Data v2. Errors when Alpaca credentials are not configured (no data is fabricated).",
      input: { symbol: symbolSchema },
      readOnly: true,
      openWorld: true,
      run: async ({ symbol }) => {
        if (!market) return { isError: true, content: [{ type: "text", text: `market_quote: ${MARKET_NOT_CONFIGURED}` }] };
        return json(await market.latestQuote(symbol));
      },
    }),
  );

  registrar.tool(
    define({
      name: "market_bars",
      title: "OHLCV bars",
      description: `Recent OHLCV bars for a US equity from Alpaca Market Data v2 (oldest first). Errors when Alpaca credentials are not configured. limit ≤ ${LIMITS.bars}.`,
      input: {
        symbol: symbolSchema,
        timeframe: z.enum(BAR_TIMEFRAMES).default("1Day").describe("Bar size."),
        limit: z.number().int().min(1).max(LIMITS.bars).default(30).describe("Number of most recent bars."),
      },
      readOnly: true,
      openWorld: true,
      run: async ({ symbol, timeframe, limit }) => {
        if (!market) return { isError: true, content: [{ type: "text", text: `market_bars: ${MARKET_NOT_CONFIGURED}` }] };
        return json(await market.bars(symbol, timeframe, limit), false);
      },
    }),
  );

  registrar.resource({
    name: "about",
    uri: "ledger://about",
    title: "About this ledger server",
    description: "Data source, HTTP contract and hash-chain definition.",
    mimeType: "text/markdown",
    read: async () => aboutMarkdown(deps),
  });

  registrar.resourceTemplate({
    name: "ledger-head",
    uriTemplate: "ledger://{ledgerId}/head",
    title: "Ledger head",
    description: "Head (seq, count, headHash, updatedAt) of a ledger as JSON.",
    mimeType: "application/json",
    list: () => [{ uri: `ledger://${deps.defaultLedgerId}/head`, name: `head (${deps.defaultLedgerId})`, mimeType: "application/json" }],
    read: async (_uri, variables) => JSON.stringify({ ...(await source.head(variableString(variables.ledgerId))), source: describeSource(source) }, null, 2),
  });

  registrar.resourceTemplate({
    name: "ledger-summary",
    uriTemplate: "ledger://{ledgerId}/summary",
    title: "Ledger summary",
    description: "Per-day and per-symbol fills, quantities and notional as JSON.",
    mimeType: "application/json",
    list: () => [{ uri: `ledger://${deps.defaultLedgerId}/summary`, name: `summary (${deps.defaultLedgerId})`, mimeType: "application/json" }],
    read: async (_uri, variables) => JSON.stringify(await summaryFor(source, variableString(variables.ledgerId)), null, 2),
  });

  registrar.prompt(
    definePrompt({
      name: "daily_review",
      title: "Daily trading review",
      description: "Structured end-of-day review of a ledger: fills, realized PnL, chain integrity, anomalies and follow-ups.",
      args: {
        ledgerId: ledgerIdSchema,
        date: dateSchema.optional().describe("Trading date (UTC) to review, YYYY-MM-DD. Defaults to the ledger's latest date."),
      },
      get: async ({ ledgerId, date }) => ({
        description: `Daily review of ledger ${ledgerId}${date ? ` for ${date}` : ""}`,
        messages: [{ role: "user", content: { type: "text", text: dailyReviewPrompt(ledgerId, date) } }],
      }),
    }),
  );
}

/** Identity helper so the prompt literal is inferred with its precise argument shape. */
function definePrompt<S extends z.ZodRawShape>(def: PromptDef<S>): PromptDef<S> {
  return def;
}

function variableString(value: string | string[] | undefined): string {
  const first = Array.isArray(value) ? value[0] : value;
  if (!first) throw new LedgerSourceError("ledgerId missing from resource URI", 400);
  return decodeURIComponent(first);
}

export function dailyReviewPrompt(ledgerId: string, date?: string): string {
  const day = date ?? "the most recent trading date in the ledger (use the last event's ts)";
  return [
    `You are reviewing the trading execution ledger "${ledgerId}" for ${day}. Use the ledger tools in this order and do not guess numbers:`,
    "",
    `1. ledger_head(ledgerId="${ledgerId}") — note seq, count and headHash.`,
    `2. ledger_summary(ledgerId="${ledgerId}"${date ? `, from="${date}", to="${date}"` : ""}) — fills, quantities and notional per symbol for the day.`,
    `3. ledger_events(ledgerId="${ledgerId}", limit=1000) — page with nextSince if needed; keep only type="fill" events whose ts falls on the review date.`,
    `4. ledger_pnl(ledgerId="${ledgerId}") — realized FIFO PnL per symbol (fees are ignored) and open positions.`,
    `5. ledger_verify(ledgerId="${ledgerId}") — confirm local.ok, remote.ok and agree are all true.`,
    "",
    "Then write the review with these sections:",
    "- **Fills** — table: time (UTC), symbol, side, qty, price, bracket leg (meta.leg).",
    "- **Realized PnL** — per symbol and total; state clearly that fees are excluded. Mention open positions and average open price.",
    "- **Integrity** — range checked, head hash, whether local and remote verification agree. Any mismatch is a blocking finding.",
    "- **Anomalies** — unusual sizes, flips from long to short, cancels, fills outside 13:30–20:00 UTC, duplicate order ids.",
    "- **Follow-ups** — concrete, prioritized actions for the next session.",
    "",
    "Keep it under 300 words, cite seq numbers for anything surprising, and say explicitly when data was unavailable.",
  ].join("\n");
}

export function aboutMarkdown(deps: LedgerDeps): string {
  const { source } = deps;
  return `# ${SERVER_NAME} ${SERVER_VERSION}

Remote MCP server on Cloudflare Workers exposing a hash-chained trading execution ledger.

- Data source: **${source.kind}** (${source.label})
- Market data: ${deps.market ? "Alpaca Market Data v2 configured" : "not configured (market_* tools return an error)"}
- Default ledgerId: \`${deps.defaultLedgerId}\`

## Hash chain

\`\`\`
LedgerEvent  = { id, ts (ISO-8601 UTC), type: fill|order|cancel|note, symbol?, side?, qty?, price?, orderId?, broker?, meta? }
ChainedEvent = LedgerEvent & { seq, prevHash, hash }
hash         = sha256_hex(prevHash + "\\n" + canonicalJSON(event))   // event = the bare LedgerEvent
genesis      = prevHash of the first event = ${GENESIS_HASH}
canonicalJSON: recursively key-sorted JSON, no whitespace, numbers as JSON
\`\`\`

## Upstream HTTP contract (open-ledger)

\`\`\`
GET /v1/ledgers/:ledgerId/head      → { ledgerId, seq, count, headHash, updatedAt }
GET /v1/ledgers/:ledgerId/events    ?since=<seq>&limit=<n ≤ 1000>&symbol=<sym> → { events: ChainedEvent[], nextSince }
GET /v1/ledgers/:ledgerId/snapshots ?from=YYYY-MM-DD&to=YYYY-MM-DD → { snapshots: [{ date, seq, count, headHash }] }
GET /v1/ledgers/:ledgerId/verify    ?from=<seq>&to=<seq> → { ok, checked, from, to, headHash }
GET /v1/ledgers/:ledgerId/summary   → { byDay: [...], bySymbol: [...] }
\`\`\`

## Limits (Workers Free plan)

- ledger_events: ≤ ${LIMITS.eventsPerCall} events per call
- ledger_pnl / computed ledger_summary: ≤ ${LIMITS.pnlEvents} events (paged internally)
- ledger_verify: ≤ ${LIMITS.verifyRange} events per call
- market_bars: ≤ ${LIMITS.bars} bars

Realized PnL is FIFO lot matching over fills; fees are ignored.
`;
}
