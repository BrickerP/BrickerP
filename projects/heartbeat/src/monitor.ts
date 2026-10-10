import { DurableObject } from "cloudflare:workers";
import { sendNotifications } from "./notify";
import { computeStats, type Sample } from "./stats";
import type {
	AuthContext,
	BeatInput,
	BeatResult,
	BeatStatus,
	ConfigureRequest,
	ConfigureResult,
	DoResult,
	HistoryBeat,
	HistoryResult,
	Incident,
	IncidentKind,
	MonitorState,
	MonitorStatus,
	NotifyConfig,
	SparkPoint,
	SparklineData,
} from "./types";
import { fmtAge, fmtMs, iso, timingSafeEqualString } from "./util";

export const DEGRADE_AFTER_BEATS = 3;
export const RECOVER_AFTER_BEATS = 3;
export const NOTIFY_MIN_INTERVAL_MS = 60_000;
export const REMINDER_BASE_MIN_MS = 60_000;
export const REMINDER_CAP_MS = 6 * 3_600_000;
const INCIDENTS_KEPT = 200;
const INCIDENTS_RETURNED = 20;

/** Reminder schedule while down: base = max(60s, expectEverySec), doubling per reminder, capped at 6h. */
export function reminderDelayMs(expectEverySec: number, reminderCount: number): number {
	const base = Math.max(REMINDER_BASE_MIN_MS, expectEverySec * 1000);
	const exponent = Math.min(30, Math.max(0, reminderCount - 1));
	return Math.min(REMINDER_CAP_MS, base * 2 ** exponent);
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS config (
	id INTEGER PRIMARY KEY CHECK (id = 1),
	monitor_id TEXT NOT NULL,
	name TEXT NOT NULL,
	expect_every_sec INTEGER NOT NULL,
	grace_sec INTEGER NOT NULL,
	p95_threshold_ms REAL,
	window_size INTEGER NOT NULL,
	notify_json TEXT,
	is_public INTEGER NOT NULL DEFAULT 1,
	beat_token_hash TEXT NOT NULL,
	base_url TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	liveness TEXT NOT NULL DEFAULT 'unknown',
	last_beat_at INTEGER,
	next_deadline INTEGER,
	reminder_count INTEGER NOT NULL DEFAULT 0,
	over_streak INTEGER NOT NULL DEFAULT 0,
	under_streak INTEGER NOT NULL DEFAULT 0,
	degraded INTEGER NOT NULL DEFAULT 0,
	failing INTEGER NOT NULL DEFAULT 0,
	last_notified_at INTEGER
);
CREATE TABLE IF NOT EXISTS beats (
	seq INTEGER PRIMARY KEY AUTOINCREMENT,
	at INTEGER NOT NULL,
	duration_ms REAL,
	status TEXT NOT NULL,
	meta_json TEXT
);
CREATE TABLE IF NOT EXISTS incidents (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	kind TEXT NOT NULL,
	opened_at INTEGER NOT NULL,
	closed_at INTEGER,
	detail TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS incidents_open_idx ON incidents (kind) WHERE closed_at IS NULL;
`;

type ConfigRow = {
	monitor_id: string;
	name: string;
	expect_every_sec: number;
	grace_sec: number;
	p95_threshold_ms: number | null;
	window_size: number;
	notify_json: string | null;
	is_public: number;
	beat_token_hash: string;
	base_url: string;
	created_at: number;
	updated_at: number;
	/** Stored liveness; `late` and `degraded` are derived at read time. */
	liveness: "unknown" | "up" | "down";
	last_beat_at: number | null;
	next_deadline: number | null;
	reminder_count: number;
	over_streak: number;
	under_streak: number;
	degraded: number;
	failing: number;
	last_notified_at: number | null;
};

type BeatRow = {
	seq: number;
	at: number;
	duration_ms: number | null;
	status: string;
	meta_json: string | null;
};

type IncidentRow = {
	id: number;
	kind: string;
	opened_at: number;
	closed_at: number | null;
	detail: string;
};

const EVENT_PRIORITY: Record<IncidentKind, number> = { missed: 0, fail: 1, p95: 2, recovered: 3 };

export class Monitor extends DurableObject<Env> {
	private readonly sql: SqlStorage;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.sql = ctx.storage.sql;
		ctx.blockConcurrencyWhile(async () => this.ensureSchema());
	}

	// ---------------------------------------------------------------- RPC API

	async configure(req: ConfigureRequest): Promise<DoResult<ConfigureResult>> {
		const { input, now } = req;
		const existing = this.loadConfig();

		if (!existing) {
			if (input.expectEverySec == null) {
				return { ok: false, status: 400, error: "expectEverySec is required when creating a monitor" };
			}
			const expect = input.expectEverySec;
			const grace = input.graceSec ?? 0;
			const deadline = now + (expect + grace) * 1000;
			this.sql.exec(
				`INSERT INTO config (id, monitor_id, name, expect_every_sec, grace_sec, p95_threshold_ms, window_size, notify_json,
					is_public, beat_token_hash, base_url, created_at, updated_at, liveness, next_deadline)
				 VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unknown', ?)`,
				req.monitorId,
				input.name ?? req.monitorId,
				expect,
				grace,
				input.p95ThresholdMs ?? null,
				input.windowSize ?? 200,
				input.notify ? JSON.stringify(input.notify) : null,
				input.public === false ? 0 : 1,
				req.providedTokenHash ?? req.generatedTokenHash,
				req.baseUrl,
				now,
				now,
				deadline,
			);
			await this.ctx.storage.setAlarm(deadline);
			const cfg = this.loadConfig();
			if (!cfg) throw new Error("config insert did not persist");
			return {
				ok: true,
				value: { created: true, tokenGenerated: req.providedTokenHash == null, status: this.buildStatus(cfg, now) },
			};
		}

		const cfg = existing;
		if (input.name !== undefined) cfg.name = input.name;
		if (input.expectEverySec !== undefined) cfg.expect_every_sec = input.expectEverySec;
		if (input.graceSec !== undefined) cfg.grace_sec = input.graceSec;
		if (input.windowSize !== undefined) cfg.window_size = input.windowSize;
		if (input.public !== undefined) cfg.is_public = input.public ? 1 : 0;
		if (input.notify !== undefined) cfg.notify_json = input.notify ? JSON.stringify(input.notify) : null;
		if (input.p95ThresholdMs !== undefined) {
			cfg.p95_threshold_ms = input.p95ThresholdMs;
			if (input.p95ThresholdMs === null && cfg.degraded) {
				cfg.degraded = 0;
				cfg.over_streak = 0;
				cfg.under_streak = 0;
				this.closeIncident("p95", now);
			}
		}
		if (req.providedTokenHash) cfg.beat_token_hash = req.providedTokenHash;
		cfg.base_url = req.baseUrl;
		cfg.updated_at = now;

		if (cfg.liveness !== "down") {
			const base = cfg.last_beat_at ?? cfg.created_at;
			cfg.next_deadline = base + (cfg.expect_every_sec + cfg.grace_sec) * 1000;
			await this.ctx.storage.setAlarm(cfg.next_deadline);
		}
		this.saveConfig(cfg);
		this.pruneBeats(cfg.window_size);
		return { ok: true, value: { created: false, tokenGenerated: false, status: this.buildStatus(cfg, now) } };
	}

	async beat(auth: AuthContext, input: BeatInput, now: number): Promise<DoResult<BeatResult>> {
		const cfg = this.loadConfig();
		if (!cfg) return notFound();
		if (!this.authorized(cfg, auth)) return unauthorized();

		const status: BeatStatus = input.status === "fail" ? "fail" : "ok";
		const durationMs = typeof input.durationMs === "number" ? input.durationMs : null;
		this.sql.exec(
			"INSERT INTO beats (at, duration_ms, status, meta_json) VALUES (?, ?, ?, ?)",
			now,
			durationMs,
			status,
			input.metaJson ?? null,
		);
		this.pruneBeats(cfg.window_size);

		const events: Array<{ kind: IncidentKind; detail: string }> = [];

		const recovered = (detail: string) => {
			this.recordRecovered(now, detail);
			events.push({ kind: "recovered", detail });
		};

		if (cfg.liveness === "down") {
			const openedAt = this.closeIncident("missed", now);
			recovered(`Beats resumed${openedAt == null ? "" : ` after ${fmtAge(now - openedAt)}`}`);
		}
		cfg.liveness = "up";
		cfg.last_beat_at = now;
		cfg.reminder_count = 0;
		cfg.next_deadline = now + (cfg.expect_every_sec + cfg.grace_sec) * 1000;
		await this.ctx.storage.setAlarm(cfg.next_deadline);

		if (status === "fail") {
			if (!cfg.failing) {
				cfg.failing = 1;
				const detail = `Beat reported status=fail${describeMeta(input.metaJson)}`;
				this.openIncident("fail", now, detail);
				events.push({ kind: "fail", detail });
			}
		} else if (cfg.failing) {
			cfg.failing = 0;
			this.closeIncident("fail", now);
			recovered("Beats are passing again");
		}

		const stats = computeStats(this.windowSamples(cfg.window_size));
		const p95 = stats.p95Ms;
		const threshold = cfg.p95_threshold_ms;
		if (threshold != null && durationMs != null && p95 != null) {
			if (p95 > threshold) {
				cfg.over_streak += 1;
				cfg.under_streak = 0;
			} else {
				cfg.under_streak += 1;
				cfg.over_streak = 0;
			}
			if (!cfg.degraded && cfg.over_streak >= DEGRADE_AFTER_BEATS) {
				cfg.degraded = 1;
				const detail = `p95 ${fmtMs(p95)} above threshold ${fmtMs(threshold)} for ${cfg.over_streak} consecutive beats`;
				this.openIncident("p95", now, detail);
				events.push({ kind: "p95", detail });
			} else if (cfg.degraded && cfg.under_streak >= RECOVER_AFTER_BEATS) {
				cfg.degraded = 0;
				this.closeIncident("p95", now);
				recovered(`p95 ${fmtMs(p95)} back under threshold ${fmtMs(threshold)}`);
			}
		}

		const state = this.deriveState(cfg, now);
		let pending: Promise<void> | null = null;
		if (events.length > 0) {
			events.sort((a, b) => EVENT_PRIORITY[a.kind] - EVENT_PRIORITY[b.kind]);
			const kind = events[0]!.kind;
			pending = this.dispatch(cfg, kind, state, p95, now, events.map((e) => e.detail).join("; "));
		}
		this.saveConfig(cfg);
		if (pending) this.ctx.waitUntil(pending);

		return { ok: true, value: { ok: true, state, p95Ms: p95, nextDeadline: iso(cfg.next_deadline) } };
	}

	async status(auth: AuthContext, now: number): Promise<DoResult<MonitorStatus>> {
		const cfg = this.loadConfig();
		if (!cfg) return notFound();
		if (!cfg.is_public && !this.authorized(cfg, auth)) return unauthorized();
		return { ok: true, value: this.buildStatus(cfg, now) };
	}

	async history(auth: AuthContext, limit: number): Promise<DoResult<HistoryResult>> {
		const cfg = this.loadConfig();
		if (!cfg) return notFound();
		if (!cfg.is_public && !this.authorized(cfg, auth)) return unauthorized();
		const rows = this.sql
			.exec<BeatRow>("SELECT seq, at, duration_ms, status, meta_json FROM beats ORDER BY seq DESC LIMIT ?", limit)
			.toArray();
		const beats: HistoryBeat[] = rows.map((r) => ({
			seq: r.seq,
			at: iso(r.at),
			durationMs: r.duration_ms,
			status: r.status === "fail" ? "fail" : "ok",
			metaJson: r.meta_json,
		}));
		return { ok: true, value: { id: cfg.monitor_id, count: beats.length, beats } };
	}

	async sparkline(auth: AuthContext, n: number, now: number): Promise<DoResult<SparklineData>> {
		const cfg = this.loadConfig();
		if (!cfg) return notFound();
		if (!cfg.is_public && !this.authorized(cfg, auth)) return unauthorized();
		const rows = this.sql
			.exec<Pick<BeatRow, "duration_ms" | "status">>(
				"SELECT duration_ms, status FROM beats WHERE duration_ms IS NOT NULL ORDER BY seq DESC LIMIT ?",
				n,
			)
			.toArray();
		const points: SparkPoint[] = rows
			.reverse()
			.map((r) => ({ durationMs: r.duration_ms as number, status: r.status === "fail" ? "fail" : "ok" }));
		const stats = computeStats(this.windowSamples(cfg.window_size));
		return {
			ok: true,
			value: {
				id: cfg.monitor_id,
				name: cfg.name,
				state: this.deriveState(cfg, now),
				p95Ms: stats.p95Ms,
				p95ThresholdMs: cfg.p95_threshold_ms,
				points,
			},
		};
	}

	/** Deletes everything for this monitor. Returns false when nothing existed. */
	async remove(): Promise<boolean> {
		if (!this.loadConfig()) return false;
		await this.ctx.storage.deleteAlarm();
		await this.ctx.storage.deleteAll();
		this.ensureSchema();
		return true;
	}

	// ------------------------------------------------------------- Alarm loop

	override async alarm(): Promise<void> {
		try {
			const cfg = this.loadConfig();
			if (!cfg) return;
			const now = Date.now();
			const expected = `expected every ${fmtAge(cfg.expect_every_sec * 1000)}, grace ${fmtAge(cfg.grace_sec * 1000)}`;
			let detail: string;
			if (cfg.liveness === "down") {
				cfg.reminder_count += 1;
				detail = `Still down: no beat for ${fmtAge(now - (cfg.last_beat_at ?? cfg.created_at))} (${expected})`;
			} else {
				cfg.liveness = "down";
				cfg.reminder_count = 1;
				detail =
					cfg.last_beat_at == null
						? `No beat received since the monitor was created ${fmtAge(now - cfg.created_at)} ago (${expected})`
						: `No beat for ${fmtAge(now - cfg.last_beat_at)} (${expected})`;
				this.openIncident("missed", now, detail);
			}
			const delay = reminderDelayMs(cfg.expect_every_sec, cfg.reminder_count);
			await this.ctx.storage.setAlarm(now + delay);
			const p95 = computeStats(this.windowSamples(cfg.window_size)).p95Ms;
			const pending = this.dispatch(cfg, "missed", "down", p95, now, `${detail}. Next reminder in ${fmtAge(delay)}`);
			this.saveConfig(cfg);
			if (pending) await pending;
		} catch (err) {
			console.error("heartbeat: alarm handler failed; re-arming in 60s", err);
			await this.ctx.storage.setAlarm(Date.now() + 60_000);
		}
	}

	// --------------------------------------------------------------- Internals

	private ensureSchema(): void {
		this.sql.exec(SCHEMA);
	}

	private loadConfig(): ConfigRow | null {
		return this.sql.exec<ConfigRow>("SELECT * FROM config WHERE id = 1").toArray()[0] ?? null;
	}

	private saveConfig(cfg: ConfigRow): void {
		this.sql.exec(
			`UPDATE config SET name = ?, expect_every_sec = ?, grace_sec = ?, p95_threshold_ms = ?, window_size = ?,
				notify_json = ?, is_public = ?, beat_token_hash = ?, base_url = ?, updated_at = ?, liveness = ?,
				last_beat_at = ?, next_deadline = ?, reminder_count = ?, over_streak = ?, under_streak = ?,
				degraded = ?, failing = ?, last_notified_at = ?
			 WHERE id = 1`,
			cfg.name,
			cfg.expect_every_sec,
			cfg.grace_sec,
			cfg.p95_threshold_ms,
			cfg.window_size,
			cfg.notify_json,
			cfg.is_public,
			cfg.beat_token_hash,
			cfg.base_url,
			cfg.updated_at,
			cfg.liveness,
			cfg.last_beat_at,
			cfg.next_deadline,
			cfg.reminder_count,
			cfg.over_streak,
			cfg.under_streak,
			cfg.degraded,
			cfg.failing,
			cfg.last_notified_at,
		);
	}

	private authorized(cfg: ConfigRow, auth: AuthContext): boolean {
		if (auth.admin) return true;
		if (!auth.tokenHash) return false;
		return timingSafeEqualString(auth.tokenHash, cfg.beat_token_hash);
	}

	private deriveState(cfg: ConfigRow, now: number): MonitorState {
		if (cfg.liveness === "down") return "down";
		if (cfg.next_deadline != null && now >= cfg.next_deadline) return "down";
		if (cfg.liveness === "unknown") return "unknown";
		if (cfg.last_beat_at != null && now >= cfg.last_beat_at + cfg.expect_every_sec * 1000) return "late";
		if (cfg.degraded || cfg.failing) return "degraded";
		return "up";
	}

	private windowSamples(windowSize: number): Sample[] {
		return this.sql
			.exec<{ durationMs: number | null; status: string }>(
				"SELECT duration_ms AS durationMs, status FROM beats ORDER BY seq DESC LIMIT ?",
				windowSize,
			)
			.toArray();
	}

	/** Keeps only the newest `windowSize` beats (ring buffer). */
	private pruneBeats(windowSize: number): void {
		this.sql.exec(
			"DELETE FROM beats WHERE seq <= (SELECT seq FROM beats ORDER BY seq DESC LIMIT 1 OFFSET ?)",
			windowSize,
		);
	}

	private openIncident(kind: IncidentKind, now: number, detail: string): void {
		const open = this.sql
			.exec<{ id: number }>("SELECT id FROM incidents WHERE kind = ? AND closed_at IS NULL LIMIT 1", kind)
			.toArray();
		if (open.length > 0) return;
		this.sql.exec("INSERT INTO incidents (kind, opened_at, closed_at, detail) VALUES (?, ?, NULL, ?)", kind, now, detail);
		this.pruneIncidents();
	}

	/** Closes the open incident of `kind`, returning when it was opened. */
	private closeIncident(kind: IncidentKind, now: number): number | null {
		const open = this.sql
			.exec<{ opened_at: number }>("SELECT opened_at FROM incidents WHERE kind = ? AND closed_at IS NULL LIMIT 1", kind)
			.toArray()[0];
		if (!open) return null;
		this.sql.exec("UPDATE incidents SET closed_at = ? WHERE kind = ? AND closed_at IS NULL", now, kind);
		return open.opened_at;
	}

	private recordRecovered(now: number, detail: string): void {
		this.sql.exec("INSERT INTO incidents (kind, opened_at, closed_at, detail) VALUES ('recovered', ?, ?, ?)", now, now, detail);
		this.pruneIncidents();
	}

	private pruneIncidents(): void {
		this.sql.exec(
			"DELETE FROM incidents WHERE closed_at IS NOT NULL AND id <= (SELECT id FROM incidents ORDER BY id DESC LIMIT 1 OFFSET ?)",
			INCIDENTS_KEPT,
		);
	}

	private recentIncidents(): Incident[] {
		return this.sql
			.exec<IncidentRow>("SELECT id, kind, opened_at, closed_at, detail FROM incidents ORDER BY id DESC LIMIT ?", INCIDENTS_RETURNED)
			.toArray()
			.map((r) => ({
				id: r.id,
				kind: r.kind as IncidentKind,
				openedAt: iso(r.opened_at),
				closedAt: iso(r.closed_at),
				detail: r.detail,
			}));
	}

	private buildStatus(cfg: ConfigRow, now: number): MonitorStatus {
		return {
			id: cfg.monitor_id,
			name: cfg.name,
			state: this.deriveState(cfg, now),
			public: cfg.is_public === 1,
			expectEverySec: cfg.expect_every_sec,
			graceSec: cfg.grace_sec,
			p95ThresholdMs: cfg.p95_threshold_ms,
			windowSize: cfg.window_size,
			createdAt: iso(cfg.created_at),
			lastBeatAt: iso(cfg.last_beat_at),
			nextDeadline: iso(cfg.next_deadline),
			stats: computeStats(this.windowSamples(cfg.window_size)),
			incidents: this.recentIncidents(),
		};
	}

	/**
	 * Applies the 1/min/monitor rate limit and returns the in-flight delivery
	 * (or null). Mutates `cfg.last_notified_at`; callers save the config afterwards.
	 */
	private dispatch(
		cfg: ConfigRow,
		kind: IncidentKind,
		state: MonitorState,
		p95Ms: number | null,
		now: number,
		detail: string,
	): Promise<void> | null {
		const notify = parseNotify(cfg.notify_json);
		if (!notify || (!notify.telegram && !notify.webhookUrl)) return null;
		if (cfg.last_notified_at != null && now - cfg.last_notified_at < NOTIFY_MIN_INTERVAL_MS) {
			console.log(`heartbeat: ${cfg.monitor_id} suppressed ${kind} notification (rate limit)`);
			return null;
		}
		cfg.last_notified_at = now;
		return sendNotifications(notify, {
			monitorId: cfg.monitor_id,
			name: cfg.name,
			kind,
			state,
			p95Ms,
			at: now,
			detail,
			statusUrl: `${cfg.base_url}/v1/monitors/${cfg.monitor_id}`,
		});
	}
}

function notFound(): DoResult<never> {
	return { ok: false, status: 404, error: "monitor not found" };
}

function unauthorized(): DoResult<never> {
	return { ok: false, status: 401, error: "unauthorized" };
}

function parseObject(text: string | null | undefined): Record<string, unknown> | null {
	if (text == null) return null;
	try {
		const parsed: unknown = JSON.parse(text);
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

function parseNotify(text: string | null): NotifyConfig | null {
	return parseObject(text) as NotifyConfig | null;
}

/** Pulls an error-ish field out of beat metadata for the incident detail. */
function describeMeta(metaJson: string | undefined): string {
	const meta = parseObject(metaJson);
	if (!meta) return "";
	const err = meta["error"] ?? meta["message"] ?? meta["exitCode"];
	if (err === undefined || err === null) return "";
	const text = typeof err === "string" ? err : JSON.stringify(err);
	return `: ${text.length > 160 ? `${text.slice(0, 157)}...` : text}`;
}
