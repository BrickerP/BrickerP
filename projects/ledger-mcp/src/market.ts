/**
 * Alpaca Market Data v2 (https://docs.alpaca.markets/reference/stocklatestquotesingle-1).
 * Only reached when ALPACA_KEY_ID / ALPACA_SECRET_KEY are configured — the tools never
 * fabricate quotes or bars.
 */
import { LIMITS } from "./env";

export const ALPACA_DATA_BASE = "https://data.alpaca.markets";

export const BAR_TIMEFRAMES = ["1Min", "5Min", "15Min", "30Min", "1Hour", "1Day", "1Week", "1Month"] as const;
export type BarTimeframe = (typeof BAR_TIMEFRAMES)[number];

export interface MarketCredentials {
  keyId: string;
  secretKey: string;
}

export interface Quote {
  symbol: string;
  ts: string;
  bid: { price: number; size: number; exchange: string } | null;
  ask: { price: number; size: number; exchange: string } | null;
  source: "alpaca";
}

export interface Bar {
  t: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  vw?: number;
  n?: number;
}

export class MarketDataError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "MarketDataError";
  }
}

export function marketCredentials(env: { ALPACA_KEY_ID?: string; ALPACA_SECRET_KEY?: string }): MarketCredentials | null {
  if (!env.ALPACA_KEY_ID || !env.ALPACA_SECRET_KEY) return null;
  return { keyId: env.ALPACA_KEY_ID, secretKey: env.ALPACA_SECRET_KEY };
}

export const MARKET_NOT_CONFIGURED =
  "market data is not configured: set the ALPACA_KEY_ID and ALPACA_SECRET_KEY secrets (wrangler secret put …). No data is fabricated.";

export class AlpacaMarketData {
  constructor(
    private readonly creds: MarketCredentials,
    private readonly fetchImpl: typeof fetch = (input, init) => fetch(input, init),
    private readonly base: string = ALPACA_DATA_BASE,
  ) {}

  async latestQuote(symbol: string): Promise<Quote> {
    const sym = normalizeSymbol(symbol);
    const data = await this.get<{ symbol?: string; quote?: Record<string, unknown> }>(`/v2/stocks/${encodeURIComponent(sym)}/quotes/latest`);
    const q = data.quote;
    if (!q) throw new MarketDataError(`no quote returned for ${sym}`);
    const num = (key: string) => (typeof q[key] === "number" ? (q[key] as number) : null);
    const str = (key: string) => (typeof q[key] === "string" ? (q[key] as string) : "");
    const bp = num("bp");
    const ap = num("ap");
    return {
      symbol: sym,
      ts: str("t"),
      bid: bp !== null ? { price: bp, size: num("bs") ?? 0, exchange: str("bx") } : null,
      ask: ap !== null ? { price: ap, size: num("as") ?? 0, exchange: str("ax") } : null,
      source: "alpaca",
    };
  }

  async bars(symbol: string, timeframe: BarTimeframe, limit: number): Promise<{ symbol: string; timeframe: BarTimeframe; bars: Bar[]; nextPageToken: string | null }> {
    const sym = normalizeSymbol(symbol);
    const capped = Math.min(LIMITS.bars, Math.max(1, Math.floor(limit)));
    const data = await this.get<{ bars?: Bar[] | null; next_page_token?: string | null }>(
      `/v2/stocks/${encodeURIComponent(sym)}/bars`,
      { timeframe, limit: String(capped), sort: "desc" },
    );
    const bars = (data.bars ?? []).slice().sort((a, b) => a.t.localeCompare(b.t));
    return { symbol: sym, timeframe, bars, nextPageToken: data.next_page_token ?? null };
  }

  private async get<T>(path: string, params: Record<string, string> = {}): Promise<T> {
    const url = new URL(this.base + path);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    let response: Response;
    try {
      response = await this.fetchImpl(url.toString(), {
        headers: {
          "APCA-API-KEY-ID": this.creds.keyId,
          "APCA-API-SECRET-KEY": this.creds.secretKey,
          accept: "application/json",
        },
        signal: AbortSignal.timeout(8_000),
      });
    } catch (error) {
      throw new MarketDataError(`Alpaca market data unreachable: ${(error as Error).message}`);
    }
    if (!response.ok) {
      const body = (await response.text().catch(() => "")).slice(0, 200);
      throw new MarketDataError(`Alpaca market data ${response.status} for ${url.pathname}${body ? `: ${body}` : ""}`, response.status);
    }
    return (await response.json()) as T;
  }
}

export function normalizeSymbol(symbol: string): string {
  const sym = symbol.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9.\-]{0,11}$/.test(sym)) throw new MarketDataError(`invalid symbol "${symbol}"`);
  return sym;
}
