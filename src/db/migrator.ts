/**
 * Schema migrations (`src/db/migrations/NNN_*.sql`, `PRAGMA user_version` tracking).
 *
 * `runMigrationsOnDb` applies pending files on an open connection with NO surrounding transaction:
 * 017 and 021 toggle `PRAGMA foreign_keys`, which is a no-op inside a transaction, and dropping
 * `memories` with foreign keys ON would cascade-delete `evidence` and the dream links (spec §4).
 * Atomicity comes from applying in memory and saving tmp → rename; the CLI path `runMigrations`
 * (and `Store.withWriteLock`) copies `memory.sqlite` to `memory.sqlite.bak-v<from>` first.
 */

import { copyFileSync, existsSync, readFileSync } from "node:fs";
import type { Database as SqlJsDatabase } from "sql.js";

import { DatabaseNewerThanCodeError } from "../core/errors";
import { nowIso } from "../core/ids";
import { TARGET_USER_VERSION } from "../core/paths";
import { readBundledMigrationFiles } from "../runtime/package-paths";
import { DatabaseCorruptError, saveDatabaseFile, verifySqliteHeader, type FileLogger } from "./db-file";
import { runPostMigrate, type PostMigrateReport } from "./post-migrate";
import { loadSqlJs } from "./sqlite";

export interface MigrationFile {
  version: number;
  filename: string;
  sql: string;
}

export interface MigrationReport {
  from: number;
  to: number;
  /** Filenames applied by this call, in order. */
  applied: string[];
}

export interface RunMigrationsOnDbOptions {
  logger?: Pick<FileLogger, "log">;
  /** Stop after this version (tests build databases at intermediate versions). Default TARGET_USER_VERSION. */
  target?: number;
}

function parseMigrationVersion(filename: string): number {
  const match = filename.match(/^(\d+)_/);
  if (match === null) {
    throw new Error(`Invalid migration filename: ${filename}`);
  }

  return Number(match[1]);
}

export function getMigrationFiles(): MigrationFile[] {
  return readBundledMigrationFiles()
    .map((entry) => ({
      version: parseMigrationVersion(entry.filename),
      filename: entry.filename,
      sql: entry.sql,
    }))
    .sort((left, right) => left.version - right.version);
}

/** Highest version among the bundled migration files (22 in this build). */
export function latestMigrationVersion(): number {
  const files = getMigrationFiles();
  return files.length === 0 ? 0 : files[files.length - 1].version;
}

export function getCurrentVersion(db: SqlJsDatabase): number {
  const result = db.exec("PRAGMA user_version;");
  if (result.length > 0 && result[0].values.length > 0) {
    const version = result[0].values[0][0];
    return version !== null ? Number(version) : 0;
  }

  return 0;
}

/**
 * Apply every pending migration file to an open connection. No transaction is opened here; the
 * caller must not hold one either. Throws DatabaseNewerThanCodeError when the database was written
 * by a newer build (`user_version > TARGET_USER_VERSION`); nothing is changed in that case.
 */
export function runMigrationsOnDb(db: SqlJsDatabase, options: RunMigrationsOnDbOptions = {}): MigrationReport {
  const from = getCurrentVersion(db);
  if (from > TARGET_USER_VERSION) {
    throw new DatabaseNewerThanCodeError(from, TARGET_USER_VERSION);
  }

  const target = options.target ?? TARGET_USER_VERSION;
  const applied: string[] = [];
  for (const migration of getMigrationFiles()) {
    if (migration.version <= from || migration.version > target) {
      continue;
    }
    options.logger?.log(`Running migration ${migration.version}: ${migration.filename}`);
    db.exec(migration.sql);
    db.run(`PRAGMA user_version = ${migration.version}`);
    applied.push(migration.filename);
  }

  return { from, to: getCurrentVersion(db), applied };
}

export interface RunMigrationsOptions {
  logger?: FileLogger;
  /** Timestamp used by post-migrate (proposal expiry, transition rows). Default: wall clock. */
  now?: string;
  /** Run `runPostMigrate` after the SQL files (default true). */
  postMigrate?: boolean;
  /** Copy the file to `<db>.bak-v<from>` before applying anything (default true). */
  backup?: boolean;
}

export interface RunMigrationsResult extends MigrationReport {
  dbPath: string;
  backupPath: string | null;
  postMigrate: PostMigrateReport | null;
  /** False when the file was already current and post-migrate had nothing to do. */
  saved: boolean;
}

type LegacyLogger = Pick<Console, "log" | "error">;

function normalizeOptions(options: RunMigrationsOptions | LegacyLogger): Required<Omit<RunMigrationsOptions, "logger">> & {
  logger: FileLogger;
} {
  if (typeof (options as LegacyLogger).log === "function") {
    const legacy = options as LegacyLogger;
    return {
      logger: { log: legacy.log.bind(legacy), warn: legacy.error.bind(legacy), error: legacy.error.bind(legacy) },
      now: nowIso(),
      postMigrate: true,
      backup: true,
    };
  }
  const modern = options as RunMigrationsOptions;
  return {
    logger: modern.logger ?? console,
    now: modern.now ?? nowIso(),
    postMigrate: modern.postMigrate ?? true,
    backup: modern.backup ?? true,
  };
}

/**
 * CLI entry: open the file (or start a new database), back it up as `<db>.bak-v<from>`, apply the
 * pending migrations, run post-migrate, and save atomically. Lock-free by design: `hm db:migrate`
 * goes through `Store.withWriteLock`, which performs the same steps under `locks/db.lock`.
 */
export async function runMigrations(
  dbPath: string,
  options: RunMigrationsOptions | LegacyLogger = {}
): Promise<RunMigrationsResult> {
  const { logger, now, postMigrate, backup } = normalizeOptions(options);
  const SQL = await loadSqlJs();
  const exists = existsSync(dbPath);

  let db: SqlJsDatabase;
  if (exists) {
    const buffer = readFileSync(dbPath);
    if (!verifySqliteHeader(buffer)) {
      throw new DatabaseCorruptError(dbPath, "header check failed; run `hm doctor` to restore .prev");
    }
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }

  try {
    const from = getCurrentVersion(db);
    logger.log(`Current schema version: ${from}`);
    if (from > TARGET_USER_VERSION) {
      throw new DatabaseNewerThanCodeError(from, TARGET_USER_VERSION);
    }

    let backupPath: string | null = null;
    if (exists && backup && from < TARGET_USER_VERSION) {
      backupPath = `${dbPath}.bak-v${from}`;
      copyFileSync(dbPath, backupPath);
      logger.log(`Backup written: ${backupPath}`);
    }

    const report = runMigrationsOnDb(db, { logger });
    db.run("PRAGMA foreign_keys = ON");
    const postMigrateReport = postMigrate ? runPostMigrate(db, { now, logger }) : null;

    const changed =
      !exists || report.applied.length > 0 || (postMigrateReport !== null && !postMigrateReport.alreadyApplied);
    if (changed) {
      await saveDatabaseFile(db, dbPath, { logger });
      logger.log(`OK schema version ${report.to} saved to ${dbPath}`);
    } else {
      logger.log("OK schema already current; nothing to save");
    }

    return { ...report, dbPath, backupPath, postMigrate: postMigrateReport, saved: changed };
  } finally {
    db.close();
  }
}
