/** Static bearer-token auth for /mcp and /sse. See README for the OAuth / Access upgrade path. */

const encoder = new TextEncoder();

/** Constant-time string equality (length leaks are unavoidable and acceptable for API keys). */
export function timingSafeEqualStrings(a: string, b: string): boolean {
  const bytesA = encoder.encode(a);
  const bytesB = encoder.encode(b);
  if (bytesA.byteLength !== bytesB.byteLength) {
    // Burn comparable time, then reject.
    constantTimeCompare(bytesA, bytesA);
    return false;
  }
  return constantTimeCompare(bytesA, bytesB);
}

function constantTimeCompare(a: Uint8Array, b: Uint8Array): boolean {
  const subtle = crypto.subtle as SubtleCrypto & { timingSafeEqual?: (x: ArrayBufferView, y: ArrayBufferView) => boolean };
  if (typeof subtle.timingSafeEqual === "function") return subtle.timingSafeEqual(a, b);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

export type AuthResult = { ok: true } | { ok: false; response: Response };

export function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() || null;
}

export function authenticate(request: Request, apiKey: string | undefined): AuthResult {
  if (!apiKey) {
    return {
      ok: false,
      response: jsonError(503, "server_misconfigured", "MCP_API_KEY is not configured on this deployment"),
    };
  }
  const token = bearerToken(request);
  if (!token || !timingSafeEqualStrings(token, apiKey)) {
    return {
      ok: false,
      response: jsonError(401, "unauthorized", "send `Authorization: Bearer <MCP_API_KEY>`", {
        "www-authenticate": 'Bearer realm="ledger-mcp"',
      }),
    };
  }
  return { ok: true };
}

export function jsonError(status: number, error: string, message: string, headers: Record<string, string> = {}): Response {
  return Response.json({ error, message }, { status, headers: { "cache-control": "no-store", ...headers } });
}
