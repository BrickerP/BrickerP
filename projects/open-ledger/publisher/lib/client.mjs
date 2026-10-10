// Minimal ingest client: POST /v1/ledgers/:ledgerId/events in batches of <= 500 with retries.

export const MAX_BATCH = 500;

export async function publish({
  url,
  ledgerId,
  token,
  events,
  batchSize = MAX_BATCH,
  fetchImpl = globalThis.fetch,
  log = () => {},
  maxAttempts = 5,
}) {
  if (!/^[a-z0-9-]{1,64}$/.test(ledgerId)) throw new Error(`invalid ledger id "${ledgerId}"`);
  const endpoint = new URL(`/v1/ledgers/${ledgerId}/events`, url).toString();
  const size = Math.max(1, Math.min(MAX_BATCH, batchSize));
  const totals = { accepted: 0, duplicates: 0, seq: null, headHash: null, batches: 0 };

  for (let i = 0; i < events.length; i += size) {
    const batch = events.slice(i, i + size);
    const result = await postBatch({ endpoint, token, batch, fetchImpl, maxAttempts, log });
    totals.accepted += result.accepted;
    totals.duplicates += result.duplicates;
    totals.seq = result.seq;
    totals.headHash = result.headHash;
    totals.batches += 1;
    log(`batch ${totals.batches}: accepted=${result.accepted} duplicates=${result.duplicates} seq=${result.seq}`);
  }
  return totals;
}

async function postBatch({ endpoint, token, batch, fetchImpl, maxAttempts, log }) {
  let attempt = 0;
  for (;;) {
    attempt += 1;
    let res;
    try {
      res = await fetchImpl(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ events: batch }),
      });
    } catch (err) {
      if (attempt >= maxAttempts) throw new Error(`network error after ${attempt} attempts: ${err.message}`);
      await backoff(attempt, log, `network error: ${err.message}`);
      continue;
    }
    if (res.ok) return res.json();

    const text = await res.text();
    if (res.status === 429 || res.status >= 500) {
      if (attempt >= maxAttempts) throw new Error(`HTTP ${res.status} after ${attempt} attempts: ${text}`);
      await backoff(attempt, log, `HTTP ${res.status}`);
      continue;
    }
    // 400/401/413 etc. will not get better by retrying.
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
}

async function backoff(attempt, log, reason) {
  const delay = Math.min(30_000, 500 * 2 ** (attempt - 1));
  log(`${reason}; retrying in ${delay} ms (attempt ${attempt})`);
  await new Promise((r) => setTimeout(r, delay));
}
