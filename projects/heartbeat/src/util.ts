const encoder = new TextEncoder();

export function bytesToHex(bytes: Uint8Array): string {
	let out = "";
	for (const b of bytes) out += b.toString(16).padStart(2, "0");
	return out;
}

export async function sha256Hex(input: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", encoder.encode(input));
	return bytesToHex(new Uint8Array(digest));
}

/**
 * Constant-time string comparison. When the lengths differ we still run a
 * comparison of equal cost before failing so timing does not reveal length.
 */
export function timingSafeEqualString(a: string, b: string): boolean {
	const ab = encoder.encode(a);
	const bb = encoder.encode(b);
	if (ab.byteLength !== bb.byteLength) {
		crypto.subtle.timingSafeEqual(ab, ab);
		return false;
	}
	return crypto.subtle.timingSafeEqual(ab, bb);
}

function base64url(bytes: Uint8Array): string {
	let bin = "";
	for (const b of bytes) bin += String.fromCharCode(b);
	return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/** 192 bits of randomness, URL- and shell-safe, prefixed so it is recognisable in logs. */
export function generateBeatToken(): string {
	const buf = new Uint8Array(24);
	crypto.getRandomValues(buf);
	return `hb_${base64url(buf)}`;
}

export function iso(ms: number): string;
export function iso(ms: number | null | undefined): string | null;
export function iso(ms: number | null | undefined): string | null {
	return ms == null ? null : new Date(ms).toISOString();
}

/** Compact duration for badges: 850ms, 2.4s, 1.5m, 2.0h. */
export function fmtMs(ms: number): string {
	if (!Number.isFinite(ms)) return "n/a";
	if (ms < 1000) return `${Math.round(ms)}ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
	if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)}m`;
	return `${(ms / 3_600_000).toFixed(1)}h`;
}

/** Coarse elapsed time for humans: 45s, 13m, 3h, 2d. */
export function fmtAge(ms: number): string {
	const s = Math.max(0, Math.floor(ms / 1000));
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m`;
	const h = Math.floor(m / 60);
	if (h < 48) return `${h}h`;
	return `${Math.floor(h / 24)}d`;
}

/** Small, fast content hash for ETags (FNV-1a 32-bit plus length). */
export function etagFor(content: string): string {
	let hash = 0x811c9dc5;
	for (let i = 0; i < content.length; i++) {
		hash ^= content.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return `"${content.length.toString(16)}-${hash.toString(16).padStart(8, "0")}"`;
}

export function clampInt(value: unknown, fallback: number, min: number, max: number): number {
	const n = typeof value === "string" ? Number(value) : typeof value === "number" ? value : NaN;
	if (!Number.isFinite(n)) return fallback;
	return Math.min(max, Math.max(min, Math.trunc(n)));
}
