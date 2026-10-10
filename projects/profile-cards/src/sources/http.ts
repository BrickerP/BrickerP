import type { Deps } from "../types.js";

export class SourceError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "SourceError";
  }
}

/** Fetch JSON with a per-request timeout; throws SourceError with a short reason. */
export async function fetchJson<T>(deps: Deps, url: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await deps.fetch(url, { ...init, signal: AbortSignal.timeout(deps.timeoutMs) });
  } catch (error) {
    const reason = error instanceof Error && error.name === "TimeoutError" ? "timeout" : "network error";
    throw new SourceError(reason);
  }
  if (!response.ok) {
    if (response.status === 403 || response.status === 429) {
      const remaining = response.headers.get("x-ratelimit-remaining");
      if (remaining === "0" || response.status === 429) throw new SourceError("rate limited", response.status);
    }
    throw new SourceError(`http ${response.status}`, response.status);
  }
  try {
    return (await response.json()) as T;
  } catch {
    throw new SourceError("invalid json");
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof SourceError) return error.message;
  if (error instanceof Error) return error.message.slice(0, 80);
  return "unknown error";
}

export function trimBaseUrl(value: string | undefined): string | null {
  const trimmed = (value ?? "").trim().replace(/\/+$/, "");
  if (!trimmed) return null;
  if (!/^https?:\/\//.test(trimmed)) return null;
  return trimmed;
}
