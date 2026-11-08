/**
 * `hm db:rollback [--to <version>] [--yes]` (spec §11): restores `memory.sqlite.bak-v<N>` (the copy the
 * migrator took before upgrading from v<N>) over memory.sqlite after confirmation. Runs under the
 * database lock so no writer races the copy; the current file is kept as `memory.sqlite.rollback-<ts>`.
 * `.prev` is removed (it holds the newer schema and would otherwise be "recovered" over the restored file)
 * and the snapshot files are deleted so hooks do not serve rows the restored database no longer has.
 *
 * Note: the next writer (worker or CLI) migrates the restored database forward again — roll back
 * when you are about to downgrade harness-memory, or after `hm uninstall`.
 */

import { copyFileSync, existsSync, rmSync } from "node:fs";

import { EXIT_CODES } from "../../core/errors";
import { acquireDirLock } from "../../db/locks";
import type { CommandContext } from "../context";
import { flagBoolean, flagNumber, type OptionSpecs } from "../lib/args";
import { listDbBackups } from "../lib/paths";
import { CLI_LOCK_WAIT_MS, EXIT_USAGE } from "../lib/store";

export const dbRollbackOptions: OptionSpecs = {
  to: { type: "number", description: "Backup version to restore (default: the newest .bak-v<N>)", placeholder: "<version>" },
  yes: { type: "boolean", description: "Do not ask for confirmation", alias: "y" },
};

export interface RollbackReport {
  db: string;
  restored_from: string;
  backup_version: number;
  previous_copy: string | null;
  removed: string[];
  confirmed: boolean;
}

export function renderRollbackReport(report: RollbackReport): string[] {
  const lines = [`restored ${report.db} from ${report.restored_from} (schema v${String(report.backup_version)})`];
  if (report.previous_copy !== null) lines.push(`  previous  ${report.previous_copy}`);
  for (const path of report.removed) lines.push(`  removed   ${path}`);
  lines.push("  note      the next writer migrates the database forward again; downgrade or `hm uninstall` first if that is not wanted");
  return lines;
}

export async function runDbRollback(ctx: CommandContext): Promise<number> {
  const backups = listDbBackups(ctx.paths);
  if (backups.length === 0) {
    ctx.out.error(`no memory.sqlite.bak-v<N> backup next to ${ctx.paths.db}`);
    return EXIT_CODES.error;
  }
  const requested = flagNumber(ctx.args, "to");
  const backup = requested === null ? backups[0]! : backups.find((entry) => entry.version === requested);
  if (backup === undefined) {
    ctx.out.error(`no backup for version ${String(requested)}; available: ${backups.map((entry) => `v${String(entry.version)}`).join(", ")}`);
    return EXIT_USAGE;
  }

  if (!flagBoolean(ctx.args, "yes")) {
    const question = `Replace ${ctx.paths.db} with ${backup.path} (schema v${String(backup.version)})? Memories learned since that backup are lost.`;
    if (!ctx.isTTY) {
      ctx.out.error("db:rollback needs confirmation; pass --yes when there is no terminal");
      ctx.out.note(question);
      return EXIT_USAGE;
    }
    if (!(await ctx.confirm(question))) {
      ctx.out.line("aborted");
      return EXIT_CODES.error;
    }
  }

  const lock = await acquireDirLock(ctx.paths.dbLock, { purpose: "rollback", waitMs: CLI_LOCK_WAIT_MS, now: ctx.clock });
  const removed: string[] = [];
  let previousCopy: string | null = null;
  try {
    if (existsSync(ctx.paths.db)) {
      previousCopy = `${ctx.paths.db}.rollback-${ctx.clock().replace(/[:.]/g, "-")}`;
      copyFileSync(ctx.paths.db, previousCopy);
    }
    copyFileSync(backup.path, ctx.paths.db);
    for (const file of [ctx.paths.dbPrev, ctx.paths.snapshotActive, ctx.paths.snapshotLexical, ctx.paths.snapshotDense]) {
      if (!existsSync(file)) continue;
      rmSync(file, { force: true });
      removed.push(file);
    }
  } finally {
    lock.release();
  }

  const report: RollbackReport = {
    db: ctx.paths.db,
    restored_from: backup.path,
    backup_version: backup.version,
    previous_copy: previousCopy,
    removed,
    confirmed: true,
  };
  ctx.out.result(report, renderRollbackReport);
  return EXIT_CODES.ok;
}
