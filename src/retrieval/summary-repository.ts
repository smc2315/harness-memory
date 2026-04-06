import type { Database as SqlJsDatabase } from "sql.js";

import { createDeterministicId } from "../memory";

type SqlParameter = string | number | Uint8Array | null;
type SqlParameters = Record<string, SqlParameter>;

const SESSION_SUMMARY_COLUMNS = [
  "id",
  "session_id",
  "summary_short",
  "summary_medium",
  "embedding",
  "source_event_ids",
  "tool_names",
  "type_distribution",
  "event_count",
  "created_at",
  "updated_at",
].join(", ");

const TOPIC_SUMMARY_COLUMNS = [
  "id",
  "canonical_topic",
  "summary_short",
  "summary_medium",
  "embedding",
  "supporting_session_ids",
  "source_event_ids",
  "created_at",
  "updated_at",
].join(", ");

export interface SessionSummaryRecord {
  id: string;
  sessionId: string;
  summaryShort: string;
  summaryMedium: string;
  embedding: Float32Array | null;
  sourceEventIds: string[];
  toolNames: string[];
  typeDistribution: Record<string, number>;
  eventCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface TopicSummaryRecord {
  id: string;
  canonicalTopic: string;
  summaryShort: string;
  summaryMedium: string;
  embedding: Float32Array | null;
  supportingSessionIds: string[];
  sourceEventIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface CreateSessionSummaryInput {
  sessionId: string;
  summaryShort: string;
  summaryMedium: string;
  embedding?: Float32Array | null;
  sourceEventIds: string[];
  toolNames: string[];
  typeDistribution: Record<string, number>;
  eventCount: number;
}

export interface CreateTopicSummaryInput {
  canonicalTopic: string;
  summaryShort: string;
  summaryMedium: string;
  embedding?: Float32Array | null;
  supportingSessionIds: string[];
  sourceEventIds: string[];
}

function nowIsoString(): string {
  return new Date().toISOString();
}

function normalizeLimit(limit: number | undefined): number | undefined {
  if (limit === undefined) {
    return undefined;
  }

  if (!Number.isInteger(limit) || limit < 0) {
    throw new Error(`Expected limit to be a non-negative integer, received ${String(limit)}`);
  }

  return limit;
}

function expectString(value: unknown, column: string): string {
  if (typeof value !== "string") {
    throw new Error(`Expected ${column} to be a string`);
  }

  return value;
}

function expectNumber(value: unknown, column: string): number {
  if (typeof value !== "number") {
    throw new Error(`Expected ${column} to be a number`);
  }

  return value;
}

function parseStringArrayJson(value: unknown, column: string): string[] {
  const serialized = expectString(value, column);
  let parsed: unknown;

  try {
    parsed = JSON.parse(serialized);
  } catch (error) {
    throw new Error(`Invalid ${column} JSON: ${String(error)}`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error(`Invalid ${column} JSON: expected an array`);
  }

  const items: string[] = [];

  for (const entry of parsed) {
    if (typeof entry !== "string") {
      throw new Error(`Invalid ${column} value: ${String(entry)}`);
    }

    items.push(entry);
  }

  return items;
}

function parseNumberRecordJson(value: unknown, column: string): Record<string, number> {
  const serialized = expectString(value, column);
  let parsed: unknown;

  try {
    parsed = JSON.parse(serialized);
  } catch (error) {
    throw new Error(`Invalid ${column} JSON: ${String(error)}`);
  }

  if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error(`Invalid ${column} JSON: expected an object`);
  }

  const record: Record<string, number> = {};

  for (const [key, entry] of Object.entries(parsed)) {
    if (typeof entry !== "number") {
      throw new Error(`Invalid ${column} value for ${key}: ${String(entry)}`);
    }

    record[key] = entry;
  }

  return record;
}

function serializeStringArray(values: readonly string[]): string {
  return JSON.stringify([...new Set(values)]);
}

function serializeNumberRecord(record: Record<string, number>): string {
  const normalized: Record<string, number> = {};

  for (const key of Object.keys(record).sort((left, right) => left.localeCompare(right))) {
    normalized[key] = record[key]!;
  }

  return JSON.stringify(normalized);
}

function toEmbeddingBlob(embedding: Float32Array | null | undefined): Uint8Array | null {
  if (embedding === undefined || embedding === null) {
    return null;
  }

  return new Uint8Array(embedding.buffer, embedding.byteOffset, embedding.byteLength);
}

function parseEmbedding(value: unknown): Float32Array | null {
  if (value === null) {
    return null;
  }

  if (!(value instanceof Uint8Array)) {
    throw new Error("Expected embedding to be a Uint8Array or null");
  }

  return new Float32Array(value.buffer, value.byteOffset, value.byteLength / 4);
}

function createSessionSummaryId(sessionId: string): string {
  return createDeterministicId(`session-summary:${sessionId}`);
}

function createTopicSummaryId(canonicalTopic: string): string {
  return createDeterministicId(`topic-summary:${canonicalTopic}`);
}

function parseSessionSummaryRow(values: readonly unknown[]): SessionSummaryRecord {
  return {
    id: expectString(values[0], "id"),
    sessionId: expectString(values[1], "session_id"),
    summaryShort: expectString(values[2], "summary_short"),
    summaryMedium: expectString(values[3], "summary_medium"),
    embedding: parseEmbedding(values[4]),
    sourceEventIds: parseStringArrayJson(values[5], "source_event_ids"),
    toolNames: parseStringArrayJson(values[6], "tool_names"),
    typeDistribution: parseNumberRecordJson(values[7], "type_distribution"),
    eventCount: expectNumber(values[8], "event_count"),
    createdAt: expectString(values[9], "created_at"),
    updatedAt: expectString(values[10], "updated_at"),
  };
}

function parseTopicSummaryRow(values: readonly unknown[]): TopicSummaryRecord {
  return {
    id: expectString(values[0], "id"),
    canonicalTopic: expectString(values[1], "canonical_topic"),
    summaryShort: expectString(values[2], "summary_short"),
    summaryMedium: expectString(values[3], "summary_medium"),
    embedding: parseEmbedding(values[4]),
    supportingSessionIds: parseStringArrayJson(values[5], "supporting_session_ids"),
    sourceEventIds: parseStringArrayJson(values[6], "source_event_ids"),
    createdAt: expectString(values[7], "created_at"),
    updatedAt: expectString(values[8], "updated_at"),
  };
}

export interface SummaryRepository {
  createSessionSummary(input: CreateSessionSummaryInput): SessionSummaryRecord;
  upsertSessionSummary(input: CreateSessionSummaryInput): SessionSummaryRecord;
  getSessionSummaryBySessionId(sessionId: string): SessionSummaryRecord | null;
  listSessionSummaries(opts?: {
    limit?: number;
    orderBy?: "updated_at" | "created_at";
  }): SessionSummaryRecord[];
  createTopicSummary(input: CreateTopicSummaryInput): TopicSummaryRecord;
  getTopicSummaryByTopic(canonicalTopic: string): TopicSummaryRecord | null;
  listTopicSummaries(opts?: { limit?: number }): TopicSummaryRecord[];
}

export class SummaryRepository {
  constructor(private readonly db: SqlJsDatabase) {}

  createSessionSummary(input: CreateSessionSummaryInput): SessionSummaryRecord {
    const createdAt = nowIsoString();
    const id = createSessionSummaryId(input.sessionId);

    this.db.run(
      `INSERT INTO session_summaries (
        id,
        session_id,
        summary_short,
        summary_medium,
        embedding,
        source_event_ids,
        tool_names,
        type_distribution,
        event_count,
        created_at,
        updated_at
      ) VALUES (
        $id,
        $sessionId,
        $summaryShort,
        $summaryMedium,
        $embedding,
        $sourceEventIds,
        $toolNames,
        $typeDistribution,
        $eventCount,
        $createdAt,
        $updatedAt
      )`,
      {
        $id: id,
        $sessionId: input.sessionId,
        $summaryShort: input.summaryShort,
        $summaryMedium: input.summaryMedium,
        $embedding: toEmbeddingBlob(input.embedding),
        $sourceEventIds: serializeStringArray(input.sourceEventIds),
        $toolNames: serializeStringArray(input.toolNames),
        $typeDistribution: serializeNumberRecord(input.typeDistribution),
        $eventCount: input.eventCount,
        $createdAt: createdAt,
        $updatedAt: createdAt,
      } satisfies SqlParameters
    );

    return this.getSessionSummaryBySessionId(input.sessionId)!;
  }

  upsertSessionSummary(input: CreateSessionSummaryInput): SessionSummaryRecord {
    const existing = this.getSessionSummaryBySessionId(input.sessionId);
    if (existing === null) {
      return this.createSessionSummary(input);
    }

    const embeddingBlob =
      input.embedding === undefined ? toEmbeddingBlob(existing.embedding) : toEmbeddingBlob(input.embedding);

    this.db.run(
      `UPDATE session_summaries
       SET summary_short = $summaryShort,
           summary_medium = $summaryMedium,
           embedding = $embedding,
           source_event_ids = $sourceEventIds,
           tool_names = $toolNames,
           type_distribution = $typeDistribution,
           event_count = $eventCount,
           updated_at = $updatedAt
       WHERE session_id = $sessionId`,
      {
        $sessionId: input.sessionId,
        $summaryShort: input.summaryShort,
        $summaryMedium: input.summaryMedium,
        $embedding: embeddingBlob,
        $sourceEventIds: serializeStringArray(input.sourceEventIds),
        $toolNames: serializeStringArray(input.toolNames),
        $typeDistribution: serializeNumberRecord(input.typeDistribution),
        $eventCount: input.eventCount,
        $updatedAt: nowIsoString(),
      } satisfies SqlParameters
    );

    return this.getSessionSummaryBySessionId(input.sessionId)!;
  }

  getSessionSummaryBySessionId(sessionId: string): SessionSummaryRecord | null {
    const result = this.db.exec(
      `SELECT ${SESSION_SUMMARY_COLUMNS} FROM session_summaries WHERE session_id = $sessionId`,
      { $sessionId: sessionId } satisfies SqlParameters
    );

    if (result.length === 0 || result[0].values.length === 0) {
      return null;
    }

    return parseSessionSummaryRow(result[0].values[0]);
  }

  listSessionSummaries(opts: {
    limit?: number;
    orderBy?: "updated_at" | "created_at";
  } = {}): SessionSummaryRecord[] {
    const orderBy = opts.orderBy === "created_at" ? "created_at" : "updated_at";
    const limit = normalizeLimit(opts.limit);
    const params: SqlParameters = {};

    if (limit !== undefined) {
      params.$limit = limit;
    }

    const limitClause = limit === undefined ? "" : " LIMIT $limit";
    const result = this.db.exec(
      `SELECT ${SESSION_SUMMARY_COLUMNS}
       FROM session_summaries
       ORDER BY ${orderBy} DESC, id ASC${limitClause}`,
      params
    );

    if (result.length === 0) {
      return [];
    }

    return result[0].values.map((row) => parseSessionSummaryRow(row));
  }

  createTopicSummary(input: CreateTopicSummaryInput): TopicSummaryRecord {
    const createdAt = nowIsoString();
    const id = createTopicSummaryId(input.canonicalTopic);

    this.db.run(
      `INSERT INTO topic_summaries (
        id,
        canonical_topic,
        summary_short,
        summary_medium,
        embedding,
        supporting_session_ids,
        source_event_ids,
        created_at,
        updated_at
      ) VALUES (
        $id,
        $canonicalTopic,
        $summaryShort,
        $summaryMedium,
        $embedding,
        $supportingSessionIds,
        $sourceEventIds,
        $createdAt,
        $updatedAt
      )`,
      {
        $id: id,
        $canonicalTopic: input.canonicalTopic,
        $summaryShort: input.summaryShort,
        $summaryMedium: input.summaryMedium,
        $embedding: toEmbeddingBlob(input.embedding),
        $supportingSessionIds: serializeStringArray(input.supportingSessionIds),
        $sourceEventIds: serializeStringArray(input.sourceEventIds),
        $createdAt: createdAt,
        $updatedAt: createdAt,
      } satisfies SqlParameters
    );

    return this.getTopicSummaryByTopic(input.canonicalTopic)!;
  }

  getTopicSummaryByTopic(canonicalTopic: string): TopicSummaryRecord | null {
    const result = this.db.exec(
      `SELECT ${TOPIC_SUMMARY_COLUMNS}
       FROM topic_summaries
       WHERE canonical_topic = $canonicalTopic
       ORDER BY updated_at DESC, created_at DESC, id ASC`,
      { $canonicalTopic: canonicalTopic } satisfies SqlParameters
    );

    if (result.length === 0 || result[0].values.length === 0) {
      return null;
    }

    return parseTopicSummaryRow(result[0].values[0]);
  }

  listTopicSummaries(opts: { limit?: number } = {}): TopicSummaryRecord[] {
    const limit = normalizeLimit(opts.limit);
    const params: SqlParameters = {};

    if (limit !== undefined) {
      params.$limit = limit;
    }

    const limitClause = limit === undefined ? "" : " LIMIT $limit";
    const result = this.db.exec(
      `SELECT ${TOPIC_SUMMARY_COLUMNS}
       FROM topic_summaries
       ORDER BY updated_at DESC, id ASC${limitClause}`,
      params
    );

    if (result.length === 0) {
      return [];
    }

    return result[0].values.map((row) => parseTopicSummaryRow(row));
  }
}
