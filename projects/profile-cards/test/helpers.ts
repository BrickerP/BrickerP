import type { CommitInfo, Deps, FillInfo, HeartbeatInfo } from "../src/types.js";

export const NOW = new Date("2026-10-10T07:41:00Z");

export type Route = (url: URL, init: RequestInit | undefined) => Response | Promise<Response>;

/** Build a Deps whose fetch dispatches on URL prefix and records every call. */
export function fakeDeps(routes: Record<string, Route>, now: Date = NOW): Deps & { calls: string[] } {
  const calls: string[] = [];
  const deps: Deps & { calls: string[] } = {
    calls,
    now: () => now,
    timeoutMs: 1000,
    fetch: async (input, init) => {
      calls.push(input);
      const url = new URL(input);
      const key = Object.keys(routes).find((prefix) => input.startsWith(prefix));
      if (!key) return new Response("no route", { status: 599 });
      const route = routes[key];
      if (!route) return new Response("no route", { status: 599 });
      return route(url, init);
    },
  };
  return deps;
}

export const json = (body: unknown, init: ResponseInit = {}): Response =>
  new Response(JSON.stringify(body), { ...init, headers: { "Content-Type": "application/json", ...(init.headers ?? {}) } });

export const sampleFill: FillInfo = {
  ledgerId: "demo",
  seq: 1204,
  count: 1204,
  headHash: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678901234567890abcdefabcdef",
  type: "fill",
  symbol: "AAPL",
  side: "buy",
  qty: 12,
  price: 187.42,
  ts: "2026-10-10T07:38:00Z",
};

export const sampleHeartbeat: HeartbeatInfo = {
  monitorId: "scan-batch",
  name: "scan-batch",
  state: "up",
  lastBeatAt: "2026-10-10T07:40:18Z",
  nextDeadline: "2026-10-10T07:47:18Z",
  count: 200,
  p50Ms: 1800,
  p95Ms: 2400,
  p95ThresholdMs: 5000,
};

export const sampleCommit: CommitInfo = {
  repo: "BrickerP/BrickerP",
  ref: "main",
  sha: "1b04034abcdef0123456789abcdef0123456789a",
  message: "Add plain-Markdown profile header above the zine <3 & more\n\nBody text",
  at: "2026-10-10T05:41:00Z",
  url: "https://github.com/BrickerP/BrickerP/commit/1b04034abcdef0123456789abcdef0123456789a",
};
