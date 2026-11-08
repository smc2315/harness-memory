#!/usr/bin/env node
// `harness-memory` / `hm` binary (spec §11). All logic lives in src/cli/main.ts so tests can run the
// dispatcher in-process; this file only maps the result to the process exit code.

import { runCli } from "../cli/main";

runCli(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`hm crashed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    process.exitCode = 1;
  }
);
