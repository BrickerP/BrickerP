import { describe, expect, it } from "vitest";
import { computeStats, percentile } from "../src/stats";
import { reminderDelayMs } from "../src/monitor";

describe("percentile (nearest-rank)", () => {
	it("returns null for an empty window", () => {
		expect(percentile([], 0.95)).toBeNull();
	});

	it("matches the textbook nearest-rank example", () => {
		// Wikipedia's worked example: p30 -> 20, p40 -> 20, p50 -> 35, p100 -> 50
		const sorted = [15, 20, 35, 40, 50];
		expect(percentile(sorted, 0.3)).toBe(20);
		expect(percentile(sorted, 0.4)).toBe(20);
		expect(percentile(sorted, 0.5)).toBe(35);
		expect(percentile(sorted, 0.95)).toBe(50);
		expect(percentile(sorted, 1)).toBe(50);
	});

	it("never interpolates: p95 of 1..100 is exactly 95", () => {
		const sorted = Array.from({ length: 100 }, (_, i) => i + 1);
		expect(percentile(sorted, 0.95)).toBe(95);
		expect(percentile(sorted, 0.99)).toBe(99);
		expect(percentile(sorted, 0.5)).toBe(50);
	});

	it("picks the worst sample once it is in the top 5%", () => {
		const sorted = [...Array.from({ length: 19 }, () => 2400), 9200];
		expect(percentile(sorted, 0.95)).toBe(2400);
		const withTwoBad = [...Array.from({ length: 18 }, () => 2400), 9200, 9200];
		expect(percentile(withTwoBad, 0.95)).toBe(9200);
	});
});

describe("computeStats", () => {
	it("ignores missing durations for percentiles but counts them for failRate", () => {
		const stats = computeStats([
			{ durationMs: 100, status: "ok" },
			{ durationMs: null, status: "fail" },
			{ durationMs: 300, status: "ok" },
			{ durationMs: 200, status: "fail" },
		]);
		expect(stats.count).toBe(4);
		expect(stats.failRate).toBe(0.5);
		expect(stats.p50Ms).toBe(200);
		expect(stats.p95Ms).toBe(300);
		expect(stats.p99Ms).toBe(300);
	});

	it("reports nulls for an empty window", () => {
		expect(computeStats([])).toEqual({ count: 0, p50Ms: null, p95Ms: null, p99Ms: null, failRate: null });
	});
});

describe("reminderDelayMs", () => {
	it("doubles from max(60s, expectEvery) and caps at 6h", () => {
		expect(reminderDelayMs(300, 1)).toBe(300_000);
		expect(reminderDelayMs(300, 2)).toBe(600_000);
		expect(reminderDelayMs(300, 3)).toBe(1_200_000);
		expect(reminderDelayMs(300, 20)).toBe(6 * 3_600_000);
		expect(reminderDelayMs(5, 1)).toBe(60_000);
	});
});
