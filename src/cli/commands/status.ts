/**
 * `hm status` (spec §11): one line —
 *   `active 212 (auto 61) | candidates 7 | proposals 3 (2 expiring) | queue 2 | last extraction 2h ago ok | probe ok | snapshot fresh | p95 71ms`
 * Counts come from the database (the source of truth; the snapshot may lag), freshness from the
 * snapshot's recorded `source` stat, p95 from `logs/hooks.log` pre-tool calls.
 */

import { EXIT_CODES } from "../../core/errors";
import type { CommandContext } from "../context";
import type { OptionSpecs } from "../lib/args";
import { countQueueFiles, readDbFacts, readSnapshotFacts, readWorkerLogFacts, probeGuidance, type SnapshotState } from "../lib/diagnostics";
import { readHookLogTail, summarizeHookLog } from "../lib/hooks-log";
import { formatRelative } from "../lib/output";
import { createCliStore } from "../lib/store";

export const statusOptions: OptionSpecs = {};

export interface StatusReport {
  root: string;
  installed: boolean;
  user_version: number | null;
  migration_needed: boolean;
  db_generation: number | null;
  counts: {
    active: number;
    auto_active: number;
    candidates: number;
    open_proposals: number;
    expiring_7d: number;
    queue: number;
    unreachable: number;
  } | null;
  last_extraction: { run_id: string; status: string; started_at: string; finished_at: string | null; provider: string; ago: string } | null;
  probe: { result: string; at: string; detail: string | null; guidance: string | null } | null;
  snapshot: { state: SnapshotState; generation: number | null; built_at: string | null };
  hooks: { calls: number; p95_ms: number | null; p95_all_ms: number | null };
  waiting: string | null;
  line: string;
  problem: string | null;
}

export function buildStatusLine(report: StatusReport): string {
  if (report.problem !== null) return report.problem;
  const counts = report.counts;
  const parts: string[] = [];
  if (counts === null) {
    parts.push(report.migration_needed ? `db v${String(report.user_version ?? 0)} (migration pending: run hm db:migrate)` : "counts unavailable");
  } else {
    parts.push(`active ${String(counts.active)} (auto ${String(counts.auto_active)})`);
    parts.push(`candidates ${String(counts.candidates)}`);
    parts.push(`proposals ${String(counts.open_proposals)}${counts.expiring_7d > 0 ? ` (${String(counts.expiring_7d)} expiring)` : ""}`);
    parts.push(`queue ${String(counts.queue)}${report.waiting === null ? "" : ` (waiting: ${report.waiting})`}`);
  }
  parts.push(report.last_extraction === null ? "last extraction never" : `last extraction ${report.last_extraction.ago} ${report.last_extraction.status}`);
  parts.push(`probe ${report.probe?.result ?? "none"}`);
  parts.push(`snapshot ${report.snapshot.state}`);
  parts.push(`p95 ${report.hooks.p95_ms === null ? (report.hooks.p95_all_ms === null ? "-" : `${String(Math.round(report.hooks.p95_all_ms))}ms (no pre-tool calls yet)`) : `${String(Math.round(report.hooks.p95_ms))}ms`}`);
  if (counts !== null && counts.unreachable > 0) parts.push(`unreachable ${String(counts.unreachable)}`);
  return parts.join(" | ");
}

export async function collectStatus(ctx: CommandContext): Promise<StatusReport> {
  const nowMs = ctx.nowMs();
  const now = ctx.clock();
  const store = createCliStore({ paths: ctx.paths, config: ctx.config, clock: ctx.clock, stderr: ctx.stderr });
  const db = await readDbFacts(store, ctx.paths, ctx.config, now);
  const snapshot = readSnapshotFacts(ctx.paths, nowMs);
  const hookLog = summarizeHookLog(readHookLogTail(ctx.paths.hooksLog));
  const worker = readWorkerLogFacts(ctx.paths);

  let problem: string | null = null;
  if (!db.exists) problem = `not installed: no database at ${ctx.paths.db} — run \`hm install --host claude\``;
  else if (db.error !== null) problem = `database unreadable: ${db.error} — run \`hm doctor\``;
  else if (db.newerThanCode) problem = `database v${String(db.userVersion)} is newer than this build — upgrade harness-memory`;

  const counts = db.counts;
  const report: StatusReport = {
    root: ctx.paths.root,
    installed: db.exists,
    user_version: db.userVersion,
    migration_needed: db.migrationNeeded,
    db_generation: db.generation,
    counts:
      counts === null
        ? null
        : {
            active: counts.active,
            auto_active: counts.auto_active,
            candidates: counts.candidates,
            open_proposals: counts.open_proposals,
            expiring_7d: counts.expiring_7d,
            queue: countQueueFiles(ctx.paths),
            unreachable: counts.unreachable,
          },
    last_extraction:
      db.lastRun === null
        ? null
        : {
            run_id: db.lastRun.id,
            status: db.lastRun.status,
            started_at: db.lastRun.startedAt,
            finished_at: db.lastRun.finishedAt,
            provider: db.lastRun.provider,
            ago: formatRelative(db.lastRun.finishedAt ?? db.lastRun.startedAt, nowMs),
          },
    probe: db.probe === null ? null : { result: db.probe.result, at: db.probe.at, detail: db.probe.detail ?? null, guidance: probeGuidance(db.probe.result) },
    snapshot: { state: snapshot.state, generation: snapshot.generation, built_at: snapshot.builtAt },
    hooks: { calls: hookLog.total, p95_ms: hookLog.p95PreTool, p95_all_ms: hookLog.p95All },
    waiting: worker.waiting,
    line: "",
    problem,
  };
  report.line = buildStatusLine(report);
  return report;
}

export async function runStatus(ctx: CommandContext): Promise<number> {
  const report = await collectStatus(ctx);
  ctx.out.result(report, (value) => {
    const lines = [value.line];
    if (value.probe?.guidance !== null && value.probe?.guidance !== undefined) lines.push(`  probe: ${value.probe.detail ? `${value.probe.detail} — ` : ""}${value.probe.guidance}`);
    return lines;
  });
  return report.problem === null ? EXIT_CODES.ok : EXIT_CODES.error;
}
