import { createVerifier } from "./chain.js";

const PAGE_SIZE = 25;
const LEDGER_RE = /^[a-z0-9-]{1,64}$/;

const params = new URLSearchParams(location.search);
const ledgerId = LEDGER_RE.test(params.get("ledger") ?? "") ? params.get("ledger") : "demo";
const api = (action, query = {}) => {
  const url = new URL(`/v1/ledgers/${ledgerId}/${action}`, location.origin);
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== "") url.searchParams.set(k, v);
  return url;
};

const $ = (id) => document.getElementById(id);
const fmtNum = (n, digits = 0) =>
  Number(n).toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
const fmtMoney = (n) => "$" + fmtNum(n, 2);
const shortHash = (h) => (typeof h === "string" && h.length === 64 ? `${h.slice(0, 8)}…${h.slice(-6)}` : h ?? "");
const fmtTs = (ts) => (typeof ts === "string" ? ts.replace("T", " ").replace(/(\.\d+)?Z$/, "") : "");

function setNotice(text, kind = "error") {
  const el = $("notice");
  el.hidden = !text;
  el.textContent = text ?? "";
  el.className = `notice${kind === "info" ? " info" : ""}`;
}

async function getJson(url) {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (res.status === 404) throw Object.assign(new Error("ledger_not_found"), { notFound: true });
  if (!res.ok) throw new Error(`${url.pathname}: HTTP ${res.status}`);
  return res.json();
}

// ------------------------------------------------------------------ header

$("ledger-input").value = ledgerId;
document.title = `open-ledger · ${ledgerId}`;
$("ledger-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const next = $("ledger-input").value.trim();
  if (!LEDGER_RE.test(next)) {
    setNotice("Ledger ids must match [a-z0-9-]{1,64}.");
    return;
  }
  const url = new URL(location.href);
  url.searchParams.set("ledger", next);
  location.href = url.toString();
});

$("head-hash").addEventListener("click", async () => {
  const text = $("head-hash").dataset.full;
  if (!text || !navigator.clipboard) return;
  await navigator.clipboard.writeText(text);
  setNotice("Head hash copied to clipboard.", "info");
  setTimeout(() => setNotice(null), 1500);
});

// -------------------------------------------------------------------- head

let head = null;

async function loadHead() {
  head = await getJson(api("head"));
  $("head-hash").textContent = head.headHash;
  $("head-hash").dataset.full = head.headHash;
  $("head-count").textContent = fmtNum(head.count);
  $("head-seq").textContent = fmtNum(head.seq);
  $("head-updated").textContent = head.updatedAt ? fmtTs(head.updatedAt) : "—";
}

// ----------------------------------------------------------------- summary

async function loadSummary() {
  const summary = await getJson(api("summary"));
  renderBars(summary.byDay ?? []);
  renderSymbols(summary.bySymbol ?? []);
}

function renderBars(byDay) {
  const host = $("by-day");
  host.replaceChildren();
  if (byDay.length === 0) {
    const p = document.createElement("p");
    p.className = "empty muted";
    p.textContent = "No fills yet.";
    host.append(p);
    return;
  }
  const max = Math.max(...byDay.map((d) => d.notional), 1);
  const showDate = (i) => byDay.length <= 12 || i % Math.ceil(byDay.length / 12) === 0;
  byDay.forEach((d, i) => {
    const bar = document.createElement("div");
    bar.className = "bar";
    bar.style.height = `${Math.max(2, Math.round((d.notional / max) * 100))}%`;
    bar.title = `${d.date}\n${d.fills} fills\nbuy ${fmtNum(d.buyQty)} / sell ${fmtNum(d.sellQty)}\nnotional ${fmtMoney(d.notional)}`;
    const label = document.createElement("span");
    label.className = "bar-label";
    label.textContent = d.fills;
    bar.append(label);
    if (showDate(i)) {
      const date = document.createElement("span");
      date.className = "bar-date";
      date.textContent = d.date.slice(5);
      bar.append(date);
    }
    host.append(bar);
  });
}

function renderSymbols(bySymbol) {
  const body = $("by-symbol");
  body.replaceChildren();
  if (bySymbol.length === 0) {
    body.append(row(["No fills yet.", "", "", "", ""], ["muted"]));
    return;
  }
  for (const s of bySymbol) {
    body.append(
      row(
        [s.symbol, fmtNum(s.fills), fmtNum(s.buyQty), fmtNum(s.sellQty), fmtMoney(s.notional)],
        ["mono", "num", "num", "num", "num"],
      ),
    );
  }
}

function row(cells, classes = []) {
  const tr = document.createElement("tr");
  cells.forEach((text, i) => {
    const td = document.createElement("td");
    td.textContent = text;
    if (classes[i]) td.className = classes[i];
    tr.append(td);
  });
  return tr;
}

// ------------------------------------------------------------------ events
// Unfiltered: newest first, page N covers seq (head - (N+1)*PAGE, head - N*PAGE], via since/limit.
// Filtered by symbol: the API cursor is seq-based, so pages walk forward (oldest first) and a
// stack of `since` cursors provides "previous".

let pageIndex = 0;
let cursorStack = [0];
let symbolFilter = (params.get("symbol") ?? "").toUpperCase();
$("symbol-input").value = symbolFilter;

$("filter-form").addEventListener("submit", (e) => {
  e.preventDefault();
  symbolFilter = $("symbol-input").value.trim().toUpperCase();
  $("symbol-input").value = symbolFilter;
  pageIndex = 0;
  cursorStack = [0];
  loadEvents().catch(showError);
});

$("prev-btn").addEventListener("click", () => {
  if (symbolFilter) {
    if (cursorStack.length > 1) cursorStack.pop();
  } else {
    pageIndex = Math.max(0, pageIndex - 1);
  }
  loadEvents().catch(showError);
});
$("next-btn").addEventListener("click", () => {
  if (symbolFilter) {
    if (nextCursor !== null) cursorStack.push(nextCursor);
  } else {
    pageIndex += 1;
  }
  loadEvents().catch(showError);
});

let nextCursor = null;

async function loadEvents() {
  const body = $("events-body");
  if (!head) return;
  let events;
  let hasPrev;
  let hasNext;
  if (symbolFilter) {
    const since = cursorStack[cursorStack.length - 1];
    const data = await getJson(api("events", { since: String(since), limit: String(PAGE_SIZE), symbol: symbolFilter }));
    events = data.events;
    hasPrev = cursorStack.length > 1;
    hasNext = data.events.length === PAGE_SIZE && data.nextSince < head.seq;
    nextCursor = hasNext ? data.nextSince : null;
    $("prev-btn").textContent = "← Previous";
    $("next-btn").textContent = "Next →";
  } else {
    const upper = head.seq - pageIndex * PAGE_SIZE;
    const since = Math.max(0, upper - PAGE_SIZE);
    const data = await getJson(api("events", { since: String(since), limit: String(PAGE_SIZE) }));
    events = data.events.filter((e) => e.seq <= upper).reverse();
    hasPrev = pageIndex > 0;
    hasNext = since > 0;
    $("prev-btn").textContent = "← Newer";
    $("next-btn").textContent = "Older →";
  }

  body.replaceChildren();
  if (events.length === 0) {
    body.append(row(["", "No events on this page.", "", "", "", "", "", "", ""], ["num", "muted"]));
  }
  for (const e of events) {
    const tr = row(
      [
        fmtNum(e.seq),
        fmtTs(e.ts),
        e.type,
        e.symbol ?? "",
        e.side ?? "",
        e.qty !== undefined ? fmtNum(e.qty, Number.isInteger(e.qty) ? 0 : 4) : "",
        e.price !== undefined ? fmtNum(e.price, 2) : "",
        e.orderId ?? "",
        shortHash(e.hash),
      ],
      ["num", "mono", "type", "mono", e.side ? `side-${e.side}` : "", "num", "num", "mono", "mono"],
    );
    tr.title = `prevHash ${e.prevHash}\nhash     ${e.hash}${e.meta ? "\nmeta     " + JSON.stringify(e.meta) : ""}`;
    body.append(tr);
  }
  $("prev-btn").disabled = !hasPrev;
  $("next-btn").disabled = !hasNext;
  if (events.length === 0) {
    $("pager-info").textContent = symbolFilter ? `no ${symbolFilter} events` : "";
  } else {
    const seqs = events.map((e) => e.seq);
    const lo = Math.min(...seqs);
    const hi = Math.max(...seqs);
    $("pager-info").textContent = `seq ${fmtNum(lo)} – ${fmtNum(hi)}${symbolFilter ? ` · ${symbolFilter} (oldest first)` : " (newest first)"}`;
  }
}

// ------------------------------------------------------------------ verify

$("verify-btn").addEventListener("click", () => verifyInBrowser().catch(showError));

async function verifyInBrowser() {
  const btn = $("verify-btn");
  const status = $("verify-status");
  const bar = $("verify-bar");
  btn.disabled = true;
  $("verify-progress").hidden = false;
  bar.style.width = "0%";
  status.className = "verify-status working";
  status.textContent = "Fetching head…";

  try {
    const liveHead = await getJson(api("head"));
    const total = liveHead.seq;
    status.textContent = `Streaming ${fmtNum(total)} events and recomputing SHA-256 links…`;

    const res = await fetch(api("export.ndjson"));
    if (!res.ok) throw new Error(`export.ndjson: HTTP ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const verifier = createVerifier();
    let buffer = "";
    let processed = 0;
    let lastChained = null;
    let stopped = false;

    const handleLine = async (line) => {
      if (!line) return;
      const chained = JSON.parse(line);
      lastChained = chained;
      const ok = await verifier.step(chained);
      processed += 1;
      if (!ok) stopped = true;
      if (processed % 100 === 0 || stopped) {
        bar.style.width = `${Math.min(100, Math.round((processed / Math.max(total, 1)) * 100))}%`;
        status.textContent = `Verified ${fmtNum(processed)} / ${fmtNum(total)}…`;
        await new Promise((r) => setTimeout(r, 0));
      }
    };

    while (!stopped) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl;
      while (!stopped && (nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        await handleLine(line);
      }
    }
    if (!stopped && buffer.trim()) await handleLine(buffer.trim());
    if (stopped) await reader.cancel().catch(() => {});

    const result = verifier.result();
    bar.style.width = "100%";
    if (!result.ok) {
      status.className = "verify-status bad";
      status.textContent =
        `✗ Chain diverges at seq ${result.failure.seq}: ${result.failure.reason}.\n` +
        `${fmtNum(result.checked)} events before it verified. ` +
        (lastChained ? `Stored hash at that row: ${lastChained.hash}` : "");
      return;
    }
    const headNow = await getJson(api("head"));
    const matchesHead = result.lastHash === headNow.headHash;
    const grew = headNow.seq !== total;
    status.className = matchesHead || grew ? "verify-status ok" : "verify-status bad";
    status.textContent =
      `✓ ${fmtNum(result.checked)} events verified from genesis.\n` +
      `last hash ${result.lastHash}\n` +
      (matchesHead
        ? "matches the published head hash."
        : grew
          ? `the ledger grew to seq ${fmtNum(headNow.seq)} while verifying; re-run to cover new rows.`
          : `does NOT match the published head hash ${headNow.headHash}.`);
  } finally {
    btn.disabled = false;
  }
}

// -------------------------------------------------------------------- misc

function renderApiLinks() {
  const list = $("api-links");
  list.replaceChildren();
  const items = [
    ["head", api("head")],
    ["events", api("events", { limit: "50" })],
    ["events (symbol)", api("events", { symbol: "AAPL", limit: "50" })],
    ["snapshots", api("snapshots")],
    ["verify", api("verify", { from: "1", to: "2000" })],
    ["export.ndjson", api("export.ndjson")],
    ["summary", api("summary")],
  ];
  for (const [label, url] of items) {
    const li = document.createElement("li");
    const a = document.createElement("a");
    a.href = url.toString();
    a.textContent = `${url.pathname}${url.search}`;
    a.target = "_blank";
    a.rel = "noopener";
    li.append(`${label.padEnd(16, " ")}`, a);
    list.append(li);
  }
}

function showError(err) {
  if (err && err.notFound) {
    setNotice(
      `Ledger "${ledgerId}" does not exist yet. Publish events with open-ledger-publish (or run its demo subcommand) to create it.`,
      "info",
    );
    $("verify-btn").disabled = true;
    return;
  }
  console.error(err);
  setNotice(err?.message ?? String(err));
}

async function main() {
  renderApiLinks();
  try {
    await loadHead();
    await Promise.all([loadSummary(), loadEvents()]);
  } catch (err) {
    showError(err);
  }
}

main();
