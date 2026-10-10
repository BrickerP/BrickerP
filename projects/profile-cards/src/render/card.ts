import {
  escapeXml,
  firstLine,
  fitFontSize,
  fmtDuration,
  fmtInt,
  fmtPrice,
  fmtQty,
  shortRepo,
  shortSha,
  timeAgo,
  truncate,
  utcClock,
  utcClockOf,
} from "../format.js";
import type { CommitInfo, FillInfo, HeartbeatInfo, SourceResult, Status } from "../types.js";

export const WIDTH = 1200;
export const HEIGHT = 400;

// The Human Zine palette used by the static spreads in assets/.
export const PAPER = "#F4F0E3";
export const INK = "#111111";
export const COBALT = "#1457FF";
export const RED = "#FF4B35";
export const YELLOW = "#FFD83D";
export const MINT = "#63E2B7";

const SANS = "Arial, Helvetica, sans-serif";
const MONO = "ui-monospace, Menlo, Consolas, monospace";

const TILE_W = 270;
const TILE_H = 230;
const TILE_Y = 100;
const TILE_X = [40, 330, 620, 910] as const;
const TEXT_W = TILE_W - 40;

export interface RenderOptions {
  title: string;
  now: Date;
  ttlSeconds: number;
  githubUser: string;
}

interface Tile {
  label: string;
  value: string;
  lines: [string, string, string];
  bar: string;
  barOpacity?: number;
  mono?: boolean;
  /** Set when the tile shows remembered data because the live source failed. */
  stale?: boolean;
}

const LINE_CHARS = 22;

function text(x: number, y: number, content: string, attrs: string): string {
  return `<text x="${x}" y="${y}" ${attrs}>${escapeXml(content)}</text>`;
}

function tile(x: number, t: Tile): string {
  const labelAttrs = `font-family="${SANS}" font-size="20" font-weight="700" letter-spacing="2" fill="${INK}" fill-opacity=".72"`;
  const valueSize = fitFontSize(t.value, TEXT_W, 60, 28);
  const valueAttrs = `font-family="${t.mono ? MONO : SANS}" font-size="${valueSize}" font-weight="700" fill="${INK}"`;
  const lineAttrs = (opacity: number, mono = false) =>
    `font-family="${mono ? MONO : SANS}" font-size="21" fill="${INK}" fill-opacity="${opacity}"`;
  const y = TILE_Y;
  const staleTag = t.stale
    ? `<g transform="translate(${x + TILE_W - 86} ${y + 24})"><rect width="70" height="26" fill="${YELLOW}"/>${text(35, 19, "STALE", `font-family="${SANS}" font-size="16" font-weight="700" letter-spacing="2" fill="${INK}" text-anchor="middle"`)}</g>`
    : "";
  return [
    `<g data-tile="${escapeXml(t.label.toLowerCase().replace(/[^a-z0-9]+/g, "-"))}"${t.stale ? ` data-stale="true"` : ""}>`,
    `<rect x="${x}" y="${y}" width="${TILE_W}" height="${TILE_H}" fill="none" stroke="${INK}" stroke-width="2"/>`,
    `<rect x="${x + 2}" y="${y + 2}" width="${TILE_W - 4}" height="10" fill="${t.bar}"${t.barOpacity !== undefined ? ` fill-opacity="${t.barOpacity}"` : ""}/>`,
    text(x + 20, y + 50, truncate(t.label.toUpperCase(), 13), labelAttrs),
    staleTag,
    text(x + 20, y + 118, t.value, valueAttrs),
    text(x + 20, y + 158, truncate(t.lines[0], LINE_CHARS), lineAttrs(0.92)),
    text(x + 20, y + 188, truncate(t.lines[1], LINE_CHARS), lineAttrs(0.72)),
    text(x + 20, y + 216, truncate(t.lines[2], LINE_CHARS), lineAttrs(0.6, t.mono === true && t.lines[2].startsWith("chain "))),
    `</g>`,
  ].join("");
}

function unconfiguredTile(label: string, what: string, project: string): Tile {
  return { label, value: "—", lines: [`${what} not wired`, project, "set the base URL var"], bar: INK, barOpacity: 0.18 };
}

function errorTile(label: string, error: string): Tile {
  return { label, value: "OFFLINE", lines: [error, "no remembered value", "retrying soon"], bar: RED };
}

function staleLine(fetchedAt: string, now: Date): string {
  return `last good ${timeAgo(fetchedAt, now)}`;
}

function fillTile(result: SourceResult<FillInfo>, now: Date): Tile {
  const label = "Last fill";
  if (result.state === "unconfigured") return unconfiguredTile(label, "ledger", "projects/open-ledger");
  if (result.state === "error") return errorTile(label, result.error);
  const f = result.data;
  const stale = result.state === "stale";
  const side = f.side ? f.side.toUpperCase() : f.type.toUpperCase();
  const trade = f.qty !== null || f.price !== null ? `${side} ${fmtQty(f.qty)} @ ${fmtPrice(f.price)}` : side;
  const lines: [string, string, string] = [
    trade,
    `${timeAgo(f.ts, now)} · seq ${fmtInt(f.seq)}`,
    stale ? staleLine(result.fetchedAt, now) : `chain ${f.headHash.slice(0, 12)}`,
  ];
  const bar = stale ? YELLOW : f.side === "sell" ? COBALT : MINT;
  return { label, value: f.symbol ?? f.type.toUpperCase(), lines, bar, mono: true, stale };
}

function p95Tile(result: SourceResult<HeartbeatInfo>, now: Date): Tile {
  const label = "Scan p95";
  if (result.state === "unconfigured") return unconfiguredTile(label, "heartbeat", "projects/heartbeat");
  if (result.state === "error") return errorTile(label, result.error);
  const h = result.data;
  const stale = result.state === "stale";
  const over = h.p95ThresholdMs !== null && h.p95Ms !== null && h.p95Ms > h.p95ThresholdMs;
  const lines: [string, string, string] = [
    h.p95ThresholdMs !== null ? `threshold ${fmtDuration(h.p95ThresholdMs)}` : "no threshold set",
    `p50 ${fmtDuration(h.p50Ms)} · ${fmtInt(h.count)} beats`,
    stale ? staleLine(result.fetchedAt, now) : over || h.state === "degraded" ? "OVER THRESHOLD" : "within budget",
  ];
  const bar = stale ? YELLOW : over || h.state === "degraded" ? RED : h.p95Ms === null ? INK : MINT;
  return { label, value: fmtDuration(h.p95Ms), lines, bar, stale, ...(bar === INK ? { barOpacity: 0.18 } : {}) };
}

function heartbeatTile(result: SourceResult<HeartbeatInfo>, now: Date): Tile {
  const label = "Heartbeat";
  if (result.state === "unconfigured") return unconfiguredTile(label, "heartbeat", "projects/heartbeat");
  if (result.state === "error") return errorTile(label, result.error);
  const h = result.data;
  const stale = result.state === "stale";
  const barByState: Record<HeartbeatInfo["state"], string> = { up: MINT, late: YELLOW, down: RED, degraded: RED, unknown: INK };
  const bar = stale ? YELLOW : barByState[h.state];
  const lines: [string, string, string] = [
    `last beat ${timeAgo(h.lastBeatAt, now)}`,
    `deadline ${utcClockOf(h.nextDeadline)}`,
    stale ? staleLine(result.fetchedAt, now) : `monitor ${h.name ?? h.monitorId}`,
  ];
  return { label, value: h.state.toUpperCase(), lines, bar, stale, ...(bar === INK ? { barOpacity: 0.18 } : {}) };
}

function commitTile(result: SourceResult<CommitInfo>, now: Date, githubUser: string): Tile {
  const label = "Last commit";
  if (result.state === "unconfigured") return unconfiguredTile(label, "GitHub", "set GITHUB_USER");
  if (result.state === "error") return errorTile(label, result.error);
  const c = result.data;
  const stale = result.state === "stale";
  const repo = shortRepo(c.repo, githubUser);
  const repoLine = c.ref && Array.from(`${repo} · ${c.ref}`).length <= LINE_CHARS ? `${repo} · ${c.ref}` : repo;
  const lines: [string, string, string] = [
    repoLine,
    c.message ? firstLine(c.message) : "—",
    stale ? staleLine(result.fetchedAt, now) : timeAgo(c.at, now),
  ];
  return { label, value: shortSha(c.sha), lines, bar: stale ? YELLOW : COBALT, mono: true, stale };
}

function cropMarks(): string {
  const o = 12;
  const l = 18;
  const s = `stroke="${INK}" stroke-width="2" stroke-opacity=".55"`;
  const corners: Array<[number, number, number, number]> = [
    [o, o, 1, 1],
    [WIDTH - o, o, -1, 1],
    [o, HEIGHT - o, 1, -1],
    [WIDTH - o, HEIGHT - o, -1, -1],
  ];
  return corners
    .map(([x, y, dx, dy]) => `<path d="M${x} ${y + dy * l}V${y}H${x + dx * l}" fill="none" ${s}/>`)
    .join("");
}

function summarize(status: Status, now: Date): string {
  const parts: string[] = [];
  if (status.fill.state === "ok" || status.fill.state === "stale") {
    const f = status.fill.data;
    parts.push(`last fill ${f.symbol ?? f.type} ${f.side ?? ""} ${fmtQty(f.qty)} at ${fmtPrice(f.price)} (${timeAgo(f.ts, now)})`);
  }
  if (status.heartbeat.state === "ok" || status.heartbeat.state === "stale") {
    const h = status.heartbeat.data;
    parts.push(`heartbeat ${h.state}, p95 ${fmtDuration(h.p95Ms)}`);
  }
  if (status.commit.state === "ok" || status.commit.state === "stale") {
    const c = status.commit.data;
    parts.push(`last commit ${shortSha(c.sha)} in ${c.repo} (${timeAgo(c.at, now)})`);
  }
  return parts.length > 0 ? parts.join("; ") : "no live sources available";
}

export function renderCard(status: Status, opts: RenderOptions): string {
  const now = opts.now;
  const refreshMin = Math.max(1, Math.round(opts.ttlSeconds / 60));
  const updated = Date.parse(status.renderedAt);
  const updatedLabel = Number.isNaN(updated) ? utcClock(now) : utcClock(new Date(updated));
  const tiles = [
    fillTile(status.fill, now),
    p95Tile(status.heartbeat, now),
    heartbeatTile(status.heartbeat, now),
    commitTile(status.commit, now, opts.githubUser),
  ];

  const headerAttrs = `font-family="${SANS}" font-size="26" font-weight="700" letter-spacing="3" fill="${INK}"`;
  const metaAttrs = `font-family="${SANS}" font-size="22" fill="${INK}" fill-opacity=".72" text-anchor="end"`;
  const footAttrs = `font-family="${SANS}" font-size="20" letter-spacing="2" fill="${INK}" fill-opacity=".6"`;

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" role="img" aria-labelledby="pc-title pc-desc">`,
    `<title id="pc-title">${escapeXml(`Live status — ${summarize(status, now)}`)}</title>`,
    `<desc id="pc-desc">${escapeXml(`Rendered by a Cloudflare Worker from live sources at ${status.renderedAt}; refreshes about every ${refreshMin} minutes.`)}</desc>`,
    `<defs><pattern id="pc-grain" width="6" height="6" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r=".6" fill="${INK}" fill-opacity=".10"/><circle cx="4" cy="3.5" r=".5" fill="${INK}" fill-opacity=".07"/></pattern></defs>`,
    `<rect width="${WIDTH}" height="${HEIGHT}" fill="${PAPER}"/>`,
    `<rect width="${WIDTH}" height="${HEIGHT}" fill="url(#pc-grain)"/>`,
    cropMarks(),
    `<g transform="translate(40 28) rotate(-2)"><rect width="92" height="40" fill="${RED}"/>${text(46, 29, "LIVE", `font-family="${SANS}" font-size="24" font-weight="700" letter-spacing="4" fill="${PAPER}" text-anchor="middle"`)}</g>`,
    text(152, 58, truncate(opts.title.toUpperCase(), 40), headerAttrs),
    text(WIDTH - 40, 58, `UPDATED ${updatedLabel} · REFRESHES EVERY ${refreshMin} MIN`, metaAttrs),
    ...tiles.map((t, i) => tile(TILE_X[i] ?? 40, t)),
    `<rect x="40" y="356" width="48" height="6" fill="${COBALT}"/>`,
    text(100, 364, "SOURCES · GITHUB · OPEN-LEDGER · HEARTBEAT", footAttrs),
    text(WIDTH - 40, 364, "A PROFILE WITH MEMORY · 001", `${footAttrs} text-anchor="end"`),
    `</svg>`,
  ].join("\n");
}
