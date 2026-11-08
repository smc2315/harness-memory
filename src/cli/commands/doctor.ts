/**
 * `hm doctor [--fix] [--host-debug <path>] [--self-test]` (spec §9.4 observability list, §8.7):
 * manifest vs registered hooks, node path, last call per event and p95 from hooks.log, queue depth,
 * last extraction run, probe result, lock state (+ stale owner), quick_check, user_version,
 * db_generation vs snapshot, unreachable memories, Git Bash on Windows, `not_logged_in` guidance,
 * the worker's `waiting=<reason>`, hook-side touch/pid files, the git footprint (`.harness-memory/.gitignore`
 * present and nothing under the directory tracked, the settings file excluded); `--host-debug` greps the
 * host's debug log for `finished with status N`. `--fix` rewrites the node/hook-script path in the settings
 * file, writes a missing `.harness-memory/.gitignore` and rebuilds the snapshot (migrating first when needed).
 */

import { existsSync, readFileSync } from "node:fs";

import { EXIT_CODES } from "../../core/errors";
import { HARNESS_DIR_NAME, TARGET_USER_VERSION, unixSocketPathTooLong } from "../../core/paths";
import type { CommandContext } from "../context";
import { flagBoolean, flagString, type OptionSpecs } from "../lib/args";
import {
  countQueueFiles,
  probeGuidance,
  readDbFacts,
  readGitTrackedFiles,
  readLockFacts,
  readSnapshotFacts,
  readWorkerLogFacts,
  type DbFacts,
  type LockFacts,
  type SnapshotFacts,
  type WorkerLogFacts,
} from "../lib/diagnostics";
import { readHookLogTail, summarizeHookLog, type HookLogSummary } from "../lib/hooks-log";
import { readManifest, sha256File, writeManifest, type InstallManifest } from "../lib/manifest";
import { formatMs, formatRelative, pluralize } from "../lib/output";
import { ensureStateGitignore, GIT_EXCLUDE_LINE, gitDirectory, hasGitExcludeLine, projectSettingsFile, resolveHookScript, siblingScripts, stateGitignoreFile } from "../lib/paths";
import { runHookSelfTest, type SelfTestResult } from "../lib/selftest";
import { findGitBash, HOOK_REGISTRATIONS, listHarnessHooks, mergeHarnessHooks, readSettingsFile, writeSettingsFile, type HarnessHookEntry, type HookCommandSpec } from "../lib/settings";
import { CLI_LOCK_WAIT_MS, createCliStore } from "../lib/store";

export const doctorOptions: OptionSpecs = {
  fix: { type: "boolean", description: "Rewrite the node/hook-script path in the settings file and rebuild the snapshot" },
  "host-debug": { type: "string", description: "Claude Code debug log to scan for `finished with status N` lines", placeholder: "<path>" },
  "self-test": { type: "boolean", description: "Run the registered session-start hook once and check hooks.log" },
  "hook-script": { type: "string", description: "dist/hook.js to use for --fix (default: this package's)", placeholder: "<path>" },
};

export type CheckStatus = "ok" | "warn" | "fail" | "info";

export interface DoctorCheck {
  id: string;
  status: CheckStatus;
  summary: string;
  detail?: string[];
}

export interface DoctorReport {
  root: string;
  ok: boolean;
  checks: DoctorCheck[];
  fixes: string[];
  self_test: SelfTestResult | null;
  summary: { ok: number; warn: number; fail: number; info: number };
}

export const P95_BUDGET_MS = 90;
export const QUEUE_WARN_DEPTH = 20;

interface SettingsFacts {
  file: string | null;
  error: string | null;
  entries: HarnessHookEntry[];
}

function readSettingsFacts(manifest: InstallManifest | null, root: string): SettingsFacts {
  const file = manifest?.settings_file ?? projectSettingsFile(root);
  try {
    const { settings } = readSettingsFile(file);
    return { file, error: null, entries: listHarnessHooks(settings) };
  } catch (error) {
    return { file, error: error instanceof Error ? error.message : String(error), entries: [] };
  }
}

interface StateIgnoreFacts {
  /** `.harness-memory/` exists (otherwise there is nothing to ignore yet). */
  dirExists: boolean;
  file: string;
  exists: boolean;
  /** Paths under `.harness-memory/` that git tracks; null when git was not consulted (absent, or no repository). */
  tracked: string[] | null;
}

function readStateIgnoreFacts(ctx: CommandContext): StateIgnoreFacts {
  const file = stateGitignoreFile(ctx.paths);
  const dirExists = existsSync(ctx.paths.dir);
  const trackedFiles = ctx.seams.gitTrackedFiles ?? ((root: string, pathspec: string) => readGitTrackedFiles(root, pathspec, ctx.env));
  return { dirExists, file, exists: existsSync(file), tracked: dirExists ? trackedFiles(ctx.paths.root, HARNESS_DIR_NAME) : null };
}

function excludeFileHasLine(file: string): boolean {
  try {
    return hasGitExcludeLine(readFileSync(file, "utf8"));
  } catch {
    return false;
  }
}

interface Facts {
  manifest: InstallManifest | null;
  settings: SettingsFacts;
  db: DbFacts;
  snapshot: SnapshotFacts;
  hookLog: HookLogSummary;
  worker: WorkerLogFacts;
  locks: LockFacts;
  queueFiles: number;
  stateIgnore: StateIgnoreFacts;
}

async function collectFacts(ctx: CommandContext): Promise<Facts> {
  const manifest = readManifest(ctx.paths.manifest);
  const store = createCliStore({ paths: ctx.paths, config: ctx.config, clock: ctx.clock, stderr: ctx.stderr });
  const nowMs = ctx.nowMs();
  return {
    manifest,
    settings: readSettingsFacts(manifest, ctx.paths.root),
    db: await readDbFacts(store, ctx.paths, ctx.config, ctx.clock()),
    snapshot: readSnapshotFacts(ctx.paths, nowMs),
    hookLog: summarizeHookLog(readHookLogTail(ctx.paths.hooksLog)),
    worker: readWorkerLogFacts(ctx.paths),
    locks: readLockFacts(ctx.paths, ctx.clock, nowMs),
    queueFiles: countQueueFiles(ctx.paths),
    stateIgnore: readStateIgnoreFacts(ctx),
  };
}

/** `settings` entries that match the manifest exactly (same node and hook script) per registered event. */
function compareRegistration(manifest: InstallManifest, entries: readonly HarnessHookEntry[]): { missing: string[]; mismatched: string[]; duplicates: string[] } {
  const missing: string[] = [];
  const mismatched: string[] = [];
  const duplicates: string[] = [];
  for (const event of manifest.events) {
    const matches = entries.filter((entry) => entry.claudeEvent === event);
    if (matches.length === 0) {
      missing.push(event);
      continue;
    }
    if (matches.length > 1) duplicates.push(event);
    const exact = matches.some((entry) => entry.script === manifest.hook_script && entry.node === manifest.node);
    if (!exact) mismatched.push(event);
  }
  return { missing, mismatched, duplicates };
}

export function buildChecks(ctx: CommandContext, facts: Facts, hostDebug: string | null): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  const nowMs = ctx.nowMs();
  const { manifest, settings, db, snapshot, hookLog, worker, locks } = facts;

  // install
  if (manifest === null) {
    checks.push({ id: "install.manifest", status: "fail", summary: `no install manifest at ${ctx.paths.manifest}; run \`hm install --host claude\`` });
  } else {
    checks.push({ id: "install.manifest", status: "ok", summary: `harness-memory ${manifest.version} installed for ${manifest.host} (${manifest.scope}) ${formatRelative(manifest.installed_at, nowMs)}` });
  }

  if (settings.error !== null) {
    checks.push({ id: "install.settings", status: "fail", summary: `settings file unreadable: ${settings.error}` });
  } else if (manifest === null) {
    checks.push({
      id: "install.settings",
      status: settings.entries.length === 0 ? "info" : "warn",
      summary: settings.entries.length === 0 ? `no harness-memory hooks in ${settings.file ?? "?"}` : `${pluralize(settings.entries.length, "harness-memory hook entry", "harness-memory hook entries")} in ${settings.file ?? "?"} without a manifest`,
    });
  } else {
    const diff = compareRegistration(manifest, settings.entries);
    if (diff.missing.length > 0) {
      checks.push({ id: "install.settings", status: "fail", summary: `${manifest.settings_file} lacks ${diff.missing.length} of ${manifest.events.length} registered events`, detail: diff.missing.map((event) => `missing ${event}`) });
    } else if (diff.mismatched.length > 0) {
      checks.push({ id: "install.settings", status: "warn", summary: `settings entries point at a different node/hook script than the manifest (${diff.mismatched.length} events); \`hm doctor --fix\` rewrites them`, detail: diff.mismatched });
    } else {
      checks.push({ id: "install.settings", status: diff.duplicates.length > 0 ? "warn" : "ok", summary: `${manifest.events.length} events registered in ${manifest.settings_file} (${manifest.hook_form} form)${diff.duplicates.length > 0 ? `; duplicate entries for ${diff.duplicates.join(", ")}` : ""}` });
    }
    if (!existsSync(manifest.node)) {
      checks.push({ id: "install.node", status: "fail", summary: `node binary recorded by install is gone: ${manifest.node}; \`hm doctor --fix\` rewrites the hooks to ${ctx.execPath}` });
    } else {
      checks.push({ id: "install.node", status: "ok", summary: `node ${manifest.node}${manifest.node === ctx.execPath ? "" : ` (this CLI runs on ${ctx.execPath})`}` });
    }
    if (!existsSync(manifest.hook_script)) {
      checks.push({ id: "install.hook_script", status: "fail", summary: `hook script missing: ${manifest.hook_script} (package moved or not built); \`hm doctor --fix\` re-points the hooks` });
    } else {
      const siblings = siblingScripts(manifest.hook_script);
      const missing = Object.entries(siblings).filter(([, file]) => !existsSync(file)).map(([name]) => name);
      checks.push({ id: "install.hook_script", status: missing.length === 0 ? "ok" : "warn", summary: missing.length === 0 ? `hook script ${manifest.hook_script} with worker/hook-bundle/embed-helper bundles` : `hook script present but ${missing.join(", ")} bundle(s) missing next to it` });
    }
  }

  // git footprint: the settings file (absolute local paths) excluded, the state directory (prompts, tool output, database) never tracked
  if (manifest !== null && manifest.scope === "project") {
    if (manifest.git_exclude === null) {
      if (gitDirectory(ctx.paths.root) !== null) {
        checks.push({ id: "install.git_exclude", status: "warn", summary: `${GIT_EXCLUDE_LINE} is not excluded from git (install could not resolve the .git pointer); add the line to .gitignore so the hooks' local paths are never committed` });
      }
    } else if (!excludeFileHasLine(manifest.git_exclude.path)) {
      checks.push({ id: "install.git_exclude", status: "warn", summary: `${GIT_EXCLUDE_LINE} is missing from ${manifest.git_exclude.path}; re-run \`hm install --host claude\`` });
    } else {
      checks.push({ id: "install.git_exclude", status: "ok", summary: `${GIT_EXCLUDE_LINE} excluded via ${manifest.git_exclude.path}` });
    }
  }
  const ignore = facts.stateIgnore;
  if (ignore.dirExists) {
    if (ignore.tracked !== null && ignore.tracked.length > 0) {
      checks.push({
        id: "install.state_ignore",
        status: "warn",
        summary: `${pluralize(ignore.tracked.length, "file is", "files are")} tracked by git under ${HARNESS_DIR_NAME}/ (ledgers and memory.sqlite hold prompts and tool output): run \`git rm -r --cached ${HARNESS_DIR_NAME}\` and commit`,
        detail: ignore.tracked.slice(0, 10),
      });
    } else if (!ignore.exists) {
      checks.push({ id: "install.state_ignore", status: "warn", summary: `${ignore.file} is missing, so \`git add -A\` would commit the state directory; \`hm doctor --fix\` writes it` });
    } else {
      checks.push({ id: "install.state_ignore", status: "ok", summary: `${HARNESS_DIR_NAME}/ ignored by git (${ignore.file})${ignore.tracked === null ? "" : ", nothing tracked"}` });
    }
  }

  // hooks log
  if (hookLog.total === 0) {
    checks.push({ id: "hooks.calls", status: "warn", summary: "no hook calls logged yet (open Claude Code in this project, or run `hm doctor --self-test`)" });
  } else {
    const registered = (manifest?.events ?? HOOK_REGISTRATIONS.map((registration) => registration.claudeEvent)).length;
    const detail: string[] = [];
    for (const registration of HOOK_REGISTRATIONS) {
      const last = hookLog.lastByEvent[registration.event];
      detail.push(last === undefined ? `${registration.event.padEnd(18)} never` : `${registration.event.padEnd(18)} ${formatRelative(last.ts, nowMs).padEnd(12)} ${last.status}${last.tool === null ? "" : ` tool=${last.tool}`}`);
    }
    const neverCalled = HOOK_REGISTRATIONS.filter((registration) => hookLog.lastByEvent[registration.event] === undefined).length;
    checks.push({
      id: "hooks.calls",
      status: hookLog.errors > 0 ? "warn" : "ok",
      summary: `${pluralize(hookLog.total, "hook call")} logged, ${registered - neverCalled}/${registered} events seen${hookLog.errors > 0 ? `, ${pluralize(hookLog.errors, "error")}` : ""}`,
      detail,
    });
  }
  if (hookLog.p95PreTool === null) {
    checks.push({ id: "hooks.p95", status: "info", summary: hookLog.p95All === null ? "no latency data yet" : `p95 ${formatMs(hookLog.p95All)} over all events (no pre-tool calls yet)` });
  } else {
    checks.push({ id: "hooks.p95", status: hookLog.p95PreTool > P95_BUDGET_MS ? "warn" : "ok", summary: `pre-tool p95 ${formatMs(hookLog.p95PreTool)} (budget ${P95_BUDGET_MS}ms)` });
  }
  if (snapshot.reindexRequestedAgeMs !== null) {
    const stale = snapshot.state !== "fresh" && snapshot.reindexRequestedAgeMs > 60_000;
    checks.push({
      id: "hooks.reindex_requested",
      status: stale ? "warn" : "info",
      summary: stale
        ? `a hook requested a reindex ${formatRelative(new Date(nowMs - snapshot.reindexRequestedAgeMs).toISOString(), nowMs)} but the snapshot is still ${snapshot.state}: check that \`node dist/worker.js <root> reindex\` runs (logs/worker.log)`
        : `reindex requested ${formatRelative(new Date(nowMs - snapshot.reindexRequestedAgeMs).toISOString(), nowMs)}`,
    });
  }

  // database
  if (!db.exists) {
    checks.push({ id: "db.file", status: "fail", summary: `no database at ${ctx.paths.db}; run \`hm install --host claude\`` });
  } else if (db.error !== null) {
    checks.push({ id: "db.file", status: "fail", summary: `database unreadable: ${db.error}` });
  } else if (db.newerThanCode) {
    checks.push({ id: "db.file", status: "fail", summary: `database user_version ${String(db.userVersion)} is newer than this build (${TARGET_USER_VERSION}); upgrade harness-memory` });
  } else if (db.quickCheck !== "ok") {
    checks.push({ id: "db.file", status: "fail", summary: `quick_check: ${db.quickCheck ?? "no result"}` });
  } else if (db.migrationNeeded) {
    checks.push({ id: "db.file", status: "warn", summary: `database at v${String(db.userVersion)} (target v${TARGET_USER_VERSION}); run \`hm db:migrate\` or \`hm doctor --fix\`` });
  } else {
    checks.push({ id: "db.file", status: "ok", summary: `memory.sqlite v${String(db.userVersion)}, db_generation ${String(db.generation)}, quick_check ok${db.installedVersion === null ? "" : `, installed_version ${db.installedVersion}`}` });
  }

  // snapshot
  switch (snapshot.state) {
    case "missing":
      checks.push({ id: "snapshot.active", status: db.exists ? "warn" : "info", summary: `no snapshot/active.v1.json${db.exists ? "; run `hm snapshot:rebuild` or `hm doctor --fix`" : ""}` });
      break;
    case "corrupt":
      checks.push({ id: "snapshot.active", status: "fail", summary: "snapshot/active.v1.json does not parse as an active.v1 snapshot; run `hm snapshot:rebuild`" });
      break;
    case "stale":
      checks.push({ id: "snapshot.active", status: "warn", summary: `snapshot is stale (built from an older memory.sqlite; snapshot gen ${String(snapshot.generation)}, db gen ${String(db.generation)}); hooks requested a reindex, or run \`hm snapshot:rebuild\`` });
      break;
    case "fresh":
      checks.push({
        id: "snapshot.active",
        status: db.generation !== null && snapshot.generation !== db.generation ? "warn" : "ok",
        summary: `snapshot fresh (gen ${String(snapshot.generation)}${db.generation !== null && snapshot.generation !== db.generation ? ` ≠ db gen ${String(db.generation)}` : ""}, built ${formatRelative(snapshot.builtAt, nowMs)}${snapshot.lexicalExists ? "" : ", lexical.v1.json missing"})`,
      });
      break;
  }
  if (db.unreachable.length > 0) {
    checks.push({
      id: "snapshot.unreachable",
      status: "warn",
      summary: `${pluralize(db.unreachable.length, "active memory", "active memories")} cannot fire from any hook and are excluded from the snapshot (fix the signature/triggers via proposals or memory:enforce)`,
      detail: db.unreachable.map((entry) => `${entry.id}  ${entry.reason}: ${entry.detail}`),
    });
  } else if (db.counts !== null) {
    checks.push({ id: "snapshot.unreachable", status: "ok", summary: "every active memory is reachable from a registered hook" });
  }

  // queue + extraction
  const episodes = db.episodes;
  const queueSummary = episodes === null ? `${facts.queueFiles} queue files` : `${facts.queueFiles} queue files; episodes queued ${episodes.queued}, leased ${episodes.leased}, failed ${episodes.failed}, dead ${episodes.dead}, extracted ${episodes.extracted}, skipped ${episodes.skipped}`;
  checks.push({ id: "queue.depth", status: facts.queueFiles > QUEUE_WARN_DEPTH || (episodes !== null && episodes.dead > 0) ? "warn" : "info", summary: queueSummary });
  if (db.lastRun === null) {
    checks.push({ id: "extraction.last_run", status: "info", summary: db.exists && !db.migrationNeeded ? "no extraction run yet" : "extraction runs unknown (database not readable at this schema)" });
  } else {
    const run = db.lastRun;
    checks.push({ id: "extraction.last_run", status: run.status === "ok" ? "ok" : "warn", summary: `last extraction ${formatRelative(run.finishedAt ?? run.startedAt, nowMs)} ${run.status} (${run.provider}${run.model === null ? "" : ` ${run.model}`}${run.error === null ? "" : `: ${run.error.slice(0, 120)}`})` });
  }
  if (db.probe === null) {
    checks.push({ id: "extraction.probe", status: "info", summary: db.exists && !db.migrationNeeded ? "provider not probed yet (the first worker run probes it; `hm install` probes too)" : "probe unknown" });
  } else {
    const guidance = probeGuidance(db.probe.result);
    checks.push({ id: "extraction.probe", status: db.probe.result === "ok" ? "ok" : "warn", summary: `probe ${db.probe.result} ${formatRelative(db.probe.at, nowMs)}${db.probe.detail ? ` (${db.probe.detail})` : ""}${guidance === null ? "" : ` — ${guidance}`}` });
  }
  if (worker.waiting !== null) {
    const guidance = probeGuidance(worker.waiting) ?? (worker.waiting === "daily_cap" ? "extraction.max_runs_per_day reached; episodes resume tomorrow" : null);
    checks.push({ id: "extraction.waiting", status: "warn", summary: `worker left episodes waiting (${worker.waiting}) at ${worker.lastLeaseAt ?? "?"}${guidance === null ? "" : ` — ${guidance}`}` });
  } else if (worker.lastEnd !== null) {
    checks.push({ id: "extraction.worker", status: worker.lastEnd.exit === 0 ? "ok" : "warn", summary: `last worker run: ${worker.lastEnd.command} exit ${String(worker.lastEnd.exit)} ${formatRelative(worker.lastEnd.at, nowMs)}${worker.lastError === null ? "" : ` (last error: ${worker.lastError.slice(0, 160)})`}` });
  } else {
    checks.push({ id: "extraction.worker", status: "info", summary: "no worker run logged yet" });
  }

  // locks
  for (const [name, inspection] of [
    ["locks.db", locks.db],
    ["locks.worker", locks.worker],
  ] as const) {
    if (inspection.state === "free") checks.push({ id: name, status: "ok", summary: "free" });
    else if (inspection.state === "held") checks.push({ id: name, status: "info", summary: `held by pid ${String(inspection.owner?.pid ?? "?")} (${inspection.owner?.purpose ?? "?"}) since ${inspection.owner?.started_at ?? "?"}` });
    else checks.push({ id: name, status: "warn", summary: `stale lock${inspection.owner === null ? "" : ` (owner pid ${String(inspection.owner.pid)} ${inspection.owner.purpose}, heartbeat ${inspection.owner.heartbeat_at})`}: ${inspection.reason ?? ""}; the next writer takes it over` });
  }
  if (locks.workerPid !== null) {
    checks.push({ id: "locks.worker_pid", status: locks.workerPid.alive ? "info" : "warn", summary: locks.workerPid.alive ? `worker running (pid ${String(locks.workerPid.pid)})` : `stale worker.pid (pid ${String(locks.workerPid.pid)} is gone)` });
  }

  // embeddings
  if (ctx.config.embeddings.enabled) {
    const helper = locks.embedHelperPid;
    const socket = ctx.paths.embedHelperSocket;
    const socketTooLong = process.platform !== "win32" && unixSocketPathTooLong(socket);
    const parts = [
      helper === null ? "helper not running" : helper.alive ? `helper running (pid ${String(helper.pid)})` : `stale embed-helper.pid (pid ${String(helper.pid)})`,
      locks.embedSpawnAgeMs === null ? "never spawned by a hook" : `last spawn request ${formatRelative(new Date(nowMs - locks.embedSpawnAgeMs).toISOString(), nowMs)}`,
      snapshot.denseExists ? "dense.v1.bin present" : "dense.v1.bin absent (no embeddings yet; `hm dream` backfills)",
      `rendezvous ${socket}${socketTooLong ? " (over the unix socket path limit: the helper refuses to start; set XDG_RUNTIME_DIR or TMPDIR to a shorter directory)" : ""}`,
    ];
    checks.push({ id: "embeddings", status: (helper !== null && !helper.alive) || socketTooLong ? "warn" : "info", summary: parts.join("; ") });
  } else {
    checks.push({ id: "embeddings", status: "info", summary: "embeddings off (install with --with-embeddings or set embeddings.enabled)" });
  }

  // environment
  const major = Number(process.versions.node.split(".")[0]);
  checks.push({ id: "env.node", status: major >= 20 ? "ok" : "fail", summary: `node ${process.versions.node}${major >= 20 ? "" : " (harness-memory needs ≥ 20)"}` });
  if (ctx.platform === "win32") {
    const gitBash = (ctx.seams.findGitBash ?? (() => findGitBash(ctx.env, ctx.platform)))();
    checks.push({ id: "env.git_bash", status: gitBash === null ? "warn" : "ok", summary: gitBash === null ? "Git Bash not found: Claude Code uses its PowerShell tool (memories still match as canonical `bash`)" : `Git Bash ${gitBash}` });
  }

  // host debug log
  if (hostDebug !== null) {
    try {
      const text = readFileSync(hostDebug, "utf8");
      const statuses: Record<string, number> = {};
      let hookLines = 0;
      for (const line of text.split("\n")) {
        const match = line.match(/finished with status (\d+)/);
        if (match === null) continue;
        hookLines += 1;
        statuses[match[1]!] = (statuses[match[1]!] ?? 0) + 1;
      }
      const nonZero = Object.entries(statuses).filter(([status]) => status !== "0");
      checks.push({
        id: "host.debug",
        status: hookLines === 0 ? "warn" : nonZero.length > 0 ? "warn" : "ok",
        summary: hookLines === 0 ? `no 'finished with status N' lines in ${hostDebug}` : `${hookLines} hook completions in ${hostDebug}: status 0 ×${String(statuses["0"] ?? 0)}${nonZero.map(([status, count]) => `, status ${status} ×${String(count)}`).join("")}`,
      });
    } catch (error) {
      checks.push({ id: "host.debug", status: "fail", summary: `cannot read ${hostDebug}: ${error instanceof Error ? error.message : String(error)}` });
    }
  }

  return checks;
}

async function applyFixes(ctx: CommandContext, facts: Facts): Promise<string[]> {
  const fixes: string[] = [];
  const manifest = facts.manifest;
  if (manifest !== null && facts.settings.error === null) {
    const diff = compareRegistration(manifest, facts.settings.entries);
    const nodeGone = !existsSync(manifest.node);
    const scriptGone = !existsSync(manifest.hook_script);
    const hookScript = flagString(ctx.args, "hook-script") ?? ctx.seams.hookScript ?? (scriptGone ? resolveHookScript() : manifest.hook_script);
    if (nodeGone || scriptGone || diff.missing.length > 0 || diff.mismatched.length > 0 || diff.duplicates.length > 0) {
      if (!existsSync(hookScript)) {
        fixes.push(`cannot re-point the hooks: no hook script at ${hookScript} (run npm run build or pass --hook-script)`);
      } else {
        const spec: HookCommandSpec = { execPath: ctx.execPath, hookScript, form: manifest.hook_form, shell: manifest.shell };
        const current = readSettingsFile(manifest.settings_file);
        const merged = mergeHarnessHooks(current.settings, spec);
        writeSettingsFile(manifest.settings_file, merged.settings);
        const updated: InstallManifest = {
          ...manifest,
          node: ctx.execPath,
          hook_script: hookScript,
          files: manifest.files.map((file) => {
            if (file.role === "settings") return { ...file, sha256: sha256File(manifest.settings_file) };
            if (file.role === "hook_script") return { ...file, path: hookScript, sha256: sha256File(hookScript) };
            if (file.role === "worker_script") return { ...file, path: siblingScripts(hookScript).worker, sha256: sha256File(siblingScripts(hookScript).worker) };
            return file;
          }),
        };
        writeManifest(ctx.paths.manifest, updated);
        fixes.push(`rewrote ${manifest.events.length} hook entries in ${manifest.settings_file} → node ${ctx.execPath}, hook ${hookScript}`);
      }
    }
  }
  if (facts.stateIgnore.dirExists && !facts.stateIgnore.exists) {
    const written = ensureStateGitignore(ctx.paths);
    fixes.push(`wrote ${written.path} (nothing under ${HARNESS_DIR_NAME}/ is ever committed)`);
  }
  if (facts.db.exists && !facts.db.newerThanCode && facts.db.error === null) {
    try {
      const store = createCliStore({ paths: ctx.paths, config: ctx.config, clock: ctx.clock, stderr: ctx.stderr });
      const result = await store.rebuildSnapshot(CLI_LOCK_WAIT_MS);
      const migrated = result.migrated !== null && result.migrated.applied.length > 0 ? ` (migrated v${String(result.migrated.from)} → v${String(result.migrated.to)})` : "";
      fixes.push(result.snapshotBuilt ? `rebuilt the snapshot${migrated}` : `snapshot rebuild failed: ${result.snapshotError instanceof Error ? result.snapshotError.message : String(result.snapshotError)}`);
    } catch (error) {
      fixes.push(`snapshot rebuild failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return fixes;
}

const STATUS_LABEL: Record<CheckStatus, string> = { ok: "OK  ", warn: "WARN", fail: "FAIL", info: "INFO" };

export function renderDoctorReport(report: DoctorReport): string[] {
  const lines = [`harness-memory doctor — ${report.root}`];
  const width = report.checks.reduce((max, check) => Math.max(max, check.id.length), 0);
  for (const check of report.checks) {
    lines.push(`  ${STATUS_LABEL[check.status]}  ${check.id.padEnd(width)}  ${check.summary}`);
    for (const detail of check.detail ?? []) lines.push(`${" ".repeat(width + 10)}${detail}`);
  }
  if (report.self_test !== null) {
    lines.push(report.self_test.ok ? `  OK    self-test ${report.self_test.event} ok (${formatMs(report.self_test.durationMs)})` : `  FAIL  self-test ${report.self_test.event}: ${report.self_test.error ?? "failed"}`);
  }
  for (const fix of report.fixes) lines.push(`  fix   ${fix}`);
  const s = report.summary;
  lines.push(`${s.ok} ok, ${s.warn} warnings, ${s.fail} failures${s.info > 0 ? `, ${s.info} info` : ""}${report.ok ? "" : " — see FAIL lines"}`);
  return lines;
}

export async function runDoctor(ctx: CommandContext): Promise<number> {
  const hostDebug = flagString(ctx.args, "host-debug");
  let facts = await collectFacts(ctx);
  let fixes: string[] = [];
  if (flagBoolean(ctx.args, "fix")) {
    fixes = await applyFixes(ctx, facts);
    facts = await collectFacts(ctx);
  }
  const checks = buildChecks(ctx, facts, hostDebug);

  let selfTest: SelfTestResult | null = null;
  if (flagBoolean(ctx.args, "self-test")) {
    const hookScript = facts.manifest?.hook_script ?? ctx.seams.hookScript ?? resolveHookScript();
    const runner = ctx.seams.selfTest ?? runHookSelfTest;
    selfTest = runner({ paths: ctx.paths, hookScript, execPath: facts.manifest?.node ?? ctx.execPath, event: "session-start", env: ctx.env });
  }

  const summary = { ok: 0, warn: 0, fail: 0, info: 0 };
  for (const check of checks) summary[check.status] += 1;
  const report: DoctorReport = {
    root: ctx.paths.root,
    ok: summary.fail === 0 && (selfTest === null || selfTest.ok),
    checks,
    fixes,
    self_test: selfTest,
    summary,
  };
  ctx.out.result(report, renderDoctorReport);
  return report.ok ? EXIT_CODES.ok : EXIT_CODES.error;
}
