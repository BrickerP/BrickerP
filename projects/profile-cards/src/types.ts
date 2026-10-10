export type SourceState = "ok" | "stale" | "unconfigured" | "error";

export interface FillInfo {
  ledgerId: string;
  seq: number;
  count: number;
  headHash: string;
  type: string;
  symbol: string | null;
  side: "buy" | "sell" | null;
  qty: number | null;
  price: number | null;
  ts: string;
}

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
  fill: SourceResult<FillInfo>;
  heartbeat: SourceResult<HeartbeatInfo>;
  commit: SourceResult<CommitInfo>;
}

/** What is persisted in KV: the last successful payload per source. */
export interface Memory {
  updatedAt: string;
  fill?: { data: FillInfo; fetchedAt: string };
  heartbeat?: { data: HeartbeatInfo; fetchedAt: string };
  commit?: { data: CommitInfo; fetchedAt: string };
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface Deps {
  fetch: FetchLike;
  now: () => Date;
  timeoutMs: number;
}
