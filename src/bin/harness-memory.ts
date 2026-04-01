#!/usr/bin/env node

import { spawnSync } from "child_process";
import { fileURLToPath } from "url";

const COMMANDS = new Map<string, string>([
  ["db:migrate", "../cli/migrate.js"],
  ["db:inspect", "../cli/inspect.js"],
  ["memory:add", "../cli/memory-add.js"],
  ["memory:export", "../cli/memory-export.js"],
  ["memory:history", "../cli/memory-history.js"],
  ["memory:list", "../cli/memory-list.js"],
  ["memory:promote", "../cli/memory-promote.js"],
  ["memory:reject", "../cli/memory-reject.js"],
  ["memory:review", "../cli/memory-review.js"],
  ["memory:stats", "../cli/memory-stats.js"],
  ["memory:why", "../cli/memory-why.js"],
  ["policy:check", "../cli/policy-check.js"],
  ["adapter:test", "../cli/adapter-test.js"],
  ["dream:evidence:list", "../cli/dream-evidence-list.js"],
  ["dream:extract", "../cli/dream-extract.js"],
  ["dream:run", "../cli/dream-run.js"],
  ["dream:runs:list", "../cli/dream-runs-list.js"],
  ["dream:runs:show", "../cli/dream-runs-show.js"],
  ["eval:baseline", "../cli/eval-baseline.js"],
  ["eval:memory", "../cli/eval-memory.js"],
  ["fixtures:add-conflict", "../cli/fixtures-add-conflict.js"],
  ["fixtures:add-duplicate-memory", "../cli/fixtures-add-duplicate-memory.js"],
  ["fixtures:add-policy-rules", "../cli/fixtures-add-policy-rules.js"],
  ["install", "../cli/install.js"],
  ["init", "../cli/init.js"],
]);

function renderHelp(): void {
  console.log("Usage: harness-memory <command> [args]");
  console.log("");
  console.log("Commands:");
  for (const command of COMMANDS.keys()) {
    console.log(`  ${command}`);
  }
}

const [command, ...args] = process.argv.slice(2);

if (command === undefined || command === "help" || command === "--help") {
  renderHelp();
  process.exit(0);
}

const commandPath = COMMANDS.get(command);
if (commandPath === undefined) {
  console.error(`Unknown command: ${command}`);
  console.error("");
  renderHelp();
  process.exit(1);
}

const scriptPath = fileURLToPath(new URL(commandPath, import.meta.url));
const proc = spawnSync(process.execPath, [scriptPath, ...args], {
  stdio: "inherit",
});

process.exit(proc.status ?? 1);
