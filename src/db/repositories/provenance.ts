/**
 * ProvenanceRepository — `memory_provenance` (migration 019) and the derived-counter recompute
 * (spec §5.7 steps 4–5, R1).
 *
 * `recomputeDerived(db, memoryId)` writes evidence_count / evidence_score / distinct_session_count and,
 * for `authority='auto'` rows only, `confidence = min(0.99, max(provenance.confidence) + 0.05 * (evidence_count - 1))`.
 * Human rows keep their confidence and importance frozen. Reconcile calls it inside the same SAVEPOINT
 * that inserted the provenance rows, before `decideTier` reads evidenceScore.
 */

import type { Database as SqlJsDatabase } from "sql.js";

import {
  AUTHORITIES,
  EVIDENCE_RELATIONS,
  PROVENANCE_RELATIONS,
  type Authority,
  type ProvenanceRelation,
} from "../../core/vocabulary";
import { MemoryNotFoundError } from "../../memory/repository";
import {
  expectEnum,
  expectNullableNumber,
  expectNullableString,
  expectNumber,
  expectString,
  nonNegativeInt,
  orNull,
  requireEnum,
  rowsChanged,
  selectAll,
  selectOne,
  truncateText,
  type SqlRow,
} from "./common";

const PROVENANCE_COLUMNS = [
  "memory_id",
  "episode_id",
  "event_seq",
  "relation",
  "confidence",
  "excerpt",
  "extraction_run_id",
  "created_at",
].join(", ");

export const PROVENANCE_EXCERPT_MAX_CHARS = 500;
export const AUTO_CONFIDENCE_CAP = 0.99;
export const AUTO_CONFIDENCE_STEP = 0.05;

const EVIDENCE_RELATION_SQL = EVIDENCE_RELATIONS.map((relation) => `'${relation}'`).join(", ");

export interface ProvenanceRecord {
  memoryId: string;
  episodeId: string;
  eventSeq: number;
  relation: ProvenanceRelation;
  confidence: number;
  excerpt: string;
  extractionRunId: string | null;
  createdAt: string;
}

export interface InsertProvenanceInput {
  memoryId: string;
  episodeId: string;
  /** e<seq> cited by the extractor; 0 for import/manual rows. */
  eventSeq: number;
  relation: ProvenanceRelation;
  confidence: number;
  /** Truncated to 500 chars (CHECK constraint). */
  excerpt?: string;
  extractionRunId?: string | null;
  createdAt: string;
}

export interface DerivedAggregate {
  /** COUNT(DISTINCT episode_id) over origin/reinforce/import rows (contradict never counts). */
  evidenceCount: number;
  /** Sum of episodes.evidence_weight over those episodes; import relations and unknown episodes weigh 1. */
  evidenceScore: number;
  distinctSessionCount: number;
  /** MAX(confidence) over the evidence relations, null when there is no evidence. */
  maxConfidence: number | null;
}

export interface RecomputeDerivedResult extends DerivedAggregate {
  memoryId: string;
  authority: Authority;
  /** Confidence after the recompute (unchanged for human rows or rows without evidence). */
  confidence: number;
  confidenceChanged: boolean;
}

export function deriveAutoConfidence(maxConfidence: number, evidenceCount: number): number {
  const raised = maxConfidence + AUTO_CONFIDENCE_STEP * Math.max(0, evidenceCount - 1);

  return Math.min(AUTO_CONFIDENCE_CAP, Math.max(0, raised));
}

export class ProvenanceRepository {
  constructor(private readonly db: SqlJsDatabase) {}

  /** INSERT OR IGNORE on (memory_id, episode_id, event_seq, relation); true when a row was added. */
  insert(input: InsertProvenanceInput): boolean {
    this.db.run(
      `
        INSERT OR IGNORE INTO memory_provenance (
          memory_id, episode_id, event_seq, relation, confidence, excerpt, extraction_run_id, created_at
        )
        VALUES ($memoryId, $episodeId, $eventSeq, $relation, $confidence, $excerpt, $extractionRunId, $createdAt)
      `,
      {
        $memoryId: input.memoryId,
        $episodeId: input.episodeId,
        $eventSeq: nonNegativeInt(input.eventSeq, "eventSeq"),
        $relation: requireEnum(input.relation, "relation", PROVENANCE_RELATIONS),
        $confidence: input.confidence,
        $excerpt: truncateText(input.excerpt ?? "", PROVENANCE_EXCERPT_MAX_CHARS),
        $extractionRunId: orNull(input.extractionRunId),
        $createdAt: input.createdAt,
      }
    );

    return rowsChanged(this.db) === 1;
  }

  listForMemory(memoryId: string): ProvenanceRecord[] {
    return selectAll(
      this.db,
      `
        SELECT ${PROVENANCE_COLUMNS}
        FROM memory_provenance
        WHERE memory_id = $memoryId
        ORDER BY created_at ASC, episode_id ASC, event_seq ASC, relation ASC
      `,
      { $memoryId: memoryId }
    ).map(mapProvenanceRow);
  }

  listForEpisode(episodeId: string): ProvenanceRecord[] {
    return selectAll(
      this.db,
      `
        SELECT ${PROVENANCE_COLUMNS}
        FROM memory_provenance
        WHERE episode_id = $episodeId
        ORDER BY created_at ASC, memory_id ASC, event_seq ASC, relation ASC
      `,
      { $episodeId: episodeId }
    ).map(mapProvenanceRow);
  }

  aggregate(memoryId: string): DerivedAggregate {
    const row = selectOne(
      this.db,
      `
        WITH ev AS (
          SELECT p.episode_id,
                 MAX(CASE WHEN p.relation = 'import' THEN 1 ELSE 0 END) AS is_import,
                 MAX(p.confidence) AS max_confidence
          FROM memory_provenance p
          WHERE p.memory_id = $memoryId AND p.relation IN (${EVIDENCE_RELATION_SQL})
          GROUP BY p.episode_id
        )
        SELECT COUNT(*) AS evidence_count,
               COALESCE(SUM(CASE WHEN ev.is_import = 1 THEN 1.0 ELSE COALESCE(e.evidence_weight, 1.0) END), 0) AS evidence_score,
               COUNT(DISTINCT COALESCE(e.session_id, ev.episode_id)) AS distinct_session_count,
               MAX(ev.max_confidence) AS max_confidence
        FROM ev
        LEFT JOIN episodes e ON e.id = ev.episode_id
      `,
      { $memoryId: memoryId }
    );

    if (row === null) {
      return { evidenceCount: 0, evidenceScore: 0, distinctSessionCount: 0, maxConfidence: null };
    }

    return {
      evidenceCount: expectNumber(row.evidence_count, "evidence_count"),
      evidenceScore: expectNumber(row.evidence_score, "evidence_score"),
      distinctSessionCount: expectNumber(row.distinct_session_count, "distinct_session_count"),
      maxConfidence: expectNullableNumber(row.max_confidence, "max_confidence"),
    };
  }
}

/**
 * Writes the derived counters of one memory from its provenance (§5.7 step 4/5). Auto rows also get
 * their confidence recomputed; human rows keep confidence/importance. Throws MemoryNotFoundError.
 */
export function recomputeDerived(db: SqlJsDatabase, memoryId: string): RecomputeDerivedResult {
  const current = selectOne(db, "SELECT authority, confidence FROM memories WHERE id = $id", { $id: memoryId });

  if (current === null) {
    throw new MemoryNotFoundError(memoryId);
  }

  const authority = expectEnum(current.authority, "authority", AUTHORITIES);
  const previousConfidence = expectNumber(current.confidence, "confidence");
  const aggregate = new ProvenanceRepository(db).aggregate(memoryId);
  const confidence =
    authority === "auto" && aggregate.maxConfidence !== null
      ? deriveAutoConfidence(aggregate.maxConfidence, aggregate.evidenceCount)
      : previousConfidence;

  db.run(
    `
      UPDATE memories
      SET evidence_count = $evidenceCount,
          evidence_score = $evidenceScore,
          distinct_session_count = $distinctSessionCount,
          confidence = $confidence
      WHERE id = $id
    `,
    {
      $id: memoryId,
      $evidenceCount: aggregate.evidenceCount,
      $evidenceScore: aggregate.evidenceScore,
      $distinctSessionCount: aggregate.distinctSessionCount,
      $confidence: confidence,
    }
  );

  return {
    ...aggregate,
    memoryId,
    authority,
    confidence,
    confidenceChanged: confidence !== previousConfidence,
  };
}

export function mapProvenanceRow(row: SqlRow): ProvenanceRecord {
  return {
    memoryId: expectString(row.memory_id, "memory_id"),
    episodeId: expectString(row.episode_id, "episode_id"),
    eventSeq: expectNumber(row.event_seq, "event_seq"),
    relation: expectEnum(row.relation, "relation", PROVENANCE_RELATIONS),
    confidence: expectNumber(row.confidence, "confidence"),
    excerpt: expectString(row.excerpt, "excerpt"),
    extractionRunId: expectNullableString(row.extraction_run_id, "extraction_run_id"),
    createdAt: expectString(row.created_at, "created_at"),
  };
}
