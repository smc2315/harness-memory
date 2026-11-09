/**
 * ProposalRepository — `proposals` + `proposal_support` (migration 019; spec §4.3, §5.7 step 6, §7.5).
 *
 * One open proposal per (kind, target, candidate) (`ux_proposals_open`); the same claim from another
 * episode upserts a support row and `recomputeDerived` refreshes support_count / support_sessions.
 * Ids are `randomUUID()` on purpose: a deterministic id would collide when the same claim is
 * re-proposed after reject/expire (propose → expire → propose must succeed).
 */

import { randomUUID } from "node:crypto";

import type { Database as SqlJsDatabase } from "sql.js";

import {
  PROPOSAL_CREATORS,
  PROPOSAL_DECIDERS,
  PROPOSAL_KINDS,
  PROPOSAL_STATUSES,
  type ProposalCreator,
  type ProposalDecider,
  type ProposalKind,
  type ProposalStatus,
} from "../../core/vocabulary";
import {
  addDays,
  expectEnum,
  expectFlag,
  expectNullableEnum,
  expectNullableString,
  expectNumber,
  expectString,
  nonNegativeInt,
  orNull,
  requireEnum,
  selectAll,
  selectOne,
  type SqlParams,
  type SqlRow,
} from "./common";

export const DEFAULT_PROPOSAL_DAYS = 30;

const PROPOSAL_COLUMNS = [
  "id",
  "kind",
  "target_memory_id",
  "candidate_memory_id",
  "rationale",
  "confidence",
  "created_by",
  "support_count",
  "support_sessions",
  "status",
  "created_at",
  "expires_at",
  "decided_at",
  "decided_by",
  "decision_note",
].join(", ");

const SUPPORT_COLUMNS = [
  "proposal_id",
  "episode_id",
  "session_id",
  "extraction_run_id",
  "confidence",
  "created_at",
  "has_human_signal",
  "deterministic",
].join(", ");

export interface ProposalRecord {
  id: string;
  kind: ProposalKind;
  targetMemoryId: string;
  candidateMemoryId: string | null;
  rationale: string;
  confidence: number;
  createdBy: ProposalCreator;
  supportCount: number;
  supportSessions: number;
  status: ProposalStatus;
  createdAt: string;
  expiresAt: string;
  decidedAt: string | null;
  decidedBy: ProposalDecider | null;
  decisionNote: string | null;
}

export interface ProposalSupportRecord {
  proposalId: string;
  episodeId: string;
  sessionId: string;
  extractionRunId: string | null;
  confidence: number;
  createdAt: string;
  hasHumanSignal: 0 | 1;
  deterministic: 0 | 1;
}

export interface CreateProposalInput {
  id?: string;
  kind: ProposalKind;
  targetMemoryId: string;
  candidateMemoryId?: string | null;
  rationale: string;
  confidence: number;
  createdBy: ProposalCreator;
  now: string;
  /** Explicit expiry; otherwise `now + expiresInDays` (default 30 d). */
  expiresAt?: string;
  expiresInDays?: number;
}

export interface AddSupportInput {
  episodeId: string;
  sessionId: string;
  extractionRunId?: string | null;
  confidence: number;
  createdAt: string;
  /** Episode flags.correction or flags.remember. */
  hasHumanSignal?: 0 | 1;
  /** The signature command ran tool_ok in the same turn with no failure. */
  deterministic?: 0 | 1;
}

export interface DecideProposalInput {
  status: Exclude<ProposalStatus, "open">;
  decidedBy: ProposalDecider;
  note?: string | null;
  now: string;
}

export interface ListOpenProposalsOptions {
  kind?: ProposalKind;
  targetId?: string;
  candidateId?: string | null;
}

export interface ListDecidedProposalsOptions {
  kind?: ProposalKind;
  targetId?: string;
  status?: Exclude<ProposalStatus, "open">;
  /** Only proposals decided at or after this ISO time. */
  since?: string;
}

export interface ProposalDerivedCounts {
  supportCount: number;
  supportSessions: number;
}

export class ProposalAlreadyOpenError extends Error {
  constructor(
    public readonly proposalId: string,
    public readonly kind: ProposalKind,
    public readonly targetMemoryId: string,
    public readonly candidateMemoryId: string | null
  ) {
    super(`An open ${kind} proposal (${proposalId}) already exists for ${targetMemoryId}; add support instead`);
    this.name = "ProposalAlreadyOpenError";
  }
}

export class ProposalRepository {
  constructor(private readonly db: SqlJsDatabase) {}

  findOpen(kind: ProposalKind, targetId: string, candidateId: string | null): ProposalRecord | null {
    const row = selectOne(
      this.db,
      `
        SELECT ${PROPOSAL_COLUMNS}
        FROM proposals
        WHERE status = 'open' AND kind = $kind AND target_memory_id = $targetId
          AND COALESCE(candidate_memory_id, '') = COALESCE($candidateId, '')
      `,
      { $kind: kind, $targetId: targetId, $candidateId: candidateId }
    );

    return row === null ? null : mapProposalRow(row);
  }

  create(input: CreateProposalInput): ProposalRecord {
    const kind = requireEnum(input.kind, "kind", PROPOSAL_KINDS);
    const createdBy = requireEnum(input.createdBy, "createdBy", PROPOSAL_CREATORS);
    const candidateId = orNull(input.candidateMemoryId);
    const open = this.findOpen(kind, input.targetMemoryId, candidateId);

    if (open !== null) {
      throw new ProposalAlreadyOpenError(open.id, kind, input.targetMemoryId, candidateId);
    }

    const id = input.id ?? randomUUID();
    const expiresAt = input.expiresAt ?? addDays(input.now, input.expiresInDays ?? DEFAULT_PROPOSAL_DAYS);

    this.db.run(
      `
        INSERT INTO proposals (
          id, kind, target_memory_id, candidate_memory_id, rationale, confidence, created_by,
          support_count, support_sessions, status, created_at, expires_at
        )
        VALUES ($id, $kind, $targetId, $candidateId, $rationale, $confidence, $createdBy, 0, 0, 'open', $createdAt, $expiresAt)
      `,
      {
        $id: id,
        $kind: kind,
        $targetId: input.targetMemoryId,
        $candidateId: candidateId,
        $rationale: input.rationale,
        $confidence: input.confidence,
        $createdBy: createdBy,
        $createdAt: input.now,
        $expiresAt: expiresAt,
      }
    );

    return this.require(id);
  }

  /** Upsert on (proposal_id, episode_id); re-citing the same episode refreshes its row instead of counting twice. */
  addSupport(proposalId: string, support: AddSupportInput): ProposalSupportRecord {
    this.require(proposalId);

    this.db.run(
      `
        INSERT INTO proposal_support (
          proposal_id, episode_id, session_id, extraction_run_id, confidence, created_at, has_human_signal, deterministic
        )
        VALUES ($proposalId, $episodeId, $sessionId, $extractionRunId, $confidence, $createdAt, $hasHumanSignal, $deterministic)
        ON CONFLICT(proposal_id, episode_id) DO UPDATE SET
          session_id = excluded.session_id,
          extraction_run_id = excluded.extraction_run_id,
          confidence = excluded.confidence,
          created_at = excluded.created_at,
          has_human_signal = MAX(proposal_support.has_human_signal, excluded.has_human_signal),
          deterministic = MAX(proposal_support.deterministic, excluded.deterministic)
      `,
      {
        $proposalId: proposalId,
        $episodeId: support.episodeId,
        $sessionId: support.sessionId,
        $extractionRunId: orNull(support.extractionRunId),
        $confidence: support.confidence,
        $createdAt: support.createdAt,
        $hasHumanSignal: support.hasHumanSignal ?? 0,
        $deterministic: support.deterministic ?? 0,
      }
    );

    const row = selectOne(
      this.db,
      `SELECT ${SUPPORT_COLUMNS} FROM proposal_support WHERE proposal_id = $proposalId AND episode_id = $episodeId`,
      { $proposalId: proposalId, $episodeId: support.episodeId }
    );

    if (row === null) {
      throw new Error(`Failed to load proposal support ${proposalId}/${support.episodeId}`);
    }

    return mapSupportRow(row);
  }

  listSupport(proposalId: string): ProposalSupportRecord[] {
    return selectAll(
      this.db,
      `SELECT ${SUPPORT_COLUMNS} FROM proposal_support WHERE proposal_id = $proposalId ORDER BY created_at ASC, episode_id ASC`,
      { $proposalId: proposalId }
    ).map(mapSupportRow);
  }

  /** support_count = COUNT(*), support_sessions = COUNT(DISTINCT session_id); written back and returned. */
  recomputeDerived(proposalId: string): ProposalDerivedCounts {
    this.require(proposalId);

    const row = selectOne(
      this.db,
      `
        SELECT COUNT(*) AS support_count, COUNT(DISTINCT session_id) AS support_sessions
        FROM proposal_support
        WHERE proposal_id = $proposalId
      `,
      { $proposalId: proposalId }
    );
    const counts: ProposalDerivedCounts = {
      supportCount: row === null ? 0 : expectNumber(row.support_count, "support_count"),
      supportSessions: row === null ? 0 : expectNumber(row.support_sessions, "support_sessions"),
    };

    this.db.run(
      "UPDATE proposals SET support_count = $supportCount, support_sessions = $supportSessions WHERE id = $id",
      { $id: proposalId, $supportCount: counts.supportCount, $supportSessions: counts.supportSessions }
    );

    return counts;
  }

  decide(id: string, input: DecideProposalInput): ProposalRecord {
    const existing = this.require(id);

    if (existing.status !== "open") {
      throw new Error(`Proposal ${id} is already ${existing.status}`);
    }

    const status = requireEnum(input.status, "status", ["accepted", "rejected", "expired"] as const);
    const decidedBy = requireEnum(input.decidedBy, "decidedBy", PROPOSAL_DECIDERS);

    this.db.run(
      `
        UPDATE proposals
        SET status = $status, decided_at = $decidedAt, decided_by = $decidedBy, decision_note = $note
        WHERE id = $id
      `,
      { $id: id, $status: status, $decidedAt: input.now, $decidedBy: decidedBy, $note: orNull(input.note) }
    );

    return this.require(id);
  }

  getById(id: string): ProposalRecord | null {
    const row = selectOne(this.db, `SELECT ${PROPOSAL_COLUMNS} FROM proposals WHERE id = $id`, { $id: id });

    return row === null ? null : mapProposalRow(row);
  }

  listOpen(options: ListOpenProposalsOptions = {}): ProposalRecord[] {
    const params: SqlParams = {};
    const where = ["status = 'open'"];

    if (options.kind !== undefined) {
      where.push("kind = $kind");
      params.$kind = options.kind;
    }

    if (options.targetId !== undefined) {
      where.push("target_memory_id = $targetId");
      params.$targetId = options.targetId;
    }

    if (options.candidateId !== undefined) {
      where.push("COALESCE(candidate_memory_id, '') = COALESCE($candidateId, '')");
      params.$candidateId = options.candidateId;
    }

    return selectAll(
      this.db,
      `SELECT ${PROPOSAL_COLUMNS} FROM proposals WHERE ${where.join(" AND ")} ORDER BY created_at ASC, rowid ASC`,
      params
    ).map(mapProposalRow);
  }

  /** Proposals where the memory is the target or the candidate, any status, newest first. */
  listForMemory(memoryId: string, options: { status?: ProposalStatus } = {}): ProposalRecord[] {
    const params: SqlParams = { $memoryId: memoryId };
    const where = ["(target_memory_id = $memoryId OR candidate_memory_id = $memoryId)"];

    if (options.status !== undefined) {
      where.push("status = $status");
      params.$status = options.status;
    }

    return selectAll(
      this.db,
      `SELECT ${PROPOSAL_COLUMNS} FROM proposals WHERE ${where.join(" AND ")} ORDER BY created_at DESC, rowid DESC`,
      params
    ).map(mapProposalRow);
  }

  listDecided(options: ListDecidedProposalsOptions = {}): ProposalRecord[] {
    const params: SqlParams = {};
    const where = ["status <> 'open'"];

    if (options.kind !== undefined) {
      where.push("kind = $kind");
      params.$kind = options.kind;
    }

    if (options.targetId !== undefined) {
      where.push("target_memory_id = $targetId");
      params.$targetId = options.targetId;
    }

    if (options.status !== undefined) {
      where.push("status = $status");
      params.$status = options.status;
    }

    if (options.since !== undefined) {
      where.push("decided_at IS NOT NULL AND decided_at >= $since");
      params.$since = options.since;
    }

    return selectAll(
      this.db,
      `SELECT ${PROPOSAL_COLUMNS} FROM proposals WHERE ${where.join(" AND ")} ORDER BY decided_at DESC, rowid DESC`,
      params
    ).map(mapProposalRow);
  }

  /** Open proposals with expires_at <= now become `expired` (decided_by 'expiry'). Returns their ids. */
  expire(now: string): string[] {
    const ids = selectAll(
      this.db,
      "SELECT id FROM proposals WHERE status = 'open' AND expires_at <= $now ORDER BY expires_at ASC, rowid ASC",
      { $now: now }
    ).map((row) => expectString(row.id, "id"));

    for (const id of ids) {
      this.db.run(
        `
          UPDATE proposals
          SET status = 'expired', decided_at = $now, decided_by = 'expiry', decision_note = 'expired'
          WHERE id = $id AND status = 'open'
        `,
        { $id: id, $now: now }
      );
    }

    return ids;
  }

  countOpen(): number {
    const row = selectOne(this.db, "SELECT COUNT(*) AS n FROM proposals WHERE status = 'open'");

    return row === null ? 0 : expectNumber(row.n, "n");
  }

  /** Open proposals expiring within `days` of `now` (the daily digest's "M expiring"). */
  countExpiringWithin(now: string, days: number): number {
    const row = selectOne(
      this.db,
      "SELECT COUNT(*) AS n FROM proposals WHERE status = 'open' AND expires_at <= $until",
      { $until: addDays(now, nonNegativeInt(days, "days")) }
    );

    return row === null ? 0 : expectNumber(row.n, "n");
  }

  private require(id: string): ProposalRecord {
    const proposal = this.getById(id);

    if (proposal === null) {
      throw new Error(`Proposal ${id} was not found`);
    }

    return proposal;
  }
}

export function mapProposalRow(row: SqlRow): ProposalRecord {
  return {
    id: expectString(row.id, "id"),
    kind: expectEnum(row.kind, "kind", PROPOSAL_KINDS),
    targetMemoryId: expectString(row.target_memory_id, "target_memory_id"),
    candidateMemoryId: expectNullableString(row.candidate_memory_id, "candidate_memory_id"),
    rationale: expectString(row.rationale, "rationale"),
    confidence: expectNumber(row.confidence, "confidence"),
    createdBy: expectEnum(row.created_by, "created_by", PROPOSAL_CREATORS),
    supportCount: expectNumber(row.support_count, "support_count"),
    supportSessions: expectNumber(row.support_sessions, "support_sessions"),
    status: expectEnum(row.status, "status", PROPOSAL_STATUSES),
    createdAt: expectString(row.created_at, "created_at"),
    expiresAt: expectString(row.expires_at, "expires_at"),
    decidedAt: expectNullableString(row.decided_at, "decided_at"),
    decidedBy: expectNullableEnum(row.decided_by, "decided_by", PROPOSAL_DECIDERS),
    decisionNote: expectNullableString(row.decision_note, "decision_note"),
  };
}

export function mapSupportRow(row: SqlRow): ProposalSupportRecord {
  return {
    proposalId: expectString(row.proposal_id, "proposal_id"),
    episodeId: expectString(row.episode_id, "episode_id"),
    sessionId: expectString(row.session_id, "session_id"),
    extractionRunId: expectNullableString(row.extraction_run_id, "extraction_run_id"),
    confidence: expectNumber(row.confidence, "confidence"),
    createdAt: expectString(row.created_at, "created_at"),
    hasHumanSignal: expectFlag(row.has_human_signal, "has_human_signal"),
    deterministic: expectFlag(row.deterministic, "deterministic"),
  };
}
