import { describe, expect, it } from "vitest";
import {
  escapeXml,
  fitFontSize,
  fmtDuration,
  fmtPrice,
  fmtQty,
  fnv1a,
  shortRepo,
  timeAgo,
  truncate,
  utcClock,
} from "../src/format.js";
import { NOW } from "./helpers.js";

describe("escapeXml", () => {
  it("escapes markup and strips control characters", () => {
    expect(escapeXml(`<svg onload="x">&'"\u0007`)).toBe("&lt;svg onload=&quot;x&quot;&gt;&amp;&apos;&quot;");
  });
});

describe("truncate", () => {
  it("collapses whitespace and appends an ellipsis when cut", () => {
    expect(truncate("  hello   world  ", 20)).toBe("hello world");
    expect(truncate("abcdefghij", 5)).toBe("abcd…");
    expect(truncate("日本語のテキストです", 5)).toBe("日本語の…");
  });
});

describe("timeAgo", () => {
  it("renders coarse relative times", () => {
    expect(timeAgo("2026-10-10T07:40:58Z", NOW)).toBe("just now");
    expect(timeAgo("2026-10-10T07:40:18Z", NOW)).toBe("42 s ago");
    expect(timeAgo("2026-10-10T07:38:00Z", NOW)).toBe("3 min ago");
    expect(timeAgo("2026-10-10T05:41:00Z", NOW)).toBe("2 h ago");
    expect(timeAgo("2026-10-01T07:41:00Z", NOW)).toBe("9 d ago");
    expect(timeAgo("garbage", NOW)).toBe("—");
    expect(timeAgo(null, NOW)).toBe("—");
  });
});

describe("number formatting", () => {
  it("formats durations, prices and quantities", () => {
    expect(fmtDuration(842)).toBe("842 ms");
    expect(fmtDuration(2400)).toBe("2.4 s");
    expect(fmtDuration(12_400)).toBe("12 s");
    expect(fmtDuration(65_000)).toBe("1m 05s");
    expect(fmtDuration(null)).toBe("—");
    expect(fmtPrice(187.42)).toBe("187.42");
    expect(fmtPrice(0.1234)).toBe("0.1234");
    expect(fmtPrice(1234.5)).toBe("1,234.50");
    expect(fmtQty(12)).toBe("12");
    expect(fmtQty(0.5)).toBe("0.5");
  });

  it("prints UTC clocks and shortens repos", () => {
    expect(utcClock(NOW)).toBe("07:41 UTC");
    expect(shortRepo("BrickerP/BrickerP.github.io", "brickerp")).toBe("BrickerP.github.io");
    expect(shortRepo("someone/else", "BrickerP")).toBe("someone/else");
  });
});

describe("fitFontSize", () => {
  it("shrinks long values and keeps short ones at the base size", () => {
    expect(fitFontSize("UP", 230, 60)).toBe(60);
    expect(fitFontSize("DEGRADED", 230, 60)).toBeLessThan(60);
    expect(fitFontSize("x".repeat(200), 230, 60, 24)).toBe(24);
  });
});

describe("fnv1a", () => {
  it("is stable and distinguishes inputs", () => {
    expect(fnv1a("abc")).toBe(fnv1a("abc"));
    expect(fnv1a("abc")).not.toBe(fnv1a("abd"));
    expect(fnv1a("")).toBe("811c9dc5");
  });
});
