/**
 * `hm recall <query> [--limit <n>] [--since <iso>] [--json]` (A′ recall layer): searches the per-episode
 * summaries the hooks inject at `before_model` — the same MiniSearch index over summary + scope refs, built
 * from `snapshot/recall.v1.json` when the snapshot is fresh, else from the database (and the output says which).
 * Every hit prints date, session (`<host>-<session_key>`, the form `hm trace` accepts), summary and kind.
 */

import { existsSync } from "node:fs";

import { stripControlCharacters } from "../../activation/injection";
import { buildRecallIndex, readRecallSnapshot, type RecallHit, type RecallIndex } from "../../activation/recall";
import { EXIT_CODES } from "../../core/errors";
import type { RecallEpisode, RecallSummaryKind } from "../../core/snapshot-types";
import { EpisodeRepository } from "../../db/repositories/episodes";
import { toRecallEpisode } from "../../db/snapshot";
import type { CommandContext } from "../context";
import { flagNumber, flagString, type OptionSpecs } from "../lib/args";
import { guard, usageError } from "../lib/cli-error";
import { readDb } from "../lib/db-access";
import { readSnapshotFacts, type SnapshotState } from "../lib/diagnostics";
import { requirePositional } from "../lib/options";

export const recallOptions: OptionSpecs = {
  limit: { type: "number", description: "Show at most <n> episodes (default 10)", placeholder: "<n>" },
  since: { type: "string", description: "Only episodes closed at or after this ISO timestamp", placeholder: "<iso>" },
};

export const RECALL_DEFAULT_LIMIT = 10;

export type RecallSource = "snapshot" | "database";

export interface RecallReportHit {
  episode_id: string;
  /** `<host>-<session_key>` — what `hm trace` takes. */
  session: string;
  session_key: string;
  host: string;
  closed_at: string;
  date: string;
  summary: string;
  kind: RecallSummaryKind;
  /** Normalized BM25 (`s / (s + 1)`). */
  score: number;
}

export interface RecallReport {
  query: string;
  enabled: boolean;
  source: RecallSource | null;
  /** Why the database was used instead of the snapshot (snapshot stale / missing / corrupt), else null. */
  source_reason: string | null;
  since: string | null;
  limit: number;
  /** Episodes the index held (after `--since`). */
  searched: number;
  hits: RecallReportHit[];
  hint: string | null;
}

/** The stored summary is already one line without control characters; a hand-edited snapshot file must not reach the terminal raw. */
function terminalSafe(summary: string): string {
  return stripControlCharacters(summary).replace(/\s+/g, " ").trim();
}

function toHit(hit: RecallHit): RecallReportHit {
  const episode = hit.episode;
  return {
    episode_id: episode.id,
    session: `${episode.host}-${episode.session_key}`,
    session_key: episode.session_key,
    host: episode.host,
    closed_at: episode.closed_at,
    date: episode.closed_at.slice(0, 10),
    summary: terminalSafe(episode.summary),
    kind: episode.summary_kind,
    score: Number(hit.score.toFixed(3)),
  };
}

export function renderRecallReport(report: RecallReport): string[] {
  if (!report.enabled) return ["recall is disabled (config.json: recall.enabled = false)"];
  const source = report.source === "database" ? `database${report.source_reason === null ? "" : ` — ${report.source_reason}`}` : "snapshot";
  const lines = [`recall "${report.query}": ${String(report.hits.length)} of ${String(report.searched)} episodes (source: ${source}${report.since === null ? "" : `, since ${report.since}`})`];
  if (report.hits.length === 0) lines.push("  (no matching episode)");
  for (const hit of report.hits) lines.push(`  ${hit.date}  ${hit.session}  [${hit.kind} ${hit.score.toFixed(2)}]  ${hit.summary}`);
  if (report.hint !== null) lines.push("", report.hint);
  return lines;
}

function filterSince(episodes: readonly RecallEpisode[], since: string | null): RecallEpisode[] {
  if (since === null) return [...episodes];
  return episodes.filter((episode) => episode.closed_at >= since);
}

function parseSince(value: string | null): string | null {
  if (value === null) return null;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw usageError(`--since must be an ISO 8601 timestamp (got '${value}')`);
  return new Date(ms).toISOString();
}

/** Snapshot when fresh and present, else the database; says which and why. */
async function loadRecallIndex(ctx: CommandContext, since: string | null): Promise<{ index: RecallIndex; source: RecallSource; reason: string | null }> {
  const state: SnapshotState = readSnapshotFacts(ctx.paths, ctx.nowMs()).state;
  let reason: string | null = null;
  if (state !== "fresh") reason = `snapshot ${state}`;
  else if (!existsSync(ctx.paths.snapshotRecall)) reason = "recall.v1.json missing (run hm snapshot:rebuild)";
  if (reason === null) {
    const loaded = await readRecallSnapshot(ctx.paths);
    if (loaded !== null) {
      if (since === null) return { index: loaded, source: "snapshot", reason: null };
      const filtered = await buildRecallIndex(filterSince(loaded.episodes, since), { dbGeneration: loaded.dbGeneration, builtAt: loaded.builtAt });
      return { index: filtered, source: "snapshot", reason: null };
    }
    reason = "recall.v1.json unreadable";
  }
  const episodes = await readDb(ctx, (db, read) => {
    const list: RecallEpisode[] = [];
    for (const record of new EpisodeRepository(db).listWithSummary({ since })) {
      const episode = toRecallEpisode(record);
      if (episode !== null) list.push(episode);
    }
    return { list, generation: read.generation, now: read.now };
  });
  return { index: await buildRecallIndex(episodes.list, { dbGeneration: episodes.generation, builtAt: episodes.now }), source: "database", reason };
}

export async function runRecall(ctx: CommandContext): Promise<number> {
  return guard(ctx, async () => {
    const query = ctx.args.positionals.join(" ").trim();
    if (query.length === 0) requirePositional(ctx, 0, "query");
    const limitRaw = flagNumber(ctx.args, "limit");
    if (limitRaw !== null && (!Number.isInteger(limitRaw) || limitRaw < 1)) throw usageError("--limit must be a positive integer");
    const limit = limitRaw ?? RECALL_DEFAULT_LIMIT;
    const since = parseSince(flagString(ctx.args, "since"));

    const report: RecallReport = { query, enabled: ctx.config.recall.enabled, source: null, source_reason: null, since, limit, searched: 0, hits: [], hint: null };
    if (!report.enabled) {
      ctx.out.result(report, renderRecallReport);
      return EXIT_CODES.ok;
    }
    const loaded = await loadRecallIndex(ctx, since);
    report.source = loaded.source;
    report.source_reason = loaded.reason;
    report.searched = loaded.index.episodeCount;
    report.hits = loaded.index.search(query, limit).map(toHit);
    report.hint = report.hits.length === 0 ? null : `hint: hm trace <session> (e.g. hm trace ${report.hits[0]!.session}) shows the full ledger of a session`;
    ctx.out.result(report, renderRecallReport);
    return EXIT_CODES.ok;
  });
}
