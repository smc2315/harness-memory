import type { Database as SqlJsDatabase } from "sql.js";

import type {
  DreamEvidenceStatus,
  DreamTrigger,
} from "../db/schema/types";
import { createDeterministicId } from "../memory";

import type {
  CompleteDreamRunInput,
  CreateDreamEvidenceEventInput,
  CreateDreamRunInput,
  DreamEvidenceEventRecord,
  DreamEvidenceLinkRecord,
  DreamRunRecord,
  ListDreamRunsInput,
  ListDreamEvidenceEventsInput,
} from "./types";

type SqlParameter = string | number | null;
type SqlParameters = Record<string, SqlParameter>;

const DREAM_EVIDENCE_COLUMNS = [
  "id",
  "session_id",
  "call_id",
  "tool_name",
  "scope_ref",
  "source_ref",
  "title",
  "excerpt",
  "args_json",
  "metadata_json",
  "topic_guess",
  "type_guess",
  "salience",
  "novelty",
  "salience_boost",
  "contradiction_signal",
  "status",
  "retry_count",
  "next_review_at",
  "last_reviewed_at",
  "dream_run_id",
  "created_at",
  "consumed_at",
  "discarded_at",
].join(", ");

const DREAM_EVIDENCE_COLUMNS_PREFIXED = [
  "evidence.id",
  "evidence.session_id",
  "evidence.call_id",
  "evidence.tool_name",
  "evidence.scope_ref",
  "evidence.source_ref",
  "evidence.title",
  "evidence.excerpt",
  "evidence.args_json",
  "evidence.metadata_json",
  "evidence.topic_guess",
  "evidence.type_guess",
  "evidence.salience",
  "evidence.novelty",
  "evidence.salience_boost",
  "evidence.contradiction_signal",
  "evidence.status",
  "evidence.retry_count",
  "evidence.next_review_at",
  "evidence.last_reviewed_at",
  "evidence.dream_run_id",
  "evidence.created_at",
  "evidence.consumed_at",
  "evidence.discarded_at",
].join(", ");

const DREAM_RUN_COLUMNS = [
  "id",
  "trigger",
  "status",
  "window_start",
  "window_end",
  "evidence_count",
  "candidate_count",
  "summary",
  "created_at",
  "completed_at",
].join(", ");

const DREAM_LINK_COLUMNS = [
  "evidence_event_id",
  "memory_id",
  "dream_run_id",
  "created_at",
].join(", ");

function nowIsoString(): string {
  return new Date().toISOString();
}

function subtractDays(isoString: string, days: number): string {
  return new Date(Date.parse(isoString) - days * 24 * 60 * 60 * 1000).toISOString();
}

function parseDreamEvidenceRow(values: readonly unknown[]): DreamEvidenceEventRecord {
  return {
    id: String(values[0]),
    sessionId: String(values[1]),
    callId: String(values[2]),
    toolName: String(values[3]),
    scopeRef: String(values[4]),
    sourceRef: String(values[5]),
    title: String(values[6]),
    excerpt: String(values[7]),
    argsJson: String(values[8]),
    metadataJson: values[9] === null ? null : String(values[9]),
    topicGuess: String(values[10]),
    typeGuess: values[11] as DreamEvidenceEventRecord["typeGuess"],
    salience: Number(values[12]),
    novelty: Number(values[13]),
    salienceBoost: Number(values[14]),
    contradictionSignal: Number(values[15]) === 1,
    status: values[16] as DreamEvidenceStatus,
    retryCount: Number(values[17]),
    nextReviewAt: values[18] === null ? null : String(values[18]),
    lastReviewedAt: values[19] === null ? null : String(values[19]),
    dreamRunId: values[20] === null ? null : String(values[20]),
    createdAt: String(values[21]),
    consumedAt: values[22] === null ? null : String(values[22]),
    discardedAt: values[23] === null ? null : String(values[23]),
  };
}

function parseDreamRunRow(values: readonly unknown[]): DreamRunRecord {
  return {
    id: String(values[0]),
    trigger: values[1] as DreamTrigger,
    status: values[2] as DreamRunRecord["status"],
    windowStart: String(values[3]),
    windowEnd: String(values[4]),
    evidenceCount: Number(values[5]),
    candidateCount: Number(values[6]),
    summary: String(values[7]),
    createdAt: String(values[8]),
    completedAt: values[9] === null ? null : String(values[9]),
  };
}

function parseDreamEvidenceLinkRow(values: readonly unknown[]): DreamEvidenceLinkRecord {
  return {
    evidenceEventId: String(values[0]),
    memoryId: String(values[1]),
    dreamRunId: String(values[2]),
    createdAt: String(values[3]),
  };
}

export class DreamRepository {
  readonly db: SqlJsDatabase;

  constructor(db: SqlJsDatabase) {
    this.db = db;
  }

  createEvidenceEvent(input: CreateDreamEvidenceEventInput): DreamEvidenceEventRecord {
    const createdAt = input.createdAt ?? nowIsoString();
    const id =
      input.id ??
      createDeterministicId(
        `dream-evidence:${input.sessionId}:${input.callId}:${input.toolName}:${createdAt}`
      );
    const argsJson = JSON.stringify(input.args);
    const metadataJson = input.metadata === undefined ? null : JSON.stringify(input.metadata);
    const contradictionSignal = input.contradictionSignal === true ? 1 : 0;

    this.db.run(
      `INSERT INTO dream_evidence_events (
        id,
        session_id,
        call_id,
        tool_name,
        scope_ref,
        source_ref,
        title,
        excerpt,
        args_json,
        metadata_json,
        topic_guess,
        type_guess,
        salience,
        novelty,
        salience_boost,
        contradiction_signal,
        status,
        created_at
      ) VALUES (
        $id,
        $sessionId,
        $callId,
        $toolName,
        $scopeRef,
        $sourceRef,
        $title,
        $excerpt,
        $argsJson,
        $metadataJson,
        $topicGuess,
        $typeGuess,
        $salience,
        $novelty,
        $salienceBoost,
        $contradictionSignal,
        'pending',
        $createdAt
      )`,
      {
        $id: id,
        $sessionId: input.sessionId,
        $callId: input.callId,
        $toolName: input.toolName,
        $scopeRef: input.scopeRef,
        $sourceRef: input.sourceRef,
        $title: input.title,
        $excerpt: input.excerpt,
        $argsJson: argsJson,
        $metadataJson: metadataJson,
        $topicGuess: input.topicGuess,
        $typeGuess: input.typeGuess,
        $salience: input.salience,
        $novelty: input.novelty,
        $salienceBoost: input.salienceBoost ?? 0,
        $contradictionSignal: contradictionSignal,
        $createdAt: createdAt,
      } satisfies SqlParameters
    );

    return this.getEvidenceEventById(id)!;
  }

  getEvidenceEventById(id: string): DreamEvidenceEventRecord | null {
    const result = this.db.exec(
      `SELECT ${DREAM_EVIDENCE_COLUMNS} FROM dream_evidence_events WHERE id = $id`,
      { $id: id }
    );

    if (result.length === 0 || result[0].values.length === 0) {
      return null;
    }

    return parseDreamEvidenceRow(result[0].values[0]);
  }

  listEvidenceEvents(input: ListDreamEvidenceEventsInput = {}): DreamEvidenceEventRecord[] {
    const clauses: string[] = [];
    const params: SqlParameters = {};

    if (input.sessionId !== undefined) {
      clauses.push("session_id = $sessionId");
      params.$sessionId = input.sessionId;
    }

    if (input.status !== undefined) {
      const statuses = Array.isArray(input.status) ? input.status : [input.status];
      const placeholders = statuses.map((_, index) => `$status${index}`);
      clauses.push(`status IN (${placeholders.join(", ")})`);
      statuses.forEach((status, index) => {
        params[`$status${index}`] = status;
      });
    }

    if (input.createdAfter !== undefined) {
      clauses.push("created_at >= $createdAfter");
      params.$createdAfter = input.createdAfter;
    }

    const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const limitClause = input.limit === undefined ? "" : ` LIMIT ${input.limit}`;
    const result = this.db.exec(
      `SELECT ${DREAM_EVIDENCE_COLUMNS} FROM dream_evidence_events ${whereClause} ORDER BY created_at ASC${limitClause}`,
      params
    );

    if (result.length === 0) {
      return [];
    }

    return result[0].values.map((row) => parseDreamEvidenceRow(row));
  }

  listProcessableEvidenceEvents(
    now: string,
    input: Omit<ListDreamEvidenceEventsInput, "status"> = {}
  ): DreamEvidenceEventRecord[] {
    const clauses: string[] = [
      "(status IN ('pending', 'retained') OR (status = 'latent' AND next_review_at IS NOT NULL AND next_review_at <= $now))",
    ];
    const params: SqlParameters = { $now: now };

    if (input.sessionId !== undefined) {
      clauses.push("session_id = $sessionId");
      params.$sessionId = input.sessionId;
    }

    if (input.createdAfter !== undefined) {
      clauses.push("created_at >= $createdAfter");
      params.$createdAfter = input.createdAfter;
    }

    const limitClause = input.limit === undefined ? "" : ` LIMIT ${input.limit}`;
    const result = this.db.exec(
      `SELECT ${DREAM_EVIDENCE_COLUMNS} FROM dream_evidence_events WHERE ${clauses.join(" AND ")} ORDER BY created_at ASC${limitClause}`,
      params
    );

    if (result.length === 0) {
      return [];
    }

    return result[0].values.map((row) => parseDreamEvidenceRow(row));
  }

  markEvidenceEventsRetained(
    ids: readonly string[],
    dreamRunId: string,
    retainedAt: string = nowIsoString()
  ): void {
    for (const id of ids) {
      this.db.run(
        `UPDATE dream_evidence_events
         SET status = 'retained',
             retry_count = retry_count + 1,
             next_review_at = NULL,
             last_reviewed_at = $retainedAt,
             dream_run_id = $dreamRunId
         WHERE id = $id`,
        {
          $id: id,
          $retainedAt: retainedAt,
          $dreamRunId: dreamRunId,
        } satisfies SqlParameters
      );
    }
  }

  markEvidenceEventsGrouped(
    ids: readonly string[],
    dreamRunId: string,
    groupedAt: string = nowIsoString()
  ): void {
    for (const id of ids) {
      this.db.run(
        `UPDATE dream_evidence_events
         SET status = 'grouped',
             retry_count = retry_count + 1,
             last_reviewed_at = $groupedAt,
             dream_run_id = $dreamRunId
         WHERE id = $id`,
        {
          $id: id,
          $groupedAt: groupedAt,
          $dreamRunId: dreamRunId,
        } satisfies SqlParameters
      );
    }
  }

  markEvidenceEventsMaterialized(
    ids: readonly string[],
    dreamRunId: string,
    materializedAt: string = nowIsoString()
  ): void {
    for (const id of ids) {
      this.db.run(
        `UPDATE dream_evidence_events
         SET status = 'materialized',
             retry_count = retry_count + 1,
             next_review_at = NULL,
             last_reviewed_at = $materializedAt,
             dream_run_id = $dreamRunId,
             consumed_at = $materializedAt
         WHERE id = $id`,
        {
          $id: id,
          $materializedAt: materializedAt,
          $dreamRunId: dreamRunId,
        } satisfies SqlParameters
      );
    }
  }

  markEvidenceEventsLatent(
    ids: readonly string[],
    dreamRunId: string,
    latentAt: string = nowIsoString()
  ): void {
    for (const id of ids) {
      this.db.run(
        `UPDATE dream_evidence_events
         SET status = 'latent',
             retry_count = retry_count + 1,
             next_review_at = NULL,
             last_reviewed_at = $latentAt,
             dream_run_id = $dreamRunId
         WHERE id = $id`,
        {
          $id: id,
          $latentAt: latentAt,
          $dreamRunId: dreamRunId,
        } satisfies SqlParameters
      );
    }
  }

  markEvidenceEventsConsumed(
    ids: readonly string[],
    dreamRunId: string,
    consumedAt: string = nowIsoString()
  ): void {
    for (const id of ids) {
      this.db.run(
        `UPDATE dream_evidence_events
         SET status = 'consumed',
             retry_count = retry_count + 1,
             next_review_at = NULL,
             last_reviewed_at = $consumedAt,
             dream_run_id = $dreamRunId,
             consumed_at = $consumedAt
         WHERE id = $id`,
        {
          $id: id,
          $dreamRunId: dreamRunId,
          $consumedAt: consumedAt,
        } satisfies SqlParameters
      );
    }
  }

  cleanupExpiredLatentEvidence(ttlDays: number, now: string = nowIsoString()): string[] {
    const cutoff = subtractDays(now, ttlDays);
    const result = this.db.exec(
      `SELECT id
       FROM dream_evidence_events
       WHERE status = 'latent'
         AND created_at < $cutoff
       ORDER BY created_at ASC`,
      { $cutoff: cutoff } satisfies SqlParameters
    );

    if (result.length === 0) {
      return [];
    }

    const ids = result[0].values.map((row) => String(row[0]));
    for (const id of ids) {
      this.db.run(
        `UPDATE dream_evidence_events
         SET status = 'discarded',
             discarded_at = $now
         WHERE id = $id`,
        {
          $id: id,
          $now: now,
        } satisfies SqlParameters
      );
    }

    return ids;
  }

  markEvidenceEventsDeferred(
    items: ReadonlyArray<{ id: string; nextReviewAt: string }>,
    dreamRunId: string,
    reviewedAt: string = nowIsoString()
  ): void {
    for (const item of items) {
      this.db.run(
        `UPDATE dream_evidence_events
         SET status = 'deferred',
             retry_count = retry_count + 1,
             next_review_at = $nextReviewAt,
             last_reviewed_at = $reviewedAt,
             dream_run_id = $dreamRunId
         WHERE id = $id`,
        {
          $id: item.id,
          $nextReviewAt: item.nextReviewAt,
          $reviewedAt: reviewedAt,
          $dreamRunId: dreamRunId,
        } satisfies SqlParameters
      );
    }
  }

  markEvidenceEventsDiscarded(
    ids: readonly string[],
    dreamRunId: string,
    discardedAt: string = nowIsoString()
  ): void {
    for (const id of ids) {
      this.db.run(
        `UPDATE dream_evidence_events
         SET status = 'discarded',
             retry_count = retry_count + 1,
             next_review_at = NULL,
             last_reviewed_at = $discardedAt,
             dream_run_id = $dreamRunId,
             discarded_at = $discardedAt
         WHERE id = $id`,
        {
          $id: id,
          $discardedAt: discardedAt,
          $dreamRunId: dreamRunId,
        } satisfies SqlParameters
      );
    }
  }

  createEvidenceLinks(
    memoryId: string,
    evidenceEventIds: readonly string[],
    dreamRunId: string,
    createdAt: string = nowIsoString()
  ): void {
    for (const evidenceEventId of evidenceEventIds) {
      this.db.run(
        `INSERT OR IGNORE INTO dream_memory_evidence_links (
           evidence_event_id,
           memory_id,
           dream_run_id,
           created_at
         ) VALUES (
           $evidenceEventId,
           $memoryId,
           $dreamRunId,
           $createdAt
         )`,
        {
          $evidenceEventId: evidenceEventId,
          $memoryId: memoryId,
          $dreamRunId: dreamRunId,
          $createdAt: createdAt,
        } satisfies SqlParameters
      );
    }
  }

  listLinkedEvidenceByMemoryIds(
    memoryIds: readonly string[]
  ): Map<string, DreamEvidenceEventRecord[]> {
    if (memoryIds.length === 0) {
      return new Map();
    }

    const params: SqlParameters = {};
    const placeholders = memoryIds.map((_, index) => {
      const key = `$memoryId${index}`;
      params[key] = memoryIds[index]!;
      return key;
    });

    const result = this.db.exec(
      `SELECT links.memory_id, ${DREAM_EVIDENCE_COLUMNS_PREFIXED}
       FROM dream_memory_evidence_links links
       JOIN dream_evidence_events evidence ON evidence.id = links.evidence_event_id
       WHERE links.memory_id IN (${placeholders.join(", ")})
       ORDER BY evidence.created_at ASC, evidence.id ASC`,
      params
    );

    const map = new Map<string, DreamEvidenceEventRecord[]>();
    if (result.length === 0) {
      return map;
    }

    for (const row of result[0].values) {
      const memoryId = String(row[0]);
      const evidence = parseDreamEvidenceRow(row.slice(1));
      const items = map.get(memoryId) ?? [];
      items.push(evidence);
      map.set(memoryId, items);
    }

    return map;
  }

  listEvidenceLinksByRunId(runId: string): DreamEvidenceLinkRecord[] {
    const result = this.db.exec(
      `SELECT ${DREAM_LINK_COLUMNS} FROM dream_memory_evidence_links WHERE dream_run_id = $runId ORDER BY created_at ASC`,
      { $runId: runId }
    );

    if (result.length === 0) {
      return [];
    }

    return result[0].values.map((row) => parseDreamEvidenceLinkRow(row));
  }

  listLinkedEvidenceByRunId(runId: string): DreamEvidenceEventRecord[] {
    const result = this.db.exec(
      `SELECT ${DREAM_EVIDENCE_COLUMNS_PREFIXED}
       FROM dream_memory_evidence_links links
       JOIN dream_evidence_events evidence ON evidence.id = links.evidence_event_id
       WHERE links.dream_run_id = $runId
       ORDER BY evidence.created_at ASC, evidence.id ASC`,
      { $runId: runId }
    );

    if (result.length === 0) {
      return [];
    }

    return result[0].values.map((row) => parseDreamEvidenceRow(row));
  }

  listAtRiskMemories(opts: {
    staleAfterDays?: number;
    minConfidence?: number;
  } = {}): Array<{
    id: string;
    type: string;
    summary: string;
    confidence: number;
    lastVerifiedAt: string | null;
  }> {
    const staleAfterDays = opts.staleAfterDays ?? 7;
    const minConfidence = opts.minConfidence ?? 0.7;
    const now = nowIsoString();
    const staleThreshold = subtractDays(now, staleAfterDays);
    const result = this.db.exec(
      `SELECT id, type, summary, confidence, last_verified_at
       FROM memories
       WHERE status = 'active'
         AND (
           last_verified_at IS NULL
           OR last_verified_at < $staleThreshold
           OR confidence < $minConfidence
         )
       ORDER BY last_verified_at ASC, confidence ASC, id ASC`,
      {
        $staleThreshold: staleThreshold,
        $minConfidence: minConfidence,
      } satisfies SqlParameters
    );

    if (result.length === 0) {
      return [];
    }

    return result[0].values.map((row) => ({
      id: String(row[0]),
      type: String(row[1]),
      summary: String(row[2]),
      confidence: Number(row[3]),
      lastVerifiedAt: row[4] === null ? null : String(row[4]),
    }));
  }

  listDreamRuns(input: ListDreamRunsInput = {}): DreamRunRecord[] {
    const clauses: string[] = [];
    const params: SqlParameters = {};

    if (input.trigger !== undefined) {
      const triggers = Array.isArray(input.trigger) ? input.trigger : [input.trigger];
      const placeholders = triggers.map((_, index) => `$trigger${index}`);
      clauses.push(`trigger IN (${placeholders.join(", ")})`);
      triggers.forEach((trigger, index) => {
        params[`$trigger${index}`] = trigger;
      });
    }

    if (input.status !== undefined) {
      const statuses = Array.isArray(input.status) ? input.status : [input.status];
      const placeholders = statuses.map((_, index) => `$runStatus${index}`);
      clauses.push(`status IN (${placeholders.join(", ")})`);
      statuses.forEach((status, index) => {
        params[`$runStatus${index}`] = status;
      });
    }

    const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const limitClause = input.limit === undefined ? "" : ` LIMIT ${input.limit}`;
    const result = this.db.exec(
      `SELECT ${DREAM_RUN_COLUMNS} FROM dream_runs ${whereClause} ORDER BY created_at DESC${limitClause}`,
      params
    );

    if (result.length === 0) {
      return [];
    }

    return result[0].values.map((row) => parseDreamRunRow(row));
  }

  createDreamRun(input: CreateDreamRunInput): DreamRunRecord {
    const createdAt = input.createdAt ?? nowIsoString();
    const id =
      input.id ??
      createDeterministicId(
        `dream-run:${input.trigger}:${input.windowStart}:${input.windowEnd}:${createdAt}`
      );

    this.db.run(
      `INSERT INTO dream_runs (
        id,
        trigger,
        status,
        window_start,
        window_end,
        evidence_count,
        candidate_count,
        summary,
        created_at
      ) VALUES (
        $id,
        $trigger,
        'started',
        $windowStart,
        $windowEnd,
        $evidenceCount,
        $candidateCount,
        $summary,
        $createdAt
      )`,
      {
        $id: id,
        $trigger: input.trigger,
        $windowStart: input.windowStart,
        $windowEnd: input.windowEnd,
        $evidenceCount: input.evidenceCount ?? 0,
        $candidateCount: input.candidateCount ?? 0,
        $summary: input.summary ?? "Dream run started",
        $createdAt: createdAt,
      } satisfies SqlParameters
    );

    return this.getDreamRunById(id)!;
  }

  getDreamRunById(id: string): DreamRunRecord | null {
    const result = this.db.exec(
      `SELECT ${DREAM_RUN_COLUMNS} FROM dream_runs WHERE id = $id`,
      { $id: id }
    );

    if (result.length === 0 || result[0].values.length === 0) {
      return null;
    }

    return parseDreamRunRow(result[0].values[0]);
  }

  completeDreamRun(id: string, input: CompleteDreamRunInput): DreamRunRecord {
    const completedAt = input.completedAt ?? nowIsoString();

    this.db.run(
      `UPDATE dream_runs
       SET status = $status,
           summary = $summary,
           candidate_count = $candidateCount,
           completed_at = $completedAt
       WHERE id = $id`,
      {
        $id: id,
        $status: input.status,
        $summary: input.summary,
        $candidateCount: input.candidateCount,
        $completedAt: completedAt,
      } satisfies SqlParameters
    );

    return this.getDreamRunById(id)!;
  }
}
