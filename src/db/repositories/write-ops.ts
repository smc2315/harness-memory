/**
 * WriteOpsRepository — `write_ops` idempotency ledger (migration 018; spec §4.2, §5.7 step 1, §9.2).
 * Ids: run id | 'decision:<proposal_id>:<decided_at>' | 'import:<file_sha256>' | 'dream:<started_at ISO>'.
 */

import type { Database as SqlJsDatabase } from "sql.js";

import { expectNumber, expectString, nonNegativeInt, rowsChanged, selectAll, selectOne, type SqlRow } from "./common";

export interface WriteOpRecord {
  id: string;
  kind: string;
  generation: number;
  appliedAt: string;
}

export class WriteOpsRepository {
  constructor(private readonly db: SqlJsDatabase) {}

  has(id: string): boolean {
    return selectOne(this.db, "SELECT 1 AS one FROM write_ops WHERE id = $id", { $id: id }) !== null;
  }

  get(id: string): WriteOpRecord | null {
    const row = selectOne(this.db, "SELECT id, kind, generation, applied_at FROM write_ops WHERE id = $id", { $id: id });

    return row === null ? null : mapWriteOpRow(row);
  }

  /** INSERT OR IGNORE; false when the id was already recorded. */
  insert(id: string, kind: string, generation: number, now: string): boolean {
    this.db.run(
      "INSERT OR IGNORE INTO write_ops (id, kind, generation, applied_at) VALUES ($id, $kind, $generation, $appliedAt)",
      { $id: id, $kind: kind, $generation: nonNegativeInt(generation, "generation"), $appliedAt: now }
    );

    return rowsChanged(this.db) === 1;
  }

  listRecent(limit: number): WriteOpRecord[] {
    return selectAll(
      this.db,
      "SELECT id, kind, generation, applied_at FROM write_ops ORDER BY generation DESC, applied_at DESC, id ASC LIMIT $limit",
      { $limit: nonNegativeInt(limit, "limit") }
    ).map(mapWriteOpRow);
  }
}

export function mapWriteOpRow(row: SqlRow): WriteOpRecord {
  return {
    id: expectString(row.id, "id"),
    kind: expectString(row.kind, "kind"),
    generation: expectNumber(row.generation, "generation"),
    appliedAt: expectString(row.applied_at, "applied_at"),
  };
}
