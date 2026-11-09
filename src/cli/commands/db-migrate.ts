/**
 * `hm db:migrate` (spec §11): `Store.withWriteLock('migrate', …, noop)` — the store copies memory.sqlite to
 * `.bak-v<from>`, applies the pending files, runs post-migrate, saves and rebuilds the snapshot. On an
 * up-to-date database nothing is written and the command says so.
 */

import { EXIT_CODES } from "../../core/errors";
import { TARGET_USER_VERSION } from "../../core/paths";
import { noopOp } from "../../db/store";
import type { CommandContext } from "../context";
import type { OptionSpecs } from "../lib/args";
import { CLI_LOCK_WAIT_MS, createCliStore } from "../lib/store";

export const dbMigrateOptions: OptionSpecs = {};

export interface MigrateReport {
  db: string;
  from: number;
  to: number;
  applied: string[];
  backup: string | null;
  saved: boolean;
  snapshot_built: boolean;
  recovered: boolean;
  corrupt_path: string | null;
  lock_taken_over: boolean;
  target: number;
}

export function renderMigrateReport(report: MigrateReport): string[] {
  const lines: string[] = [];
  if (report.applied.length === 0) {
    lines.push(`${report.db} is at v${String(report.to)} (target v${String(report.target)}); nothing to migrate`);
  } else {
    lines.push(`migrated ${report.db} v${String(report.from)} → v${String(report.to)} (${String(report.applied.length)} files)`);
    for (const file of report.applied) lines.push(`  applied   ${file}`);
    if (report.backup !== null) lines.push(`  backup    ${report.backup}`);
  }
  if (report.recovered) lines.push(`  recovered the main file from .prev${report.corrupt_path === null ? "" : ` (damaged copy kept at ${report.corrupt_path})`}`);
  if (report.lock_taken_over) lines.push("  took over a stale database lock");
  lines.push(`  snapshot  ${report.snapshot_built ? "rebuilt" : "unchanged"}`);
  return lines;
}

export async function runDbMigrate(ctx: CommandContext): Promise<number> {
  const store = createCliStore({ paths: ctx.paths, config: ctx.config, clock: ctx.clock, stderr: ctx.stderr });
  const result = await store.withWriteLock("migrate", CLI_LOCK_WAIT_MS, () => noopOp("migrate"));
  const report: MigrateReport = {
    db: ctx.paths.db,
    from: result.migrated?.from ?? result.userVersion,
    to: result.userVersion,
    applied: result.migrated?.applied ?? [],
    backup: result.backupPath,
    saved: result.saved,
    snapshot_built: result.snapshotBuilt,
    recovered: result.recovered,
    corrupt_path: result.corruptPath,
    lock_taken_over: result.lockTakenOver,
    target: TARGET_USER_VERSION,
  };
  ctx.out.result(report, renderMigrateReport);
  return EXIT_CODES.ok;
}
