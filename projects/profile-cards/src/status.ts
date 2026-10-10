import { fetchLatestCommit } from "./sources/github.js";
import { fetchHeartbeat } from "./sources/heartbeat.js";
import { errorMessage, trimBaseUrl } from "./sources/http.js";
import { fetchLatestFill } from "./sources/ledger.js";
import type { CommitInfo, Deps, FillInfo, HeartbeatInfo, Memory, SourceResult, Status } from "./types.js";

export const MEMORY_KEY = "memory:v1";

/** Everything persisted in KV: the last computed status plus last-known-good per source. */
export interface Stored {
  version: 1;
  status: Status;
  memory: Memory;
}

export interface StatusConfig {
  githubUser: string;
  githubFallbackRepo: string;
  githubToken: string | undefined;
  ledgerBaseUrl: string | null;
  ledgerId: string;
  heartbeatBaseUrl: string | null;
  heartbeatMonitorId: string;
  ttlSeconds: number;
}

export function configFromEnv(env: Env): StatusConfig {
  return {
    githubUser: env.GITHUB_USER,
    githubFallbackRepo: env.GITHUB_FALLBACK_REPO,
    githubToken: env.GITHUB_TOKEN?.trim() || undefined,
    ledgerBaseUrl: trimBaseUrl(env.LEDGER_BASE_URL),
    ledgerId: env.LEDGER_ID,
    heartbeatBaseUrl: trimBaseUrl(env.HEARTBEAT_BASE_URL),
    heartbeatMonitorId: env.HEARTBEAT_MONITOR_ID,
    ttlSeconds: parseTtl(env.CACHE_TTL_SECONDS),
  };
}

export function parseTtl(value: string | undefined, fallback = 300): number {
  const n = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(3600, Math.max(30, n));
}

interface Remembered<T> {
  data: T;
  fetchedAt: string;
}

/**
 * Run one source. Success refreshes its memory slot; failure falls back to the
 * remembered value (marked stale) when there is one.
 */
async function resolve<T>(
  configured: boolean,
  load: () => Promise<T>,
  remembered: Remembered<T> | undefined,
  remember: (value: Remembered<T>) => void,
  now: Date,
): Promise<SourceResult<T>> {
  if (!configured) return { state: "unconfigured" };
  const fetchedAt = now.toISOString();
  try {
    const data = await load();
    remember({ data, fetchedAt });
    return { state: "ok", data, fetchedAt };
  } catch (error) {
    const message = errorMessage(error);
    if (remembered) return { state: "stale", data: remembered.data, fetchedAt: remembered.fetchedAt, error: message };
    return { state: "error", error: message };
  }
}

/** Query every source in parallel, falling back to remembered data on failure. */
export async function collectStatus(config: StatusConfig, deps: Deps, previous: Memory | null): Promise<Stored> {
  const now = deps.now();
  const memory: Memory = { ...(previous ?? {}), updatedAt: now.toISOString() };

  const [fill, heartbeat, commit] = await Promise.all([
    resolve<FillInfo>(
      config.ledgerBaseUrl !== null,
      () => fetchLatestFill(deps, config.ledgerBaseUrl as string, config.ledgerId),
      memory.fill,
      (value) => {
        memory.fill = value;
      },
      now,
    ),
    resolve<HeartbeatInfo>(
      config.heartbeatBaseUrl !== null,
      () => fetchHeartbeat(deps, config.heartbeatBaseUrl as string, config.heartbeatMonitorId),
      memory.heartbeat,
      (value) => {
        memory.heartbeat = value;
      },
      now,
    ),
    resolve<CommitInfo>(
      config.githubUser.trim() !== "",
      () => fetchLatestCommit(deps, { user: config.githubUser, fallbackRepo: config.githubFallbackRepo, token: config.githubToken }),
      memory.commit,
      (value) => {
        memory.commit = value;
      },
      now,
    ),
  ]);

  return { version: 1, status: { renderedAt: now.toISOString(), fill, heartbeat, commit }, memory };
}

export async function readStored(kv: KVNamespace): Promise<Stored | null> {
  try {
    const value = await kv.get<Stored>(MEMORY_KEY, "json");
    if (value && value.version === 1 && value.status && value.memory) return value;
    return null;
  } catch (error) {
    console.error(JSON.stringify({ message: "kv read failed", error: errorMessage(error) }));
    return null;
  }
}

export function isFresh(renderedAt: string, now: Date, ttlSeconds: number): boolean {
  const at = Date.parse(renderedAt);
  if (Number.isNaN(at)) return false;
  return now.getTime() - at < ttlSeconds * 1000;
}

export interface Resolved {
  status: Status;
  /** True when served from KV without contacting any source. */
  cached: boolean;
}

/**
 * Serve the remembered status while it is fresh; otherwise refresh every source
 * and persist the result (in the background) for the next request.
 */
export async function getStatus(env: Env, ctx: ExecutionContext, deps: Deps, config = configFromEnv(env)): Promise<Resolved> {
  const stored = await readStored(env.MEMORY);
  if (stored && isFresh(stored.status.renderedAt, deps.now(), config.ttlSeconds)) return { status: stored.status, cached: true };

  const next = await collectStatus(config, deps, stored?.memory ?? null);
  ctx.waitUntil(
    env.MEMORY.put(MEMORY_KEY, JSON.stringify(next)).catch((error: unknown) => {
      console.error(JSON.stringify({ message: "kv write failed", error: errorMessage(error) }));
    }),
  );
  return { status: next.status, cached: false };
}

/** True when at least one tile is missing data it is supposed to have. */
export function isDegraded(status: Status): boolean {
  return [status.fill, status.heartbeat, status.commit].some((s) => s.state === "error" || s.state === "stale");
}
