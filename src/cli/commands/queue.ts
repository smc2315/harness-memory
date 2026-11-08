/**
 * `hm queue [list | show <id> | retry <id> | drop <id>]` (spec §11, §9.4 F3): the extraction queue is the
 * `queue/*.json` descriptors not yet inserted plus the `episodes` rows in queued / leased / failed / dead.
 * `retry` puts a failed / dead / skipped episode back to `queued` (dead rows get their attempts reset);
 * `drop` removes the queue file and marks the episode `skipped(dropped)`. Status writes stay in EpisodeRepository.
 */

import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Database as SqlJsDatabase } from "sql.js";

import type { EpisodeDescriptor } from "../../core/episode-types";
import { EXIT_CODES } from "../../core/errors";
import { extractionRunId } from "../../core/ids";
import { queueFile } from "../../core/paths";
import type { EpisodeStatus } from "../../core/vocabulary";
import { EpisodeRepository, type EpisodeRecord } from "../../db/repositories/episodes";
import { ProvenanceRepository, type ProvenanceRecord } from "../../db/repositories/provenance";
import { ExtractionRunRepository, type ExtractionRunRecord } from "../../db/repositories/runs";
import { selectAll } from "../../db/sql";
import { isEligibleForExtraction } from "../../dream/episode";
import { isEpisodeDescriptor } from "../../dream/worker";
import type { CommandContext } from "../context";
import type { OptionSpecs } from "../lib/args";
import { CliInputError, guard, usageError } from "../lib/cli-error";
import { readDb, writeDb } from "../lib/db-access";
import { readWorkerLogFacts } from "../lib/diagnostics";
import { shortId } from "../lib/lookup";
import { clip } from "../lib/memory-render";
import { formatRelative, renderTable } from "../lib/output";

export const queueOptions: OptionSpecs = {};

export const QUEUE_SUBCOMMANDS = ["list", "show", "retry", "drop"] as const;
export type QueueSubcommand = (typeof QUEUE_SUBCOMMANDS)[number];

/** Episode statuses shown by `queue list` (extracted / skipped rows are history, not queue). */
export const QUEUE_STATUSES: readonly EpisodeStatus[] = ["queued", "leased", "failed", "dead"];

export interface QueueFileView {
  file: string;
  id: string;
  host: string;
  session_id: string;
  close_reason: string;
  evidence_weight: number;
  eligible: boolean;
  eligibility: string;
  /** True when the episodes table already has the row (the file is a leftover). */
  inserted: boolean;
  malformed: boolean;
}

export interface QueueListReport {
  counts: Record<EpisodeStatus, number>;
  waiting: string | null;
  files: QueueFileView[];
  episodes: EpisodeRecord[];
}

export function readQueueFiles(queueDir: string): Array<{ file: string; descriptor: EpisodeDescriptor | null }> {
  let names: string[];
  try {
    names = readdirSync(queueDir).filter((name) => name.endsWith(".json")).sort();
  } catch {
    return [];
  }
  return names.map((name) => {
    const file = join(queueDir, name);
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
      return { file, descriptor: isEpisodeDescriptor(parsed) ? parsed : null };
    } catch {
      return { file, descriptor: null };
    }
  });
}

function fileView(entry: { file: string; descriptor: EpisodeDescriptor | null }, episodes: EpisodeRepository): QueueFileView {
  const descriptor = entry.descriptor;
  if (descriptor === null) {
    return { file: entry.file, id: "-", host: "-", session_id: "-", close_reason: "-", evidence_weight: 0, eligible: false, eligibility: "malformed", inserted: false, malformed: true };
  }
  const eligibility = isEligibleForExtraction(descriptor);
  return {
    file: entry.file,
    id: descriptor.id,
    host: descriptor.host,
    session_id: descriptor.session_id,
    close_reason: descriptor.close_reason,
    evidence_weight: descriptor.evidence_weight,
    eligible: eligibility.eligible,
    eligibility: eligibility.reason,
    inserted: episodes.getById(descriptor.id) !== null,
    malformed: false,
  };
}

export function collectQueueList(db: SqlJsDatabase, ctx: CommandContext): QueueListReport {
  const episodes = new EpisodeRepository(db);
  const rows: EpisodeRecord[] = [];
  for (const status of QUEUE_STATUSES) rows.push(...episodes.listByStatus(status));
  rows.sort((left, right) => left.closedAt.localeCompare(right.closedAt) || left.id.localeCompare(right.id));
  return {
    counts: episodes.countByStatus(),
    waiting: readWorkerLogFacts(ctx.paths).waiting,
    files: readQueueFiles(ctx.paths.queueDir).map((entry) => fileView(entry, episodes)),
    episodes: rows,
  };
}

export function renderQueueList(report: QueueListReport, nowMs: number): string[] {
  const c = report.counts;
  const lines = [
    `queue files ${String(report.files.length)} | episodes queued ${String(c.queued)} leased ${String(c.leased)} failed ${String(c.failed)} dead ${String(c.dead)} | extracted ${String(c.extracted)} skipped ${String(c.skipped)}${report.waiting === null ? "" : ` | waiting: ${report.waiting}`}`,
  ];
  if (report.files.length > 0) {
    lines.push("", "pending queue files:");
    lines.push(
      ...renderTable(
        report.files.map((file) => [shortId(file.id), file.host, file.close_reason, String(file.evidence_weight), file.malformed ? "malformed" : file.eligible ? "yes" : `no (${file.eligibility})`, file.inserted ? "yes" : "no"]),
        ["ID", "HOST", "CLOSE", "WEIGHT", "ELIGIBLE", "IN DB"]
      )
    );
  }
  if (report.episodes.length > 0) {
    lines.push("", "episodes:");
    lines.push(
      ...renderTable(
        report.episodes.map((episode) => [
          shortId(episode.id),
          episode.status,
          episode.host,
          formatRelative(episode.closedAt, nowMs),
          String(episode.evidenceWeight),
          String(episode.attemptCount),
          episode.nextAttemptAt === null ? "-" : formatRelative(episode.nextAttemptAt, nowMs),
          clip(episode.lastError ?? "", 50),
        ]),
        ["ID", "STATUS", "HOST", "CLOSED", "WEIGHT", "ATTEMPTS", "NEXT", "LAST ERROR"]
      )
    );
  }
  if (report.files.length === 0 && report.episodes.length === 0) lines.push("the queue is empty");
  return lines;
}

export interface QueueShowReport {
  episode: EpisodeRecord | null;
  queue_file: string | null;
  descriptor: EpisodeDescriptor | null;
  runs: ExtractionRunRecord[];
  provenance: ProvenanceRecord[];
  raw_files: string[];
}

function resolveEpisodeId(db: SqlJsDatabase, ref: string, ctx: CommandContext): string {
  const exact = new EpisodeRepository(db).getById(ref);
  if (exact !== null) return exact.id;
  const fromFile = readQueueFiles(ctx.paths.queueDir).find((entry) => entry.descriptor !== null && (entry.descriptor.id === ref || entry.descriptor.id.startsWith(ref)));
  if (fromFile?.descriptor !== null && fromFile?.descriptor !== undefined && ref.length >= 4) return fromFile.descriptor.id;
  if (ref.length < 4) throw new CliInputError(`no episode with id ${ref}`, { hint: "prefixes need at least 4 characters" });
  const matches = selectAll(db, "SELECT id FROM episodes WHERE id LIKE ? ORDER BY id LIMIT 6", [`${ref.replace(/[%_]/g, "")}%`]).map((row) => String(row.id));
  if (matches.length === 1) return matches[0]!;
  if (matches.length === 0) throw new CliInputError(`no episode with id ${ref}`);
  throw new CliInputError(`episode id prefix ${ref} is ambiguous: ${matches.join(", ")}`);
}

export function collectQueueShow(db: SqlJsDatabase, ctx: CommandContext, ref: string): QueueShowReport {
  const id = resolveEpisodeId(db, ref, ctx);
  const episode = new EpisodeRepository(db).getById(id);
  const file = queueFile(ctx.paths, id);
  const entry = existsSync(file) ? readQueueFiles(ctx.paths.queueDir).find((candidate) => candidate.file === file) : undefined;
  const runId = extractionRunId(id);
  let rawFiles: string[] = [];
  try {
    rawFiles = readdirSync(ctx.paths.rawDir)
      .filter((name) => name.startsWith(runId))
      .map((name) => join(ctx.paths.rawDir, name));
  } catch {
    rawFiles = [];
  }
  return {
    episode,
    queue_file: entry === undefined ? null : entry.file,
    descriptor: entry?.descriptor ?? null,
    runs: new ExtractionRunRepository(db).listForEpisode(id),
    provenance: new ProvenanceRepository(db).listForEpisode(id),
    raw_files: rawFiles,
  };
}

export function renderQueueShow(report: QueueShowReport): string[] {
  const lines: string[] = [];
  const episode = report.episode;
  if (episode !== null) {
    lines.push(
      `episode ${episode.id}`,
      `  ${episode.host} session ${episode.sessionId} turn ${episode.turnKey} segment ${String(episode.segment)}`,
      `  status ${episode.status}${episode.skipReason === null ? "" : ` (${episode.skipReason})`} attempts ${String(episode.attemptCount)}${episode.nextAttemptAt === null ? "" : ` next ${episode.nextAttemptAt}`}${episode.leaseUntil === null ? "" : ` lease until ${episode.leaseUntil}`}`,
      `  closed ${episode.closedAt} (${episode.closeReason}) weight ${String(episode.evidenceWeight)} events ${String(episode.eventCount)} tools [${episode.tools.join(", ")}]`,
      `  ${episode.ledgerRef}${episode.correctionFor === null ? "" : `  corrects ${shortId(episode.correctionFor)}`}`
    );
    if (episode.scopeRefs.length > 0) lines.push(`  scope refs [${episode.scopeRefs.slice(0, 12).join(", ")}]`);
    if (episode.failureSignatures.length > 0) lines.push(`  failures ${episode.failureSignatures.map((entry) => `${entry.sig}${entry.resolved_seq === null ? "" : " (resolved)"}`).join("; ")}`);
    if (episode.lastError !== null) lines.push(`  last error: ${clip(episode.lastError, 200)}`);
  } else {
    lines.push("episode row not in the database yet");
  }
  lines.push(`  queue file ${report.queue_file ?? "none"}`);
  if (report.descriptor?.prompt_text !== null && report.descriptor?.prompt_text !== undefined) lines.push(`  prompt: ${clip(report.descriptor.prompt_text, 160)}`);
  if (report.runs.length > 0) {
    lines.push("runs:");
    for (const run of report.runs) lines.push(`  ${shortId(run.id)} ${run.provider} ${run.status} facts ${String(run.factsAccepted)}/${String(run.factsTotal)} ${run.finishedAt ?? run.startedAt}${run.error === null ? "" : `  ${clip(run.error, 100)}`}`);
  }
  if (report.provenance.length > 0) {
    lines.push("memories written:");
    for (const row of report.provenance) lines.push(`  ${shortId(row.memoryId)} ${row.relation} e${String(row.eventSeq)} conf ${row.confidence.toFixed(2)}`);
  }
  if (report.raw_files.length > 0) lines.push(`raw: ${report.raw_files.join(", ")}`);
  return lines;
}

export interface QueueMutationReport {
  action: "retry" | "drop";
  episode_id: string;
  before: EpisodeStatus | null;
  after: EpisodeStatus | null;
  removed_file: string | null;
}

export async function runQueue(ctx: CommandContext): Promise<number> {
  return guard(ctx, async () => {
    const sub = (ctx.args.positionals[0] ?? "list") as QueueSubcommand;
    if (!(QUEUE_SUBCOMMANDS as readonly string[]).includes(sub)) throw usageError(`unknown queue subcommand '${sub}'`, `use ${QUEUE_SUBCOMMANDS.join(" | ")}`);
    const nowMs = ctx.nowMs();

    if (sub === "list") {
      const report = await readDb(ctx, (db) => collectQueueList(db, ctx));
      ctx.out.result(report, (value) => renderQueueList(value, nowMs));
      return EXIT_CODES.ok;
    }

    const ref = ctx.args.positionals[1];
    if (ref === undefined) throw usageError(`queue ${sub} needs an episode id`);

    if (sub === "show") {
      const report = await readDb(ctx, (db) => collectQueueShow(db, ctx, ref));
      ctx.out.result(report, renderQueueShow);
      return EXIT_CODES.ok;
    }

    const { value } = await writeDb(
      ctx,
      { purpose: `queue:${sub}`, kind: `queue:${sub}`, subject: ref },
      (db, write) => {
        const episodes = new EpisodeRepository(db);
        let id: string;
        let episode: EpisodeRecord | null;
        try {
          id = resolveEpisodeId(db, ref, ctx);
          episode = episodes.getById(id);
        } catch (error) {
          if (sub !== "drop" || !(error instanceof CliInputError)) throw error;
          id = ref;
          episode = null;
        }
        const report: QueueMutationReport = { action: sub, episode_id: id, before: episode?.status ?? null, after: episode?.status ?? null, removed_file: null };

        if (sub === "retry") {
          if (episode === null) throw new CliInputError(`episode ${ref} is not in the database`, { hint: "run `hm extract` to insert pending queue files first" });
          if (!(["failed", "dead", "skipped", "leased"] as EpisodeStatus[]).includes(episode.status)) {
            throw new CliInputError(`episode ${shortId(id)} is ${episode.status}; only failed, dead, skipped or leased episodes are retried`);
          }
          episodes.requeue(id, { nextAttemptAt: write.now, undoAttempt: false, resetAttempts: episode.status === "dead", lastError: null });
          report.after = episodes.getById(id)?.status ?? null;
          return report;
        }

        const file = queueFile(ctx.paths, id);
        if (existsSync(file)) {
          rmSync(file, { force: true });
          report.removed_file = file;
        }
        if (episode !== null && (QUEUE_STATUSES as readonly EpisodeStatus[]).includes(episode.status)) {
          episodes.markSkipped(id, "dropped");
          report.after = episodes.getById(id)?.status ?? null;
        } else if (episode === null && report.removed_file === null) {
          throw new CliInputError(`nothing to drop for ${ref}: no queue file and no queued episode`);
        }
        return report;
      },
      (report) => report.before === report.after && report.removed_file === null
    );
    ctx.out.result(value, (report) => [
      `${report.action} ${shortId(report.episode_id)}: ${report.before ?? "no row"} → ${report.after ?? "no row"}${report.removed_file === null ? "" : `, removed ${report.removed_file}`}`,
    ]);
    return EXIT_CODES.ok;
  });
}
