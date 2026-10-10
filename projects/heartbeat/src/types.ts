export type MonitorState = "up" | "late" | "down" | "degraded" | "unknown";
export type BeatStatus = "ok" | "fail";
export type IncidentKind = "missed" | "p95" | "fail" | "recovered";

export interface TelegramTarget {
	botToken: string;
	chatId: string;
}

export interface NotifyConfig {
	telegram?: TelegramTarget;
	webhookUrl?: string;
}

/** Validated body of `PUT /v1/monitors/:id`. Every field is optional on update. */
export interface MonitorInput {
	name?: string;
	expectEverySec?: number;
	graceSec?: number;
	/** `null` clears the threshold. */
	p95ThresholdMs?: number | null;
	windowSize?: number;
	/** `null` removes all notification targets. */
	notify?: NotifyConfig | null;
	public?: boolean;
}

export interface ConfigureRequest {
	monitorId: string;
	input: MonitorInput;
	/** sha256 hex of a caller-supplied beat token, or null when none was supplied. */
	providedTokenHash: string | null;
	/** sha256 hex of a freshly generated token; used only when creating without a supplied token. */
	generatedTokenHash: string;
	/** Origin of the API, stored so notifications can link back to the status page. */
	baseUrl: string;
	now: number;
}

export interface ConfigureResult {
	created: boolean;
	/** True when the generated token was adopted; the caller must reveal it exactly once. */
	tokenGenerated: boolean;
	status: MonitorStatus;
}

export interface AuthContext {
	admin: boolean;
	/** sha256 hex of the presented bearer token when it is not the admin token. */
	tokenHash: string | null;
}

export interface BeatInput {
	durationMs?: number;
	status?: BeatStatus;
	/** Caller-provided metadata, already serialised to JSON by the Worker. */
	metaJson?: string;
}

export interface BeatResult {
	ok: true;
	state: MonitorState;
	p95Ms: number | null;
	nextDeadline: string;
}

export interface Stats {
	count: number;
	p50Ms: number | null;
	p95Ms: number | null;
	p99Ms: number | null;
	failRate: number | null;
}

export interface Incident {
	id: number;
	kind: IncidentKind;
	openedAt: string;
	closedAt: string | null;
	detail: string;
}

export interface MonitorStatus {
	id: string;
	name: string;
	state: MonitorState;
	public: boolean;
	expectEverySec: number;
	graceSec: number;
	p95ThresholdMs: number | null;
	windowSize: number;
	createdAt: string;
	lastBeatAt: string | null;
	nextDeadline: string | null;
	stats: Stats;
	incidents: Incident[];
}

export interface HistoryBeat {
	seq: number;
	at: string;
	durationMs: number | null;
	status: BeatStatus;
	/** Raw JSON text; the Worker parses it before responding. */
	metaJson: string | null;
}

export interface HistoryResult {
	id: string;
	count: number;
	beats: HistoryBeat[];
}

export interface SparkPoint {
	durationMs: number;
	status: BeatStatus;
}

export interface SparklineData {
	id: string;
	name: string;
	state: MonitorState;
	p95Ms: number | null;
	p95ThresholdMs: number | null;
	points: SparkPoint[];
}

export type DoError = { ok: false; status: 400 | 401 | 404; error: string };
export type DoResult<T> = { ok: true; value: T } | DoError;

export interface NotificationEvent {
	monitorId: string;
	name: string;
	kind: IncidentKind;
	state: MonitorState;
	p95Ms: number | null;
	at: number;
	detail: string;
	statusUrl: string;
}
