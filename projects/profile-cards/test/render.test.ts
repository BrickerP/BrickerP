import { describe, expect, it } from "vitest";
import { HEIGHT, renderCard, WIDTH } from "../src/render/card.js";
import type { Status } from "../src/types.js";
import { NOW, sampleCommit, sampleFill, sampleHeartbeat } from "./helpers.js";

const opts = { title: "Field Notes · Live Status", now: NOW, ttlSeconds: 300, githubUser: "BrickerP" };

const healthy: Status = {
  renderedAt: "2026-10-10T07:41:00Z",
  fill: { state: "ok", data: sampleFill, fetchedAt: "2026-10-10T07:41:00Z" },
  heartbeat: { state: "ok", data: sampleHeartbeat, fetchedAt: "2026-10-10T07:41:00Z" },
  commit: { state: "ok", data: sampleCommit, fetchedAt: "2026-10-10T07:41:00Z" },
};

describe("renderCard", () => {
  it("renders a well-formed SVG with all four tiles", () => {
    const svg = renderCard(healthy, opts);
    expect(svg.startsWith(`<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}"`)).toBe(true);
    expect(svg.trimEnd().endsWith("</svg>")).toBe(true);
    expect((svg.match(/<g data-tile=/g) ?? []).length).toBe(4);
    expect(svg).toContain(">AAPL<");
    expect(svg).toContain("BUY 12 @ 187.42");
    expect(svg).toContain("3 min ago · seq 1,204");
    expect(svg).toContain("chain a1b2c3d4e5f6");
    expect(svg).toContain(">2.4 s<");
    expect(svg).toContain("threshold 5.0 s");
    expect(svg).toContain(">UP<");
    expect(svg).toContain("last beat 42 s ago");
    expect(svg).toContain("deadline 07:47 UTC");
    expect(svg).not.toContain("data-stale");
    expect(svg).toContain(">1b04034<");
    expect(svg).toContain("BrickerP · main");
    expect(svg).toContain("UPDATED 07:41 UTC · REFRESHES EVERY 5 MIN");
    expect(svg).toContain("FIELD NOTES · LIVE STATUS");
  });

  it("escapes untrusted text and never emits raw markup from data", () => {
    const hostile: Status = {
      ...healthy,
      commit: {
        state: "ok",
        fetchedAt: "2026-10-10T07:41:00Z",
        data: { ...sampleCommit, message: `<script>alert(1)</script> & "quotes"`, repo: `evil/<img src=x onerror=alert(1)>` },
      },
    };
    const svg = renderCard(hostile, opts);
    expect(svg).not.toContain("<script>");
    expect(svg).not.toContain("<img");
    expect(svg).toContain("&lt;script&gt;alert(1)&lt;/scr…");
    // Only our own SVG elements may appear.
    const tags = new Set([...svg.matchAll(/<\/?([a-zA-Z][\w-]*)/g)].map((m) => m[1]));
    expect([...tags].sort()).toEqual(["circle", "defs", "desc", "g", "path", "pattern", "rect", "svg", "text", "title"]);
  });

  it("shows not-wired and offline states explicitly", () => {
    const status: Status = {
      renderedAt: "2026-10-10T07:41:00Z",
      fill: { state: "unconfigured" },
      heartbeat: { state: "error", error: "timeout" },
      commit: { state: "error", error: "rate limited" },
    };
    const svg = renderCard(status, opts);
    expect(svg).toContain("ledger not wired");
    expect(svg).toContain("projects/open-ledger");
    expect((svg.match(/>OFFLINE</g) ?? []).length).toBe(3);
    expect(svg).toContain(">timeout<");
    expect(svg).toContain(">rate limited<");
  });

  it("marks stale tiles and flags p95 over threshold", () => {
    const status: Status = {
      ...healthy,
      heartbeat: {
        state: "stale",
        error: "http 503",
        fetchedAt: "2026-10-10T05:41:00Z",
        data: { ...sampleHeartbeat, state: "degraded", p95Ms: 9200 },
      },
    };
    const svg = renderCard(status, opts);
    expect(svg).toContain('data-tile="scan-p95" data-stale="true"');
    expect(svg).toContain('data-tile="heartbeat" data-stale="true"');
    expect((svg.match(/>STALE</g) ?? []).length).toBe(2);
    expect((svg.match(/>last good 2 h ago</g) ?? []).length).toBe(2);
    expect(svg).toContain(">9.2 s<");
    expect(svg).toContain(">DEGRADED<");
    expect(svg).toContain('fill="#FFD83D"');
  });

  it("uses only the Human Zine palette", () => {
    const svg = renderCard(healthy, opts);
    const colors = new Set([...svg.matchAll(/#[0-9A-Fa-f]{6}\b/g)].map((m) => m[0].toUpperCase()));
    for (const color of colors) {
      expect(["#F4F0E3", "#111111", "#1457FF", "#FF4B35", "#FFD83D", "#63E2B7"]).toContain(color);
    }
  });
});
