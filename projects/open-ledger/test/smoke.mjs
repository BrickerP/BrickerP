// End-to-end smoke test: boots `wrangler dev` (Worker + Durable Object + static dashboard in local
// workerd, no Cloudflare login), publishes the deterministic demo ledger and a SQLite tail with the
// real `open-ledger-publish` CLI over HTTP, then checks every public endpoint and the dashboard files.
//
//   npm run smoke
//
// INGEST_TOKEN comes from .dev.vars when it exists; otherwise a throwaway token is generated for the
// run and the file is removed afterwards. Local state goes to a temp dir, so runs are repeatable.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createVerifier } from "../public/chain.js";
import { generateDemoEvents } from "../publisher/lib/demo.mjs";

const ANCHOR = "2026-10-09";
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const devVars = join(root, ".dev.vars");
const tmp = mkdtempSync(join(tmpdir(), "open-ledger-smoke-"));
const wranglerLog = [];
let wrangler;
let createdDevVars = false;
let base = "";
let token = "";
let checks = 0;

const request = (url, init = {}) => fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });

function cleanup() {
  if (wrangler?.pid) {
    try {
      process.kill(-wrangler.pid, "SIGTERM");
    } catch {
      // already gone
    }
  }
  if (createdDevVars) rmSync(devVars, { force: true });
  rmSync(tmp, { recursive: true, force: true });
}
process.on("exit", cleanup);

function loadToken() {
  if (existsSync(devVars)) {
    const match = /^INGEST_TOKEN=(.+)$/m.exec(readFileSync(devVars, "utf8"));
    if (!match) throw new Error(".dev.vars exists but has no INGEST_TOKEN line");
    return match[1].trim().replace(/^["']|["']$/g, "");
  }
  const generated = randomBytes(16).toString("hex");
  writeFileSync(devVars, `INGEST_TOKEN=${generated}\n`);
  createdDevVars = true;
  return generated;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function startWrangler(port) {
  wrangler = spawn(
    process.execPath,
    [
      join(root, "node_modules", "wrangler", "bin", "wrangler.js"),
      "dev",
      "--ip",
      "127.0.0.1",
      "--port",
      String(port),
      "--persist-to",
      join(tmp, "state"),
    ],
    {
      cwd: root,
      env: { ...process.env, WRANGLER_SEND_METRICS: "false", NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    },
  );
  let exited = null;
  wrangler.on("exit", (code, signal) => {
    exited = { code, signal };
  });
  for (const stream of [wrangler.stdout, wrangler.stderr]) {
    stream.on("data", (chunk) => wranglerLog.push(chunk.toString()));
  }
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (exited) throw new Error(`wrangler dev exited early: ${JSON.stringify(exited)}`);
    try {
      if ((await request(`${base}/v1`)).ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("wrangler dev did not become ready within 120 s");
}

function publisher(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(root, "publisher", "bin.mjs"), ...args], {
      cwd: tmp,
      env: { ...process.env, INGEST_TOKEN: token },
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 90_000);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`open-ledger-publish ${args[0]} exited ${code}:\n${stderr}`));
    });
  });
}

async function getJson(path) {
  const res = await request(base + path);
  assert.equal(res.status, 200, `GET ${path} -> HTTP ${res.status}`);
  return res.json();
}

async function allEvents(ledgerId, limit) {
  const out = [];
  let since = 0;
  for (;;) {
    const page = await getJson(`/v1/ledgers/${ledgerId}/events?since=${since}&limit=${limit}`);
    if (page.events.length === 0) return out;
    assert.ok(page.nextSince > since, `nextSince ${page.nextSince} did not advance past ${since}`);
    out.push(...page.events);
    since = page.nextSince;
  }
}

async function recompute(events) {
  const verifier = createVerifier();
  for (const event of events) {
    assert.ok(await verifier.step(event), `chain diverges at seq ${event.seq}: ${JSON.stringify(verifier.result().failure)}`);
  }
  return verifier.result();
}

async function step(name, fn) {
  const value = await fn();
  checks += 1;
  console.log(`ok ${checks} - ${name}`);
  return value;
}

async function main() {
  token = loadToken();
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;

  const demo = generateDemoEvents({ anchor: ANCHOR });
  const total = demo.length;
  const fills = demo.filter((e) => e.type === "fill");

  await step("wrangler dev boots the Worker, Durable Object and assets", () => startWrangler(port));

  await step("unknown ledger is 404 and ingest without a token is 401", async () => {
    assert.equal((await request(`${base}/v1/ledgers/demo/head`)).status, 404);
    const res = await request(`${base}/v1/ledgers/demo/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(res.status, 401);
  });

  const published = await step(`publisher demo ingests ${total} events`, async () => {
    const out = JSON.parse((await publisher(["demo", "--url", base, "--anchor", ANCHOR])).stdout);
    assert.deepEqual([out.accepted, out.duplicates, out.seq], [total, 0, total]);
    return out;
  });

  await step("re-running the demo is idempotent", async () => {
    const out = JSON.parse((await publisher(["demo", "--url", base, "--anchor", ANCHOR])).stdout);
    assert.deepEqual([out.accepted, out.duplicates, out.seq], [0, total, total]);
    assert.equal(out.headHash, published.headHash);
  });

  const head = await step("head reports the published chain", async () => {
    const res = await request(`${base}/v1/ledgers/demo/head`, { headers: { origin: "https://example.com" } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("access-control-allow-origin"), "*");
    const body = await res.json();
    assert.equal(body.ledgerId, "demo");
    assert.deepEqual([body.seq, body.count], [total, total]);
    assert.equal(body.headHash, published.headHash);
    assert.match(body.headHash, /^[0-9a-f]{64}$/);
    assert.match(body.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
    return body;
  });

  const events = await step("events pagination walks the chain and it recomputes from genesis", async () => {
    const all = await allEvents("demo", 100);
    assert.deepEqual(
      all.map((e) => e.id),
      demo.map((e) => e.id),
    );
    assert.equal((await recompute(all)).lastHash, head.headHash);
    return all;
  });

  await step("symbol filter returns only that symbol", async () => {
    const expected = demo.filter((e) => e.symbol === "AAPL").length;
    const page = await getJson("/v1/ledgers/demo/events?symbol=AAPL&limit=1000");
    assert.ok(expected > 0);
    assert.equal(page.events.length, expected);
    assert.ok(page.events.every((e) => e.symbol === "AAPL"));
  });

  await step("verify covers the whole chain and sub-ranges", async () => {
    const full = await getJson(`/v1/ledgers/demo/verify?from=1&to=${total}`);
    assert.deepEqual(full, { ledgerId: "demo", ok: true, checked: total, from: 1, to: total, headSeq: total, headHash: head.headHash });
    const part = await getJson("/v1/ledgers/demo/verify?from=11&to=20");
    assert.deepEqual([part.ok, part.checked, part.from, part.to], [true, 10, 11, 20]);
    assert.equal(part.headHash, events[19].hash);
  });

  await step("export.ndjson streams every row and recomputes in the browser verifier", async () => {
    const res = await request(`${base}/v1/ledgers/demo/export.ndjson`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /ndjson/);
    const rows = (await res.text()).trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(rows, events);
    assert.equal((await recompute(rows)).lastHash, head.headHash);
  });

  await step("summary aggregates fills by day and by symbol", async () => {
    const summary = await getJson("/v1/ledgers/demo/summary");
    const notional = fills.reduce((sum, e) => sum + e.qty * e.price, 0);
    for (const key of ["byDay", "bySymbol"]) {
      assert.equal(summary[key].reduce((sum, row) => sum + row.fills, 0), fills.length, key);
      const got = summary[key].reduce((sum, row) => sum + row.notional, 0);
      assert.ok(Math.abs(got - notional) < 1e-6 * notional, `${key} notional ${got} vs ${notional}`);
    }
    assert.deepEqual(
      summary.bySymbol.map((row) => row.symbol),
      [...new Set(fills.map((e) => e.symbol))].sort(),
    );
  });

  await step("snapshots hold the append date's head", async () => {
    const date = head.updatedAt.slice(0, 10);
    const snapshots = await getJson(`/v1/ledgers/demo/snapshots?from=${date}&to=${date}`);
    assert.deepEqual(snapshots, { ledgerId: "demo", snapshots: [{ date, seq: total, count: total, headHash: head.headHash }] });
  });

  await step("tail publishes a local SQLite ledger and resumes from its cursor file", async () => {
    const db = join(tmp, "fills.sqlite");
    const config = join(tmp, "publisher.config.json");
    const cursorFile = join(tmp, "cursor.json");
    await publisher(["demo", "--db", db, "--dry-run", "--anchor", ANCHOR]);
    await publisher(["init", "--out", config]);
    const cfg = JSON.parse(readFileSync(config, "utf8"));
    Object.assign(cfg, { url: base, ledgerId: "tail-test", sqlite: db, cursorFile, batchSize: 500 });
    writeFileSync(config, JSON.stringify(cfg));

    await publisher(["tail", "--config", config, "--once"]);
    await publisher(["tail", "--config", config, "--once"]);
    assert.equal(JSON.parse(readFileSync(cursorFile, "utf8")).cursor, fills.length);

    const tailHead = await getJson("/v1/ledgers/tail-test/head");
    assert.deepEqual([tailHead.seq, tailHead.count], [fills.length, fills.length]);
    const first = (await getJson("/v1/ledgers/tail-test/events?limit=3")).events;
    assert.deepEqual(
      first.map((e) => e.id),
      fills.slice(0, 3).map((e) => e.id),
    );
    assert.deepEqual(Object.keys(first[0].meta).sort(), ["fee", "venue"]);
    const verify = await getJson(`/v1/ledgers/tail-test/verify?from=1&to=${fills.length}`);
    assert.deepEqual([verify.ok, verify.checked, verify.headHash], [true, fills.length, tailHead.headHash]);
  });

  await step("dashboard files are served", async () => {
    for (const path of ["/", "/?ledger=demo"]) {
      const res = await request(base + path);
      assert.equal(res.status, 200, path);
      assert.match(await res.text(), /Verify chain in your browser/, path);
    }
    for (const [path, type] of [
      ["/app.js", /javascript/],
      ["/chain.js", /javascript/],
      ["/styles.css", /css/],
    ]) {
      const res = await request(base + path);
      assert.equal(res.status, 200, path);
      assert.match(res.headers.get("content-type") ?? "", type, path);
    }
  });
}

let exitCode = 0;
try {
  await main();
  console.log(`\nsmoke passed (${checks} checks)`);
} catch (err) {
  console.error(`\nsmoke FAILED after ${checks} checks: ${err?.stack ?? err}`);
  console.error(`\n--- last wrangler output ---\n${wranglerLog.join("").split("\n").slice(-60).join("\n")}`);
  exitCode = 1;
} finally {
  cleanup();
}
await Promise.all([process.stdout, process.stderr].map((stream) => new Promise((resolve) => stream.write("", resolve))));
process.exit(exitCode);
