/**
 * Small sql.js helpers shared by the v0.6 repositories. Every statement is freed in `finally`.
 */

import type { Database as SqlJsDatabase, SqlValue } from "sql.js";

export type SqlRow = Record<string, SqlValue>;
export type SqlParams = Record<string, SqlValue>;

export function selectAll(db: SqlJsDatabase, sql: string, params: SqlParams = {}): SqlRow[] {
  const statement = db.prepare(sql);

  try {
    statement.bind(params);
    const rows: SqlRow[] = [];

    while (statement.step()) {
      rows.push(statement.getAsObject());
    }

    return rows;
  } finally {
    statement.free();
  }
}

export function selectOne(db: SqlJsDatabase, sql: string, params: SqlParams = {}): SqlRow | null {
  const statement = db.prepare(sql);

  try {
    statement.bind(params);

    if (!statement.step()) {
      return null;
    }

    return statement.getAsObject();
  } finally {
    statement.free();
  }
}

/** Rows changed by the most recent INSERT/UPDATE/DELETE on this connection. */
export function rowsChanged(db: SqlJsDatabase): number {
  const row = selectOne(db, "SELECT changes() AS n");
  return row === null ? 0 : expectNumber(row.n, "changes");
}

export function expectString(value: unknown, column: string): string {
  if (typeof value !== "string") {
    throw new Error(`Expected ${column} to be a string`);
  }

  return value;
}

export function expectNullableString(value: unknown, column: string): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  return expectString(value, column);
}

export function expectNumber(value: unknown, column: string): number {
  if (typeof value !== "number") {
    throw new Error(`Expected ${column} to be a number`);
  }

  return value;
}

export function expectNullableNumber(value: unknown, column: string): number | null {
  if (value === null || value === undefined) {
    return null;
  }

  return expectNumber(value, column);
}

export function expectFlag(value: unknown, column: string): 0 | 1 {
  const number = expectNumber(value, column);

  if (number !== 0 && number !== 1) {
    throw new Error(`Expected ${column} to be 0 or 1`);
  }

  return number;
}

export function expectEnum<T extends string>(value: unknown, column: string, allowed: readonly T[]): T {
  const text = expectString(value, column);

  if (!(allowed as readonly string[]).includes(text)) {
    throw new Error(`Invalid ${column}: ${text}`);
  }

  return text as T;
}

export function expectNullableEnum<T extends string>(
  value: unknown,
  column: string,
  allowed: readonly T[]
): T | null {
  if (value === null || value === undefined) {
    return null;
  }

  return expectEnum(value, column, allowed);
}

export function requireEnum<T extends string>(value: unknown, field: string, allowed: readonly T[]): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw new Error(`${field} must be one of ${allowed.join(", ")} (got ${String(value)})`);
  }

  return value as T;
}

export function parseJsonArray<T>(text: string | null, column: string): T[] {
  if (text === null || text === "") {
    return [];
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid ${column} JSON: ${String(error)}`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error(`Invalid ${column} JSON: expected an array`);
  }

  return parsed as T[];
}

export function parseJsonObject<T extends object>(text: string | null, column: string): T {
  if (text === null || text === "") {
    return {} as T;
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid ${column} JSON: ${String(error)}`);
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Invalid ${column} JSON: expected an object`);
  }

  return parsed as T;
}

/** sql.js throws on `undefined`; every optional input goes through this before binding. */
export function orNull<T extends SqlValue>(value: T | null | undefined): T | null {
  return value === undefined ? null : value;
}

export function nonNegativeInt(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative integer`);
  }

  return value;
}

export function truncateText(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : text.slice(0, maxChars);
}

export function addSeconds(iso: string, seconds: number): string {
  return new Date(Date.parse(iso) + seconds * 1000).toISOString();
}

export function addDays(iso: string, days: number): string {
  return new Date(Date.parse(iso) + days * 24 * 60 * 60 * 1000).toISOString();
}

/** Later of two ISO timestamps (null counts as "none"). */
export function laterIso(left: string | null, right: string): string {
  if (left === null) {
    return right;
  }

  return Date.parse(right) > Date.parse(left) ? right : left;
}

/**
 * SQL predicate marking a correction episode: it corrects a previous episode or its prompt carried
 * the correction flag (`flags_json` is JSON.stringify output, so the compact `"correction":1` form is stable).
 */
export function correctionEpisodeSql(alias: string): string {
  return `(${alias}.correction_for IS NOT NULL OR ${alias}.flags_json LIKE '%"correction":1%')`;
}
