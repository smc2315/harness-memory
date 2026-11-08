/**
 * Running the worker in-process for `hm extract`, `hm dream` and `hm import`: the same Store composition
 * the detached worker uses (createCliStore), the worker.log logger, an embed function (same composition as
 * src/worker.ts createWorkerEmbed) so new rows get embeddings when embeddings are enabled, and provider
 * resolution (`--provider`, the test seam, or the config). The result renderer is shared so the three
 * commands print the same shape.
 */

import type { HarnessConfig } from "../../core/config";
import { EXIT_CODES } from "../../core/errors";
import { PROVIDERS, type ProviderName } from "../../core/vocabulary";
import type { DreamReport, EmbedFn } from "../../dream/consolidate";
import { selectProvider, type ExtractionProvider } from "../../dream/extract/providers";
import { createWorkerEmbed, createWorkerLogger, runWorker, type WorkerCommand, type WorkerResult } from "../../dream/worker";
import type { CommandContext } from "../context";
import { CliInputError, usageError } from "./cli-error";
import { requireDatabase } from "./db-access";
import { probeGuidance } from "./diagnostics";
import { shortId } from "./lookup";
import { pluralize } from "./output";
import { createCliStore } from "./store";

export interface ResolvedProvider {
  provider: ExtractionProvider | null;
  source: "seam" | "flag" | "config";
  name: string;
}

/** `--provider <name>` wins over the config; the test seam (`ctx.seams.provider`) wins over both (after the name check). */
export function resolveCliProvider(ctx: CommandContext, requested: string | null): ResolvedProvider {
  if (requested !== null && !(PROVIDERS as readonly string[]).includes(requested)) {
    throw usageError(`unknown provider ${requested}`, `choose one of ${PROVIDERS.join(", ")}`);
  }
  if (ctx.seams.provider !== undefined) {
    return { provider: ctx.seams.provider, source: "seam", name: ctx.seams.provider?.name ?? "none" };
  }
  if (requested !== null) {
    const name = requested as ProviderName;
    const provider = selectProvider({ extraction: { ...ctx.config.extraction, provider: name } }, { paths: ctx.paths, envOverride: name });
    if (provider === null) {
      throw new CliInputError(`provider ${name} is not available`, {
        hint: name === "opencode" ? "the OpenCode provider ships in a later release" : `the ${name} binary was not found (set HARNESS_MEMORY_${name.toUpperCase()}_BIN)`,
      });
    }
    return { provider, source: "flag", name };
  }
  const provider = selectProvider(ctx.config, { paths: ctx.paths });
  return { provider, source: "config", name: provider?.name ?? "none" };
}

/**
 * Document-side embedder for in-process worker runs — the same composition as `createWorkerEmbed` in
 * src/worker.ts (lazy @xenova/transformers pipeline, e5 `passage:` prefix, null when embeddings are off).
 * Kept here instead of importing src/worker.ts: that module runs its `main()` whenever `import.meta.url`
 * equals `pathToFileURL(process.argv[1])`, which is true for any bundle it is inlined into (`dist/bin/harness-memory.js`).
 */
export function createCliEmbed(config: HarnessConfig): EmbedFn | null {
  return createWorkerEmbed(config);
}

export interface RunCliWorkerOptions {
  command: WorkerCommand;
  provider: ExtractionProvider | null;
  /** Config handed to the worker (import lifts the daily cap). */
  config?: HarnessConfig;
  maxLoops?: number;
  args?: readonly string[];
}

export async function runCliWorker(ctx: CommandContext, options: RunCliWorkerOptions): Promise<WorkerResult> {
  requireDatabase(ctx);
  const config = options.config ?? ctx.config;
  const store = createCliStore({ paths: ctx.paths, config, clock: ctx.clock, stderr: ctx.stderr });
  const logger = createWorkerLogger(ctx.paths, { command: options.command, clock: ctx.clock, maxBytes: config.log.max_bytes, rotations: config.log.rotations });
  return runWorker({
    paths: ctx.paths,
    config,
    store,
    command: options.command,
    args: options.args,
    provider: options.provider,
    clock: ctx.clock,
    logger,
    maxLoops: options.maxLoops,
    embed: createCliEmbed(config),
  });
}

export function workerExitCode(result: WorkerResult): number {
  if (result.busy) return EXIT_CODES.ok;
  return result.exitCode;
}

export function renderDreamReport(report: DreamReport): string[] {
  const gc = report.gc;
  const lines = [
    `dream: ttl extended ${String(report.ttlExtended.length)}, downgraded ${String(report.downgraded.length)}, revalidate proposals ${String(report.revalidateProposals.length)}, staled ${String(report.staled.length)}`,
    `  candidates rejected ${String(report.rejectedCandidates.length)}, proposals expired ${String(report.expiredProposals.length)} (staled by expiry ${String(report.staledByExpiry.length)}), merge proposals ${String(report.mergeProposals.length)}, fix_signature ${String(report.fixSignatureProposals.length)}`,
    `  embedded ${String(report.embedded)}, idle turns closed ${String(report.idleClosed.length)}, gc ledgers ${String(gc.ledgers)} states ${String(gc.states)} raw ${String(gc.raw)} tmp ${String(gc.tmp)} audit ${String(gc.audit)}`,
  ];
  for (const error of report.errors) lines.push(`  error: ${error}`);
  return lines;
}

export function renderWorkerResult(result: WorkerResult, providerName: string): string[] {
  if (result.busy) return [`${result.command}: another worker holds worker.lock; nothing was processed here (it will pick up the queue)`];
  const lines: string[] = [
    `${result.command}: provider ${providerName}; inserted ${pluralize(result.inserted, "episode")} from queue, processed ${pluralize(result.processed.length, "run")}, skipped ${String(result.skipped.length)}, loops ${String(result.loops)}`,
  ];
  for (const item of result.processed) {
    lines.push(
      `  episode ${shortId(item.episodeId)} run ${shortId(item.runId)} ${item.status}${item.fromCache ? " (raw cache)" : ""}: created ${String(item.created.length)}, activated ${String(item.activated.length)}, proposals ${String(item.proposals.length)}, outcomes ${String(item.outcomes)}`
    );
  }
  if (result.waiting !== null) {
    lines.push(`  waiting: ${pluralize(result.waiting.count, "episode")} (${result.waiting.reason})`);
    const guidance = probeGuidance(result.waiting.reason === "no_provider" ? "missing" : result.waiting.reason);
    if (guidance !== null) lines.push(`    ${guidance}`);
    if (result.waiting.reason === "daily_cap") lines.push("    extraction.max_runs_per_day reached; the remaining episodes run tomorrow");
  }
  if (result.dream !== null) lines.push(...renderDreamReport(result.dream));
  if (result.snapshotBuilt) lines.push("  snapshot rebuilt");
  for (const error of result.errors) lines.push(`  error: ${error}`);
  return lines;
}
