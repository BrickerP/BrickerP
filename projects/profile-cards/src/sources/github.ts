import type { CommitInfo, Deps } from "../types.js";
import { fetchJson, SourceError } from "./http.js";

const API = "https://api.github.com";

interface PushEvent {
  type: string;
  created_at: string;
  repo: { name: string };
  payload: { ref?: string; head?: string };
}

interface CommitDetail {
  sha: string;
  html_url: string;
  commit: { message: string; author?: { date?: string } | null; committer?: { date?: string } | null };
}

export interface GitHubOptions {
  user: string;
  fallbackRepo: string;
  token?: string | undefined;
}

function headers(token: string | undefined): HeadersInit {
  const h: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "profile-cards (+https://github.com/BrickerP/BrickerP)",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

/**
 * Latest public commit by the user: the newest PushEvent in their public
 * events feed, enriched with the commit message. Falls back to the newest
 * commit of `fallbackRepo` when the feed has no push or is unavailable.
 */
export async function fetchLatestCommit(deps: Deps, opts: GitHubOptions): Promise<CommitInfo> {
  const h = headers(opts.token);
  let feedError: unknown;
  try {
    const events = await fetchJson<PushEvent[]>(deps, `${API}/users/${encodeURIComponent(opts.user)}/events/public?per_page=30`, {
      headers: h,
    });
    const push = events.find((e) => e.type === "PushEvent" && typeof e.payload?.head === "string");
    if (push && push.payload.head) {
      const base: CommitInfo = {
        repo: push.repo.name,
        ref: push.payload.ref ? push.payload.ref.replace(/^refs\/heads\//, "") : null,
        sha: push.payload.head,
        message: null,
        at: push.created_at,
        url: `https://github.com/${push.repo.name}/commit/${push.payload.head}`,
      };
      try {
        const detail = await fetchJson<CommitDetail>(deps, `${API}/repos/${push.repo.name}/commits/${push.payload.head}`, { headers: h });
        return {
          ...base,
          message: detail.commit.message,
          at: detail.commit.committer?.date ?? detail.commit.author?.date ?? base.at,
          url: detail.html_url ?? base.url,
        };
      } catch {
        // The event alone is still a valid answer; the message is optional.
        return base;
      }
    }
  } catch (error) {
    feedError = error;
  }

  try {
    const commits = await fetchJson<CommitDetail[]>(deps, `${API}/repos/${opts.fallbackRepo}/commits?per_page=1`, { headers: h });
    const latest = commits[0];
    if (!latest) throw new SourceError("no commits");
    return {
      repo: opts.fallbackRepo,
      ref: null,
      sha: latest.sha,
      message: latest.commit.message,
      at: latest.commit.committer?.date ?? latest.commit.author?.date ?? deps.now().toISOString(),
      url: latest.html_url,
    };
  } catch (error) {
    throw feedError instanceof SourceError ? feedError : error;
  }
}
