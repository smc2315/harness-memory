/**
 * `hm install --host claude [--user] [--with-embeddings]` (spec §8.7, §11; m0-facts #1, #3, #10, #15–#17).
 *
 *  1 `.harness-memory/` directories, its `.gitignore` (`*`: ledgers and the database are never committed)
 *    + `config.json` defaults (`--with-embeddings` → npm install in the package root + enabled)
 *  2 migrate (backup first) + `meta.installed_version` + snapshot build, under the store's lock
 *  3 hooks into `.claude/settings.local.json` (`--user`: `~/.claude/settings.json`), exec form
 *    `{command: <node>, args: [<dist/hook.js>, <event>], timeout}` per §8.2, idempotent merge
 *  4 `.claude/settings.local.json` in `.git/info/exclude` (a worktree's / submodule's pointer is followed)
 *  5 `install-manifest.json` (files touched + sha256, node path, version)
 *  6 provider probe (cached in meta) → `not_logged_in` guidance when needed
 *  7 self-test: `node dist/hook.js session-start` with synthetic stdin → one hooks.log line
 */

import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { DEFAULT_CONFIG, loadConfig, mergeConfig, type HarnessConfig } from "../../core/config";
import { EXIT_CODES } from "../../core/errors";
import { stateDirectories, type HarnessPaths } from "../../core/paths";
import type { ProbeResult } from "../../core/vocabulary";
import { META_KEYS, MetaRepository } from "../../db/repositories/meta";
import type { Store } from "../../db/store";
import { normalizeProbe, selectProvider, writeProbeCache, type ExtractionProvider } from "../../dream/extract/providers";
import type { CommandContext, NpmRunResult } from "../context";
import { flagBoolean, flagString, type OptionSpecs } from "../lib/args";
import { AUTO_MEMORY_DEFAULT_TYPES, listAutoMemoryNotes, locateAutoMemory, selectAutoMemoryNotes } from "../lib/auto-memory";
import { probeGuidance, readSnapshotFacts } from "../lib/diagnostics";
import { sha256File, writeManifest, type InstallManifest, type ManifestFile } from "../lib/manifest";
import { formatMs, pluralize } from "../lib/output";
import {
  ensureStateGitignore,
  findExecutable,
  GIT_EXCLUDE_LINE,
  gitDirectory,
  gitExcludeFile,
  hasGitExcludeLine,
  projectSettingsFile,
  resolveHookScript,
  siblingScripts,
  userSettingsFile,
} from "../lib/paths";
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
  /** `.harness-memory/.gitignore` (`*`), written for every scope and checkout layout; `created` is false when a file was already there. */
  git_ignore: { path: string; created: boolean };
  /** Claude Code's auto memory directory of this project and its feedback-note count (`hm import --from auto-memory`); null when absent. */
  auto_memory: { dir: string; notes: number } | null;
  manifest: string;
  probe: { provider: string | null; result: ProbeResult | null; skipped: boolean; guidance: string | null; detail?: string | null };
  self_test: SelfTestResult | { skipped: true; reason: string };
  warnings: string[];
}

export interface NpmSpawnPlan {
  file: string;
  args: string[];
  shell: boolean;
}

/** The `npm-cli.js` bundled with the node binary at `execPath` (`<dir>/node_modules/npm/…` on Windows, `<dir>/../lib/node_modules/npm/…` elsewhere), or null. */
export function bundledNpmCli(execPath: string = process.execPath): string | null {
  const dir = dirname(execPath);
  for (const candidate of [join(dir, "node_modules", "npm", "bin", "npm-cli.js"), resolve(dir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js")]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * How `npm <args>` is spawned: the npm bundled with the running node, through node itself (absolute paths,
 * no shell); otherwise PATH's `npm`. On Windows that is the `npm.cmd` shim, which needs cmd.exe and gets its
 * absolute path as one quoted command string: a bare `npm.cmd` would be looked up in the cwd before PATH, and
 * an args array next to `shell: true` is deprecated (DEP0190). Null when no npm can be found.
 */
export function planNpmSpawn(args: readonly string[], options: { execPath?: string; platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv } = {}): NpmSpawnPlan | null {
  const execPath = options.execPath ?? process.execPath;
  const bundled = bundledNpmCli(execPath);
  if (bundled !== null) return { file: execPath, args: [bundled, ...args], shell: false };
  if ((options.platform ?? process.platform) !== "win32") return { file: "npm", args: [...args], shell: false };
  const shim = findExecutable(["npm.cmd"], options.env ?? process.env);
  if (shim === null) return null;
  return { file: `"${shim}" ${args.join(" ")}`, args: [], shell: true };
}

function defaultRunNpm(args: readonly string[], cwd: string): NpmRunResult {
  const plan = planNpmSpawn(args);
  if (plan === null) return { ok: false, output: "npm not found: no npm-cli.js next to the running node and no npm.cmd on PATH" };
  try {
    const run = spawnSync(plan.file, plan.args, { cwd, encoding: "utf8", shell: plan.shell, windowsHide: true, timeout: 10 * 60_000 });
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

/**
 * Adds `.claude/settings.local.json` to git's exclude file (m0-facts #17): `.git/info/exclude`, or the
 * repository's for a worktree / submodule checkout. Null when the project has no `.git`, or its pointer
 * file cannot be resolved (the caller warns).
 */
export function ensureGitExclude(root: string): { path: string; added: boolean; already: boolean } | null {
  const file = gitExcludeFile(root);
  if (file === null) return null;
  let content = "";
  try {
    content = readFileSync(file, "utf8");
  } catch {
    content = "";
  }
  if (hasGitExcludeLine(content)) return { path: file, added: false, already: true };
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
): Promise<{ provider: string | null; result: ProbeResult | null; detail: string | null; guidance: string | null }> {
  if (provider === null) return { provider: null, result: null, detail: null, guidance: probeGuidance("missing") };
  if (provider.name === "replay") return { provider: provider.name, result: "ok", detail: null, guidance: null };
  const outcome = normalizeProbe(await provider.probe({ config, paths, now }));
  await store.withWriteLock("install:probe", CLI_LOCK_WAIT_MS, (db) => {
    writeProbeCache(db, { at: now, result: outcome.result, detail: outcome.detail });
    return { id: null, kind: "probe", noop: true, wrote: true };
  });
  return { provider: provider.name, result: outcome.result, detail: outcome.detail, guidance: probeGuidance(outcome.result) };
}

/**
 * The project's Claude Code auto memory directory and how many of its notes are `feedback` (what `hm import --from
 * auto-memory` would take), for the install hint. Read-only; null when the directory is absent or unreadable.
 */
export function detectAutoMemory(ctx: Pick<CommandContext, "paths" | "env" | "platform">): InstallReport["auto_memory"] {
  try {
    const lookup = locateAutoMemory(ctx.paths.root, { env: ctx.env, platform: ctx.platform });
    if (lookup.location === null) return null;
    const notes = selectAutoMemoryNotes(listAutoMemoryNotes(lookup.location.dir).notes, AUTO_MEMORY_DEFAULT_TYPES).selected.length;
    return { dir: lookup.location.dir, notes };
  } catch {
    return null;
  }
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
  lines.push(`  git         ${report.git_ignore.path} ${report.git_ignore.created ? "written" : "kept"} (nothing under .harness-memory/ is ever committed)`);
  if (report.probe.skipped) lines.push("  provider    probe skipped");
  else if (report.probe.provider === null) lines.push(`  provider    none found — ${report.probe.guidance ?? ""}`.trimEnd());
  else lines.push(`  provider    ${report.probe.provider} — probe ${report.probe.result ?? "?"}${report.probe.detail ? ` (${report.probe.detail})` : ""}${report.probe.guidance === null ? "" : `; ${report.probe.guidance}`}`);
  if ("skipped" in report.self_test) lines.push(`  self-test   skipped (${report.self_test.reason})`);
  else if (report.self_test.ok) lines.push(`  self-test   ${report.self_test.event} ok (${formatMs(report.self_test.durationMs)}, hook status ${report.self_test.logEntry?.status ?? "?"})`);
  else lines.push(`  self-test   FAILED: ${report.self_test.error ?? "unknown error"}`);
  lines.push(`  manifest    ${report.manifest}`);
  for (const warning of report.warnings) lines.push(`  warning     ${warning}`);
  const importable = report.ok ? ["CLAUDE.md", "AGENTS.md"].find((name) => existsSync(join(report.root, name))) : undefined;
  if (importable !== undefined) {
    lines.push(`  import      \`hm import --from ${importable}\` turns its bullets into human memories (a confirmation table lets you pick)`);
  }
  if (report.ok && report.auto_memory !== null && report.auto_memory.notes > 0) {
    lines.push(`  import      \`hm import --from auto-memory\` turns Claude Code's ${pluralize(report.auto_memory.notes, "auto-memory feedback note")} into human memories (${report.auto_memory.dir})`);
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

  // 1 directories (+ .gitignore) + config
  for (const dir of stateDirectories(ctx.paths)) mkdirSync(dir, { recursive: true });
  const gitIgnore = ensureStateGitignore(ctx.paths);
  const embeddings = { requested: withEmbeddings, installed: false, output: null as string | null };
  let configPatch: Record<string, unknown> | null = null;
  if (withEmbeddings) {
    if (ctx.packageRoot === null) {
      // Never npm-install in the project directory: that runs the project's lifecycle scripts and .npmrc,
      // and the package that must receive the dependency is unknown anyway (plan §4 B3: the package root).
      warnings.push("npm install @xenova/transformers skipped: the harness-memory package directory was not found (run it inside the package yourself); embeddings stay disabled");
    } else {
      const runNpm = ctx.seams.runNpm ?? defaultRunNpm;
      const cwd = ctx.packageRoot;
      ctx.out.line(`installing @xenova/transformers in ${cwd} …`);
      const npm = runNpm(["install", "@xenova/transformers"], cwd);
      embeddings.installed = npm.ok;
      embeddings.output = npm.output.length === 0 ? null : npm.output.slice(-2000);
      if (npm.ok) configPatch = { embeddings: { enabled: true } };
      else warnings.push(`npm install @xenova/transformers failed; embeddings stay disabled (${npm.output.split("\n").slice(-1)[0] ?? "no output"})`);
    }
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

  // 4 git exclude (project scope; a worktree's / submodule's .git pointer is followed to the repository's info/exclude)
  const gitExclude = userScope ? null : ensureGitExclude(ctx.paths.root);
  if (!userScope && gitExclude === null && gitDirectory(ctx.paths.root) !== null) {
    warnings.push(`${GIT_EXCLUDE_LINE} was not added to git's exclude file (.git is a pointer whose gitdir could not be resolved); add the line to .gitignore so the hooks' local paths are never committed`);
  }

  // 5 manifest
  const files: ManifestFile[] = [
    { path: settingsFile, role: "settings", sha256: sha256File(settingsFile), created: !current.existed },
    { path: ctx.paths.config, role: "config", sha256: sha256File(ctx.paths.config), created: configFile.created },
    { path: gitIgnore.path, role: "git_ignore", sha256: sha256File(gitIgnore.path), created: gitIgnore.created },
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
    git_ignore: gitIgnore,
    auto_memory: detectAutoMemory(ctx),
    manifest: ctx.paths.manifest,
    probe,
    self_test: selfTest,
    warnings,
  };
  ctx.out.result(report, renderInstallReport);
  return report.ok ? EXIT_CODES.ok : EXIT_CODES.error;
}
