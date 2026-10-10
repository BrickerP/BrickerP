import { describe, expect, it } from "vitest";
import { badgeSpecFor, escapeXml, renderBadge, renderSparkline, STATE_COLORS } from "../src/svg";
import type { MonitorStatus } from "../src/types";
import { etagFor, fmtAge, fmtMs } from "../src/util";

function status(overrides: Partial<MonitorStatus> = {}): MonitorStatus {
	return {
		id: "scan-batch",
		name: "scan-batch",
		state: "up",
		public: true,
		expectEverySec: 300,
		graceSec: 120,
		p95ThresholdMs: 5000,
		windowSize: 200,
		createdAt: "2026-10-10T00:00:00.000Z",
		lastBeatAt: "2026-10-10T00:10:00.000Z",
		nextDeadline: "2026-10-10T00:17:00.000Z",
		stats: { count: 30, p50Ms: 2300, p95Ms: 2400, p99Ms: 2600, failRate: 0 },
		incidents: [],
		...overrides,
	};
}

describe("escapeXml", () => {
	it("escapes the five XML specials", () => {
		expect(escapeXml(`a<b>&"c'`)).toBe("a&lt;b&gt;&amp;&quot;c&apos;");
	});
});

describe("renderBadge", () => {
	it("renders label, value and colour", () => {
		const svg = renderBadge({ label: "scan-batch", value: "up · p95 2.4s", color: STATE_COLORS.up });
		expect(svg.startsWith("<svg")).toBe(true);
		expect(svg).toContain(">scan-batch</text>");
		expect(svg).toContain(">up · p95 2.4s</text>");
		expect(svg).toContain(`fill="${STATE_COLORS.up}"`);
		expect(svg).toContain("<title>scan-batch: up · p95 2.4s</title>");
	});

	it("escapes XML in user-controlled text", () => {
		const svg = renderBadge({ label: `job <x> & "y"`, value: "<script>", color: "#000" });
		expect(svg).not.toContain("<x>");
		expect(svg).not.toContain("<script>");
		expect(svg).toContain("job &lt;x&gt; &amp; &quot;y&quot;");
		expect(svg).toContain("&lt;script&gt;");
	});
});

describe("badgeSpecFor", () => {
	const now = Date.parse("2026-10-10T00:12:00.000Z");

	it("formats up with p95", () => {
		expect(badgeSpecFor(status(), now)).toEqual({ label: "scan-batch", value: "up · p95 2.4s", color: STATE_COLORS.up });
	});

	it("formats late with overdue age", () => {
		const s = status({ state: "late", lastBeatAt: "2026-10-10T00:05:00.000Z" });
		expect(badgeSpecFor(s, now).value).toBe("late 2m");
	});

	it("formats down with the open incident age", () => {
		const s = status({
			state: "down",
			incidents: [{ id: 1, kind: "missed", openedAt: "2026-10-09T23:59:00.000Z", closedAt: null, detail: "x" }],
		});
		expect(badgeSpecFor(s, now)).toEqual({ label: "scan-batch", value: "down 13m", color: STATE_COLORS.down });
	});

	it("formats degraded with p95 when the p95 incident is open", () => {
		const s = status({
			state: "degraded",
			stats: { count: 30, p50Ms: 8000, p95Ms: 9200, p99Ms: 9900, failRate: 0 },
			incidents: [{ id: 2, kind: "p95", openedAt: "2026-10-10T00:11:00.000Z", closedAt: null, detail: "x" }],
		});
		expect(badgeSpecFor(s, now).value).toBe("degraded · p95 9.2s");
	});

	it("formats degraded caused by failing beats", () => {
		const s = status({
			state: "degraded",
			incidents: [{ id: 3, kind: "fail", openedAt: "2026-10-10T00:11:00.000Z", closedAt: null, detail: "x" }],
		});
		expect(badgeSpecFor(s, now).value).toBe("degraded · failing");
	});

	it("formats unknown", () => {
		const s = status({ state: "unknown", lastBeatAt: null, stats: { count: 0, p50Ms: null, p95Ms: null, p99Ms: null, failRate: null } });
		expect(badgeSpecFor(s, now)).toEqual({ label: "scan-batch", value: "unknown", color: STATE_COLORS.unknown });
	});
});

describe("renderSparkline", () => {
	it("draws bars, a dashed threshold line and the latest value", () => {
		const points = Array.from({ length: 30 }, (_, i) => ({ durationMs: 2000 + i * 20, status: "ok" as const }));
		const svg = renderSparkline({ name: "scan-batch", state: "up", points, p95Ms: 2560, thresholdMs: 5000, width: 600, height: 120 });
		expect(svg).toContain('width="600" height="120"');
		expect((svg.match(/<rect /g) ?? []).length).toBeGreaterThanOrEqual(31);
		expect(svg).toContain('stroke-dasharray="4 3"');
		expect(svg).toContain("threshold 5.0s");
		expect(svg).toContain("latest 2.6s · p95 2.6s");
		expect(svg).toContain("last 30 runs");
	});

	it("falls back to a polyline when bars would be too thin and marks failures", () => {
		const points = Array.from({ length: 1000 }, (_, i) => ({ durationMs: 100 + (i % 7), status: i === 999 ? ("fail" as const) : ("ok" as const) }));
		const svg = renderSparkline({ name: "x", state: "degraded", points, p95Ms: 106, thresholdMs: null, width: 600, height: 120 });
		expect(svg).toContain("<path d=\"M");
		expect(svg).toContain("<circle");
		expect(svg).not.toContain("stroke-dasharray");
	});

	it("renders an empty-state message and escapes the name", () => {
		const svg = renderSparkline({ name: "a<b>", state: "unknown", points: [], p95Ms: null, thresholdMs: null, width: 300, height: 80 });
		expect(svg).toContain("no durations reported yet");
		expect(svg).toContain("a&lt;b&gt;");
		expect(svg).not.toContain("a<b>");
	});
});

describe("formatting helpers", () => {
	it("fmtMs picks sensible units", () => {
		expect(fmtMs(850)).toBe("850ms");
		expect(fmtMs(2400)).toBe("2.4s");
		expect(fmtMs(9200)).toBe("9.2s");
		expect(fmtMs(90_000)).toBe("1.5m");
		expect(fmtMs(7_200_000)).toBe("2.0h");
	});

	it("fmtAge is coarse and never negative", () => {
		expect(fmtAge(-5)).toBe("0s");
		expect(fmtAge(45_000)).toBe("45s");
		expect(fmtAge(13 * 60_000 + 20_000)).toBe("13m");
		expect(fmtAge(3 * 3_600_000)).toBe("3h");
		expect(fmtAge(3 * 86_400_000)).toBe("3d");
	});

	it("etagFor is stable and quoted", () => {
		expect(etagFor("abc")).toBe(etagFor("abc"));
		expect(etagFor("abc")).not.toBe(etagFor("abd"));
		expect(etagFor("abc")).toMatch(/^"[0-9a-f]+-[0-9a-f]{8}"$/);
	});
});
