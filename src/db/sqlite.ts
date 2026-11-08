/**
 * sql.js bootstrap. One WASM runtime per process, shared by every opener (store, migrator, tests).
 *
 * sql.js works on a whole-database buffer: `new SQL.Database(bytes)` loads it, `db.export()` returns it.
 * `export()` closes and reopens the underlying connection, which frees every prepared statement and
 * resets connection-level PRAGMAs (`foreign_keys` goes back to OFF); `user_version` lives in the file
 * and survives. Writers must therefore re-apply `PRAGMA foreign_keys = ON` after exporting.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import initSqlJs, { type Database as SqlJsDatabase, type SqlJsStatic } from "sql.js";

let sqlJsPromise: Promise<SqlJsStatic> | null = null;

/** Cached sql.js runtime; the first call initializes the WASM module, a failure allows a retry. */
export function loadSqlJs(): Promise<SqlJsStatic> {
  if (sqlJsPromise === null) {
    sqlJsPromise = initSqlJs().catch((error: unknown) => {
      sqlJsPromise = null;
      throw error;
    });
  }

  return sqlJsPromise;
}

export interface OpenSqlJsDatabaseOptions {
  requireExists?: boolean;
}

/**
 * Plain open without header verification, locking or migrations. Prefer `Store` (`./store`) for
 * anything that writes; this stays for read-only tooling and the eval runners.
 */
export async function openSqlJsDatabase(
  dbPath: string,
  options: OpenSqlJsDatabaseOptions = {}
): Promise<SqlJsDatabase> {
  const SQL = await loadSqlJs();
  const resolvedPath = resolve(dbPath);

  if (existsSync(resolvedPath)) {
    return new SQL.Database(readFileSync(resolvedPath));
  }

  if (options.requireExists) {
    throw new Error(`Database file not found: ${resolvedPath}`);
  }

  return new SQL.Database();
}

/**
 * Plain, non-atomic save (export → write). Writers use `saveDatabaseFile` from `./db-file`
 * (tmp → fsync → .prev → rename); this remains for legacy callers and throwaway tooling.
 */
export function saveSqlJsDatabase(db: SqlJsDatabase, dbPath: string): void {
  const resolvedPath = resolve(dbPath);

  mkdirSync(dirname(resolvedPath), { recursive: true });
  writeFileSync(resolvedPath, Buffer.from(db.export()));
}
