import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { publish } from "./lib/client.mjs";
import { DEFAULT_DEMO_SEED, generateDemoEvents, writeDemoSqlite } from "./lib/demo.mjs";
import { EXAMPLE_CONFIG, loadConfig, tailOnce } from "./lib/tail.mjs";

const HELP = `open-ledger-publish — publish events to an open-ledger instance

Usage:
  open-ledger-publish demo --url <base-url> [--ledger demo] [--token <t>] [--count 300]
                           [--seed 42] [--anchor YYYY-MM-DD] [--db ./demo.sqlite] [--dry-run]
  open-ledger-publish tail --config publisher.config.json [--once] [--interval 5000] [--dry-run]
  open-ledger-publish init [--out publisher.config.json]

Subcommands:
  demo   Generate ~300 deterministic fake fills (AAPL/MSFT/SPY/NVDA/...) and publish them.
         With --db also write them to a local SQLite file so you can try \`tail\` against it.
  tail   Tail a local SQLite database using the SQL query in the config file, map rows to
         LedgerEvents and POST new rows to the ingest API, keeping a cursor file.
  init   Write an example config file to get started with \`tail\`.

The ingest token is read from --token, otherwise from the environment variable named by the
config's "tokenEnv" (default INGEST_TOKEN).
`;

export async function run(argv) {
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case "demo":
        return await demo(rest);
      case "tail":
        return await tail(rest);
      case "init":
        return await init(rest);
      case undefined:
      case "-h":
      case "--help":
      case "help":
        process.stdout.write(HELP);
        return command === undefined ? 1 : 0;
      default:
        process.stderr.write(`unknown subcommand "${command}"\n\n${HELP}`);
        return 1;
    }
  } catch (err) {
    process.stderr.write(`error: ${err?.message ?? err}\n`);
    return 1;
  }
}

function log(message) {
  process.stderr.write(`[open-ledger-publish] ${message}\n`);
}

function resolveToken(explicit, envName = "INGEST_TOKEN", dryRun = false) {
  const token = explicit ?? process.env[envName];
  if (!token && !dryRun) {
    throw new Error(`no ingest token: pass --token or set ${envName}`);
  }
  return token ?? "";
}

async function demo(args) {
  const { values } = parseArgs({
    args,
    options: {
      url: { type: "string" },
      ledger: { type: "string", default: "demo" },
      token: { type: "string" },
      count: { type: "string", default: "300" },
      seed: { type: "string", default: String(DEFAULT_DEMO_SEED) },
      anchor: { type: "string" },
      db: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }
  const url = values.url ?? process.env.OPEN_LEDGER_URL;
  if (!url && !values["dry-run"] && !values.db) {
    throw new Error("--url is required (or set OPEN_LEDGER_URL)");
  }
  const count = Number.parseInt(values.count, 10);
  const seed = Number.parseInt(values.seed, 10);
  if (!Number.isInteger(count) || count < 1 || count > 20000) throw new Error("--count must be 1..20000");
  if (!Number.isInteger(seed)) throw new Error("--seed must be an integer");

  const events = generateDemoEvents({ count, seed, anchor: values.anchor });
  const fills = events.filter((e) => e.type === "fill").length;
  log(`generated ${events.length} events (${fills} fills) with seed ${seed}`);

  if (values.db) {
    const written = await writeDemoSqlite(values.db, events);
    log(`wrote ${written} fills to ${values.db} (table "fills"); try: open-ledger-publish init && open-ledger-publish tail --config publisher.config.json --once`);
  }

  if (values["dry-run"]) {
    for (const e of events.slice(0, 5)) process.stdout.write(JSON.stringify(e) + "\n");
    log(`dry run: showed the first 5 of ${events.length} events, nothing published`);
    return 0;
  }
  if (!url) return 0;

  const token = resolveToken(values.token);
  const result = await publish({ url, ledgerId: values.ledger, token, events, log });
  process.stdout.write(JSON.stringify({ ledgerId: values.ledger, ...result }, null, 2) + "\n");
  return 0;
}

async function tail(args) {
  const { values } = parseArgs({
    args,
    options: {
      config: { type: "string", default: "publisher.config.json" },
      token: { type: "string" },
      once: { type: "boolean", default: false },
      interval: { type: "string", default: "5000" },
      "dry-run": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }
  const config = await loadConfig(values.config);
  const dryRun = values["dry-run"];
  const once = values.once || dryRun;
  const token = resolveToken(values.token, config.tokenEnv, dryRun);
  const interval = Number.parseInt(values.interval, 10);
  if (!Number.isInteger(interval) || interval < 250) throw new Error("--interval must be >= 250 (ms)");

  let stopped = false;
  const stop = () => {
    stopped = true;
    log("stopping after the current pass");
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  do {
    const result = await tailOnce({ config, token, dryRun, log });
    if (result.rows > 0 || once) {
      log(
        `rows=${result.rows} accepted=${result.accepted} duplicates=${result.duplicates} ` +
          `cursor=${JSON.stringify(result.cursor)} seq=${result.seq ?? "-"} head=${result.headHash ?? "-"}`,
      );
    }
    if (once || stopped) break;
    await new Promise((r) => setTimeout(r, interval));
  } while (!stopped);
  return 0;
}

async function init(args) {
  const { values } = parseArgs({
    args,
    options: {
      out: { type: "string", default: "publisher.config.json" },
      force: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (!values.force) {
    try {
      await readFile(values.out);
      throw new Error(`${values.out} already exists (use --force to overwrite)`);
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
  }
  await writeFile(values.out, JSON.stringify(EXAMPLE_CONFIG, null, 2) + "\n");
  log(`wrote ${values.out}; edit "url", "sqlite" and "query" to match your database`);
  return 0;
}
