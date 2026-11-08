/**
 * The one writer protocol for `memory.sqlite` (spec §9.2 steps 1–6, §9.4 F1/F4/F6, §12 D1).
 *
 *   1 lock          acquireDirLock(locks/db.lock) with heartbeat; stale/dead holders are taken over
 *   2 load          read file, verify the SQLite header + quick_check; damaged → restore .prev, keep .corrupt-<ts>
 *   3 migrate       user_version < 21 → copy to .bak-v<N> → runMigrationsOnDb → hooks.postMigrate (default runPostMigrate)
 *   4 apply         BEGIN; op = fn(db, ctx); noop without writes → ROLLBACK (nothing saved);
 *                   otherwise hooks.deriveRules → meta.db_generation += 1 → write_ops(op.id) → quick_check → COMMIT
 *   5 save          export → .tmp-<pid> → fsync → copy current → .prev → rename (retries, copy fallback)
 *   6 snapshot      hooks.buildSnapshot(db, ctx); finally release the lock
 *
 * The module depends on nothing above `src/db`: the composition root (worker / CLI) injects
 * `StoreHooks` for policy-rule derivation and snapshot building.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import type { Database as SqlJsDatabase } from "sql.js";

import { DatabaseNewerThanCodeError } from "../core/errors";
import { nowIso } from "../core/ids";
import { stateDirectories, TARGET_USER_VERSION, type HarnessPaths } from "../core/paths";
import {
  cleanOrphanTmp,
  DatabaseCorruptError,
  DatabaseMissingError,
  DEFAULT_ORPHAN_TMP_MAX_AGE_MS,
  recoverFromPrev,
  saveDatabaseFile,
  verifySqliteHeader,
  type FileLogger,
} from "./db-file";
import { acquireDirLock, type LockHandle } from "./locks";
import { getDbGeneration, hasWriteOp, insertWriteOp, setDbGeneration } from "./meta";
import { getCurrentVersion, runMigrationsOnDb, type MigrationReport } from "./migrator";
import { runPostMigrate } from "./post-migrate";
import { quickCheck } from "./sql";
import { loadSqlJs } from "./sqlite";

export type StoreLogger = FileLogger;

/** What a write callback reports back (spec §9.2 step 4). `wrote` is consulted only when `noop` is true. */
export interface WriteOp {
  /** write_ops id (run id, `decision:<proposal>:<at>`, `import:<sha>`, `dream:<started_at>`) or null. */
  id: string | null;
  kind: string;
  /** True when the operation was already applied (e.g. the run id is in write_ops). */
  noop: boolean;
  /** For a noop: true when rows were still changed (e.g. the episode was marked extracted) and must be saved. */
  wrote: boolean;
}

export interface WriteContext {
  paths: HarnessPaths;
  now: string;
  /** Generation this write produces (`db_generation` after the increment). Unchanged on noop. */
  generation: number;
  userVersion: number;
  logger: StoreLogger;
  /** True when write_ops already holds this id; callbacks use it to return a noop early. */
  alreadyApplied(opId: string): boolean;
}

export interface ReadContext {
  paths: HarnessPaths;
  now: string;
  generation: number;
  userVersion: number;
  logger: StoreLogger;
  /** `user_version < TARGET_USER_VERSION`: a writer must run before the schema can be trusted. */
  migrationNeeded: boolean;
  /** `user_version > TARGET_USER_VERSION`: read-only callers should refuse and ask for an upgrade. */
  newerThanCode: boolean;
}

export interface MigrateContext {
  paths: HarnessPaths;
  now: string;
  logger: StoreLogger;
  from: number;
  to: number;
  backupPath: string | null;
}

export interface StoreHooks {
  /** After the SQL files; default `runPostMigrate`. Pass null to skip. */
  postMigrate?: ((db: SqlJsDatabase, ctx: MigrateContext) => unknown) | null;
  /** Inside the transaction, before the generation bump (derivePolicyRules, §10). */
  deriveRules?: (db: SqlJsDatabase, ctx: WriteContext) => unknown;
  /** After the file is saved; builds snapshot/*.v1.* via tmp + rename (§4.8). */
  buildSnapshot?: (db: SqlJsDatabase, ctx: WriteContext) => unknown;
}

export interface StoreOptions {
  paths: HarnessPaths;
  hooks?: StoreHooks;
  logger?: StoreLogger;
  clock?: () => string;
  /** Test seam for tmp file naming. */
  pid?: number;
  orphanTmpMaxAgeMs?: number;
}

export interface WriteOptions {
  /** Build the snapshot even when nothing was saved (`worker reindex`). */
  alwaysSnapshot?: boolean;
  /** Lock takeover threshold; default 120 s. */
  staleMs?: number;
}

export interface WriteResult {
  op: WriteOp;
  /** True when memory.sqlite was rewritten (commit or migration). */
  saved: boolean;
  /** db_generation after this call. */
  generation: number;
  userVersion: number;
  migrated: MigrationReport | null;
  backupPath: string | null;
  /** True when `.prev` had to be restored over a damaged main file. */
  recovered: boolean;
  corruptPath: string | null;
  lockTakenOver: boolean;
  /** True when write_ops already held op.id: the callback's changes were rolled back. */
  alreadyApplied: boolean;
  snapshotBuilt: boolean;
  /** A snapshot hook failure does not undo the committed write; it is reported here and logged. */
  snapshotError: unknown;
  orphansRemoved: string[];
}

export type WriteFn = (db: SqlJsDatabase, ctx: WriteContext) => WriteOp | Promise<WriteOp>;

export function noopOp(kind: string, id: string | null = null): WriteOp {
  return { id, kind, noop: true, wrote: false };
}

function assertWriteOp(value: unknown): asserts value is WriteOp {
  const op = value as Partial<WriteOp> | null | undefined;
  if (
    typeof op !== "object" ||
    op === null ||
    typeof op.kind !== "string" ||
    typeof op.noop !== "boolean" ||
    typeof op.wrote !== "boolean" ||
    !(op.id === null || typeof op.id === "string")
  ) {
    throw new TypeError("withWriteLock callback must return a WriteOp {id, kind, noop, wrote}");
  }
}

interface LoadedDatabase {
  db: SqlJsDatabase;
  exists: boolean;
  recovered: boolean;
  corruptPath: string | null;
}

export class Store {
  readonly paths: HarnessPaths;
  private readonly hooks: StoreHooks;
  private readonly logger: StoreLogger;
  private readonly clock: () => string;
  private readonly pid: number;
  private readonly orphanTmpMaxAgeMs: number;

  constructor(options: StoreOptions) {
    this.paths = options.paths;
    this.hooks = options.hooks ?? {};
    this.logger = options.logger ?? console;
    this.clock = options.clock ?? nowIso;
    this.pid = options.pid ?? process.pid;
    this.orphanTmpMaxAgeMs = options.orphanTmpMaxAgeMs ?? DEFAULT_ORPHAN_TMP_MAX_AGE_MS;
  }

  exists(): boolean {
    return existsSync(this.paths.db);
  }

  /**
   * Spec §9.2 steps 1–6. `fn` runs inside `BEGIN … COMMIT` and returns a WriteOp; any exception
   * rolls back and is rethrown. Prepared statements must not outlive `fn` (the save reopens the connection).
   */
  async withWriteLock(purpose: string, waitMs: number, fn: WriteFn, options: WriteOptions = {}): Promise<WriteResult> {
    const now = this.clock();
    for (const directory of stateDirectories(this.paths)) {
      mkdirSync(directory, { recursive: true });
    }

    const lock: LockHandle = await acquireDirLock(this.paths.dbLock, {
      purpose,
      waitMs,
      staleMs: options.staleMs,
      now: this.clock,
    });

    let db: SqlJsDatabase | null = null;
    try {
      const nowMs = Date.parse(now);
      const orphansRemoved = cleanOrphanTmp(this.paths, this.orphanTmpMaxAgeMs, Number.isFinite(nowMs) ? nowMs : Date.now());

      const loaded = await this.load({ repair: true, now });
      db = loaded.db;

      // step 3: migrate
      let userVersion = getCurrentVersion(db);
      if (userVersion > TARGET_USER_VERSION) {
        throw new DatabaseNewerThanCodeError(userVersion, TARGET_USER_VERSION);
      }
      let migrated: MigrationReport | null = null;
      let backupPath: string | null = null;
      if (userVersion < TARGET_USER_VERSION) {
        if (loaded.exists) {
          backupPath = this.paths.dbBackup(userVersion);
          copyFileSync(this.paths.db, backupPath);
          this.logger.log(`backup written before migration: ${backupPath}`);
        }
        migrated = runMigrationsOnDb(db, { logger: this.logger });
        db.run("PRAGMA foreign_keys = ON");
        const postMigrate = this.hooks.postMigrate === undefined ? defaultPostMigrate : this.hooks.postMigrate;
        if (postMigrate !== null) {
          await postMigrate(db, { paths: this.paths, now, logger: this.logger, from: migrated.from, to: migrated.to, backupPath });
        }
        userVersion = getCurrentVersion(db);
      }
      const mustSave = migrated !== null;

      // step 4: apply
      const generationBefore = getDbGeneration(db);
      const connection = db;
      const ctx: WriteContext = {
        paths: this.paths,
        now,
        generation: generationBefore + 1,
        userVersion,
        logger: this.logger,
        alreadyApplied: (opId: string) => hasWriteOp(connection, opId),
      };

      let op: WriteOp;
      let committed = false;
      let alreadyApplied = false;
      db.run("BEGIN");
      try {
        const returned: unknown = await fn(db, ctx);
        assertWriteOp(returned);
        op = returned;
        if (op.id !== null && !op.noop && hasWriteOp(db, op.id)) {
          alreadyApplied = true;
          op = { ...op, noop: true, wrote: false };
        }
        if (op.noop && !op.wrote) {
          db.run("ROLLBACK");
        } else {
          if (!op.noop) {
            await this.hooks.deriveRules?.(db, ctx);
            setDbGeneration(db, ctx.generation);
            if (op.id !== null) {
              insertWriteOp(db, op.id, op.kind, ctx.generation, now);
            }
          }
          const check = quickCheck(db);
          if (check !== "ok") {
            throw new DatabaseCorruptError(this.paths.db, `quick_check before commit: ${check}`);
          }
          db.run("COMMIT");
          committed = true;
        }
      } catch (error) {
        try {
          db.run("ROLLBACK");
        } catch {
          // the transaction was already gone
        }
        throw error;
      }

      const generation = committed && !op.noop ? ctx.generation : generationBefore;
      const finalCtx: WriteContext = { ...ctx, generation };

      // step 5: save
      let saved = false;
      if (committed || mustSave) {
        await saveDatabaseFile(db, this.paths.db, { pid: this.pid, logger: this.logger, prevPath: this.paths.dbPrev });
        db.run("PRAGMA foreign_keys = ON");
        saved = true;
      }

      // step 6: snapshot
      let snapshotBuilt = false;
      let snapshotError: unknown = null;
      if ((saved || options.alwaysSnapshot === true) && this.hooks.buildSnapshot !== undefined) {
        try {
          await this.hooks.buildSnapshot(db, finalCtx);
          snapshotBuilt = true;
        } catch (error) {
          snapshotError = error;
          this.logger.error(`snapshot build failed after ${purpose}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      return {
        op,
        saved,
        generation,
        userVersion,
        migrated,
        backupPath,
        recovered: loaded.recovered,
        corruptPath: loaded.corruptPath,
        lockTakenOver: lock.takenOver,
        alreadyApplied,
        snapshotBuilt,
        snapshotError,
        orphansRemoved,
      };
    } finally {
      db?.close();
      lock.release();
    }
  }

  /** `worker reindex`: rebuild the snapshot under the lock without writing (migrates first if needed). */
  rebuildSnapshot(waitMs = 5_000): Promise<WriteResult> {
    return this.withWriteLock("reindex", waitMs, () => noopOp("reindex"), { alwaysSnapshot: true });
  }

  /**
   * Read-only access: no lock, no save, migrations NOT applied. Callers see `ctx.userVersion` /
   * `ctx.migrationNeeded` and may refuse. A damaged main file is read from `.prev` in memory
   * (nothing on disk changes); a missing file throws DatabaseMissingError.
   */
  async read<T>(fn: (db: SqlJsDatabase, ctx: ReadContext) => T | Promise<T>): Promise<T> {
    const now = this.clock();
    const loaded = await this.load({ repair: false, now });
    try {
      const userVersion = getCurrentVersion(loaded.db);
      const ctx: ReadContext = {
        paths: this.paths,
        now,
        generation: getDbGeneration(loaded.db),
        userVersion,
        logger: this.logger,
        migrationNeeded: userVersion < TARGET_USER_VERSION,
        newerThanCode: userVersion > TARGET_USER_VERSION,
      };
      return await fn(loaded.db, ctx);
    } finally {
      loaded.db.close();
    }
  }

  private async load(options: { repair: boolean; now: string }): Promise<LoadedDatabase> {
    const SQL = await loadSqlJs();
    if (!existsSync(this.paths.db)) {
      if (!options.repair) {
        throw new DatabaseMissingError(this.paths.db);
      }
      const fresh = new SQL.Database();
      fresh.run("PRAGMA foreign_keys = ON");
      return { db: fresh, exists: false, recovered: false, corruptPath: null };
    }

    const buffer = readFileSync(this.paths.db);
    if (verifySqliteHeader(buffer)) {
      const db = new SQL.Database(buffer);
      const check = quickCheck(db);
      if (check === "ok") {
        db.run("PRAGMA foreign_keys = ON");
        return { db, exists: true, recovered: false, corruptPath: null };
      }
      db.close();
      this.logger.warn(`quick_check failed on ${this.paths.db}: ${check}`);
    } else {
      this.logger.warn(`header check failed on ${this.paths.db}`);
    }

    let previous: Uint8Array;
    let corruptPath: string | null = null;
    if (options.repair) {
      const recovered = recoverFromPrev(this.paths.db, this.paths.dbPrev, { now: options.now, logger: this.logger });
      previous = recovered.buffer;
      corruptPath = recovered.corruptPath;
    } else {
      if (!existsSync(this.paths.dbPrev)) {
        throw new DatabaseCorruptError(this.paths.db, "header check failed and there is no .prev to read");
      }
      previous = readFileSync(this.paths.dbPrev);
      if (!verifySqliteHeader(previous)) {
        throw new DatabaseCorruptError(this.paths.db, "header check failed and .prev is damaged too");
      }
    }

    const db = new SQL.Database(previous);
    const check = quickCheck(db);
    if (check !== "ok") {
      db.close();
      throw new DatabaseCorruptError(this.paths.db, `.prev failed quick_check: ${check}`);
    }
    db.run("PRAGMA foreign_keys = ON");
    return { db, exists: true, recovered: true, corruptPath };
  }
}

function defaultPostMigrate(db: SqlJsDatabase, ctx: MigrateContext): void {
  runPostMigrate(db, { now: ctx.now, logger: ctx.logger });
}

export { cleanOrphanTmp, verifySqliteHeader } from "./db-file";
export { getDbGeneration, getMeta, hasWriteOp, insertWriteOp, setDbGeneration, setMeta } from "./meta";
