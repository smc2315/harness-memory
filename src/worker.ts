/**
 * Bundle entry for the detached worker: `node dist/worker.js <root> <extract|dream|reindex|import> [args]`.
 * Composes the Store with the v0.6 hooks (post-migrate, derived policy rules, snapshot) and exits with
 * 0 (done / busy), 1 (error) or 75 (database lock busy). Logs go to `.harness-memory/logs/worker.log`.
 */

import { existsSync } from "node:fs";
import { basename } from "node:path";

import { loadConfig } from "./core/config";
import { EXIT_CODES } from "./core/errors";
import { resolvePaths } from "./core/paths";
import { composeStore, createWorkerEmbed, createWorkerLogger, parseWorkerArgv, runWorker } from "./dream/worker";

export { composeStore, composeStoreHooks, createWorkerEmbed, createWorkerLogger, parseWorkerArgv, runWorker } from "./dream/worker";

async function main(argv: readonly string[]): Promise<number> {
  const parsed = parseWorkerArgv(argv);
  if (parsed === null) {
    process.stderr.write("usage: worker <root> <extract|dream|reindex|import> [descriptor-file]\n");
    return EXIT_CODES.error;
  }
  const paths = resolvePaths(parsed.root);
  if (!existsSync(paths.dir)) {
    process.stderr.write(`harness-memory is not installed under ${paths.root} (missing ${paths.dir})\n`);
    return EXIT_CODES.error;
  }
  const config = loadConfig(paths.config);
  const logger = createWorkerLogger(paths, { command: parsed.command, maxBytes: config.log.max_bytes, rotations: config.log.rotations });
  const store = composeStore({ paths, config, logger });
  const result = await runWorker({ paths, config, store, command: parsed.command, args: parsed.args, logger, embed: createWorkerEmbed(config) });
  return result.exitCode;
}

/**
 * True only when this file is the process entry (`node dist/worker.js …`). The check is on the entry's file name,
 * not on `import.meta.url`: once tsup inlines this module into another bundle (dist/bin/harness-memory.js), the
 * URL comparison would be true for every CLI invocation and the worker main would run beside the CLI.
 */
const invokedDirectly = (() => {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  return /^worker\.(?:js|mjs|cjs)$/i.test(basename(entry));
})();

if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(`worker crashed: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = EXIT_CODES.error;
    }
  );
}
