/**
 * `hm snapshot:rebuild` (spec §11): `Store.rebuildSnapshot()` — the lock session migrates a pending
 * database first and always writes snapshot/active.v1.json, lexical.v1.json (and dense.v1.bin when any
 * row has an embedding). Reports the counts the hooks will see.
 */

import { statSync } from "node:fs";

import { EXIT_CODES } from "../../core/errors";
import type { SnapshotCounts } from "../../core/snapshot-types";
import type { CommandContext } from "../context";
import type { OptionSpecs } from "../lib/args";
import { readSnapshotFacts } from "../lib/diagnostics";
import { formatBytes } from "../lib/output";
import { CLI_LOCK_WAIT_MS, createCliStore } from "../lib/store";

export const snapshotRebuildOptions: OptionSpecs = {};

export interface SnapshotRebuildReport {
  built: boolean;
  error: string | null;
  migrated_from: number | null;
  generation: number;
  counts: SnapshotCounts | null;
  files: Array<{ path: string; bytes: number }>;
}

function sizeOf(file: string): number | null {
  try {
    return statSync(file).size;
  } catch {
    return null;
  }
}

export function renderSnapshotRebuildReport(report: SnapshotRebuildReport): string[] {
  if (!report.built) return [`snapshot build failed${report.error === null ? "" : `: ${report.error}`}`];
  const lines = [`snapshot rebuilt (db_generation ${String(report.generation)})${report.migrated_from === null ? "" : ` after migrating from v${String(report.migrated_from)}`}`];
  if (report.counts !== null) {
    const c = report.counts;
    lines.push(`  active ${String(c.active)} (auto ${String(c.auto_active)}) | candidates ${String(c.candidates)} | proposals ${String(c.open_proposals)} | queue ${String(c.queue)}${c.unreachable > 0 ? ` | unreachable ${String(c.unreachable)}` : ""}`);
  }
  for (const file of report.files) lines.push(`  ${formatBytes(file.bytes).padStart(9)}  ${file.path}`);
  return lines;
}

export async function runSnapshotRebuild(ctx: CommandContext): Promise<number> {
  const store = createCliStore({ paths: ctx.paths, config: ctx.config, clock: ctx.clock, stderr: ctx.stderr });
  const result = await store.rebuildSnapshot(CLI_LOCK_WAIT_MS);
  const facts = readSnapshotFacts(ctx.paths, ctx.nowMs());
  const files: SnapshotRebuildReport["files"] = [];
  for (const path of [ctx.paths.snapshotActive, ctx.paths.snapshotLexical, ctx.paths.snapshotDense]) {
    const bytes = sizeOf(path);
    if (bytes !== null) files.push({ path, bytes });
  }
  const report: SnapshotRebuildReport = {
    built: result.snapshotBuilt,
    error: result.snapshotError === null ? null : result.snapshotError instanceof Error ? result.snapshotError.message : String(result.snapshotError),
    migrated_from: result.migrated === null || result.migrated.applied.length === 0 ? null : result.migrated.from,
    generation: result.generation,
    counts: facts.counts,
    files,
  };
  ctx.out.result(report, renderSnapshotRebuildReport);
  return report.built ? EXIT_CODES.ok : EXIT_CODES.error;
}
