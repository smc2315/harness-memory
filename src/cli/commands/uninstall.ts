/**
 * `hm uninstall [--purge]` (spec §8.7, §11; m0-facts #8): removes the hook entries the manifest points
 * at (every other hook in the settings file survives), the `.git/info/exclude` line install added and
 * the manifest. `--purge` also deletes `.harness-memory/` — except the `memory.sqlite.bak-v<N>` backups,
 * which stay so a downgrade can `db:rollback`.
 */

import { existsSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { EXIT_CODES } from "../../core/errors";
import type { HarnessPaths } from "../../core/paths";
import type { CommandContext } from "../context";
import { flagBoolean, type OptionSpecs } from "../lib/args";
import { readPidFile } from "../lib/diagnostics";
import { readManifest, type InstallManifest } from "../lib/manifest";
import { GIT_EXCLUDE_LINE, gitExcludeFile, projectSettingsFile, userSettingsFile } from "../lib/paths";
import { readSettingsFile, SettingsParseError, stripHarnessHooks, writeSettingsFile } from "../lib/settings";

export const uninstallOptions: OptionSpecs = {
  purge: { type: "boolean", description: "Also delete .harness-memory/ (keeps memory.sqlite.bak-v<N> backups)" },
  user: { type: "boolean", description: "Without a manifest: also strip ~/.claude/settings.json" },
};

export interface SettingsCleanup {
  file: string;
  removed: number;
  deleted_file: boolean;
  error: string | null;
}

export interface UninstallReport {
  root: string;
  manifest_found: boolean;
  settings: SettingsCleanup[];
  git_exclude_removed: boolean;
  manifest_removed: boolean;
  purged: boolean;
  kept: string[];
  removed_paths: string[];
  /** Informational (a worker still running, …); never changes the exit code. */
  warnings: string[];
  /** Something could not be removed or rewritten; exit code 1. */
  errors: string[];
}

export const BACKUP_PATTERN = /\.bak-v\d+$/;

export function cleanupSettingsFile(file: string, deleteWhenEmpty: boolean): SettingsCleanup {
  if (!existsSync(file)) return { file, removed: 0, deleted_file: false, error: null };
  try {
    const { settings } = readSettingsFile(file);
    const stripped = stripHarnessHooks(settings);
    if (stripped.removed === 0) return { file, removed: 0, deleted_file: false, error: null };
    if (deleteWhenEmpty && Object.keys(stripped.settings).length === 0) {
      unlinkSync(file);
      return { file, removed: stripped.removed, deleted_file: true, error: null };
    }
    writeSettingsFile(file, stripped.settings);
    return { file, removed: stripped.removed, deleted_file: false, error: null };
  } catch (error) {
    const message = error instanceof SettingsParseError ? error.message : error instanceof Error ? error.message : String(error);
    return { file, removed: 0, deleted_file: false, error: message };
  }
}

export function removeGitExcludeLine(root: string): boolean {
  const file = gitExcludeFile(root);
  if (file === null || !existsSync(file)) return false;
  const content = readFileSync(file, "utf8");
  const lines = content.split(/\r?\n/);
  const kept = lines.filter((line) => {
    const trimmed = line.trim();
    return trimmed !== GIT_EXCLUDE_LINE && trimmed !== `/${GIT_EXCLUDE_LINE}`;
  });
  if (kept.length === lines.length) return false;
  writeFileSync(file, kept.join("\n").replace(/\n*$/, "\n"), "utf8");
  return true;
}

/** Deletes everything under `.harness-memory/` except `*.bak-v<N>`; the directory stays only when backups remain. */
export function purgeHarnessDir(paths: HarnessPaths): { kept: string[]; removed: string[]; errors: string[] } {
  const kept: string[] = [];
  const removed: string[] = [];
  const errors: string[] = [];
  let names: string[];
  try {
    names = readdirSync(paths.dir);
  } catch {
    return { kept, removed, errors };
  }
  for (const name of names) {
    const target = join(paths.dir, name);
    if (BACKUP_PATTERN.test(name)) {
      kept.push(target);
      continue;
    }
    try {
      rmSync(target, { recursive: true, force: true });
      removed.push(target);
    } catch (error) {
      errors.push(`${target}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (kept.length === 0 && errors.length === 0) {
    try {
      rmSync(paths.dir, { recursive: true, force: true });
      removed.push(paths.dir);
    } catch (error) {
      errors.push(`${paths.dir}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { kept, removed, errors };
}

export function renderUninstallReport(report: UninstallReport): string[] {
  const lines = [`harness-memory uninstalled from ${report.root}${report.manifest_found ? "" : " (no install manifest; cleaned the default settings files)"}`];
  for (const entry of report.settings) {
    if (entry.error !== null) lines.push(`  settings    ${entry.file}: ${entry.error}`);
    else if (entry.deleted_file) lines.push(`  settings    ${entry.file}: removed ${String(entry.removed)} hook entries, deleted the now-empty file`);
    else lines.push(`  settings    ${entry.file}: removed ${String(entry.removed)} hook entries`);
  }
  if (report.git_exclude_removed) lines.push(`  git         ${GIT_EXCLUDE_LINE} removed from .git/info/exclude`);
  lines.push(`  manifest    ${report.manifest_removed ? "removed" : "none"}`);
  if (report.purged) {
    lines.push(`  purge       removed ${String(report.removed_paths.length)} entries under .harness-memory/`);
    for (const path of report.kept) lines.push(`  kept        ${path}`);
  } else {
    lines.push("  data        .harness-memory/ kept (memories, ledgers, logs); `hm uninstall --purge` deletes it");
  }
  for (const warning of report.warnings) lines.push(`  warning     ${warning}`);
  for (const error of report.errors) lines.push(`  error       ${error}`);
  return lines;
}

export async function runUninstall(ctx: CommandContext): Promise<number> {
  const purge = flagBoolean(ctx.args, "purge");
  const manifest: InstallManifest | null = readManifest(ctx.paths.manifest);
  const warnings: string[] = [];
  const errors: string[] = [];
  const settings: SettingsCleanup[] = [];

  if (manifest !== null) {
    const created = manifest.files.some((file) => file.role === "settings" && file.created);
    settings.push(cleanupSettingsFile(manifest.settings_file, created));
  } else {
    settings.push(cleanupSettingsFile(projectSettingsFile(ctx.paths.root), false));
    if (flagBoolean(ctx.args, "user")) settings.push(cleanupSettingsFile(userSettingsFile(ctx.env), false));
  }
  for (const entry of settings) if (entry.error !== null) errors.push(entry.error);

  const gitExcludeRemoved = manifest?.git_exclude?.added === true ? removeGitExcludeLine(ctx.paths.root) : false;

  let manifestRemoved = false;
  if (existsSync(ctx.paths.manifest)) {
    try {
      unlinkSync(ctx.paths.manifest);
      manifestRemoved = true;
    } catch (error) {
      errors.push(`could not remove ${ctx.paths.manifest}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  let kept: string[] = [];
  let removedPaths: string[] = [];
  if (purge) {
    const worker = readPidFile(ctx.paths.workerPid);
    if (worker !== null && worker.alive) warnings.push(`a worker (pid ${String(worker.pid)}) is still running; files it holds open may survive the purge`);
    const helper = readPidFile(ctx.paths.embedHelperPid);
    if (helper !== null && helper.alive) warnings.push(`the embedding helper (pid ${String(helper.pid)}) is still running; it exits after ${String(ctx.config.embeddings.idle_exit_minutes)} idle minutes`);
    const purged = purgeHarnessDir(ctx.paths);
    kept = purged.kept;
    removedPaths = purged.removed;
    errors.push(...purged.errors);
  }

  const report: UninstallReport = {
    root: ctx.paths.root,
    manifest_found: manifest !== null,
    settings,
    git_exclude_removed: gitExcludeRemoved,
    manifest_removed: manifestRemoved,
    purged: purge,
    kept,
    removed_paths: removedPaths,
    warnings,
    errors,
  };
  ctx.out.result(report, renderUninstallReport);
  return errors.length === 0 ? EXIT_CODES.ok : EXIT_CODES.error;
}
