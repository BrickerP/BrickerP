import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MEMORY_KEY, type Stored } from "../src/status.js";
import { sampleCommit } from "./helpers.js";

const BASE = "https://profile-cards.test";

function stubGitHub(): void {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith("https://api.github.com/users/BrickerP/events/public")) {
      return Response.json([
        { type: "PushEvent", repo: { name: "BrickerP/BrickerP" }, payload: { ref: "refs/heads/main", head: sampleCommit.sha }, created_at: sampleCommit.at },
      ]);
    }
    if (url.startsWith(`https://api.github.com/repos/BrickerP/BrickerP/commits/${sampleCommit.sha}`)) {
      return Response.json({ sha: sampleCommit.sha, html_url: sampleCommit.url, commit: { message: sampleCommit.message, committer: { date: sampleCommit.at } } });
    }
    throw new Error(`unexpected request: ${url}`);
  });
}

describe("worker routes", () => {
  beforeEach(async () => {
    await env.MEMORY.delete(MEMORY_KEY);
    stubGitHub();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("serves the SVG card with caching headers", async () => {
    const response = await exports.default.fetch(`${BASE}/card.svg`);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/svg+xml; charset=utf-8");
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=300, s-maxage=300, stale-while-revalidate=60");
    expect(response.headers.get("ETag")).toMatch(/^W\/"[0-9a-f]{8}"$/);
    expect(response.headers.get("X-Profile-Cards-Source")).toBe("live");
    const svg = await response.text();
    expect(svg).toContain("<svg");
    expect(svg).toContain(">1b04034<");
    expect(svg).toContain("ledger not wired");
    expect(svg).toContain("heartbeat not wired");
  });

  it("answers 304 for a matching ETag and serves the second request from memory", async () => {
    const first = await exports.default.fetch(`${BASE}/card.svg`);
    const etag = first.headers.get("ETag") ?? "";
    const second = await exports.default.fetch(`${BASE}/card.svg`, { headers: { "If-None-Match": etag } });
    expect(second.status).toBe(304);
    const third = await exports.default.fetch(`${BASE}/status.json`);
    expect(third.headers.get("X-Profile-Cards-Source")).toBeNull();
    const body = (await third.json()) as { cache: { servedFrom: string }; commit: { state: string } };
    expect(body.cache.servedFrom).toBe("memory");
    expect(body.commit.state).toBe("ok");
  });

  it("exposes machine-readable status", async () => {
    const response = await exports.default.fetch(`${BASE}/status.json`);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      fill: { state: "unconfigured" },
      heartbeat: { state: "unconfigured" },
      commit: { state: "ok", data: { sha: sampleCommit.sha } },
      sources: { github: "configured", ledger: "unconfigured", heartbeat: "unconfigured" },
      cache: { ttlSeconds: 300, servedFrom: "live" },
    });
  });

  it("still renders a card when GitHub is down and nothing is remembered", async () => {
    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("network down"));
    const response = await exports.default.fetch(`${BASE}/card.svg`);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=60, s-maxage=60, stale-while-revalidate=60");
    const svg = await response.text();
    expect(svg).toContain(">OFFLINE<");
    expect(svg).toContain(">network error<");
  });

  it("falls back to remembered data when GitHub fails later", async () => {
    const remembered: Stored = {
      version: 1,
      status: { renderedAt: "2026-01-01T00:00:00Z", fill: { state: "unconfigured" }, heartbeat: { state: "unconfigured" }, commit: { state: "unconfigured" } },
      memory: { updatedAt: "2026-01-01T00:00:00Z", commit: { data: sampleCommit, fetchedAt: "2026-01-01T00:00:00Z" } },
    };
    await env.MEMORY.put(MEMORY_KEY, JSON.stringify(remembered));
    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 403, headers: { "x-ratelimit-remaining": "0" } }));
    const response = await exports.default.fetch(`${BASE}/card.svg`);
    const svg = await response.text();
    expect(svg).toContain('data-tile="last-commit" data-stale="true"');
    expect(svg).toContain(">1b04034<");
  });

  it("serves a landing page, health check and 404s", async () => {
    const home = await exports.default.fetch(`${BASE}/`);
    expect(home.status).toBe(200);
    expect(home.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(await home.text()).toContain(`${BASE}/card.svg`);

    const health = await exports.default.fetch(`${BASE}/healthz`);
    expect(await health.text()).toBe("ok");

    const missing = await exports.default.fetch(`${BASE}/nope`);
    expect(missing.status).toBe(404);

    const post = await exports.default.fetch(`${BASE}/card.svg`, { method: "POST" });
    expect(post.status).toBe(405);
  });
});
