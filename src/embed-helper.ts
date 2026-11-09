/**
 * `dist/embed-helper.js <root>` — entry of the detached embedding helper spawned by the `prompt` hook
 * (`src/embed/client.ts` → `ensureHelper`). Lives until `embeddings.idle_exit_minutes` pass without a
 * request; see `src/embed/helper.ts`.
 */

import { appendFileSync, mkdirSync } from "node:fs";

import { loadConfig } from "./core/config";
import { resolvePaths } from "./core/paths";
import { startHelper } from "./embed/helper";

const root = process.argv[2] ?? process.cwd();
const paths = resolvePaths(root);
const config = loadConfig(paths.config);

function log(line: string): void {
  try {
    mkdirSync(paths.logsDir, { recursive: true });
    appendFileSync(paths.workerLog, `${new Date().toISOString()} embed-helper ${line}\n`, "utf8");
  } catch {
    // logging is best effort
  }
}

startHelper({ paths, config, log }).catch((error: unknown) => {
  log(`failed to start: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
