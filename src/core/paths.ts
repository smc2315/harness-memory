/**
 * Where state lives (spec §3.2). Everything project-scoped is under `<root>/.harness-memory/`;
 * the user-level directory `~/.harness-memory/` holds the headless-CLI cwd, the embedding model
 * cache and the untouched v0.5 global database.
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";

export const HARNESS_DIR_NAME = ".harness-memory";
export const DB_FILE_NAME = "memory.sqlite";
export const TARGET_USER_VERSION = 21;

export interface HarnessPaths {
  /** Project root (directory that contains .harness-memory). */
  root: string;
  dir: string;
  db: string;
  dbPrev: string;
  dbBackup: (userVersion: number) => string;
  snapshotDir: string;
  snapshotActive: string;
  snapshotLexical: string;
  snapshotDense: string;
  reindexRequested: string;
  ledgerDir: string;
  stateDir: string;
  queueDir: string;
  rawDir: string;
  locksDir: string;
  dbLock: string;
  workerLock: string;
  workerPid: string;
  embedHelperPid: string;
  embedHelperSocket: string;
  logsDir: string;
  hooksLog: string;
  workerLog: string;
  auditLog: string;
  config: string;
  manifest: string;
  /** Legacy v0.5 files that `uninstall --purge` removes. */
  legacyConversationBuffer: string;
  legacyExtractState: string;
}

export function resolvePaths(root: string): HarnessPaths {
  const absoluteRoot = resolve(root);
  const dir = join(absoluteRoot, HARNESS_DIR_NAME);
  const locksDir = join(dir, "locks");
  const hash = repoHash(absoluteRoot);
  return {
    root: absoluteRoot,
    dir,
    db: join(dir, DB_FILE_NAME),
    dbPrev: join(dir, `${DB_FILE_NAME}.prev`),
    dbBackup: (userVersion: number) => join(dir, `${DB_FILE_NAME}.bak-v${userVersion}`),
    snapshotDir: join(dir, "snapshot"),
    snapshotActive: join(dir, "snapshot", "active.v1.json"),
    snapshotLexical: join(dir, "snapshot", "lexical.v1.json"),
    snapshotDense: join(dir, "snapshot", "dense.v1.bin"),
    reindexRequested: join(dir, "snapshot", ".reindex-requested"),
    ledgerDir: join(dir, "ledger"),
    stateDir: join(dir, "state"),
    queueDir: join(dir, "queue"),
    rawDir: join(dir, "raw"),
    locksDir,
    dbLock: join(locksDir, "db.lock"),
    workerLock: join(locksDir, "worker.lock"),
    workerPid: join(locksDir, "worker.pid"),
    embedHelperPid: join(locksDir, "embed-helper.pid"),
    embedHelperSocket:
      process.platform === "win32"
        ? `\\\\.\\pipe\\harness-memory-embed-${hash}`
        : join(locksDir, "embed-helper.sock"),
    logsDir: join(dir, "logs"),
    hooksLog: join(dir, "logs", "hooks.log"),
    workerLog: join(dir, "logs", "worker.log"),
    auditLog: join(dir, "logs", "audit.log"),
    config: join(dir, "config.json"),
    manifest: join(dir, "install-manifest.json"),
    legacyConversationBuffer: join(dir, ".conversation-buffer.json"),
    legacyExtractState: join(dir, ".dream-extract-state.json"),
  };
}

/** Directories a writer must ensure exist (hooks create them lazily with mkdirSync recursive). */
export function stateDirectories(paths: HarnessPaths): string[] {
  return [paths.dir, paths.snapshotDir, paths.ledgerDir, paths.stateDir, paths.queueDir, paths.rawDir, paths.locksDir, paths.logsDir];
}

/**
 * Project root = first ancestor of `cwd` (inclusive) containing `.harness-memory/`; otherwise the
 * first ancestor containing `.git/`; otherwise `cwd` itself (spec §3.4).
 */
export function findProjectRoot(cwd: string): string {
  const start = resolve(cwd);
  const withHarness = findAncestorContaining(start, HARNESS_DIR_NAME);
  if (withHarness !== null) return withHarness;
  const withGit = findAncestorContaining(start, ".git");
  return withGit ?? start;
}

/** Null when no ancestor has `.harness-memory/` (hooks then exit immediately with status not_installed). */
export function findInstalledRoot(cwd: string): string | null {
  return findAncestorContaining(resolve(cwd), HARNESS_DIR_NAME);
}

function findAncestorContaining(start: string, name: string): string | null {
  let current = start;
  for (;;) {
    if (existsSync(join(current, name))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/** sha1(host + ':' + session_id).slice(0, 16) */
export function sessionKey(host: string, sessionId: string): string {
  return createHash("sha1").update(`${host}:${sessionId}`, "utf8").digest("hex").slice(0, 16);
}

/** Stable per-repository hash from the normalized absolute root path. */
export function repoHash(root: string): string {
  let normalized = resolve(root).split(sep).join("/");
  if (process.platform === "win32") normalized = normalized.toLowerCase();
  return createHash("sha1").update(normalized, "utf8").digest("hex").slice(0, 16);
}

export function userHarnessDir(): string {
  return process.env.HARNESS_MEMORY_HOME ?? join(homedir(), HARNESS_DIR_NAME);
}

/** Empty cwd for the headless extraction CLI, outside any git repository (§3.2). */
export function workerCwd(root: string): string {
  return join(userHarnessDir(), "worker", repoHash(root));
}

export function modelsDir(): string {
  return join(userHarnessDir(), "models");
}

export function globalDbPath(): string {
  return join(userHarnessDir(), "global.sqlite");
}

export function ledgerFile(paths: HarnessPaths, host: string, key: string): string {
  return join(paths.ledgerDir, `${host}-${key}.jsonl`);
}

export function stateFile(paths: HarnessPaths, host: string, key: string): string {
  return join(paths.stateDir, `${host}-${key}.json`);
}

export function notifyFile(paths: HarnessPaths, host: string, key: string): string {
  return join(paths.stateDir, `${host}-${key}.notify.json`);
}

export function queueFile(paths: HarnessPaths, episodeId: string): string {
  return join(paths.queueDir, `${episodeId}.json`);
}

export function rawFile(paths: HarnessPaths, runId: string, attempt?: number): string {
  return join(paths.rawDir, attempt === undefined ? `${runId}.json` : `${runId}.${attempt}.json`);
}
