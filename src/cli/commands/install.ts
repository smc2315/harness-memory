/**
 * `hm install --host claude [--user] [--with-embeddings]` (spec §8.7, §11; m0-facts #1, #3, #10, #15–#17).
 *
 *  1 `.harness-memory/` directories + `config.json` defaults (`--with-embeddings` → npm install + enabled)
 *  2 migrate (backup first) + `meta.installed_version` + snapshot build, under the store's lock
 *  3 hooks into `.claude/settings.local.json` (`--user`: `~/.claude/settings.json`), exec form
 *    `{command: <node>, args: [<dist/hook.js>, <event>], timeout}` per §8.2, idempotent merge
 *  4 `.claude/settings.local.json` in `.git/info/exclude`
 *  5 `install-manifest.json` (files touched + sha256, node path, version)
 *  6 provider probe (cached in meta) → `not_logged_in` guidance when needed
 *  7 self-test: `node dist/hook.js session-start` with synthetic stdin → one hooks.log line
 */

import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { DEFAULT_CONFIG, loadConfig, mergeConfig, type HarnessConfig } from "../../core/config";
import { EXIT_CODES } from "../../core/errors";
import { stateDirectories, type HarnessPaths } from "../../core/paths";
import type { ProbeResult } from "../../core/vocabulary";
import { META_KEYS, MetaRepository } from "../../db/repositories/meta";
import type { Store } from "../../db/store";
import { selectProvider, writeProbeCache, type ExtractionProvider } from "../../dream/extract/providers";
import type { CommandContext, NpmRunResult } from "../context";
import { flagBoolean, flagString, type OptionSpecs } from "../lib/args";
import { probeGuidance, readSnapshotFacts } from "../lib/diagnostics";
import { sha256File, writeManifest, type InstallManifest, type ManifestFile } from "../lib/manifest";
import { formatMs } from "../lib/output";
import { GIT_EXCLUDE_LINE, gitExcludeFile, projectSettingsFile, resolveHookScript, siblingScripts, userSettingsFile } from "../lib/paths";
import { runHookSelfTest, type SelfTestResult } from "../lib/selftest";
import {
  chooseHookForm,
  detectClaudeVersion,
  findGitBash,
  HOOK_REGISTRATIONS,
  mergeHarnessHooks,
  readSettingsFile,
  writeSettingsFile,
  type HookCommandSpec,
  type HookForm,
  type HookShell,
} from "../lib/settings";
import { CLI_LOCK_WAIT_MS, createCliStore, EXIT_USAGE } from "../lib/store";

export const installOptions: OptionSpecs = {
  host: { type: "string", description: "Host to install for (this build: claude)", placeholder: "claude" },
  user: { type: "boolean", description: "Register the hooks in ~/.claude/settings.json instead of the project's .claude/settings.local.json" },
  "with-embeddings": { type: "boolean", description: "npm install @xenova/transformers and enable dense retrieval" },
  "hook-form": { type: "string", description: "exec (default when claude ≥ 2.1.139 or unknown) | shell | auto", placeholder: "auto" },
  "hook-script": { type: "string", description: "Absolute dist/hook.js to register (default: this package's)", placeholder: "<path>" },
  "skip-probe": { type: "boolean", description: "Do not probe the extraction provider" },
  "skip-self-test": { type: "boolean", description: "Do not run the hook once after registering it" },
};

export interface InstallReport {
  ok: boolean;
  version: string;
  root: string;
  scope: "project" | "user";
  settings_file: string;
  hook_script: string;
  hook_form: HookForm;
  shell: HookShell | null;
  node: string;
  claude_version: string | null;
  events: string[];
  replaced_entries: number;
  config: { path: string; created: boolean; embeddings_enabled: boolean };
  embeddings: { requested: boolean; installed: boolean; output: string | null };
  database: { path: string; user_version: number; migrated_from: number | null; backup: string | null; snapshot_built: boolean };
  snapshot_counts: { active: number; candidates: number; unreachable: number } | null;
  git_exclude: { path: string; added: boolean; already: boolean } | null;
  manifest: string;
  probe: { provider: string | null; result: ProbeResult | null; skipped: boolean; guidance: string | null };
  self_test: SelfTestResult | { skipped: true; reason: string };
  warnings: string[];
}

function defaultRunNpm(args: readonly string[], cwd: string): NpmRunResult {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  try {
    const run = spawnSync(npm, [...args], { cwd, encoding: "utf8", shell: process.platform === "win32", windowsHide: true, timeout: 10 * 60_000 });
    const output = `${run.stdout ?? ""}${run.stderr ?? ""}`.trim();
    return { ok: run.status === 0, output: run.error === undefined ? output : `${run.error.message}\n${output}`.trim() };
  } catch (error) {
    return { ok: false, output: error instanceof Error ? error.message : String(error) };
  }
}

/** Writes defaults when missing; merges `patch` into the existing file otherwise (unknown keys are kept). */
export function ensureConfigFile(paths: HarnessPaths, patch: Record<string, unknown> | null): { created: boolean; config: HarnessConfig } {
  let existing: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(paths.config, "utf8"));
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) existing = parsed as Record<string, unknown>;
  } catch {
    existing = null;
  }
  const created = existing === null;
  const next: Record<string, unknown> = existing ?? structuredClone(DEFAULT_CONFIG as unknown as Record<string, unknown>);
  if (patch !== null) {
    for (const [key, value] of Object.entries(patch)) {
      const current = next[key];
      next[key] = typeof current === "object" && current !== null && typeof value === "object" && value !== null ? { ...(current as object), ...(value as object) } : value;
    }
  }
  if (created || patch !== null) {
    mkdirSync(dirname(paths.config), { recursive: true });
    writeFileSync(paths.config, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  }
  return { created, config: mergeConfig(DEFAULT_CONFIG, next) };
}

/** Adds `.claude/settings.local.json` to `.git/info/exclude` (m0-facts #17); null when the project has no `.git/` directory. */
export function ensureGitExclude(root: string): { path: string; added: boolean; already: boolean } | null {
  const file = gitExcludeFile(root);
  if (file === null) return null;
  let content = "";
  try {
    content = readFileSync(file, "utf8");
  } catch {
    content = "";
  }
  const present = content.split(/\r?\n/).some((line) => {
    const trimmed = line.trim();
    return trimmed === GIT_EXCLUDE_LINE || trimmed === `/${GIT_EXCLUDE_LINE}`;
  });
  if (present) return { path: file, added: false, already: true };
  mkdirSync(dirname(file), { recursive: true });
  const prefix = content.length === 0 || content.endsWith("\n") ? "" : "\n";
  appendFileSync(file, `${prefix}${GIT_EXCLUDE_LINE}\n`, "utf8");
  return { path: file, added: true, already: false };
}

export interface MigrateForInstallResult {
  userVersion: number;
  migratedFrom: number | null;
  backup: string | null;
  snapshotBuilt: boolean;
}

/** One lock session: migrate when needed, stamp `installed_version`, always build the snapshot. */
export async function migrateForInstall(store: Store, version: string): Promise<MigrateForInstallResult> {
  const result = await store.withWriteLock(
    "install",
    CLI_LOCK_WAIT_MS,
    (db) => {
      new MetaRepository(db).set(META_KEYS.installedVersion, version);
      return { id: null, kind: "install", noop: true, wrote: true };
    },
    { alwaysSnapshot: true }
  );
  return {
    userVersion: result.userVersion,
    migratedFrom: result.migrated === null || result.migrated.applied.length === 0 ? null : result.migrated.from,
    backup: result.backupPath,
    snapshotBuilt: result.snapshotBuilt,
  };
}

export async function probeForInstall(
  store: Store,
  paths: HarnessPaths,
  config: HarnessConfig,
  now: string,
  provider: ExtractionProvider | null
): Promise<{ provider: string | null; result: ProbeResult | null; guidance: string | null }> {
  if (provider === null) return { provider: null, result: null, guidance: probeGuidance("missing") };
  if (provider.name === "replay") return { provider: provider.name, result: "ok", guidance: null };
  const result = await provider.probe({ config, paths, now });
  await store.withWriteLock("install:probe", CLI_LOCK_WAIT_MS, (db) => {
    writeProbeCache(db, { at: now, result });
    return { id: null, kind: "probe", noop: true, wrote: true };
  });
  return { provider: provider.name, result, guidance: probeGuidance(result) };
}

export function renderInstallReport(report: InstallReport): string[] {
  const lines: string[] = [];
  lines.push(`harness-memory ${report.version} ${report.ok ? "installed" : "installed with problems"} for Claude Code`);
  lines.push(`  project     ${report.root}`);
  lines.push(`  hooks       ${report.events.length} events → ${report.settings_file} (${report.hook_form} form${report.shell === null ? "" : `, shell ${report.shell}`}${report.replaced_entries > 0 ? `, replaced ${report.replaced_entries} earlier entries` : ""})`);
  lines.push(`  node        ${report.node}${report.claude_version === null ? "" : `  (claude ${report.claude_version})`}`);
  lines.push(`  hook script ${report.hook_script}`);
  const db = report.database;
  const migrated = db.migrated_from === null ? "" : ` (migrated from v${String(db.migrated_from)}${db.backup === null ? "" : `, backup ${db.backup}`})`;
  lines.push(`  database    ${db.path} v${String(db.user_version)}${migrated}`);
  const counts = report.snapshot_counts;
  lines.push(`  snapshot    ${db.snapshot_built ? "built" : "not rebuilt"}${counts === null ? "" : ` (active ${String(counts.active)}, candidates ${String(counts.candidates)}${counts.unreachable > 0 ? `, unreachable ${String(counts.unreachable)}` : ""})`}`);
  lines.push(`  config      ${report.config.path}${report.config.created ? " (created)" : ""}; embeddings ${report.config.embeddings_enabled ? "enabled" : "off"}`);
  if (report.git_exclude !== null) {
    lines.push(`  git         ${GIT_EXCLUDE_LINE} ${report.git_exclude.added ? "added to" : "already in"} ${report.git_exclude.path}`);
  }
  if (report.probe.skipped) lines.push("  provider    probe skipped");
  else if (report.probe.provider === null) lines.push(`  provider    none found — ${report.probe.guidance ?? ""}`.trimEnd());
  else lines.push(`  provider    ${report.probe.provider} — probe ${report.probe.result ?? "?"}${report.probe.guidance === null ? "" : `; ${report.probe.guidance}`}`);
  if ("skipped" in report.self_test) lines.push(`  self-test   skipped (${report.self_test.reason})`);
  else if (report.self_test.ok) lines.push(`  self-test   ${report.self_test.event} ok (${formatMs(report.self_test.durationMs)}, hook status ${report.self_test.logEntry?.status ?? "?"})`);
  else lines.push(`  self-test   FAILED: ${report.self_test.error ?? "unknown error"}`);
  lines.push(`  manifest    ${report.manifest}`);
  for (const warning of report.warnings) lines.push(`  warning     ${warning}`);
  const importable = report.ok ? ["CLAUDE.md", "AGENTS.md"].find((name) => existsSync(join(report.root, name))) : undefined;
  if (importable !== undefined) {
    lines.push(`  import      \`hm import --from ${importable}\` turns its bullets into human memories (a confirmation table lets you pick)`);
  }
  lines.push(report.ok ? "Open Claude Code in this project; `hm status` shows what the hooks learn." : "Run `hm doctor` for details.");
  return lines;
}

export async function runInstall(ctx: CommandContext): Promise<number> {
  const host = flagString(ctx.args, "host") ?? "claude";
  if (host !== "claude") {
    ctx.out.error(`install --host ${host}: not in this build (v1 ships the Claude Code host; codex/opencode/all arrive later)`);
    return EXIT_USAGE;
  }
  const formFlag = flagString(ctx.args, "hook-form") ?? "auto";
  if (formFlag !== "auto" && formFlag !== "exec" && formFlag !== "shell") {
    ctx.out.error(`--hook-form must be auto, exec or shell (got ${formFlag})`);
    return EXIT_USAGE;
  }
  const userScope = flagBoolean(ctx.args, "user");
  const withEmbeddings = flagBoolean(ctx.args, "with-embeddings");
  const warnings: string[] = [];

  const hookScript = flagString(ctx.args, "hook-script") ?? ctx.seams.hookScript ?? resolveHookScript();
  if (!existsSync(hookScript)) {
    ctx.out.error(`hook script not found: ${hookScript}`);
    ctx.out.note("hint: run `npm run build` in the harness-memory package (dist/hook.js is the registered launcher), or pass --hook-script <path>");
    return EXIT_CODES.error;
  }
  const siblings = siblingScripts(hookScript);
  for (const [name, file] of Object.entries(siblings)) {
    if (!existsSync(file)) warnings.push(`${name} bundle missing next to the hook script: ${file}`);
  }

  // 1 directories + config
  for (const dir of stateDirectories(ctx.paths)) mkdirSync(dir, { recursive: true });
  const embeddings = { requested: withEmbeddings, installed: false, output: null as string | null };
  let configPatch: Record<string, unknown> | null = null;
  if (withEmbeddings) {
    const runNpm = ctx.seams.runNpm ?? defaultRunNpm;
    const cwd = ctx.packageRoot ?? ctx.paths.root;
    ctx.out.line(`installing @xenova/transformers in ${cwd} …`);
    const npm = runNpm(["install", "@xenova/transformers"], cwd);
    embeddings.installed = npm.ok;
    embeddings.output = npm.output.length === 0 ? null : npm.output.slice(-2000);
    if (npm.ok) configPatch = { embeddings: { enabled: true } };
    else warnings.push(`npm install @xenova/transformers failed; embeddings stay disabled (${npm.output.split("\n").slice(-1)[0] ?? "no output"})`);
  }
  const configFile = ensureConfigFile(ctx.paths, configPatch);
  const config = loadConfig(ctx.paths.config);

  // 2 database + snapshot
  const store = createCliStore({ paths: ctx.paths, config, clock: ctx.clock, stderr: ctx.stderr });
  const database = await migrateForInstall(store, ctx.version);
  const snapshotFacts = readSnapshotFacts(ctx.paths, ctx.nowMs());

  // 3 hooks
  const claudeVersion = (ctx.seams.detectClaudeVersion ?? detectClaudeVersion)();
  const form = chooseHookForm(claudeVersion, formFlag);
  const gitBash = (ctx.seams.findGitBash ?? (() => findGitBash(ctx.env, ctx.platform)))();
  const shell: HookShell | null = form === "shell" && ctx.platform === "win32" ? (gitBash === null ? "powershell" : "bash") : null;
  const spec: HookCommandSpec = { execPath: ctx.execPath, hookScript, form, shell };
  const settingsFile = userScope ? userSettingsFile(ctx.env) : projectSettingsFile(ctx.paths.root);
  const current = readSettingsFile(settingsFile);
  const merged = mergeHarnessHooks(current.settings, spec);
  writeSettingsFile(settingsFile, merged.settings);
  if (ctx.platform === "win32" && gitBash === null) warnings.push("Git Bash not found: Claude Code will use its PowerShell tool; pitfalls learned under bash still fire (canonical tool `bash`)");

  // 4 git exclude
  const gitExclude = userScope ? null : ensureGitExclude(ctx.paths.root);

  // 5 manifest
  const files: ManifestFile[] = [
    { path: settingsFile, role: "settings", sha256: sha256File(settingsFile), created: !current.existed },
    { path: ctx.paths.config, role: "config", sha256: sha256File(ctx.paths.config), created: configFile.created },
    { path: hookScript, role: "hook_script", sha256: sha256File(hookScript), created: false },
    { path: siblings.worker, role: "worker_script", sha256: sha256File(siblings.worker), created: false },
  ];
  if (gitExclude !== null) files.push({ path: gitExclude.path, role: "git_exclude", sha256: sha256File(gitExclude.path), created: false });
  const manifest: InstallManifest = {
    schema: "install-manifest.v1",
    version: ctx.version,
    installed_at: ctx.clock(),
    host: "claude",
    scope: userScope ? "user" : "project",
    root: ctx.paths.root,
    node: ctx.execPath,
    hook_script: hookScript,
    hook_form: form,
    shell,
    settings_file: settingsFile,
    events: HOOK_REGISTRATIONS.map((registration) => registration.claudeEvent),
    claude_version: claudeVersion,
    git_exclude: gitExclude === null ? null : { path: gitExclude.path, line: GIT_EXCLUDE_LINE, added: gitExclude.added },
    files,
  };
  writeManifest(ctx.paths.manifest, manifest);

  // 6 probe
  let probe: InstallReport["probe"] = { provider: null, result: null, skipped: true, guidance: null };
  if (!flagBoolean(ctx.args, "skip-probe")) {
    const provider = ctx.seams.provider !== undefined ? ctx.seams.provider : selectProvider(config, { paths: ctx.paths });
    try {
      probe = { ...(await probeForInstall(store, ctx.paths, config, ctx.clock(), provider)), skipped: false };
    } catch (error) {
      probe = { provider: provider?.name ?? null, result: null, skipped: false, guidance: null };
      warnings.push(`provider probe failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // 7 self-test
  let selfTest: InstallReport["self_test"];
  if (flagBoolean(ctx.args, "skip-self-test")) {
    selfTest = { skipped: true, reason: "--skip-self-test" };
  } else {
    const runner = ctx.seams.selfTest ?? runHookSelfTest;
    const outcome = runner({ paths: ctx.paths, hookScript, execPath: ctx.execPath, event: "session-start", env: ctx.env });
    selfTest = outcome ?? { skipped: true, reason: "no self-test runner" };
  }

  const report: InstallReport = {
    ok: warnings.every((warning) => !warning.startsWith("npm install")) && ("skipped" in selfTest || selfTest.ok),
    version: ctx.version,
    root: ctx.paths.root,
    scope: userScope ? "user" : "project",
    settings_file: settingsFile,
    hook_script: hookScript,
    hook_form: form,
    shell,
    node: ctx.execPath,
    claude_version: claudeVersion,
    events: manifest.events,
    replaced_entries: merged.replaced,
    config: { path: ctx.paths.config, created: configFile.created, embeddings_enabled: config.embeddings.enabled },
    embeddings,
    database: { path: ctx.paths.db, user_version: database.userVersion, migrated_from: database.migratedFrom, backup: database.backup, snapshot_built: database.snapshotBuilt },
    snapshot_counts:
      snapshotFacts.counts === null ? null : { active: snapshotFacts.counts.active, candidates: snapshotFacts.counts.candidates, unreachable: snapshotFacts.counts.unreachable },
    git_exclude: gitExclude,
    manifest: ctx.paths.manifest,
    probe,
    self_test: selfTest,
    warnings,
  };
  ctx.out.result(report, renderInstallReport);
  return report.ok ? EXIT_CODES.ok : EXIT_CODES.error;
}
