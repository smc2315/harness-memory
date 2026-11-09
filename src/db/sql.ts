/**
 * Tiny sql.js query helpers that follow the project convention: prepare → bind → step → getAsObject,
 * always `free()` in a finally block. Repositories may import these instead of re-implementing them.
 */

import type { BindParams, Database as SqlJsDatabase, SqlValue } from "sql.js";

export type Row = Record<string, SqlValue>;

export function selectAll(db: SqlJsDatabase, sql: string, params?: BindParams): Row[] {
  const statement = db.prepare(sql);
  try {
    if (params !== undefined) {
      statement.bind(params);
    }
    const rows: Row[] = [];
    while (statement.step()) {
      rows.push(statement.getAsObject());
    }
    return rows;
  } finally {
    statement.free();
  }
}

export function selectOne(db: SqlJsDatabase, sql: string, params?: BindParams): Row | null {
  const statement = db.prepare(sql);
  try {
    if (params !== undefined) {
      statement.bind(params);
    }
    return statement.step() ? statement.getAsObject() : null;
  } finally {
    statement.free();
  }
}

/** First column of the first row, or null when the query returns no rows. */
export function selectValue(db: SqlJsDatabase, sql: string, params?: BindParams): SqlValue | null {
  const statement = db.prepare(sql);
  try {
    if (params !== undefined) {
      statement.bind(params);
    }
    if (!statement.step()) {
      return null;
    }
    const values = statement.get();
    return values.length > 0 ? values[0] : null;
  } finally {
    statement.free();
  }
}

/** `SELECT COUNT(*) …` style queries: the first value coerced to a number (0 when absent). */
export function selectCount(db: SqlJsDatabase, sql: string, params?: BindParams): number {
  const value = selectValue(db, sql, params);
  return typeof value === "number" ? value : Number(value ?? 0);
}

export function tableExists(db: SqlJsDatabase, tableName: string): boolean {
  return (
    selectCount(db, "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?", [tableName]) > 0
  );
}

/** Rows changed by the most recent INSERT/UPDATE/DELETE on this connection. */
export function changes(db: SqlJsDatabase): number {
  return selectCount(db, "SELECT changes()");
}

export function userVersion(db: SqlJsDatabase): number {
  const value = selectValue(db, "PRAGMA user_version");
  return typeof value === "number" ? value : Number(value ?? 0);
}

/** `PRAGMA quick_check(1)` result: the string 'ok' on a healthy database. */
export function quickCheck(db: SqlJsDatabase): string {
  const value = selectValue(db, "PRAGMA quick_check(1)");
  return value === null ? "no result" : String(value);
}
