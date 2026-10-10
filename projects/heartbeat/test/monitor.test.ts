import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Monitor, NOTIFY_MIN_INTERVAL_MS } from "../src/monitor";
import type { ConfigureRequest, MonitorInput } from "../src/types";
import { sha256Hex } from "../src/util";
import { ADMIN, captureNotifications, monitorStub, tokenAuth, uniqueId } from "./helpers";

const WEBHOOK = "https://hooks.example.test/heartbeat";
const TELEGRAM_TOKEN = "123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw0";

afterEach(() => {
	vi.restoreAllMocks();
});

async function configure(id: string, input: MonitorInput, now: number, extra: Partial<ConfigureRequest> = {}) {
	const stub = monitorStub(id);
	const req: ConfigureRequest = {
		monitorId: id,
		input,
		providedTokenHash: null,
		generatedTokenHash: await sha256Hex(`generated-${id}`),
		baseUrl: "https://heartbeat.test",
		now,
		...extra,
	};
	const result = await stub.configure(req);
	if (!result.ok) throw new Error(result.error);
	return { stub, status: result.value.status };
}

async function expectBeat(stub: ReturnType<typeof monitorStub>, now: number, durationMs?: number, status?: "ok" | "fail") {
	const res = await stub.beat(ADMIN, { durationMs, status }, now);
	if (!res.ok) throw new Error(res.error);
	return res.value;
}

async function expectStatus(stub: ReturnType<typeof monitorStub>, now: number) {
	const res = await stub.status(ADMIN, now);
	if (!res.ok) throw new Error(res.error);
	return res.value;
}

describe("dead-man's switch", () => {
	it("arms an alarm on create and again after each beat", async () => {
		const id = uniqueId("arm");
		const t0 = Date.now();
		const { stub } = await configure(id, { expectEverySec: 300, graceSec: 120 }, t0);
		await runInDurableObject(stub, async (_instance, state) => {
			expect(await state.storage.getAlarm()).toBe(t0 + 420_000);
		});
		await expectBeat(stub, t0 + 10_000, 100);
		await runInDurableObject(stub, async (instance, state) => {
			expect(instance).toBeInstanceOf(Monitor);
			expect(await state.storage.getAlarm()).toBe(t0 + 430_000);
		});
	});

	it("alarm -> down with a missed incident and a notification, beat -> recovered", async () => {
		const id = uniqueId("down");
		const calls = captureNotifications();
		const t0 = Date.now();
		const { stub } = await configure(
			id,
			{ expectEverySec: 60, graceSec: 30, notify: { webhookUrl: WEBHOOK, telegram: { botToken: TELEGRAM_TOKEN, chatId: "-100123" } } },
			t0,
		);
		await expectBeat(stub, t0, 2400);
		expect(calls).toHaveLength(0);

		expect(await runDurableObjectAlarm(stub)).toBe(true);

		let status = await expectStatus(stub, t0 + 95_000);
		expect(status.state).toBe("down");
		expect(status.incidents).toHaveLength(1);
		expect(status.incidents[0]).toMatchObject({ kind: "missed", closedAt: null });
		expect(status.incidents[0]!.detail).toContain("expected every 1m, grace 30s");

		expect(calls).toHaveLength(2);
		const webhook = calls.find((c) => c.url === WEBHOOK)!;
		expect(webhook.body).toMatchObject({ monitorId: id, kind: "missed", state: "down", p95Ms: 2400 });
		expect(typeof webhook.body["at"]).toBe("string");
		expect(webhook.body["url"]).toBe(`https://heartbeat.test/v1/monitors/${id}`);
		const telegram = calls.find((c) => c.url.startsWith("https://api.telegram.org/bot"))!;
		expect(telegram.url).toBe(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`);
		expect(telegram.body["chat_id"]).toBe("-100123");
		expect(String(telegram.body["text"])).toContain("[DOWN]");

		// A reminder alarm is re-armed in the future.
		await runInDurableObject(stub, async (_instance, state) => {
			const alarm = await state.storage.getAlarm();
			expect(alarm).not.toBeNull();
			expect(alarm!).toBeGreaterThan(Date.now() + 50_000);
		});

		const recoveryAt = t0 + NOTIFY_MIN_INTERVAL_MS + 120_000;
		const beatResult = await expectBeat(stub, recoveryAt, 2500);
		expect(beatResult.state).toBe("up");

		status = await expectStatus(stub, recoveryAt);
		expect(status.state).toBe("up");
		expect(status.incidents.map((i) => i.kind)).toEqual(["recovered", "missed"]);
		expect(status.incidents[1]!.closedAt).not.toBeNull();
		expect(status.incidents[0]!.detail).toContain("Beats resumed");

		expect(calls).toHaveLength(4);
		const recovered = calls.filter((c) => c.url === WEBHOOK).at(-1)!;
		expect(recovered.body).toMatchObject({ kind: "recovered", state: "up" });
	});

	it("sends reminders with exponential backoff while down and keeps one open incident", async () => {
		const id = uniqueId("remind");
		const calls = captureNotifications();
		const t0 = Date.now();
		const { stub } = await configure(id, { expectEverySec: 300, graceSec: 0, notify: { webhookUrl: WEBHOOK } }, t0);
		await expectBeat(stub, t0, 100);

		const delays: number[] = [];
		for (let i = 0; i < 4; i++) {
			const before = Date.now();
			expect(await runDurableObjectAlarm(stub)).toBe(true);
			await runInDurableObject(stub, async (_instance, state) => {
				delays.push((await state.storage.getAlarm())! - before);
				// Reset the rate limiter so every reminder is observable.
				state.storage.sql.exec("UPDATE config SET last_notified_at = NULL");
			});
		}
		expect(delays[0]).toBeGreaterThanOrEqual(300_000 - 1000);
		expect(delays[1]).toBeGreaterThanOrEqual(600_000 - 1000);
		expect(delays[2]).toBeGreaterThanOrEqual(1_200_000 - 1000);
		expect(delays[3]).toBeGreaterThanOrEqual(2_400_000 - 1000);

		const status = await expectStatus(stub, Date.now());
		expect(status.incidents.filter((i) => i.kind === "missed")).toHaveLength(1);
		expect(calls).toHaveLength(4);
		expect(String(calls[3]!.body["detail"])).toContain("Still down");
	});

	it("flags a monitor that never beats", async () => {
		const id = uniqueId("never");
		const { stub } = await configure(id, { expectEverySec: 30, graceSec: 0 }, Date.now());
		expect(await runDurableObjectAlarm(stub)).toBe(true);
		const status = await expectStatus(stub, Date.now());
		expect(status.state).toBe("down");
		expect(status.incidents[0]!.detail).toContain("No beat received since the monitor was created");
	});

	it("rate-limits notifications to one per minute per monitor", async () => {
		const id = uniqueId("ratelimit");
		const calls = captureNotifications();
		const t0 = Date.now();
		const { stub } = await configure(id, { expectEverySec: 60, graceSec: 0, notify: { webhookUrl: WEBHOOK } }, t0);
		await expectBeat(stub, t0, 100);
		expect(await runDurableObjectAlarm(stub)).toBe(true);
		expect(calls).toHaveLength(1);

		// Recovery a few seconds after the alarm is suppressed...
		await expectBeat(stub, t0 + 5_000, 100);
		expect(calls).toHaveLength(1);

		// ...but the incident log still records it.
		const status = await expectStatus(stub, t0 + 5_000);
		expect(status.incidents.map((i) => i.kind)).toEqual(["recovered", "missed"]);

		// Later events go through again.
		expect(await runDurableObjectAlarm(stub)).toBe(true);
		await runInDurableObject(stub, async (_instance, state) => {
			state.storage.sql.exec("UPDATE config SET last_notified_at = ?", t0 - NOTIFY_MIN_INTERVAL_MS * 2);
		});
		await expectBeat(stub, t0 + 200_000, 100);
		expect(calls).toHaveLength(2);
	});
});

describe("derived states", () => {
	it("reports late inside the grace window and down after it, without waiting for the alarm", async () => {
		const id = uniqueId("late");
		const t0 = Date.now();
		const { stub } = await configure(id, { expectEverySec: 60, graceSec: 60 }, t0);
		await expectBeat(stub, t0, 100);
		expect((await expectStatus(stub, t0 + 30_000)).state).toBe("up");
		expect((await expectStatus(stub, t0 + 61_000)).state).toBe("late");
		expect((await expectStatus(stub, t0 + 121_000)).state).toBe("down");
	});

	it("keeps unknown until the first beat", async () => {
		const id = uniqueId("unknown");
		const t0 = Date.now();
		const { stub, status } = await configure(id, { expectEverySec: 60, graceSec: 60 }, t0);
		expect(status.state).toBe("unknown");
		expect((await expectStatus(stub, t0 + 100_000)).state).toBe("unknown");
		expect((await expectStatus(stub, t0 + 121_000)).state).toBe("down");
	});
});

describe("p95 gate with hysteresis", () => {
	it("needs three consecutive breaches to degrade and three clean evaluations to recover", async () => {
		const id = uniqueId("p95");
		const calls = captureNotifications();
		let now = Date.now();
		const { stub } = await configure(id, { expectEverySec: 300, graceSec: 60, p95ThresholdMs: 5000, windowSize: 5, notify: { webhookUrl: WEBHOOK } }, now);

		const tick = async (durationMs: number) => {
			now += 1000;
			return expectBeat(stub, now, durationMs);
		};

		expect((await tick(9200)).state).toBe("up");
		expect((await tick(9200)).state).toBe("up");
		const third = await tick(9200);
		expect(third.state).toBe("degraded");
		expect(third.p95Ms).toBe(9200);

		let status = await expectStatus(stub, now);
		expect(status.state).toBe("degraded");
		expect(status.incidents[0]).toMatchObject({ kind: "p95", closedAt: null });
		expect(status.incidents[0]!.detail).toContain("9.2s above threshold 5.0s for 3 consecutive beats");
		expect(calls).toHaveLength(1);
		expect(calls[0]!.body).toMatchObject({ kind: "p95", state: "degraded", p95Ms: 9200 });

		// Window of 5: p95 (nearest rank 5) stays 9200 while any breach is in the window.
		for (let i = 0; i < 4; i++) expect((await tick(2400)).state).toBe("degraded");
		// Window is now all 2400 -> first clean evaluation.
		expect((await tick(2400)).state).toBe("degraded");
		expect((await tick(2400)).state).toBe("degraded");
		const recovered = await tick(2400);
		expect(recovered.state).toBe("up");
		expect(recovered.p95Ms).toBe(2400);

		status = await expectStatus(stub, now);
		expect(status.incidents.map((i) => i.kind)).toEqual(["recovered", "p95"]);
		expect(status.incidents[1]!.closedAt).not.toBeNull();
	});

	it("does not degrade on fewer than three consecutive breaches", async () => {
		const id = uniqueId("p95-flap");
		let now = Date.now();
		// windowSize 1 makes the p95 equal to the latest duration, so the streak is easy to steer.
		const { stub } = await configure(id, { expectEverySec: 300, graceSec: 60, p95ThresholdMs: 5000, windowSize: 1 }, now);
		const tick = async (durationMs: number) => expectBeat(stub, (now += 1000), durationMs);
		expect((await tick(9000)).state).toBe("up");
		expect((await tick(9000)).state).toBe("up");
		expect((await tick(100)).state).toBe("up");
		expect((await tick(9000)).state).toBe("up");
		expect((await tick(9000)).state).toBe("up");
		expect((await expectStatus(stub, now)).incidents).toEqual([]);
		expect((await tick(9000)).state).toBe("degraded");
	});

	it("clears the degraded state when the threshold is removed", async () => {
		const id = uniqueId("p95-clear");
		let now = Date.now();
		const { stub } = await configure(id, { expectEverySec: 300, graceSec: 60, p95ThresholdMs: 1000, windowSize: 3 }, now);
		for (let i = 0; i < 3; i++) await expectBeat(stub, (now += 1000), 5000);
		expect((await expectStatus(stub, now)).state).toBe("degraded");
		await configure(id, { p95ThresholdMs: null }, (now += 1000));
		const status = await expectStatus(stub, now);
		expect(status.state).toBe("up");
		expect(status.p95ThresholdMs).toBeNull();
		expect(status.incidents[0]).toMatchObject({ kind: "p95" });
		expect(status.incidents[0]!.closedAt).not.toBeNull();
	});
});

describe("token handling", () => {
	it("stores only the sha256 of the beat token and compares hashes", async () => {
		const id = uniqueId("hash");
		const token = "hb_plaintext-token-for-hash-test";
		const t0 = Date.now();
		const { stub } = await configure(id, { expectEverySec: 60 }, t0, { providedTokenHash: await sha256Hex(token) });
		await runInDurableObject(stub, async (_instance, state) => {
			const row = state.storage.sql.exec<{ beat_token_hash: string }>("SELECT beat_token_hash FROM config").one();
			expect(row.beat_token_hash).toBe(await sha256Hex(token));
			expect(row.beat_token_hash).not.toContain("plaintext");
		});
		const good = await stub.beat(await tokenAuth(token), { durationMs: 1 }, t0);
		expect(good.ok).toBe(true);
		const bad = await stub.beat(await tokenAuth("hb_some-other-token-value-00"), { durationMs: 1 }, t0);
		expect(bad).toMatchObject({ ok: false, status: 401 });
	});

	it("rotates the token on update when a new one is supplied", async () => {
		const id = uniqueId("rotate");
		const t0 = Date.now();
		const { stub } = await configure(id, { expectEverySec: 60 }, t0, { providedTokenHash: await sha256Hex("first-token-value-0001") });
		await configure(id, {}, t0 + 1000, { providedTokenHash: await sha256Hex("second-token-value-002") });
		expect((await stub.beat(await tokenAuth("first-token-value-0001"), {}, t0 + 2000)).ok).toBe(false);
		expect((await stub.beat(await tokenAuth("second-token-value-002"), {}, t0 + 2000)).ok).toBe(true);
	});
});
