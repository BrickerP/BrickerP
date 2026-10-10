import type { MonitorState, MonitorStatus, SparkPoint } from "./types";
import { fmtAge, fmtMs } from "./util";

export function escapeXml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&apos;");
}

export const STATE_COLORS: Record<MonitorState, string> = {
	up: "#4c1",
	late: "#dfb317",
	degraded: "#fe7d37",
	down: "#e05d44",
	unknown: "#9f9f9f",
};

// Approximate Verdana 11px advance widths (the font shields.io renders with).
// textLength on the <text> elements makes the exact values non-critical.
const CHAR_WIDTHS: Record<string, number> = {
	" ": 3.9, "!": 4.4, '"': 5.2, "#": 8.4, "$": 7, "%": 10.2, "&": 8.4, "'": 3, "(": 4.9, ")": 4.9,
	"*": 7, "+": 8.4, ",": 3.9, "-": 5, ".": 3.9, "/": 5, ":": 4.4, ";": 4.4, "<": 8.4, "=": 8.4,
	">": 8.4, "?": 6, "@": 11, "[": 4.9, "\\": 5, "]": 4.9, "^": 8.4, _: 7, "`": 7, "{": 6.9,
	"|": 5, "}": 6.9, "~": 8.4, "·": 3.9,
	a: 6.6, b: 6.9, c: 5.8, d: 6.9, e: 6.6, f: 3.9, g: 6.9, h: 6.9, i: 3, j: 3.7, k: 6.3, l: 3,
	m: 10.7, n: 6.9, o: 6.7, p: 6.9, q: 6.9, r: 4.5, s: 5.7, t: 4.1, u: 6.9, v: 6.4, w: 9,
	x: 6.4, y: 6.4, z: 5.7,
	A: 7.5, B: 7.6, C: 7.8, D: 8.5, E: 7, F: 6.4, G: 8.5, H: 8.4, I: 4.6, J: 5, K: 7.6, L: 6.1,
	M: 9.3, N: 8.4, O: 9.3, P: 6.7, Q: 9.3, R: 7.7, S: 7.5, T: 6.8, U: 8.1, V: 7.5, W: 10.9,
	X: 7.5, Y: 6.8, Z: 7.5,
};

export function textWidth(text: string): number {
	let w = 0;
	for (const ch of text) {
		const cw = CHAR_WIDTHS[ch];
		w += cw ?? (/[0-9]/.test(ch) ? 7 : 7.5);
	}
	return Math.round(w * 10) / 10;
}

export interface BadgeSpec {
	label: string;
	value: string;
	color: string;
}

/** shields.io "flat" style badge, rendered as a plain string template. */
export function renderBadge({ label, value, color }: BadgeSpec): string {
	const lw = textWidth(label);
	const vw = textWidth(value);
	const leftW = Math.round(lw + 10);
	const rightW = Math.round(vw + 10);
	const total = leftW + rightW;
	const l = escapeXml(label);
	const v = escapeXml(value);
	const title = `${l}: ${v}`;
	const lx = Math.round((leftW / 2) * 10);
	const vx = Math.round((leftW + rightW / 2) * 10);
	const ltl = Math.round(lw * 10);
	const vtl = Math.round(vw * 10);
	return (
		`<svg xmlns="http://www.w3.org/2000/svg" width="${total}" height="20" role="img" aria-label="${title}">` +
		`<title>${title}</title>` +
		`<linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient>` +
		`<clipPath id="r"><rect width="${total}" height="20" rx="3" fill="#fff"/></clipPath>` +
		`<g clip-path="url(#r)"><rect width="${leftW}" height="20" fill="#555"/><rect x="${leftW}" width="${rightW}" height="20" fill="${color}"/><rect width="${total}" height="20" fill="url(#s)"/></g>` +
		`<g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" text-rendering="geometricPrecision" font-size="110">` +
		`<text aria-hidden="true" x="${lx}" y="150" fill="#010101" fill-opacity=".3" transform="scale(.1)" textLength="${ltl}">${l}</text>` +
		`<text x="${lx}" y="140" transform="scale(.1)" fill="#fff" textLength="${ltl}">${l}</text>` +
		`<text aria-hidden="true" x="${vx}" y="150" fill="#010101" fill-opacity=".3" transform="scale(.1)" textLength="${vtl}">${v}</text>` +
		`<text x="${vx}" y="140" transform="scale(.1)" fill="#fff" textLength="${vtl}">${v}</text>` +
		`</g></svg>`
	);
}

/** Turns a status document into badge label/value/colour, e.g. `up · p95 2.4s` or `down 13m`. */
export function badgeSpecFor(status: MonitorStatus, now: number): BadgeSpec {
	const p95 = status.stats.p95Ms;
	const p95Text = p95 == null ? null : `p95 ${fmtMs(p95)}`;
	let value: string;
	switch (status.state) {
		case "up":
			value = p95Text ? `up · ${p95Text}` : "up";
			break;
		case "late": {
			const expectedAt = status.lastBeatAt ? Date.parse(status.lastBeatAt) + status.expectEverySec * 1000 : now;
			value = `late ${fmtAge(now - expectedAt)}`;
			break;
		}
		case "down": {
			const open = status.incidents.find((i) => i.kind === "missed" && i.closedAt === null);
			const since = open ? Date.parse(open.openedAt) : status.nextDeadline ? Date.parse(status.nextDeadline) : now;
			value = `down ${fmtAge(now - since)}`;
			break;
		}
		case "degraded": {
			const failing = status.incidents.some((i) => i.kind === "fail" && i.closedAt === null);
			const p95Open = status.incidents.some((i) => i.kind === "p95" && i.closedAt === null);
			value = p95Open && p95Text ? `degraded · ${p95Text}` : failing ? "degraded · failing" : "degraded";
			break;
		}
		default:
			value = "unknown";
	}
	return { label: status.name, value, color: STATE_COLORS[status.state] };
}

export interface SparklineSpec {
	name: string;
	state: MonitorState;
	points: SparkPoint[];
	p95Ms: number | null;
	thresholdMs: number | null;
	width: number;
	height: number;
}

const FONT = 'font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11"';

/** Bars (or a polyline when bars would be thinner than 2px) of recent durations. */
export function renderSparkline(spec: SparklineSpec): string {
	const { width: w, height: h, points, thresholdMs } = spec;
	const top = 20;
	const left = 6;
	const right = 6;
	const bottom = 5;
	const plotW = Math.max(1, w - left - right);
	const plotH = Math.max(1, h - top - bottom);
	const plotBottom = h - bottom;
	const name = escapeXml(spec.name);
	const n = points.length;

	let header = `<text x="${left}" y="14" ${FONT} fill="#57606a">${name} · last ${n} run${n === 1 ? "" : "s"}</text>`;
	const latest = points[n - 1];
	const rightParts: string[] = [];
	if (latest) rightParts.push(`latest ${fmtMs(latest.durationMs)}`);
	if (spec.p95Ms != null) rightParts.push(`p95 ${fmtMs(spec.p95Ms)}`);
	if (rightParts.length > 0) {
		header += `<text x="${w - right}" y="14" ${FONT} text-anchor="end" fill="${STATE_COLORS[spec.state]}" font-weight="bold">${escapeXml(rightParts.join(" · "))}</text>`;
	}

	let body = "";
	if (n === 0) {
		body = `<text x="${w / 2}" y="${top + plotH / 2 + 4}" ${FONT} text-anchor="middle" fill="#8c959f">no durations reported yet</text>`;
	} else {
		let max = 0;
		for (const p of points) if (p.durationMs > max) max = p.durationMs;
		if (thresholdMs != null && thresholdMs > max) max = thresholdMs;
		const yMax = Math.max(1, max * 1.08);
		const y = (v: number) => plotBottom - (v / yMax) * plotH;
		const slot = plotW / n;
		const colorFor = (p: SparkPoint) =>
			p.status === "fail" ? STATE_COLORS.down : thresholdMs != null && p.durationMs > thresholdMs ? STATE_COLORS.degraded : "#2f81f7";

		if (slot >= 2) {
			const gap = slot >= 4 ? 1 : 0.5;
			const bw = Math.max(0.5, slot - gap);
			for (let i = 0; i < n; i++) {
				const p = points[i]!;
				const x = left + i * slot;
				const barTop = y(p.durationMs);
				const barH = Math.max(1, plotBottom - barTop);
				body += `<rect x="${x.toFixed(1)}" y="${(plotBottom - barH).toFixed(1)}" width="${bw.toFixed(1)}" height="${barH.toFixed(1)}" fill="${colorFor(p)}"/>`;
			}
		} else {
			let d = "";
			let fails = "";
			for (let i = 0; i < n; i++) {
				const p = points[i]!;
				const x = left + (i + 0.5) * slot;
				const py = y(p.durationMs);
				d += `${i === 0 ? "M" : "L"}${x.toFixed(1)} ${py.toFixed(1)}`;
				if (p.status === "fail") fails += `<circle cx="${x.toFixed(1)}" cy="${py.toFixed(1)}" r="1.5" fill="${STATE_COLORS.down}"/>`;
			}
			body += `<path d="${d}" fill="none" stroke="#2f81f7" stroke-width="1.2"/>${fails}`;
		}

		if (thresholdMs != null) {
			const ty = y(thresholdMs);
			const labelY = ty - top > 14 ? ty - 3 : ty + 11;
			body +=
				`<line x1="${left}" x2="${w - right}" y1="${ty.toFixed(1)}" y2="${ty.toFixed(1)}" stroke="${STATE_COLORS.degraded}" stroke-width="1" stroke-dasharray="4 3"/>` +
				`<text x="${left + 2}" y="${labelY.toFixed(1)}" ${FONT} fill="${STATE_COLORS.degraded}">threshold ${fmtMs(thresholdMs)}</text>`;
		}
	}

	return (
		`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${name}: recent run durations">` +
		`<title>${name}: last ${n} run durations</title>` +
		`<rect width="${w}" height="${h}" rx="4" fill="#ffffff" stroke="#d0d7de"/>` +
		header +
		body +
		`</svg>`
	);
}
