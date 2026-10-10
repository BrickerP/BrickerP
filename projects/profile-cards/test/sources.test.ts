import { describe, expect, it } from "vitest";
import { fetchLatestCommit } from "../src/sources/github.js";
import { fetchHeartbeat } from "../src/sources/heartbeat.js";
import { fetchLatestFill } from "../src/sources/ledger.js";
import { fakeDeps, json } from "./helpers.js";

const GH = "https://api.github.com";

describe("github source", () => {
  it("uses the newest PushEvent and enriches it with the commit message", async () => {
    const deps = fakeDeps({
      [`${GH}/users/BrickerP/events/public`]: () =>
        json([
          { type: "DeleteEvent", repo: { name: "BrickerP/x" }, payload: {}, created_at: "2026-10-10T06:56:52Z" },
          {
            type: "PushEvent",
            repo: { name: "BrickerP/BrickerP.github.io" },
            payload: { ref: "refs/heads/main", head: "58cff951f47d912c8446be465757d80186652395" },
            created_at: "2026-10-10T02:58:11Z",
          },
        ]),
      [`${GH}/repos/BrickerP/BrickerP.github.io/commits/58cff951`]: (_url, init) => {
        const headers = new Headers(init?.headers);
        expect(headers.get("Authorization")).toBe("Bearer t0k");
        return json({
          sha: "58cff951f47d912c8446be465757d80186652395",
          html_url: "https://github.com/BrickerP/BrickerP.github.io/commit/58cff951",
          commit: { message: "Tighten seam gate\n\nmore", committer: { date: "2026-10-10T02:58:00Z" } },
        });
      },
    });
    const commit = await fetchLatestCommit(deps, { user: "BrickerP", fallbackRepo: "BrickerP/BrickerP", token: "t0k" });
    expect(commit).toMatchObject({
      repo: "BrickerP/BrickerP.github.io",
      ref: "main",
      sha: "58cff951f47d912c8446be465757d80186652395",
      message: "Tighten seam gate\n\nmore",
      at: "2026-10-10T02:58:00Z",
    });
  });

  it("keeps the event when the commit detail call fails", async () => {
    const deps = fakeDeps({
      [`${GH}/users/BrickerP/events/public`]: () =>
        json([{ type: "PushEvent", repo: { name: "BrickerP/a" }, payload: { ref: "refs/heads/dev", head: "abc1234def" }, created_at: "2026-10-10T02:58:11Z" }]),
      [`${GH}/repos/BrickerP/a/commits/abc1234def`]: () => new Response("", { status: 403, headers: { "x-ratelimit-remaining": "0" } }),
    });
    const commit = await fetchLatestCommit(deps, { user: "BrickerP", fallbackRepo: "BrickerP/BrickerP" });
    expect(commit).toMatchObject({ repo: "BrickerP/a", ref: "dev", sha: "abc1234def", message: null, at: "2026-10-10T02:58:11Z" });
  });

  it("falls back to the repository's latest commit when the feed has no push", async () => {
    const deps = fakeDeps({
      [`${GH}/users/BrickerP/events/public`]: () => json([{ type: "CreateEvent", repo: { name: "BrickerP/a" }, payload: {}, created_at: "2026-10-10T02:58:11Z" }]),
      [`${GH}/repos/BrickerP/BrickerP/commits?per_page=1`]: () =>
        json([{ sha: "1b04034ffff", html_url: "https://github.com/BrickerP/BrickerP/commit/1b04034ffff", commit: { message: "Latest", committer: { date: "2026-10-09T10:00:00Z" } } }]),
    });
    const commit = await fetchLatestCommit(deps, { user: "BrickerP", fallbackRepo: "BrickerP/BrickerP" });
    expect(commit).toMatchObject({ repo: "BrickerP/BrickerP", sha: "1b04034ffff", message: "Latest", at: "2026-10-09T10:00:00Z" });
  });

  it("reports rate limiting as a short reason", async () => {
    const deps = fakeDeps({
      [`${GH}/`]: () => new Response("{}", { status: 403, headers: { "x-ratelimit-remaining": "0" } }),
    });
    await expect(fetchLatestCommit(deps, { user: "BrickerP", fallbackRepo: "BrickerP/BrickerP" })).rejects.toThrow("rate limited");
  });
});

describe("ledger source", () => {
  const BASE = "https://ledger.example";

  it("returns the newest fill within the lookback window", async () => {
    const deps = fakeDeps({
      [`${BASE}/v1/ledgers/demo/head`]: () => json({ ledgerId: "demo", seq: 30, count: 30, headHash: "ff".repeat(32), updatedAt: "2026-10-10T07:38:00Z" }),
      [`${BASE}/v1/ledgers/demo/events`]: (url) => {
        expect(url.searchParams.get("since")).toBe("5");
        return json({
          events: [
            { id: "e29", ts: "2026-10-10T07:37:00Z", type: "fill", symbol: "MSFT", side: "sell", qty: 3, price: 410.1, seq: 29, hash: "x" },
            { id: "e30", ts: "2026-10-10T07:38:00Z", type: "note", seq: 30, hash: "y" },
            { id: "e28", ts: "2026-10-10T07:36:00Z", type: "fill", symbol: "AAPL", side: "buy", qty: 12, price: 187.42, seq: 28, hash: "z" },
          ],
          nextSince: 30,
        });
      },
    });
    const fill = await fetchLatestFill(deps, BASE, "demo");
    expect(fill).toMatchObject({ ledgerId: "demo", seq: 30, count: 30, symbol: "MSFT", side: "sell", qty: 3, price: 410.1, ts: "2026-10-10T07:37:00Z" });
  });

  it("rejects an empty ledger", async () => {
    const deps = fakeDeps({ [`${BASE}/v1/ledgers/demo/head`]: () => json({ ledgerId: "demo", seq: 0, count: 0, headHash: "0".repeat(64), updatedAt: null }) });
    await expect(fetchLatestFill(deps, BASE, "demo")).rejects.toThrow("empty ledger");
  });
});

describe("heartbeat source", () => {
  it("maps the monitor status and tolerates missing fields", async () => {
    const deps = fakeDeps({
      ["https://hb.example/v1/monitors/scan-batch"]: () =>
        json({ id: "scan-batch", name: "scan-batch", state: "degraded", lastBeatAt: "2026-10-10T07:40:18Z", stats: { count: 200, p50Ms: 1800, p95Ms: 9200 }, config: { p95ThresholdMs: 5000 } }),
    });
    const hb = await fetchHeartbeat(deps, "https://hb.example", "scan-batch");
    expect(hb).toEqual({
      monitorId: "scan-batch",
      name: "scan-batch",
      state: "degraded",
      lastBeatAt: "2026-10-10T07:40:18Z",
      nextDeadline: null,
      count: 200,
      p50Ms: 1800,
      p95Ms: 9200,
      p95ThresholdMs: 5000,
    });
  });

  it("normalizes unknown states", async () => {
    const deps = fakeDeps({ ["https://hb.example/"]: () => json({ id: "m", state: "weird" }) });
    const hb = await fetchHeartbeat(deps, "https://hb.example", "m");
    expect(hb.state).toBe("unknown");
    expect(hb.p95Ms).toBeNull();
  });

  it("surfaces timeouts", async () => {
    const deps = fakeDeps({
      ["https://hb.example/"]: (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
    });
    deps.timeoutMs = 20;
    await expect(fetchHeartbeat(deps, "https://hb.example", "m")).rejects.toThrow("timeout");
  });
});
