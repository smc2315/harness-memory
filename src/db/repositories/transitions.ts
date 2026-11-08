/**
 * TransitionRepository — `memory_transitions` (migration 019). Every status change of a memory leaves
 * one row; writers are `transitionMemory` (src/promotion/transitions.ts), post-migrate, and — with from_status =
 * to_status — the enforcement escalations of src/promotion/escalation.ts and the remember adoptions of
 * src/promotion/transitions.ts adoptActiveMemory (Phase F).
 */

import { randomUUID } from "node:crypto";

import type { Database as SqlJsDatabase } from "sql.js";

import { MEMORY_STATUSES, TRANSITION_ACTORS, type MemoryStatus, type TransitionActor } from "../../core/vocabulary";
import {
  expectEnum,
  expectNullableString,
  expectString,
  nonNegativeInt,
  orNull,
  requireEnum,
  selectAll,
  selectOne,
  type SqlRow,
} from "./common";

const TRANSITION_COLUMNS = [
  "id",
  "memory_id",
  "from_status",
  "to_status",
  "actor",
  "proposal_id",
  "extraction_run_id",
  "reason",
  "created_at",
].join(", ");

export interface TransitionRecord {
  id: string;
  memoryId: string;
  fromStatus: MemoryStatus;
  toStatus: MemoryStatus;
  actor: TransitionActor;
  proposalId: string | null;
  extractionRunId: string | null;
  reason: string;
  createdAt: string;
}

export interface InsertTransitionInput {
  /** Defaults to randomUUID(). */
  id?: string;
  memoryId: string;
  fromStatus: MemoryStatus;
  toStatus: MemoryStatus;
  actor: TransitionActor;
  proposalId?: string | null;
  extractionRunId?: string | null;
  reason: string;
  createdAt: string;
}

export class TransitionRepository {
  constructor(private readonly db: SqlJsDatabase) {}

  insert(input: InsertTransitionInput): TransitionRecord {
    const id = input.id ?? randomUUID();

    this.db.run(
      `
        INSERT INTO memory_transitions (
          id, memory_id, from_status, to_status, actor, proposal_id, extraction_run_id, reason, created_at
        )
        VALUES ($id, $memoryId, $fromStatus, $toStatus, $actor, $proposalId, $extractionRunId, $reason, $createdAt)
      `,
      {
        $id: id,
        $memoryId: input.memoryId,
        $fromStatus: requireEnum(input.fromStatus, "fromStatus", MEMORY_STATUSES),
        $toStatus: requireEnum(input.toStatus, "toStatus", MEMORY_STATUSES),
        $actor: requireEnum(input.actor, "actor", TRANSITION_ACTORS),
        $proposalId: orNull(input.proposalId),
        $extractionRunId: orNull(input.extractionRunId),
        $reason: input.reason,
        $createdAt: input.createdAt,
      }
    );

    const row = selectOne(this.db, `SELECT ${TRANSITION_COLUMNS} FROM memory_transitions WHERE id = $id`, { $id: id });

    if (row === null) {
      throw new Error(`Failed to load memory transition ${id}`);
    }

    return mapTransitionRow(row);
  }

  listForMemory(memoryId: string): TransitionRecord[] {
    return selectAll(
      this.db,
      `
        SELECT ${TRANSITION_COLUMNS}
        FROM memory_transitions
        WHERE memory_id = $memoryId
        ORDER BY created_at ASC, rowid ASC
      `,
      { $memoryId: memoryId }
    ).map(mapTransitionRow);
  }

  listRecent(limit: number): TransitionRecord[] {
    return selectAll(
      this.db,
      `SELECT ${TRANSITION_COLUMNS} FROM memory_transitions ORDER BY created_at DESC, rowid DESC LIMIT $limit`,
      { $limit: nonNegativeInt(limit, "limit") }
    ).map(mapTransitionRow);
  }
}

export function mapTransitionRow(row: SqlRow): TransitionRecord {
  return {
    id: expectString(row.id, "id"),
    memoryId: expectString(row.memory_id, "memory_id"),
    fromStatus: expectEnum(row.from_status, "from_status", MEMORY_STATUSES),
    toStatus: expectEnum(row.to_status, "to_status", MEMORY_STATUSES),
    actor: expectEnum(row.actor, "actor", TRANSITION_ACTORS),
    proposalId: expectNullableString(row.proposal_id, "proposal_id"),
    extractionRunId: expectNullableString(row.extraction_run_id, "extraction_run_id"),
    reason: expectString(row.reason, "reason"),
    createdAt: expectString(row.created_at, "created_at"),
  };
}
