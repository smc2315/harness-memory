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
  DreamRunRecord,
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
  "contradiction_signal",
  "status",
  "dream_run_id",
  "created_at",
  "consumed_at",
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

function nowIsoString(): string {
  return new Date().toISOString();
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
    contradictionSignal: Number(values[14]) === 1,
    status: values[15] as DreamEvidenceStatus,
    dreamRunId: values[16] === null ? null : String(values[16]),
    createdAt: String(values[17]),
    consumedAt: values[18] === null ? null : String(values[18]),
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

  markEvidenceEventsConsumed(
    ids: readonly string[],
    dreamRunId: string,
    consumedAt: string = nowIsoString()
  ): void {
    for (const id of ids) {
      this.db.run(
        `UPDATE dream_evidence_events
         SET status = 'consumed',
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
