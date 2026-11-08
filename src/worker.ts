/**
 * Bundle entry for the detached worker: `node dist/worker.js <root> <extract|dream|reindex|import> [args]`.
 * Composes the Store with the v0.6 hooks (post-migrate, derived policy rules, snapshot) and exits with
 * 0 (done / busy), 1 (error) or 75 (database lock busy). Logs go to `.harness-memory/logs/worker.log`.
 */

import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { loadConfig, type HarnessConfig } from "./core/config";
import { EXIT_CODES } from "./core/errors";
import { resolvePaths } from "./core/paths";
import type { EmbedFn } from "./dream/consolidate";
import { composeStore, createWorkerLogger, parseWorkerArgv, runWorker } from "./dream/worker";
import { createTransformersEmbedder, type Embedder } from "./embed/helper";

export { composeStore, composeStoreHooks, createWorkerLogger, parseWorkerArgv, runWorker } from "./dream/worker";

/**
 * Document-side embedder for the worker (`EmbedFn` of consolidate/backfillEmbeddings): lazily loads the same
 * @xenova/transformers pipeline the embedding helper uses, with the e5 `passage: ` prefix. Null when embeddings
 * are disabled; an empty batch only warms the model.
 */
export function createWorkerEmbed(config: HarnessConfig): EmbedFn | null {
  if (!config.embeddings.enabled) return null;
  const factory = createTransformersEmbedder(config);
  let loading: Promise<Embedder> | null = null;
  return async (texts: string[]): Promise<Float32Array[]> => {
    loading ??= factory();
    const embedder = await loading;
    const vectors: Float32Array[] = [];
    for (const text of texts) {
      vectors.push(embedder.embedPassage !== undefined ? await embedder.embedPassage(text) : await embedder.embedQuery(text));
    }
    return vectors;
  };
}

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

/** True when this file is the process entry (`node dist/worker.js …`), not when it is imported by the CLI or tests. */
const invokedDirectly = (() => {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return pathToFileURL(entry).href === import.meta.url || /[\\/]worker\.(?:js|mjs|cjs)$/.test(entry);
  } catch {
    return false;
  }
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
