#!/usr/bin/env node
// Entry point for the `open-ledger-publish` bin.
//
// `node:sqlite` ships flagged on Node 22.5–22.12 (--experimental-sqlite) and unflagged from
// Node 22.13 / 23.4 onward. Only the `tail` subcommand (and `demo --db`) touch SQLite, so we
// probe lazily and re-exec with the flag when the running Node needs it.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const needsSqlite = args[0] === "tail" || (args[0] === "demo" && args.includes("--db"));

if (needsSqlite && !process.execArgv.includes("--experimental-sqlite")) {
  let available = true;
  try {
    await import("node:sqlite");
  } catch {
    available = false;
  }
  if (!available) {
    const cli = fileURLToPath(new URL("./cli.mjs", import.meta.url));
    const result = spawnSync(process.execPath, ["--experimental-sqlite", cli, ...args], { stdio: "inherit" });
    process.exit(result.status ?? 1);
  }
}

const { run } = await import("./cli.mjs");
process.exitCode = await run(args);
