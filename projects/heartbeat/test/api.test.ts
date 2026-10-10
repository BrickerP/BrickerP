import { afterEach, describe, expect, it, vi } from "vitest";
import type { MonitorStatus } from "../src/types";
import { ADMIN_TOKEN, adminJson, api, beat, createMonitor, uniqueId } from "./helpers";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("landing and routing", () => {
	it("serves the HTML landing page without secrets", async () => {
		const res = await api("/");
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/html");
		const html = await res.text();
		expect(html).toContain("heartbeat");
		expect(html).toContain("/v1/monitors/");
		expect(html).not.toContain(ADMIN_TOKEN);
	});

	it("returns 404 JSON for unknown paths", async () => {
		const res = await api("/nope");
		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({ error: "not found" });
	});

	it("rejects invalid monitor ids with 400", async () => {
		const res = await adminJson("PUT", "/v1/monitors/Not_Valid!", { expectEverySec: 60 });
		expect(res.status).toBe(400);
		const body = await res.json<{ error: string }>();
		expect(body.error).toContain("invalid monitor id");
	});

	it("answers CORS preflight", async () => {
		const res = await api("/v1/monitors/x", { method: "OPTIONS" });
		expect(res.status).toBe(204);
		expect(res.headers.get("access-control-allow-origin")).toBe("*");
	});
});

describe("create / update", () => {
	it("creates a monitor and returns the beat token exactly once", async () => {
		const id = uniqueId("create");
		const created = await createMonitor(id, { name: "Scan batch", p95ThresholdMs: 5000 });
		expect(created.created).toBe(true);
		expect(created.beatToken).toMatch(/^hb_[A-Za-z0-9_-]{32}$/);
		expect(created.monitor.state).toBe("unknown");
		expect(created.monitor.name).toBe("Scan batch");
		expect(created.monitor.p95ThresholdMs).toBe(5000);
		expect(created.monitor.windowSize).toBe(200);
		expect(JSON.stringify(created.monitor)).not.toContain(created.beatToken);

		const updated = await adminJson("PUT", `/v1/monitors/${id}`, { graceSec: 30 });
		expect(updated.status).toBe(200);
		const body = await updated.json<{ created: boolean; beatToken?: string; monitor: MonitorStatus }>();
		expect(body.created).toBe(false);
		expect(body.beatToken).toBeUndefined();
		expect(body.monitor.graceSec).toBe(30);
		expect(body.monitor.expectEverySec).toBe(300);

		const status = await (await api(`/v1/monitors/${id}`)).json<MonitorStatus>();
		expect(JSON.stringify(status)).not.toContain("beatToken");
	});

	it("accepts a caller-supplied beat token and does not echo it", async () => {
		const id = uniqueId("owntoken");
		const token = "my-very-own-secret-token-123";
		const res = await adminJson("PUT", `/v1/monitors/${id}`, { expectEverySec: 60, beatToken: token });
		expect(res.status).toBe(201);
		const body = await res.json<{ beatToken?: string }>();
		expect(body.beatToken).toBeUndefined();
		expect((await beat(id, token, { durationMs: 10 })).status).toBe(200);
		expect((await beat(id, "hb_wrong-token-that-is-long-enough", { durationMs: 10 })).status).toBe(401);
	});

	it("requires expectEverySec on create and validates fields", async () => {
		const id = uniqueId("validate");
		expect((await adminJson("PUT", `/v1/monitors/${id}`, {})).status).toBe(400);
		expect((await adminJson("PUT", `/v1/monitors/${id}`, { expectEverySec: 0 })).status).toBe(400);
		expect((await adminJson("PUT", `/v1/monitors/${id}`, { expectEverySec: 60, windowSize: 5001 })).status).toBe(400);
		expect((await adminJson("PUT", `/v1/monitors/${id}`, { expectEverySec: 60, beatToken: "short" })).status).toBe(400);
		expect((await adminJson("PUT", `/v1/monitors/${id}`, { expectEverySec: 60, notify: { webhookUrl: "ftp://x" } })).status).toBe(400);
		expect((await adminJson("PUT", `/v1/monitors/${id}`, { expectEverySec: 60, notify: { telegram: { botToken: "bad", chatId: "1" } } })).status).toBe(400);
		const notJson = await api(`/v1/monitors/${id}`, {
			method: "PUT",
			headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
			body: "{not json",
		});
		expect(notJson.status).toBe(400);
	});
});

describe("beats and status", () => {
	it("updates stats, state and incidents with each beat", async () => {
		const id = uniqueId("beats");
		const { beatToken } = await createMonitor(id, { p95ThresholdMs: 5000 });
		const token = beatToken!;

		for (let i = 1; i <= 20; i++) {
			const res = await beat(id, token, { durationMs: 2000 + i * 20, meta: { batch: i } });
			expect(res.status).toBe(200);
			const body = await res.json<{ ok: boolean; state: string; p95Ms: number; nextDeadline: string }>();
			expect(body.ok).toBe(true);
			expect(body.state).toBe("up");
			expect(Date.parse(body.nextDeadline)).toBeGreaterThan(Date.now() + 400_000);
		}

		const status = await (await api(`/v1/monitors/${id}`)).json<MonitorStatus>();
		expect(status.state).toBe("up");
		expect(status.stats.count).toBe(20);
		expect(status.stats.p50Ms).toBe(2200);
		expect(status.stats.p95Ms).toBe(2380);
		expect(status.stats.p99Ms).toBe(2400);
		expect(status.stats.failRate).toBe(0);
		expect(status.lastBeatAt).not.toBeNull();
		expect(status.incidents).toEqual([]);
	});

	it("accepts an empty body and the admin token for beats", async () => {
		const id = uniqueId("emptybeat");
		await createMonitor(id);
		const res = await api(`/v1/monitors/${id}/beat`, { method: "POST", headers: { authorization: `Bearer ${ADMIN_TOKEN}` } });
		expect(res.status).toBe(200);
		const status = await (await api(`/v1/monitors/${id}`)).json<MonitorStatus>();
		expect(status.stats.count).toBe(1);
		expect(status.stats.p95Ms).toBeNull();
	});

	it("opens a fail incident on status=fail and closes it on the next ok beat", async () => {
		const id = uniqueId("fail");
		const { beatToken } = await createMonitor(id);
		const token = beatToken!;
		await beat(id, token, { durationMs: 100 });
		const failed = await beat(id, token, { durationMs: 100, status: "fail", meta: { error: "boom" } });
		expect((await failed.json<{ state: string }>()).state).toBe("degraded");

		let status = await (await api(`/v1/monitors/${id}`)).json<MonitorStatus>();
		expect(status.state).toBe("degraded");
		expect(status.stats.failRate).toBe(0.5);
		expect(status.incidents[0]).toMatchObject({ kind: "fail", closedAt: null });
		expect(status.incidents[0]!.detail).toContain("boom");

		await beat(id, token, { durationMs: 100 });
		status = await (await api(`/v1/monitors/${id}`)).json<MonitorStatus>();
		expect(status.state).toBe("up");
		expect(status.incidents.map((i) => i.kind)).toEqual(["recovered", "fail"]);
		expect(status.incidents[1]!.closedAt).not.toBeNull();
	});

	it("trims the ring buffer to windowSize", async () => {
		const id = uniqueId("ring");
		const { beatToken } = await createMonitor(id, { windowSize: 5 });
		for (let i = 1; i <= 8; i++) await beat(id, beatToken!, { durationMs: i * 100 });
		const history = await (await api(`/v1/monitors/${id}/history?limit=50`)).json<{ count: number; beats: Array<{ durationMs: number; meta: unknown }> }>();
		expect(history.count).toBe(5);
		expect(history.beats.map((b) => b.durationMs)).toEqual([800, 700, 600, 500, 400]);
		const status = await (await api(`/v1/monitors/${id}`)).json<MonitorStatus>();
		expect(status.stats.count).toBe(5);
		expect(status.stats.p50Ms).toBe(600);
	});

	it("validates beat bodies", async () => {
		const id = uniqueId("beatvalid");
		const { beatToken } = await createMonitor(id);
		expect((await beat(id, beatToken!, { durationMs: -1 })).status).toBe(400);
		expect((await beat(id, beatToken!, { status: "meh" })).status).toBe(400);
		expect((await beat(id, beatToken!, { meta: "x".repeat(5000) })).status).toBe(400);
	});
});

describe("auth", () => {
	it("rejects admin endpoints without or with a wrong token", async () => {
		const id = uniqueId("auth");
		const noToken = await api(`/v1/monitors/${id}`, { method: "PUT", body: "{}", headers: { "content-type": "application/json" } });
		expect(noToken.status).toBe(401);
		expect(noToken.headers.get("www-authenticate")).toBe("Bearer");
		const wrong = await api(`/v1/monitors/${id}`, {
			method: "PUT",
			body: JSON.stringify({ expectEverySec: 60 }),
			headers: { "content-type": "application/json", authorization: "Bearer nope-nope-nope-nope" },
		});
		expect(wrong.status).toBe(401);
		expect((await api(`/v1/monitors/${id}`, { method: "DELETE" })).status).toBe(401);
	});

	it("rejects beats without a token, with a wrong token, and for unknown monitors", async () => {
		const id = uniqueId("beatauth");
		const { beatToken } = await createMonitor(id);
		expect((await api(`/v1/monitors/${id}/beat`, { method: "POST" })).status).toBe(401);
		expect((await beat(id, "hb_definitely-not-the-token-000", {})).status).toBe(401);
		expect((await beat(id, `${beatToken}x`, {})).status).toBe(401);
		expect((await beat("does-not-exist", beatToken!, {})).status).toBe(404);
	});

	it("returns 404 for status/badge/history of unknown monitors", async () => {
		expect((await api("/v1/monitors/ghost")).status).toBe(404);
		expect((await api("/v1/monitors/ghost/badge.svg")).status).toBe(404);
		expect((await api("/v1/monitors/ghost/sparkline.svg")).status).toBe(404);
		expect((await api("/v1/monitors/ghost/history")).status).toBe(404);
	});
});

describe("private monitors", () => {
	it("hide every GET unless the beat token or admin token is presented", async () => {
		const id = uniqueId("private");
		const { beatToken } = await createMonitor(id, { public: false });
		const token = beatToken!;
		await beat(id, token, { durationMs: 50 });

		for (const path of [`/v1/monitors/${id}`, `/v1/monitors/${id}/badge.svg`, `/v1/monitors/${id}/sparkline.svg`, `/v1/monitors/${id}/history`]) {
			const anon = await api(path);
			expect(anon.status, path).toBe(401);
			const withToken = await api(path, { headers: { authorization: `Bearer ${token}` } });
			expect(withToken.status, path).toBe(200);
			const withAdmin = await api(path, { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } });
			expect(withAdmin.status, path).toBe(200);
		}
	});
});

describe("badge.svg", () => {
	it("renders the state, escapes XML and sets caching headers", async () => {
		const id = uniqueId("badge");
		const name = `scan <batch> & "co"`;
		const { beatToken } = await createMonitor(id, { name, p95ThresholdMs: 5000 });
		for (let i = 0; i < 5; i++) await beat(id, beatToken!, { durationMs: 2400 });

		const res = await api(`/v1/monitors/${id}/badge.svg`);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("image/svg+xml");
		expect(res.headers.get("cache-control")).toBe("public, max-age=60");
		const etag = res.headers.get("etag");
		expect(etag).toMatch(/^".+"$/);
		const svg = await res.text();
		expect(svg).toContain("up · p95 2.4s");
		expect(svg).toContain("scan &lt;batch&gt; &amp; &quot;co&quot;");
		expect(svg).not.toContain("<batch>");

		const cached = await api(`/v1/monitors/${id}/badge.svg`, { headers: { "if-none-match": etag! } });
		expect(cached.status).toBe(304);
	});

	it("shows unknown before the first beat", async () => {
		const id = uniqueId("badge-unknown");
		await createMonitor(id);
		const svg = await (await api(`/v1/monitors/${id}/badge.svg`)).text();
		expect(svg).toContain(">unknown</text>");
		expect(svg).toContain('fill="#9f9f9f"');
	});
});

describe("sparkline.svg", () => {
	it("renders the last n durations with the threshold line", async () => {
		const id = uniqueId("spark");
		const { beatToken } = await createMonitor(id, { p95ThresholdMs: 5000 });
		for (let i = 0; i < 12; i++) await beat(id, beatToken!, { durationMs: 2000 + i * 100 });
		const res = await api(`/v1/monitors/${id}/sparkline.svg?n=10&w=400&h=100`);
		expect(res.status).toBe(200);
		expect(res.headers.get("cache-control")).toBe("public, max-age=60");
		const svg = await res.text();
		expect(svg).toContain('width="400" height="100"');
		expect(svg).toContain("last 10 runs");
		expect(svg).toContain("threshold 5.0s");
		expect(svg).toContain("latest 3.1s");
	});

	it("clamps query parameters instead of failing", async () => {
		const id = uniqueId("spark-clamp");
		await createMonitor(id);
		const res = await api(`/v1/monitors/${id}/sparkline.svg?n=abc&w=99999&h=1`);
		expect(res.status).toBe(200);
		expect(await res.text()).toContain('width="2000" height="40"');
	});
});

describe("history and delete", () => {
	it("returns raw beats newest first with parsed meta", async () => {
		const id = uniqueId("history");
		const { beatToken } = await createMonitor(id);
		await beat(id, beatToken!, { durationMs: 10, meta: { run: 1 } });
		await beat(id, beatToken!, { durationMs: 20, status: "fail", meta: { run: 2, error: "x" } });
		const body = await (await api(`/v1/monitors/${id}/history?limit=1`)).json<{ id: string; count: number; beats: Array<Record<string, unknown>> }>();
		expect(body.id).toBe(id);
		expect(body.count).toBe(1);
		expect(body.beats[0]).toMatchObject({ durationMs: 20, status: "fail", meta: { run: 2, error: "x" } });
		expect(typeof body.beats[0]!["at"]).toBe("string");
	});

	it("deletes a monitor and everything it owns", async () => {
		const id = uniqueId("delete");
		const { beatToken } = await createMonitor(id);
		await beat(id, beatToken!, { durationMs: 10 });
		const res = await adminJson("DELETE", `/v1/monitors/${id}`);
		expect(res.status).toBe(200);
		expect((await api(`/v1/monitors/${id}`)).status).toBe(404);
		expect((await beat(id, beatToken!, {})).status).toBe(404);
		expect((await adminJson("DELETE", `/v1/monitors/${id}`)).status).toBe(404);

		const recreated = await createMonitor(id);
		expect(recreated.monitor.stats.count).toBe(0);
		expect(recreated.beatToken).toBeDefined();
	});
});
