/**
 * `hm extract [--now] [--provider <name>] [--dry-run]` and `hm dream` (spec §11): run the worker in this process
 * (same Store composition and worker.log as the detached worker; `createWorkerEmbed(config)` so new rows get
 * embeddings when embeddings are enabled). `--now` is accepted for parity with the spec and means the same as the
 * default (process right away in this process). `--dry-run` lists the pending queue files and due episodes without
 * leasing anything.
 */

import type { Database as SqlJsDatabase } from "sql.js";

import { EXIT_CODES } from "../../core/errors";
import type { EpisodeStatus } from "../../core/vocabulary";
import { EpisodeRepository, type EpisodeRecord } from "../../db/repositories/episodes";
import { ExtractionRunRepository } from "../../db/repositories/runs";
import { readProbeCache } from "../../dream/extract/providers";
import { isEligibleForExtraction } from "../../dream/episode";
import type { CommandContext } from "../context";
import { flagBoolean, flagString, type OptionSpecs } from "../lib/args";
import { guard } from "../lib/cli-error";
import { readDb } from "../lib/db-access";
import { probeGuidance } from "../lib/diagnostics";
import { shortId } from "../lib/lookup";
import { renderTable } from "../lib/output";
import { renderWorkerResult, resolveCliProvider, runCliWorker, workerExitCode } from "../lib/worker-run";
import { readQueueFiles } from "./queue";

export const extractOptions: OptionSpecs = {
  now: { type: "boolean", description: "Process immediately in this process (the default; kept for the spec's `extract --now`)" },
  provider: { type: "string", description: "Extraction provider for this run (claude | codex | replay); default from config", placeholder: "<name>" },
  "dry-run": { type: "boolean", description: "Show what would be processed without leasing or calling the provider" },
};

export const dreamOptions: OptionSpecs = {
  provider: { type: "string", description: "Extraction provider for the queue drain that precedes consolidation", placeholder: "<name>" },
};

export interface ExtractDryRunReport {
  provider: string;
  probe: { result: string; at: string; detail: string | null } | null;
  runs_today: number;
  daily_cap: number;
  queue_files: Array<{ id: string; host: string; eligible: boolean; eligibility: string; inserted: boolean }>;
  due: Array<{ id: string; host: string; status: EpisodeStatus; attempts: number; correction: boolean; closed_at: string }>;
  not_due: number;
}

function startOfUtcDay(iso: string): string {
  return `${iso.slice(0, 10)}T00:00:00.000Z`;
}

export function collectDryRun(db: SqlJsDatabase, ctx: CommandContext, providerName: string, now: string): ExtractDryRunReport {
  const episodes = new EpisodeRepository(db);
  const queued = episodes.listByStatus("queued");
  const due: EpisodeRecord[] = [];
  let notDue = 0;
  for (const episode of queued) {
    if (episode.nextAttemptAt === null || episode.nextAttemptAt <= now) due.push(episode);
    else notDue += 1;
  }
  const files = readQueueFiles(ctx.paths.queueDir).map((entry) => {
    if (entry.descriptor === null) return { id: entry.file, host: "-", eligible: false, eligibility: "malformed", inserted: false };
    const eligibility = isEligibleForExtraction(entry.descriptor);
    return { id: entry.descriptor.id, host: entry.descriptor.host, eligible: eligibility.eligible, eligibility: eligibility.reason, inserted: episodes.getById(entry.descriptor.id) !== null };
  });
  const probe = readProbeCache(db, now);
  return {
    provider: providerName,
    probe: probe === null ? null : { result: probe.result, at: probe.at, detail: probe.detail ?? null },
    runs_today: new ExtractionRunRepository(db).countSince(startOfUtcDay(now), { excludeCorrection: true }),
    daily_cap: ctx.config.extraction.max_runs_per_day,
    queue_files: files,
    due: due.map((episode) => ({
      id: episode.id,
      host: episode.host,
      status: episode.status,
      attempts: episode.attemptCount,
      correction: episode.correctionFor !== null || episode.flags.correction === 1,
      closed_at: episode.closedAt,
    })),
    not_due: notDue,
  };
}

export function renderDryRun(report: ExtractDryRunReport): string[] {
  const lines = [
    `dry run: provider ${report.provider}; probe ${report.probe === null ? "not cached" : `${report.probe.result} (${report.probe.at})`}; runs today ${String(report.runs_today)}/${String(report.daily_cap)}`,
  ];
  const guidance = report.probe === null ? null : probeGuidance(report.probe.result);
  if (guidance !== null) lines.push(`  ${report.probe?.detail ? `${report.probe.detail} — ` : ""}${guidance}`);
  lines.push(`queue files to insert: ${String(report.queue_files.length)}`);
  if (report.queue_files.length > 0) {
    lines.push(...renderTable(report.queue_files.map((file) => [shortId(file.id), file.host, file.eligible ? "yes" : `no (${file.eligibility})`, file.inserted ? "yes" : "no"]), ["ID", "HOST", "ELIGIBLE", "IN DB"]));
  }
  lines.push(`due episodes: ${String(report.due.length)}${report.not_due > 0 ? ` (${String(report.not_due)} waiting for their retry time)` : ""}`);
  if (report.due.length > 0) {
    lines.push(...renderTable(report.due.map((episode) => [shortId(episode.id), episode.host, episode.correction ? "yes" : "no", String(episode.attempts), episode.closed_at]), ["ID", "HOST", "CORRECTION", "ATTEMPTS", "CLOSED"]));
  }
  return lines;
}

export async function runExtract(ctx: CommandContext): Promise<number> {
  return guard(ctx, async () => {
    const resolved = resolveCliProvider(ctx, flagString(ctx.args, "provider"));
    if (flagBoolean(ctx.args, "dry-run")) {
      const now = ctx.clock();
      const report = await readDb(ctx, (db) => collectDryRun(db, ctx, resolved.name, now));
      ctx.out.result(report, renderDryRun);
      return EXIT_CODES.ok;
    }
    void flagBoolean(ctx.args, "now");
    const result = await runCliWorker(ctx, { command: "extract", provider: resolved.provider });
    ctx.out.result(result, (value) => renderWorkerResult(value, resolved.name));
    return workerExitCode(result);
  });
}

export async function runDream(ctx: CommandContext): Promise<number> {
  return guard(ctx, async () => {
    const resolved = resolveCliProvider(ctx, flagString(ctx.args, "provider"));
    const result = await runCliWorker(ctx, { command: "dream", provider: resolved.provider });
    ctx.out.result(result, (value) => renderWorkerResult(value, resolved.name));
    return workerExitCode(result);
  });
}
