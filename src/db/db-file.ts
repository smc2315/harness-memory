/**
 * File-level helpers for the whole-database-buffer model of sql.js (spec §9.2 steps 2 and 5, §9.4 F1/F4).
 *
 * - `verifySqliteHeader`: the 16-byte magic every real database file starts with.
 * - `saveDatabaseFile`: export → `<db>.tmp-<pid>` → fsync → copy current → `.prev` → rename
 *   (5 retries, 20 ms apart; EPERM/EBUSY fall back to copy + warning).
 * - `recoverFromPrev`: keep the damaged file as `<db>.corrupt-<ts>` and restore `.prev`.
 * - `cleanOrphanTmp`: delete `*.tmp-<pid>` files older than 10 minutes next to the database and in `snapshot/`.
 */

import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { Database as SqlJsDatabase } from "sql.js";

import type { HarnessPaths } from "../core/paths";

export const SQLITE_HEADER = "SQLite format 3\u0000";
const SQLITE_HEADER_BYTES = Buffer.from(SQLITE_HEADER, "latin1");
/** A real database file is at least one page (512 bytes); the header alone is 100 bytes. */
const MIN_DATABASE_BYTES = 100;

export const TMP_SUFFIX_PATTERN = /\.tmp-\d+$/;
export const DEFAULT_ORPHAN_TMP_MAX_AGE_MS = 10 * 60_000;
export const RENAME_ATTEMPTS = 5;
export const RENAME_BACKOFF_MS = 20;

export interface FileLogger {
  log(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export const silentLogger: FileLogger = {
  log() {},
  warn() {},
  error() {},
};

export class DatabaseCorruptError extends Error {
  constructor(
    public readonly dbPath: string,
    public readonly reason: string
  ) {
    super(`Database ${dbPath} is damaged: ${reason}`);
    this.name = "DatabaseCorruptError";
  }
}

export class DatabaseMissingError extends Error {
  constructor(public readonly dbPath: string) {
    super(`Database file not found: ${dbPath}`);
    this.name = "DatabaseMissingError";
  }
}

export function verifySqliteHeader(buffer: Uint8Array): boolean {
  if (buffer.byteLength < MIN_DATABASE_BYTES) {
    return false;
  }
  for (let index = 0; index < SQLITE_HEADER_BYTES.length; index += 1) {
    if (buffer[index] !== SQLITE_HEADER_BYTES[index]) {
      return false;
    }
  }
  return true;
}

export function tmpDbPath(dbPath: string, pid: number = process.pid): string {
  return `${dbPath}.tmp-${pid}`;
}

/** `<db>.corrupt-2026-11-08T10-00-00-000Z` (colons and dots are not filesystem-safe everywhere). */
export function corruptDbPath(dbPath: string, now: string): string {
  return `${dbPath}.corrupt-${now.replace(/[:.]/g, "-")}`;
}

function writeFileWithFsync(path: string, data: Uint8Array): void {
  const fd = openSync(path, "w");
  try {
    let offset = 0;
    while (offset < data.byteLength) {
      offset += writeSync(fd, data, offset, data.byteLength - offset);
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export interface RenameWithRetryOptions {
  attempts?: number;
  backoffMs?: number;
  logger?: FileLogger;
}

/**
 * `renameSync` with retries for transient Windows sharing violations. Returns true when the rename
 * succeeded and false when the copy fallback had to be used (EPERM/EBUSY/EACCES after every attempt).
 * Any other error is rethrown and the source file is left in place for `cleanOrphanTmp`.
 */
export async function renameWithRetry(from: string, to: string, options: RenameWithRetryOptions = {}): Promise<boolean> {
  const attempts = options.attempts ?? RENAME_ATTEMPTS;
  const backoffMs = options.backoffMs ?? RENAME_BACKOFF_MS;
  const logger = options.logger ?? silentLogger;
  let lastError: NodeJS.ErrnoException | null = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      renameSync(from, to);
      return true;
    } catch (error) {
      lastError = error as NodeJS.ErrnoException;
      if (attempt < attempts) {
        await sleep(backoffMs);
      }
    }
  }

  const code = lastError?.code;
  if (code === "EPERM" || code === "EBUSY" || code === "EACCES") {
    copyFileSync(from, to);
    rmSync(from, { force: true });
    logger.warn(
      `rename ${basename(from)} -> ${basename(to)} failed with ${code} after ${attempts} attempts; copied the file instead`
    );
    return false;
  }

  throw lastError ?? new Error(`rename ${from} -> ${to} failed`);
}

export interface SaveDatabaseOptions {
  pid?: number;
  logger?: FileLogger;
  /** Where the previous version is copied before the rename; null disables the `.prev` copy. */
  prevPath?: string | null;
  renameAttempts?: number;
  renameBackoffMs?: number;
}

export interface SaveDatabaseResult {
  bytes: number;
  /** False when the copy fallback replaced the rename. */
  renamed: boolean;
  /** True when an existing file was copied to `.prev` first. */
  prevWritten: boolean;
}

/**
 * Atomic save of a sql.js database. After this call the connection has been reopened by `export()`:
 * prepared statements are gone and `PRAGMA foreign_keys` is back to its default (OFF).
 */
export async function saveDatabaseFile(
  db: SqlJsDatabase,
  dbPath: string,
  options: SaveDatabaseOptions = {}
): Promise<SaveDatabaseResult> {
  const pid = options.pid ?? process.pid;
  const logger = options.logger ?? silentLogger;
  const prevPath = options.prevPath === undefined ? `${dbPath}.prev` : options.prevPath;

  mkdirSync(dirname(dbPath), { recursive: true });
  const data = db.export();
  const tmpPath = tmpDbPath(dbPath, pid);
  writeFileWithFsync(tmpPath, data);

  let prevWritten = false;
  if (prevPath !== null && existsSync(dbPath)) {
    copyFileSync(dbPath, prevPath);
    prevWritten = true;
  }

  const renamed = await renameWithRetry(tmpPath, dbPath, {
    attempts: options.renameAttempts,
    backoffMs: options.renameBackoffMs,
    logger,
  });

  return { bytes: data.byteLength, renamed, prevWritten };
}

export interface RecoverOptions {
  now: string;
  logger?: FileLogger;
}

export interface RecoverResult {
  buffer: Uint8Array;
  /** Where the damaged file was moved, or null when there was no file to keep. */
  corruptPath: string | null;
}

/**
 * Restore `.prev` over a damaged main file. The damaged file is kept as `<db>.corrupt-<ts>` for
 * forensics; `hm doctor` lists it. Throws DatabaseCorruptError when `.prev` is missing or damaged too.
 */
export function recoverFromPrev(dbPath: string, prevPath: string, options: RecoverOptions): RecoverResult {
  const logger = options.logger ?? silentLogger;
  if (!existsSync(prevPath)) {
    throw new DatabaseCorruptError(dbPath, "header check failed and there is no .prev to restore");
  }
  const previous = readFileSync(prevPath);
  if (!verifySqliteHeader(previous)) {
    throw new DatabaseCorruptError(dbPath, "header check failed and .prev is damaged too");
  }

  let corruptPath: string | null = null;
  if (existsSync(dbPath)) {
    corruptPath = corruptDbPath(dbPath, options.now);
    try {
      renameSync(dbPath, corruptPath);
    } catch {
      copyFileSync(dbPath, corruptPath);
      rmSync(dbPath, { force: true });
    }
  }
  copyFileSync(prevPath, dbPath);
  logger.warn(
    `restored ${basename(prevPath)} over damaged ${basename(dbPath)}${corruptPath === null ? "" : ` (kept as ${basename(corruptPath)})`}`
  );

  return { buffer: previous, corruptPath };
}

/**
 * Remove `*.tmp-<pid>` leftovers of crashed writers next to the database and in `snapshot/`.
 * Only files older than `olderThanMs` (default 10 minutes) are removed; returns the removed paths.
 */
export function cleanOrphanTmp(
  paths: Pick<HarnessPaths, "dir" | "snapshotDir">,
  olderThanMs: number = DEFAULT_ORPHAN_TMP_MAX_AGE_MS,
  nowMs: number = Date.now()
): string[] {
  const removed: string[] = [];
  for (const directory of new Set([paths.dir, paths.snapshotDir])) {
    let entries: string[];
    try {
      entries = readdirSync(directory);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!TMP_SUFFIX_PATTERN.test(name)) {
        continue;
      }
      const fullPath = join(directory, name);
      try {
        const stat = statSync(fullPath);
        if (!stat.isFile() || nowMs - stat.mtimeMs < olderThanMs) {
          continue;
        }
        rmSync(fullPath, { force: true });
        removed.push(fullPath);
      } catch {
        // a concurrent writer may have renamed it away; nothing to do
      }
    }
  }
  return removed;
}
