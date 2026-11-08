/**
 * `meta` key/value table (018) and the `write_ops` idempotency ledger (018), as used by the store.
 * Keys: db_generation, extractor_version, semantic_key_backfill, last_dream_at, last_probe_at,
 * last_probe_result, installed_version.
 */

import type { Database as SqlJsDatabase } from "sql.js";

import { selectCount, selectValue, tableExists } from "./sql";

export const META_DB_GENERATION = "db_generation";

export function getMeta(db: SqlJsDatabase, key: string): string | null {
  const value = selectValue(db, "SELECT value FROM meta WHERE key = ?", [key]);
  return value === null ? null : String(value);
}

export function setMeta(db: SqlJsDatabase, key: string, value: string): void {
  db.run("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [
    key,
    value,
  ]);
}

/** 0 when the key is missing or the `meta` table does not exist yet (legacy database before 018). */
export function getDbGeneration(db: SqlJsDatabase): number {
  if (!tableExists(db, "meta")) {
    return 0;
  }
  const raw = getMeta(db, META_DB_GENERATION);
  const parsed = raw === null ? 0 : Number(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function setDbGeneration(db: SqlJsDatabase, generation: number): void {
  setMeta(db, META_DB_GENERATION, String(generation));
}

export function hasWriteOp(db: SqlJsDatabase, id: string): boolean {
  return selectCount(db, "SELECT COUNT(*) FROM write_ops WHERE id = ?", [id]) > 0;
}

export function insertWriteOp(db: SqlJsDatabase, id: string, kind: string, generation: number, appliedAt: string): void {
  db.run("INSERT INTO write_ops (id, kind, generation, applied_at) VALUES (?, ?, ?, ?)", [id, kind, generation, appliedAt]);
}
