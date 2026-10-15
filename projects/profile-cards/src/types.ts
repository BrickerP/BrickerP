export type SourceState = "ok" | "stale" | "unconfigured" | "error";

export type HeartbeatState = "up" | "late" | "down" | "degraded" | "unknown";

export interface HeartbeatInfo {
  monitorId: string;
  name: string | null;
  state: HeartbeatState;
  lastBeatAt: string | null;
  nextDeadline: string | null;
  count: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
  p95ThresholdMs: number | null;
}

export interface CommitInfo {
  repo: string;
  ref: string | null;
  sha: string;
  message: string | null;
  at: string;
  url: string;
}

export type SourceResult<T> =
  | { state: "ok"; data: T; fetchedAt: string }
  | { state: "stale"; data: T; fetchedAt: string; error: string }
  | { state: "unconfigured" }
  | { state: "error"; error: string };

export interface Status {
  renderedAt: string;
  heartbeat: SourceResult<HeartbeatInfo>;
  commit: SourceResult<CommitInfo>;
}

/** What is persisted in KV: the last successful payload per source. */
export interface Memory {
  updatedAt: string;
  heartbeat?: { data: HeartbeatInfo; fetchedAt: string };
  commit?: { data: CommitInfo; fetchedAt: string };
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface Deps {
  fetch: FetchLike;
  now: () => Date;
  timeoutMs: number;
}
