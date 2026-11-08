/**
 * MetaRepository — the `meta` key/value table (migration 018; spec §4.2).
 */

import type { Database as SqlJsDatabase } from "sql.js";

import { expectString, selectAll, selectOne } from "./common";

export const META_KEYS = {
  dbGeneration: "db_generation",
  extractorVersion: "extractor_version",
  semanticKeyBackfill: "semantic_key_backfill",
  lastDreamAt: "last_dream_at",
  lastProbeAt: "last_probe_at",
  lastProbeResult: "last_probe_result",
  lastProbeError: "last_probe_error",
  installedVersion: "installed_version",
} as const;

export class MetaRepository {
  constructor(private readonly db: SqlJsDatabase) {}

  get(key: string): string | null {
    const row = selectOne(this.db, "SELECT value FROM meta WHERE key = $key", { $key: key });

    return row === null ? null : expectString(row.value, "value");
  }

  set(key: string, value: string): void {
    this.db.run("INSERT OR REPLACE INTO meta (key, value) VALUES ($key, $value)", { $key: key, $value: value });
  }

  delete(key: string): void {
    this.db.run("DELETE FROM meta WHERE key = $key", { $key: key });
  }

  getAll(): Record<string, string> {
    const entries: Record<string, string> = {};

    for (const row of selectAll(this.db, "SELECT key, value FROM meta ORDER BY key ASC")) {
      entries[expectString(row.key, "key")] = expectString(row.value, "value");
    }

    return entries;
  }

  /** `db_generation` as a number (0 when missing or malformed). */
  getGeneration(): number {
    const raw = this.get(META_KEYS.dbGeneration);

    if (raw === null) {
      return 0;
    }

    const parsed = Number.parseInt(raw, 10);

    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
  }

  /** Increments `db_generation` and returns the new value. */
  bumpGeneration(): number {
    const next = this.getGeneration() + 1;
    this.set(META_KEYS.dbGeneration, String(next));

    return next;
  }
}
