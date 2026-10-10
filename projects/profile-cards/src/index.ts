import { fnv1a } from "./format.js";
import { renderCard } from "./render/card.js";
import { configFromEnv, getStatus, isDegraded } from "./status.js";
import type { Deps, Status } from "./types.js";

const DEGRADED_TTL_SECONDS = 60;

function defaultDeps(): Deps {
  return {
    fetch: (input, init) => fetch(input, init),
    now: () => new Date(),
    timeoutMs: 3000,
  };
}

function cacheControl(seconds: number): string {
  return `public, max-age=${seconds}, s-maxage=${seconds}, stale-while-revalidate=60`;
}

function withEtag(request: Request, body: string, init: ResponseInit & { headers: Record<string, string> }): Response {
  const etag = `W/"${fnv1a(body)}"`;
  const headers = { ...init.headers, ETag: etag, Vary: "Accept-Encoding" };
  if (request.headers.get("If-None-Match") === etag) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(request.method === "HEAD" ? null : body, { ...init, headers });
}

function emptyStatus(now: Date, error: string): Status {
  return {
    renderedAt: now.toISOString(),
    fill: { state: "error", error },
    heartbeat: { state: "error", error },
    commit: { state: "error", error },
  };
}

async function resolveStatus(env: Env, ctx: ExecutionContext, deps: Deps): Promise<{ status: Status; cached: boolean }> {
  try {
    return await getStatus(env, ctx, deps);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({ message: "status resolution failed", error: message }));
    return { status: emptyStatus(deps.now(), "internal error"), cached: false };
  }
}

function cardResponse(request: Request, env: Env, status: Status, cached: boolean, deps: Deps): Response {
  const config = configFromEnv(env);
  const svg = renderCard(status, { title: env.CARD_TITLE, now: deps.now(), ttlSeconds: config.ttlSeconds, githubUser: config.githubUser });
  const ttl = isDegraded(status) ? Math.min(DEGRADED_TTL_SECONDS, config.ttlSeconds) : config.ttlSeconds;
  return withEtag(request, svg, {
    status: 200,
    headers: {
      "Content-Type": "image/svg+xml; charset=utf-8",
      "Cache-Control": cacheControl(ttl),
      "Access-Control-Allow-Origin": "*",
      "X-Content-Type-Options": "nosniff",
      "X-Profile-Cards-Source": cached ? "memory" : "live",
    },
  });
}

function statusResponse(request: Request, env: Env, status: Status, cached: boolean): Response {
  const config = configFromEnv(env);
  const ttl = isDegraded(status) ? Math.min(DEGRADED_TTL_SECONDS, config.ttlSeconds) : config.ttlSeconds;
  const body = JSON.stringify(
    {
      ...status,
      cache: { ttlSeconds: config.ttlSeconds, servedFrom: cached ? "memory" : "live" },
      sources: {
        github: config.githubUser ? "configured" : "unconfigured",
        ledger: config.ledgerBaseUrl ? "configured" : "unconfigured",
        heartbeat: config.heartbeatBaseUrl ? "configured" : "unconfigured",
      },
    },
    null,
    2,
  );
  return withEtag(request, body, {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": cacheControl(ttl),
      "Access-Control-Allow-Origin": "*",
    },
  });
}

function landing(request: Request): Response {
  const origin = new URL(request.url).origin;
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>profile-cards — live SVG status cards</title>
<style>
  body { margin: 0; padding: 48px 24px; background: #F4F0E3; color: #111; font: 17px/1.5 Arial, Helvetica, sans-serif; }
  main { max-width: 1200px; margin: 0 auto; }
  h1 { font-size: 28px; letter-spacing: 2px; text-transform: uppercase; margin: 0 0 8px; }
  p { max-width: 70ch; }
  img { width: 100%; height: auto; display: block; border: 2px solid #111; margin: 24px 0; }
  code, pre { font: 15px/1.5 ui-monospace, Menlo, Consolas, monospace; }
  pre { background: #fff; border: 2px solid #111; padding: 16px; overflow-x: auto; }
  a { color: #1457FF; }
</style>
</head>
<body>
<main>
  <h1>profile-cards</h1>
  <p>Live SVG status cards for a GitHub profile README, rendered at the edge by a Cloudflare Worker. The card below is the live one.</p>
  <img src="/card.svg" alt="Live status card" width="1200" height="400">
  <p>Embed it in a README:</p>
  <pre>&lt;img src="${origin}/card.svg" width="100%" alt="Live status"&gt;</pre>
  <p>Machine-readable data: <a href="/status.json">/status.json</a>. Source: <a href="https://github.com/BrickerP/BrickerP/tree/main/projects/profile-cards">BrickerP/BrickerP · projects/profile-cards</a>.</p>
</main>
</body>
</html>
`;
  return new Response(request.method === "HEAD" ? null : html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
    }
    const url = new URL(request.url);
    const deps = defaultDeps();

    switch (url.pathname) {
      case "/":
        return landing(request);
      case "/card.svg": {
        const { status, cached } = await resolveStatus(env, ctx, deps);
        return cardResponse(request, env, status, cached, deps);
      }
      case "/status.json": {
        const { status, cached } = await resolveStatus(env, ctx, deps);
        return statusResponse(request, env, status, cached);
      }
      case "/healthz":
        return new Response("ok", { headers: { "Cache-Control": "no-store" } });
      default:
        return new Response("Not found", { status: 404, headers: { "Cache-Control": "public, max-age=60" } });
    }
  },
} satisfies ExportedHandler<Env>;
