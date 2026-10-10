import type { Deps, HeartbeatInfo, HeartbeatState } from "../types.js";
import { fetchJson, SourceError } from "./http.js";

/** Shape of the heartbeat public API (projects/heartbeat). */
interface MonitorStatus {
  id: string;
  name?: string | null;
  state: string;
  lastBeatAt?: string | null;
  nextDeadline?: string | null;
  p95ThresholdMs?: number | null;
  config?: { p95ThresholdMs?: number | null } | null;
  stats?: { count?: number; p50Ms?: number | null; p95Ms?: number | null } | null;
}

const STATES: ReadonlySet<string> = new Set(["up", "late", "down", "degraded", "unknown"]);

export async function fetchHeartbeat(deps: Deps, baseUrl: string, monitorId: string): Promise<HeartbeatInfo> {
  const status = await fetchJson<MonitorStatus>(deps, `${baseUrl}/v1/monitors/${encodeURIComponent(monitorId)}`);
  if (typeof status.state !== "string") throw new SourceError("bad status");
  const state: HeartbeatState = STATES.has(status.state) ? (status.state as HeartbeatState) : "unknown";
  const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
  return {
    monitorId: status.id ?? monitorId,
    name: status.name ?? null,
    state,
    lastBeatAt: status.lastBeatAt ?? null,
    nextDeadline: status.nextDeadline ?? null,
    count: num(status.stats?.count),
    p50Ms: num(status.stats?.p50Ms),
    p95Ms: num(status.stats?.p95Ms),
    p95ThresholdMs: num(status.p95ThresholdMs ?? status.config?.p95ThresholdMs),
  };
}
