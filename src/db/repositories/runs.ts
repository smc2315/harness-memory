/**
 * ExtractionRunRepository — `extraction_runs` (migration 018; spec §4.2, §5.3 daily cap, §9.3).
 *
 * The run id is deterministic (`run:<episode_id>:<extractor_version>`), so a retry after
 * `timeout`/`provider_error` reuses the same id: `start()` is an upsert that resets the row for the
 * new attempt. A run that reached commit is never retried (write_ops holds its id).
 */

import type { Database as SqlJsDatabase } from "sql.js";

import type { FactOutcome } from "../../core/extraction-types";
import {
  PROVIDERS,
  RUN_STATUSES,
  type ProviderName,
  type RunStatus,
} from "../../core/vocabulary";
import {
  correctionEpisodeSql,
  expectEnum,
  expectNullableNumber,
  expectNullableString,
  expectNumber,
  expectString,
  nonNegativeInt,
  orNull,
  parseJsonArray,
  selectAll,
  selectOne,
  truncateText,
  type SqlParams,
  type SqlRow,
} from "./common";

const RUN_COLUMNS = [
  "id",
  "episode_id",
  "provider",
  "model",
  "extractor_version",
  "prompt_sha256",
  "input_chars",
  "started_at",
  "finished_at",
  "duration_ms",
  "status",
  "facts_total",
  "facts_accepted",
  "raw_output_ref",
  "error",
  "outcomes_json",
].join(", ");

const MAX_ERROR_CHARS = 2_000;

export interface ExtractionRunRecord {
  id: string;
  episodeId: string;
  provider: ProviderName;
  model: string | null;
  extractorVersion: string;
  promptSha256: string;
  inputChars: number;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  status: RunStatus;
  factsTotal: number;
  factsAccepted: number;
  rawOutputRef: string | null;
  error: string | null;
  outcomes: FactOutcome[];
}

export interface StartRunInput {
  id: string;
  episodeId: string;
  provider: ProviderName;
  model?: string | null;
  extractorVersion: string;
  promptSha256: string;
  inputChars: number;
  startedAt: string;
}

export interface FinishRunInput {
  status: RunStatus;
  finishedAt: string;
  durationMs?: number | null;
  factsTotal?: number;
  factsAccepted?: number;
  rawOutputRef?: string | null;
  error?: string | null;
  outcomes?: readonly FactOutcome[];
  /** Model actually used, when the provider reports it after the fact. */
  model?: string | null;
}

export interface CountRunsOptions {
  provider?: ProviderName;
  /** Exclude runs whose episode is a correction (daily cap, spec §5.3). */
  excludeCorrection?: boolean;
  /** Only count these statuses (default: every status). */
  statuses?: readonly RunStatus[];
}

export class ExtractionRunRepository {
  constructor(private readonly db: SqlJsDatabase) {}

  start(input: StartRunInput): ExtractionRunRecord {
    this.db.run(
      `
        INSERT INTO extraction_runs (
          id, episode_id, provider, model, extractor_version, prompt_sha256, input_chars, started_at,
          finished_at, duration_ms, status, facts_total, facts_accepted, raw_output_ref, error, outcomes_json
        )
        VALUES (
          $id, $episodeId, $provider, $model, $extractorVersion, $promptSha256, $inputChars, $startedAt,
          NULL, NULL, 'started', 0, 0, NULL, NULL, '[]'
        )
        ON CONFLICT(id) DO UPDATE SET
          episode_id = excluded.episode_id,
          provider = excluded.provider,
          model = excluded.model,
          extractor_version = excluded.extractor_version,
          prompt_sha256 = excluded.prompt_sha256,
          input_chars = excluded.input_chars,
          started_at = excluded.started_at,
          finished_at = NULL,
          duration_ms = NULL,
          status = 'started',
          facts_total = 0,
          facts_accepted = 0,
          raw_output_ref = NULL,
          error = NULL,
          outcomes_json = '[]'
      `,
      {
        $id: input.id,
        $episodeId: input.episodeId,
        $provider: expectEnum(input.provider, "provider", PROVIDERS),
        $model: orNull(input.model),
        $extractorVersion: input.extractorVersion,
        $promptSha256: input.promptSha256,
        $inputChars: nonNegativeInt(input.inputChars, "inputChars"),
        $startedAt: input.startedAt,
      }
    );

    return this.require(input.id);
  }

  finish(id: string, input: FinishRunInput): ExtractionRunRecord {
    const existing = this.require(id);

    this.db.run(
      `
        UPDATE extraction_runs
        SET status = $status,
            finished_at = $finishedAt,
            duration_ms = $durationMs,
            facts_total = $factsTotal,
            facts_accepted = $factsAccepted,
            raw_output_ref = $rawOutputRef,
            error = $error,
            outcomes_json = $outcomesJson,
            model = $model
        WHERE id = $id
      `,
      {
        $id: id,
        $status: expectEnum(input.status, "status", RUN_STATUSES),
        $finishedAt: input.finishedAt,
        $durationMs:
          input.durationMs === undefined
            ? Math.max(0, Date.parse(input.finishedAt) - Date.parse(existing.startedAt))
            : input.durationMs,
        $factsTotal: nonNegativeInt(input.factsTotal ?? 0, "factsTotal"),
        $factsAccepted: nonNegativeInt(input.factsAccepted ?? 0, "factsAccepted"),
        $rawOutputRef: orNull(input.rawOutputRef),
        $error: input.error === undefined || input.error === null ? null : truncateText(input.error, MAX_ERROR_CHARS),
        $outcomesJson: JSON.stringify(input.outcomes ?? []),
        $model: input.model === undefined ? existing.model : input.model,
      }
    );

    return this.require(id);
  }

  getById(id: string): ExtractionRunRecord | null {
    const row = selectOne(this.db, `SELECT ${RUN_COLUMNS} FROM extraction_runs WHERE id = $id`, { $id: id });

    return row === null ? null : mapRunRow(row);
  }

  listRecent(limit: number): ExtractionRunRecord[] {
    return selectAll(
      this.db,
      `SELECT ${RUN_COLUMNS} FROM extraction_runs ORDER BY started_at DESC, id ASC LIMIT $limit`,
      { $limit: nonNegativeInt(limit, "limit") }
    ).map(mapRunRow);
  }

  listForEpisode(episodeId: string): ExtractionRunRecord[] {
    return selectAll(
      this.db,
      `SELECT ${RUN_COLUMNS} FROM extraction_runs WHERE episode_id = $episodeId ORDER BY started_at ASC, id ASC`,
      { $episodeId: episodeId }
    ).map(mapRunRow);
  }

  /** Most recently started run, or null (status line "last extraction"). */
  latest(): ExtractionRunRecord | null {
    const rows = this.listRecent(1);

    return rows.length === 0 ? null : rows[0];
  }

  /** Runs started at or after `startIso` (daily cap: pass the start of today, `excludeCorrection: true`). */
  countSince(startIso: string, options: CountRunsOptions = {}): number {
    const params: SqlParams = { $start: startIso };
    const where = ["r.started_at >= $start"];

    if (options.provider !== undefined) {
      where.push("r.provider = $provider");
      params.$provider = options.provider;
    }

    if (options.statuses !== undefined && options.statuses.length > 0) {
      const placeholders = options.statuses.map((status, index) => {
        params[`$status${index}`] = status;
        return `$status${index}`;
      });
      where.push(`r.status IN (${placeholders.join(", ")})`);
    }

    const join = options.excludeCorrection === true ? "LEFT JOIN episodes e ON e.id = r.episode_id" : "";

    if (options.excludeCorrection === true) {
      where.push(`(e.id IS NULL OR NOT ${correctionEpisodeSql("e")})`);
    }

    const row = selectOne(
      this.db,
      `SELECT COUNT(*) AS n FROM extraction_runs r ${join} WHERE ${where.join(" AND ")}`,
      params
    );

    return row === null ? 0 : expectNumber(row.n, "n");
  }

  private require(id: string): ExtractionRunRecord {
    const run = this.getById(id);

    if (run === null) {
      throw new Error(`Extraction run ${id} was not found`);
    }

    return run;
  }
}

export function mapRunRow(row: SqlRow): ExtractionRunRecord {
  return {
    id: expectString(row.id, "id"),
    episodeId: expectString(row.episode_id, "episode_id"),
    provider: expectEnum(row.provider, "provider", PROVIDERS),
    model: expectNullableString(row.model, "model"),
    extractorVersion: expectString(row.extractor_version, "extractor_version"),
    promptSha256: expectString(row.prompt_sha256, "prompt_sha256"),
    inputChars: expectNumber(row.input_chars, "input_chars"),
    startedAt: expectString(row.started_at, "started_at"),
    finishedAt: expectNullableString(row.finished_at, "finished_at"),
    durationMs: expectNullableNumber(row.duration_ms, "duration_ms"),
    status: expectEnum(row.status, "status", RUN_STATUSES),
    factsTotal: expectNumber(row.facts_total, "facts_total"),
    factsAccepted: expectNumber(row.facts_accepted, "facts_accepted"),
    rawOutputRef: expectNullableString(row.raw_output_ref, "raw_output_ref"),
    error: expectNullableString(row.error, "error"),
    outcomes: parseJsonArray<FactOutcome>(expectNullableString(row.outcomes_json, "outcomes_json"), "outcomes_json"),
  };
}
