import type { IncidentKind, NotificationEvent, NotifyConfig } from "./types";
import { fmtMs, iso } from "./util";

const TIMEOUT_MS = 8000;

const HEADLINES: Record<IncidentKind, string> = {
	missed: "DOWN",
	p95: "DEGRADED",
	fail: "FAILING",
	recovered: "RECOVERED",
};

export function formatTelegramText(event: NotificationEvent): string {
	const lines = [`[${HEADLINES[event.kind]}] ${event.name}`, event.detail];
	if (event.p95Ms != null) lines.push(`p95 ${fmtMs(event.p95Ms)} · state ${event.state}`);
	else lines.push(`state ${event.state}`);
	lines.push(event.statusUrl);
	return lines.join("\n");
}

export function webhookPayload(event: NotificationEvent) {
	return {
		monitorId: event.monitorId,
		name: event.name,
		kind: event.kind,
		state: event.state,
		p95Ms: event.p95Ms,
		at: iso(event.at),
		detail: event.detail,
		url: event.statusUrl,
	};
}

async function post(url: string, body: unknown, label: string): Promise<void> {
	try {
		const res = await fetch(url, {
			method: "POST",
			headers: { "content-type": "application/json", "user-agent": "heartbeat/0.1 (+cloudflare-workers)" },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
		if (!res.ok) console.warn(`heartbeat: ${label} notification returned HTTP ${res.status}`);
	} catch (err) {
		console.warn(`heartbeat: ${label} notification failed`, err instanceof Error ? err.message : err);
	}
}

/** Fires every configured target concurrently; failures are logged, never thrown. */
export async function sendNotifications(config: NotifyConfig | null, event: NotificationEvent): Promise<void> {
	if (!config) return;
	const jobs: Promise<void>[] = [];
	if (config.telegram) {
		const { botToken, chatId } = config.telegram;
		jobs.push(
			post(
				`https://api.telegram.org/bot${botToken}/sendMessage`,
				{ chat_id: chatId, text: formatTelegramText(event), disable_web_page_preview: true },
				"telegram",
			),
		);
	}
	if (config.webhookUrl) jobs.push(post(config.webhookUrl, webhookPayload(event), "webhook"));
	await Promise.allSettled(jobs);
}
