/**
 * EpisodeRepository — the extraction queue (`episodes`, migration 018; spec §4.2, §4.7, §9.3 A, §9.4 F3).
 *
 * Status machine (written only here): queued → leased → extracted | skipped | failed;
 * leased → queued (lease expired); failed → queued (retry due) → dead (worker decides after 3 attempts).
 * Records are camelCase; `episodeRecordToDescriptor` rebuilds the snake_case queue descriptor for the
 * prompt builder (prompt_text / last_assistant_message are not stored and come back null).
 */

import type { Database as SqlJsDatabase } from "sql.js";

import { stripControlCharacters } from "../../activation/injection";
import {
  EPISODE_SCHEMA,
  type EpisodeDescriptor,
  type EpisodeFlags,
  type FailureSignatureEntry,
  type FiredEntry,
} from "../../core/episode-types";
import { sessionKey } from "../../core/paths";
import type { RecallSummaryKind } from "../../core/snapshot-types";
import {
  CLOSE_REASONS,
  EPISODE_STATUSES,
  HOSTS,
  type CanonicalTool,
  type CloseReason,
  type EpisodeStatus,
  type Host,
} from "../../core/vocabulary";
import {
  addSeconds,
  correctionEpisodeSql,
  expectEnum,
  expectNullableEnum,
  expectNullableString,
  expectNumber,
  expectString,
  nonNegativeInt,
  orNull,
  parseJsonArray,
  parseJsonObject,
  rowsChanged,
  selectAll,
  selectOne,
  truncateText,
  type SqlRow,
} from "./common";

const EPISODE_COLUMNS = [
  "id",
  "host",
  "session_id",
  "turn_key",
  "segment",
  "started_at",
  "closed_at",
  "close_reason",
  "ledger_ref",
  "correction_for",
  "context_ref",
  "scope_refs_json",
  "tools_json",
  "failure_signatures_json",
  "flags_json",
  "fired_json",
  "evidence_weight",
  "event_count",
  "status",
  "skip_reason",
  "lease_until",
  "attempt_count",
  "next_attempt_at",
  "last_error",
  "extraction_run_id",
  "summary",
  "summary_kind",
].join(", ");

const MAX_ERROR_CHARS = 2_000;
/** `episodes.summary` cap (migration 022); matches the extractor schema's `episode_summary` maxLength. */
export const EPISODE_SUMMARY_MAX_CHARS = 400;
export const EPISODE_SUMMARY_KINDS: readonly RecallSummaryKind[] = ["extracted", "derived"];

/**
 * Storage-boundary normalization shared by both summary kinds (the worker's derived text and the extractor's
 * `episode_summary`): ANSI CSI sequences and C0 / C1 control characters removed, whitespace collapsed to one
 * line, at most `EPISODE_SUMMARY_MAX_CHARS` (an over-long text ends in `…`). What `hm recall` prints and what
 * the prompt hook injects is therefore terminal-safe before either strips again at render time.
 */
export function normalizeEpisodeSummary(summary: string): string {
  const flat = stripControlCharacters(summary).replace(/\s+/g, " ").trim();
  if (flat.length <= EPISODE_SUMMARY_MAX_CHARS) return flat;
  return `${flat.slice(0, EPISODE_SUMMARY_MAX_CHARS - 1)}…`;
}

export interface EpisodeRecord {
  id: string;
  host: Host;
  sessionId: string;
  turnKey: string;
  segment: number;
  startedAt: string;
  closedAt: string;
  closeReason: CloseReason;
  ledgerRef: string;
  correctionFor: string | null;
  contextRef: string | null;
  scopeRefs: string[];
  tools: CanonicalTool[];
  failureSignatures: FailureSignatureEntry[];
  flags: EpisodeFlags;
  fired: FiredEntry[];
  evidenceWeight: number;
  eventCount: number;
  status: EpisodeStatus;
  skipReason: string | null;
  leaseUntil: string | null;
  attemptCount: number;
  nextAttemptAt: string | null;
  lastError: string | null;
  extractionRunId: string | null;
  /** Recall summary (migration 022): the extractor's `episode_summary` or the worker's derived one; null until set. */
  summary: string | null;
  summaryKind: RecallSummaryKind | null;
}

/** Name used by the implementation plan for the leased rows. */
export type EpisodeRow = EpisodeRecord;

export interface LeaseOptions {
  leaseSeconds: number;
  now: string;
  /** Default true: episodes that correct a previous one are leased before older plain episodes. */
  correctionFirst?: boolean;
}

export interface MarkFailedOptions {
  /** When the episode becomes eligible again (null = never, used with `dead`). */
  retryAt: string | null;
  /** True after the last allowed attempt: status becomes `dead`. */
  dead?: boolean;
}

export interface ListEpisodesOptions {
  limit?: number;
}

export interface ListWithSummaryOptions {
  /** Newest `limit` episodes (closed_at DESC); -1 / undefined = all. */
  limit?: number;
  /** Only episodes closed at or after this ISO timestamp. */
  since?: string | null;
}

export function isCorrectionEpisode(record: Pick<EpisodeRecord, "correctionFor" | "flags">): boolean {
  return record.correctionFor !== null || record.flags.correction === 1;
}

export function episodeRecordToDescriptor(record: EpisodeRecord): EpisodeDescriptor {
  return {
    schema: EPISODE_SCHEMA,
    id: record.id,
    host: record.host,
    session_id: record.sessionId,
    session_key: sessionKey(record.host, record.sessionId),
    turn_key: record.turnKey,
    segment: record.segment,
    started_at: record.startedAt,
    closed_at: record.closedAt,
    close_reason: record.closeReason,
    ledger_ref: record.ledgerRef,
    correction_for: record.correctionFor,
    context_ref: record.contextRef,
    scope_refs: [...record.scopeRefs],
    tools: [...record.tools],
    failure_signatures: record.failureSignatures.map((entry) => ({ ...entry })),
    flags: { ...record.flags },
    fired: record.fired.map((entry) => ({ ...entry })),
    evidence_weight: record.evidenceWeight,
    event_count: record.eventCount,
    prompt_text: null,
    last_assistant_message: null,
  };
}

export class EpisodeRepository {
  constructor(private readonly db: SqlJsDatabase) {}

  /** INSERT OR IGNORE of a queue descriptor; true when the row was new. Fresh rows are due at `now`. */
  insertIfAbsent(descriptor: EpisodeDescriptor, now: string): boolean {
    this.db.run(
      `
        INSERT OR IGNORE INTO episodes (
          id, host, session_id, turn_key, segment, started_at, closed_at, close_reason, ledger_ref,
          correction_for, context_ref, scope_refs_json, tools_json, failure_signatures_json, flags_json,
          fired_json, evidence_weight, event_count, status, attempt_count, next_attempt_at
        )
        VALUES (
          $id, $host, $sessionId, $turnKey, $segment, $startedAt, $closedAt, $closeReason, $ledgerRef,
          $correctionFor, $contextRef, $scopeRefsJson, $toolsJson, $failureSignaturesJson, $flagsJson,
          $firedJson, $evidenceWeight, $eventCount, 'queued', 0, $now
        )
      `,
      {
        $id: descriptor.id,
        $host: descriptor.host,
        $sessionId: descriptor.session_id,
        $turnKey: descriptor.turn_key,
        $segment: nonNegativeInt(descriptor.segment, "segment"),
        $startedAt: descriptor.started_at,
        $closedAt: descriptor.closed_at,
        $closeReason: descriptor.close_reason,
        $ledgerRef: descriptor.ledger_ref,
        $correctionFor: orNull(descriptor.correction_for),
        $contextRef: orNull(descriptor.context_ref),
        $scopeRefsJson: JSON.stringify(descriptor.scope_refs ?? []),
        $toolsJson: JSON.stringify(descriptor.tools ?? []),
        $failureSignaturesJson: JSON.stringify(descriptor.failure_signatures ?? []),
        $flagsJson: JSON.stringify(descriptor.flags ?? {}),
        $firedJson: JSON.stringify(descriptor.fired ?? []),
        $evidenceWeight: descriptor.evidence_weight,
        $eventCount: nonNegativeInt(descriptor.event_count, "event_count"),
        $now: now,
      }
    );

    return rowsChanged(this.db) === 1;
  }

  /**
   * Takes up to `limit` due `queued` episodes: correction episodes first, then oldest closed first.
   * Each leased row gets `status='leased'`, `lease_until = now + leaseSeconds`, `attempt_count += 1`.
   */
  lease(limit: number, options: LeaseOptions): EpisodeRecord[] {
    const count = nonNegativeInt(limit, "limit");

    if (count === 0) {
      return [];
    }

    const correctionFirst = options.correctionFirst ?? true;
    const order = correctionFirst
      ? `CASE WHEN ${correctionEpisodeSql("e")} THEN 0 ELSE 1 END, e.closed_at ASC, e.id ASC`
      : "e.closed_at ASC, e.id ASC";
    const due = selectAll(
      this.db,
      `
        SELECT e.id
        FROM episodes e
        WHERE e.status = 'queued' AND (e.next_attempt_at IS NULL OR e.next_attempt_at <= $now)
        ORDER BY ${order}
        LIMIT $limit
      `,
      { $now: options.now, $limit: count }
    );
    const leaseUntil = addSeconds(options.now, options.leaseSeconds);
    const leased: EpisodeRecord[] = [];

    for (const row of due) {
      const id = expectString(row.id, "id");

      this.db.run(
        `
          UPDATE episodes
          SET status = 'leased', lease_until = $leaseUntil, attempt_count = attempt_count + 1
          WHERE id = $id AND status = 'queued'
        `,
        { $id: id, $leaseUntil: leaseUntil }
      );

      const record = this.getById(id);
      if (record !== null) {
        leased.push(record);
      }
    }

    return leased;
  }

  markExtracted(id: string, runId: string): void {
    this.db.run(
      `
        UPDATE episodes
        SET status = 'extracted', extraction_run_id = $runId, lease_until = NULL, next_attempt_at = NULL, last_error = NULL
        WHERE id = $id
      `,
      { $id: id, $runId: runId }
    );
  }

  markSkipped(id: string, reason: string): void {
    this.db.run(
      `
        UPDATE episodes
        SET status = 'skipped', skip_reason = $reason, lease_until = NULL, next_attempt_at = NULL
        WHERE id = $id
      `,
      { $id: id, $reason: truncateText(reason, 200) }
    );
  }

  markFailed(id: string, error: string, options: MarkFailedOptions): void {
    this.db.run(
      `
        UPDATE episodes
        SET status = $status, last_error = $error, next_attempt_at = $retryAt, lease_until = NULL
        WHERE id = $id
      `,
      {
        $id: id,
        $status: options.dead === true ? "dead" : "failed",
        $error: truncateText(error, MAX_ERROR_CHARS),
        $retryAt: options.dead === true ? null : options.retryAt,
      }
    );
  }

  /**
   * Puts one leased/failed episode back to `queued` at `nextAttemptAt` outside the normal backoff accounting:
   * provider-unavailable outcomes (no_provider / not_logged_in / nested_refusal, m0-facts #3) must not burn one
   * of the three attempts, so `undoAttempt` reverses the increment the lease made. `resetAttempts` (an operator's
   * `hm queue retry` on a dead episode) starts the count from zero again.
   */
  requeue(id: string, options: { nextAttemptAt: string; undoAttempt?: boolean; resetAttempts?: boolean; lastError?: string | null }): void {
    this.db.run(
      `
        UPDATE episodes
        SET status = 'queued',
            lease_until = NULL,
            attempt_count = CASE WHEN $reset = 1 THEN 0 WHEN $undo = 1 THEN MAX(0, attempt_count - 1) ELSE attempt_count END,
            next_attempt_at = $next,
            last_error = COALESCE($error, last_error)
        WHERE id = $id
      `,
      {
        $id: id,
        $next: options.nextAttemptAt,
        $undo: options.undoAttempt === true ? 1 : 0,
        $reset: options.resetAttempts === true ? 1 : 0,
        $error: options.lastError === undefined || options.lastError === null ? null : truncateText(options.lastError, MAX_ERROR_CHARS),
      }
    );
  }

  /** `leased` rows whose lease ended at or before `now` go back to `queued` (§9.4 F3). Returns the count. */
  releaseExpiredLeases(now: string): number {
    this.db.run(
      `
        UPDATE episodes
        SET status = 'queued', lease_until = NULL
        WHERE status = 'leased' AND lease_until IS NOT NULL AND lease_until <= $now
      `,
      { $now: now }
    );

    return rowsChanged(this.db);
  }

  /** `failed` rows whose backoff ended at or before `now` go back to `queued`. Returns the count. */
  requeueDueFailures(now: string): number {
    this.db.run(
      `
        UPDATE episodes
        SET status = 'queued'
        WHERE status = 'failed' AND next_attempt_at IS NOT NULL AND next_attempt_at <= $now
      `,
      { $now: now }
    );

    return rowsChanged(this.db);
  }

  listByStatus(status: EpisodeStatus, options: ListEpisodesOptions = {}): EpisodeRecord[] {
    const limit = options.limit === undefined ? -1 : nonNegativeInt(options.limit, "limit");

    return selectAll(
      this.db,
      `
        SELECT ${EPISODE_COLUMNS}
        FROM episodes
        WHERE status = $status
        ORDER BY closed_at ASC, id ASC
        LIMIT $limit
      `,
      { $status: status, $limit: limit }
    ).map(mapEpisodeRow);
  }

  listForSession(host: Host, sessionId: string): EpisodeRecord[] {
    return selectAll(
      this.db,
      `
        SELECT ${EPISODE_COLUMNS}
        FROM episodes
        WHERE host = $host AND session_id = $sessionId
        ORDER BY closed_at ASC, id ASC
      `,
      { $host: host, $sessionId: sessionId }
    ).map(mapEpisodeRow);
  }

  getById(id: string): EpisodeRecord | null {
    const row = selectOne(this.db, `SELECT ${EPISODE_COLUMNS} FROM episodes WHERE id = $id`, { $id: id });

    return row === null ? null : mapEpisodeRow(row);
  }

  /**
   * Stores the recall summary of an episode, normalized at this boundary (`normalizeEpisodeSummary`: one line,
   * ANSI / C0 / C1 control characters removed, ≤ 400 chars; an empty summary is ignored). The caller decides the
   * precedence: reconcile writes 'extracted' over anything, the worker writes 'derived' only where no summary
   * exists yet. Import episodes (`host = 'import'`, one per CLAUDE.md / auto-memory bullet) never carry one: the
   * bullet already reaches the model as the imported rule, so recalling it would say the same thing twice.
   * True when the row was updated.
   */
  setSummary(id: string, summary: string, kind: RecallSummaryKind): boolean {
    const flat = normalizeEpisodeSummary(summary);
    if (flat.length === 0) return false;
    this.db.run(
      `
        UPDATE episodes
        SET summary = $summary, summary_kind = $kind
        WHERE id = $id AND host <> 'import'
      `,
      { $id: id, $summary: flat, $kind: kind }
    );

    return rowsChanged(this.db) === 1;
  }

  /**
   * Session episodes that carry a summary, newest first (the recall snapshot's source and `hm recall`'s database
   * fallback). Import rows are excluded here as well, so `recall.keep_episodes` is never spent on a row the
   * snapshot builder would drop anyway.
   */
  listWithSummary(options: ListWithSummaryOptions = {}): EpisodeRecord[] {
    const limit = options.limit === undefined ? -1 : nonNegativeInt(options.limit, "limit");
    const since = options.since ?? null;

    return selectAll(
      this.db,
      `
        SELECT ${EPISODE_COLUMNS}
        FROM episodes
        WHERE summary IS NOT NULL AND host <> 'import' AND ($since IS NULL OR closed_at >= $since)
        ORDER BY closed_at DESC, id ASC
        LIMIT $limit
      `,
      { $since: since, $limit: limit }
    ).map(mapEpisodeRow);
  }

  countWithSummary(): number {
    const row = selectOne(this.db, "SELECT COUNT(*) AS n FROM episodes WHERE summary IS NOT NULL AND host <> 'import'");

    return row === null ? 0 : expectNumber(row.n, "n");
  }

  countQueued(): number {
    const row = selectOne(this.db, "SELECT COUNT(*) AS n FROM episodes WHERE status = 'queued'");

    return row === null ? 0 : expectNumber(row.n, "n");
  }

  countByStatus(): Record<EpisodeStatus, number> {
    const counts: Record<EpisodeStatus, number> = {
      queued: 0,
      leased: 0,
      extracted: 0,
      skipped: 0,
      failed: 0,
      dead: 0,
    };

    for (const row of selectAll(this.db, "SELECT status, COUNT(*) AS n FROM episodes GROUP BY status")) {
      counts[expectEnum(row.status, "status", EPISODE_STATUSES)] = expectNumber(row.n, "n");
    }

    return counts;
  }
}

export function mapEpisodeRow(row: SqlRow): EpisodeRecord {
  return {
    id: expectString(row.id, "id"),
    host: expectEnum(row.host, "host", HOSTS),
    sessionId: expectString(row.session_id, "session_id"),
    turnKey: expectString(row.turn_key, "turn_key"),
    segment: expectNumber(row.segment, "segment"),
    startedAt: expectString(row.started_at, "started_at"),
    closedAt: expectString(row.closed_at, "closed_at"),
    closeReason: expectEnum(row.close_reason, "close_reason", CLOSE_REASONS),
    ledgerRef: expectString(row.ledger_ref, "ledger_ref"),
    correctionFor: expectNullableString(row.correction_for, "correction_for"),
    contextRef: expectNullableString(row.context_ref, "context_ref"),
    scopeRefs: parseJsonArray<string>(expectNullableString(row.scope_refs_json, "scope_refs_json"), "scope_refs_json"),
    tools: parseJsonArray<CanonicalTool>(expectNullableString(row.tools_json, "tools_json"), "tools_json"),
    failureSignatures: parseJsonArray<FailureSignatureEntry>(
      expectNullableString(row.failure_signatures_json, "failure_signatures_json"),
      "failure_signatures_json"
    ),
    flags: parseJsonObject<EpisodeFlags>(expectNullableString(row.flags_json, "flags_json"), "flags_json"),
    fired: parseJsonArray<FiredEntry>(expectNullableString(row.fired_json, "fired_json"), "fired_json"),
    evidenceWeight: expectNumber(row.evidence_weight, "evidence_weight"),
    eventCount: expectNumber(row.event_count, "event_count"),
    status: expectEnum(row.status, "status", EPISODE_STATUSES),
    skipReason: expectNullableString(row.skip_reason, "skip_reason"),
    leaseUntil: expectNullableString(row.lease_until, "lease_until"),
    attemptCount: expectNumber(row.attempt_count, "attempt_count"),
    nextAttemptAt: expectNullableString(row.next_attempt_at, "next_attempt_at"),
    lastError: expectNullableString(row.last_error, "last_error"),
    extractionRunId: expectNullableString(row.extraction_run_id, "extraction_run_id"),
    summary: expectNullableString(row.summary, "summary"),
    summaryKind: expectNullableEnum(row.summary_kind, "summary_kind", EPISODE_SUMMARY_KINDS),
  };
}
