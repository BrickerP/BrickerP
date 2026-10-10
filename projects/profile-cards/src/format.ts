const XML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&apos;",
};

/** Escape text for use inside SVG text nodes and attribute values. */
export function escapeXml(value: string): string {
  // Control characters are invalid in XML 1.0 and would break the document.
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").replace(/[&<>"']/g, (c) => XML_ESCAPES[c] ?? c);
}

/** Truncate to `max` characters, appending an ellipsis when cut. */
export function truncate(value: string, max: number): string {
  const chars = Array.from(value.trim().replace(/\s+/g, " "));
  if (chars.length <= max) return chars.join("");
  return chars.slice(0, Math.max(1, max - 1)).join("").trimEnd() + "…";
}

/** First line of a commit message, without trailing punctuation noise. */
export function firstLine(value: string): string {
  const line = value.split(/\r?\n/, 1)[0] ?? "";
  return line.trim();
}

export function timeAgo(iso: string | null | undefined, now: Date): string {
  if (!iso) return "—";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "—";
  const diff = Math.max(0, now.getTime() - then);
  const s = Math.round(diff / 1000);
  if (s < 5) return "just now";
  if (s < 60) return `${s} s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d < 60) return `${d} d ago`;
  const mo = Math.round(d / 30);
  return `${mo} mo ago`;
}

export function utcClock(date: Date): string {
  const hh = String(date.getUTCHours()).padStart(2, "0");
  const mm = String(date.getUTCMinutes()).padStart(2, "0");
  return `${hh}:${mm} UTC`;
}

export function utcClockOf(iso: string | null | undefined): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  return utcClock(new Date(t));
}

export function fmtDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)} s`;
  const m = Math.floor(s / 60);
  const rest = Math.round(s - m * 60);
  return `${m}m ${String(rest).padStart(2, "0")}s`;
}

export function fmtPrice(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  const digits = abs >= 1000 ? 2 : abs >= 1 ? 2 : 4;
  return value.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function fmtQty(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return value.toLocaleString("en-US", { maximumFractionDigits: 4 });
}

export function fmtInt(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return Math.round(value).toLocaleString("en-US");
}

export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

/** Drop the owner prefix when it matches the profile user, e.g. BrickerP/x → x. */
export function shortRepo(fullName: string, owner: string): string {
  const [first, ...rest] = fullName.split("/");
  if (first && rest.length > 0 && first.toLowerCase() === owner.toLowerCase()) return rest.join("/");
  return fullName;
}

/**
 * Pick a font size so `text` fits in `maxWidth` px, assuming a bold sans-serif
 * whose average glyph is ~0.66em wide. Never below `min`.
 */
export function fitFontSize(text: string, maxWidth: number, base: number, min = 24): number {
  const chars = Math.max(1, Array.from(text).length);
  const fits = Math.floor(maxWidth / (chars * 0.66));
  return Math.max(min, Math.min(base, fits));
}

/** Small, fast, non-cryptographic hash for ETags. */
export function fnv1a(value: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}
