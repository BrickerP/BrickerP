import type { Stats } from "./types";

/**
 * Nearest-rank percentile over an ascending-sorted array: the value at rank
 * ceil(p * n) (1-based), so p95 of 1..100 is exactly 95 and no interpolation
 * is ever performed.
 */
export function percentile(sorted: readonly number[], p: number): number | null {
	const n = sorted.length;
	if (n === 0) return null;
	const rank = Math.min(n, Math.max(1, Math.ceil(p * n)));
	return sorted[rank - 1] ?? null;
}

export interface Sample {
	durationMs: number | null;
	status: string;
}

/** Single pass over the window plus one numeric sort; fine for <= 5000 samples. */
export function computeStats(samples: readonly Sample[]): Stats {
	const durations: number[] = [];
	let fails = 0;
	for (const s of samples) {
		if (s.status === "fail") fails++;
		if (s.durationMs != null) durations.push(s.durationMs);
	}
	durations.sort((a, b) => a - b);
	return {
		count: samples.length,
		p50Ms: percentile(durations, 0.5),
		p95Ms: percentile(durations, 0.95),
		p99Ms: percentile(durations, 0.99),
		failRate: samples.length === 0 ? null : fails / samples.length,
	};
}
