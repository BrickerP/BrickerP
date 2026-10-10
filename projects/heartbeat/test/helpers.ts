import { env, exports } from "cloudflare:workers";
import { expect, vi } from "vitest";
import type { AuthContext, MonitorStatus } from "../src/types";
import { sha256Hex } from "../src/util";

export const ADMIN_TOKEN = "test-admin-token-0123456789abcdef";
export const BASE = "https://heartbeat.test";
export const ADMIN: AuthContext = { admin: true, tokenHash: null };

export function api(path: string, init: RequestInit = {}): Promise<Response> {
	return exports.default.fetch(`${BASE}${path}`, init);
}

export function adminJson(method: string, path: string, body?: unknown): Promise<Response> {
	return api(path, {
		method,
		headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
}

export interface CreateResponse {
	ok: boolean;
	created: boolean;
	beatToken?: string;
	monitor: MonitorStatus;
}

export async function createMonitor(id: string, body: Record<string, unknown> = {}): Promise<CreateResponse> {
	const res = await adminJson("PUT", `/v1/monitors/${id}`, { expectEverySec: 300, graceSec: 120, ...body });
	expect(res.status, await res.clone().text()).toBe(201);
	return res.json<CreateResponse>();
}

export function beat(id: string, token: string, body?: Record<string, unknown>): Promise<Response> {
	return api(`/v1/monitors/${id}/beat`, {
		method: "POST",
		headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
}

export async function tokenAuth(token: string): Promise<AuthContext> {
	return { admin: false, tokenHash: await sha256Hex(token) };
}

/** Direct stub for Durable Object level tests. */
export function monitorStub(id: string) {
	return env.MONITOR.getByName(id);
}

export interface CapturedNotification {
	url: string;
	body: Record<string, unknown>;
}

/**
 * Replaces global fetch (shared with the Durable Object, which runs in the
 * test isolate) and records every outbound notification.
 */
export function captureNotifications(): CapturedNotification[] {
	const calls: CapturedNotification[] = [];
	vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		const raw = init?.body;
		const text = typeof raw === "string" ? raw : "";
		let body: Record<string, unknown> = {};
		try {
			body = JSON.parse(text) as Record<string, unknown>;
		} catch {
			body = { raw: text };
		}
		calls.push({ url, body });
		return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
	});
	return calls;
}

export function uniqueId(prefix: string): string {
	return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}
