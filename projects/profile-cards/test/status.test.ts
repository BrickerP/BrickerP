import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { collectStatus, configFromEnv, getStatus, isDegraded, MEMORY_KEY, parseTtl, type StatusConfig, type Stored } from "../src/status.js";
import { fakeDeps, json, NOW, sampleCommit, sampleFill, sampleHeartbeat } from "./helpers.js";

const config: StatusConfig = {
  githubUser: "BrickerP",
  githubFallbackRepo: "BrickerP/BrickerP",
  githubToken: undefined,
  ledgerBaseUrl: "https://ledger.example",
  ledgerId: "demo",
  heartbeatBaseUrl: "https://hb.example",
  heartbeatMonitorId: "scan-batch",
  ttlSeconds: 300,
};

const githubRoutes = {
  "https://api.github.com/users/BrickerP/events/public": () =>
    json([{ type: "PushEvent", repo: { name: "BrickerP/BrickerP" }, payload: { ref: "refs/heads/main", head: sampleCommit.sha }, created_at: sampleCommit.at }]),
  [`https://api.github.com/repos/BrickerP/BrickerP/commits/${sampleCommit.sha}`]: () =>
    json({ sha: sampleCommit.sha, html_url: sampleCommit.url, commit: { message: sampleCommit.message, committer: { date: sampleCommit.at } } }),
};

const ledgerRoutes = {
  "https://ledger.example/v1/ledgers/demo/head": () => json({ ledgerId: "demo", seq: 1204, count: 1204, headHash: sampleFill.headHash, updatedAt: sampleFill.ts }),
  "https://ledger.example/v1/ledgers/demo/events": () =>
    json({ events: [{ id: "e", ts: sampleFill.ts, type: "fill", symbol: "AAPL", side: "buy", qty: 12, price: 187.42, seq: 1204, hash: "h" }] }),
};

const heartbeatRoutes = {
  "https://hb.example/v1/monitors/scan-batch": () =>
    json({ id: "scan-batch", name: "scan-batch", state: "up", lastBeatAt: sampleHeartbeat.lastBeatAt, nextDeadline: sampleHeartbeat.nextDeadline, stats: { count: 200, p50Ms: 1800, p95Ms: 2400 }, p95ThresholdMs: 5000 }),
};

const healthyRoutes = { ...githubRoutes, ...ledgerRoutes, ...heartbeatRoutes };

describe("parseTtl", () => {
  it("clamps and defaults", () => {
    expect(parseTtl("300")).toBe(300);
    expect(parseTtl("5")).toBe(30);
    expect(parseTtl("99999")).toBe(3600);
    expect(parseTtl("nope")).toBe(300);
    expect(parseTtl(undefined, 120)).toBe(120);
  });
});

describe("collectStatus", () => {
  it("queries all sources in parallel and remembers successes", async () => {
    const deps = fakeDeps(healthyRoutes);
    const stored = await collectStatus(config, deps, null);
    expect(stored.status.fill).toMatchObject({ state: "ok", data: { symbol: "AAPL", seq: 1204 } });
    expect(stored.status.heartbeat).toMatchObject({ state: "ok", data: { state: "up", p95Ms: 2400 } });
    expect(stored.status.commit).toMatchObject({ state: "ok", data: { sha: sampleCommit.sha, ref: "main" } });
    expect(stored.memory.fill?.data.symbol).toBe("AAPL");
    expect(stored.memory.commit?.data.sha).toBe(sampleCommit.sha);
    expect(isDegraded(stored.status)).toBe(false);
  });

  it("marks unconfigured sources without touching the network", async () => {
    const deps = fakeDeps(healthyRoutes);
    const stored = await collectStatus({ ...config, ledgerBaseUrl: null, heartbeatBaseUrl: null }, deps, null);
    expect(stored.status.fill).toEqual({ state: "unconfigured" });
    expect(stored.status.heartbeat).toEqual({ state: "unconfigured" });
    expect(deps.calls.every((url) => url.startsWith("https://api.github.com"))).toBe(true);
  });

  it("falls back to remembered values when a source fails", async () => {
    const deps = fakeDeps({
      ...ledgerRoutes,
      "https://hb.example/v1/monitors/scan-batch": () => new Response("boom", { status: 503 }),
      "https://api.github.com/": () => new Response("", { status: 403, headers: { "x-ratelimit-remaining": "0" } }),
    });
    const previous = {
      updatedAt: "2026-10-10T07:00:00Z",
      heartbeat: { data: sampleHeartbeat, fetchedAt: "2026-10-10T07:00:00Z" },
    };
    const stored = await collectStatus(config, deps, previous);
    expect(stored.status.heartbeat).toMatchObject({ state: "stale", error: "http 503", fetchedAt: "2026-10-10T07:00:00Z", data: { state: "up" } });
    expect(stored.status.commit).toEqual({ state: "error", error: "rate limited" });
    expect(stored.status.fill.state).toBe("ok");
    expect(stored.memory.heartbeat?.fetchedAt).toBe("2026-10-10T07:00:00Z");
    expect(isDegraded(stored.status)).toBe(true);
  });
});

describe("getStatus with KV memory", () => {
  beforeEach(async () => {
    await env.MEMORY.delete(MEMORY_KEY);
  });

  it("serves a fresh stored status without contacting any source", async () => {
    const stored: Stored = {
      version: 1,
      status: {
        renderedAt: "2026-10-10T07:39:00Z",
        fill: { state: "ok", data: sampleFill, fetchedAt: "2026-10-10T07:39:00Z" },
        heartbeat: { state: "ok", data: sampleHeartbeat, fetchedAt: "2026-10-10T07:39:00Z" },
        commit: { state: "ok", data: sampleCommit, fetchedAt: "2026-10-10T07:39:00Z" },
      },
      memory: { updatedAt: "2026-10-10T07:39:00Z" },
    };
    await env.MEMORY.put(MEMORY_KEY, JSON.stringify(stored));
    const deps = fakeDeps(healthyRoutes);
    const ctx = createExecutionContext();
    const result = await getStatus(env, ctx, deps, config);
    await waitOnExecutionContext(ctx);
    expect(result.cached).toBe(true);
    expect(result.status.renderedAt).toBe("2026-10-10T07:39:00Z");
    expect(deps.calls).toEqual([]);
  });

  it("refreshes an expired status and persists it", async () => {
    const stale: Stored = {
      version: 1,
      status: { renderedAt: "2026-10-10T06:00:00Z", fill: { state: "unconfigured" }, heartbeat: { state: "unconfigured" }, commit: { state: "unconfigured" } },
      memory: { updatedAt: "2026-10-10T06:00:00Z" },
    };
    await env.MEMORY.put(MEMORY_KEY, JSON.stringify(stale));
    const deps = fakeDeps(healthyRoutes);
    const ctx = createExecutionContext();
    const result = await getStatus(env, ctx, deps, config);
    await waitOnExecutionContext(ctx);
    expect(result.cached).toBe(false);
    expect(result.status.renderedAt).toBe(NOW.toISOString());
    expect(deps.calls.length).toBeGreaterThan(0);
    const persisted = await env.MEMORY.get<Stored>(MEMORY_KEY, "json");
    expect(persisted?.status.renderedAt).toBe(NOW.toISOString());
    expect(persisted?.memory.fill?.data.symbol).toBe("AAPL");
  });

  it("reads configuration from the Worker environment", () => {
    const fromEnv = configFromEnv(env);
    expect(fromEnv.githubUser).toBe("BrickerP");
    expect(fromEnv.ledgerBaseUrl).toBeNull();
    expect(fromEnv.heartbeatBaseUrl).toBeNull();
    expect(fromEnv.ttlSeconds).toBe(300);
  });
});
