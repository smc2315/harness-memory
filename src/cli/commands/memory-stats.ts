/**
 * `hm memory:stats [--since <iso>]` (spec §11): counts by status / authority / type, the review load
 * (items per active day — the dogfood gate is ≤ 3), recent auto activations and fires/overrides since the
 * window start (default: the last 7 days), episodes and extraction runs in the window.
 */

import type { Database as SqlJsDatabase } from "sql.js";

import { EXIT_CODES } from "../../core/errors";
import type { EpisodeStatus, MemoryStatus, MemoryType, ProposalKind, RunStatus } from "../../core/vocabulary";
import { META_KEYS, MetaRepository } from "../../db/repositories/meta";
import { EpisodeRepository } from "../../db/repositories/episodes";
import { ProposalRepository } from "../../db/repositories/proposals";
import { ExtractionRunRepository } from "../../db/repositories/runs";
import { selectAll, selectCount } from "../../db/sql";
import { readLastProbe } from "../../dream/extract/providers";
import { MemoryRepository } from "../../memory/repository";
import type { CommandContext } from "../context";
import { flagString, type OptionSpecs } from "../lib/args";
import { guard, usageError } from "../lib/cli-error";
import { readDb } from "../lib/db-access";
import { shortId } from "../lib/lookup";
import { clip } from "../lib/memory-render";
import { collectReviewItems, countByGroup, REVIEW_GROUP_TITLES, type ReviewGroup } from "../lib/review-queue";

export const memoryStatsOptions: OptionSpecs = {
  since: { type: "string", description: "Window start (ISO date or datetime; default 7 days ago)", placeholder: "<iso>" },
};

export const STATS_DEFAULT_WINDOW_DAYS = 7;
export const REVIEW_LOAD_GATE_PER_DAY = 3;

export interface MemoryStatsReport {
  now: string;
  since: string;
  memories: {
    by_status: Record<MemoryStatus, number>;
    by_authority: { human: number; auto: number };
    by_type: Record<MemoryType, number>;
    active_auto: number;
    active_human: number;
    unconfirmed_imports: number;
    contested: number;
    needs_scope: number;
    with_signature: number;
    with_embedding: number;
  };
  proposals: {
    open: number;
    open_by_kind: Partial<Record<ProposalKind, number>>;
    expiring_7d: number;
    decided_since: { accepted: number; rejected: number; expired: number };
  };
  review: {
    items: number;
    by_group: Record<ReviewGroup, number>;
    created_since: number;
    active_days: number;
    per_active_day: number;
    gate_per_day: number;
    within_gate: boolean;
  };
  activations: {
    auto_since: Array<{ memory_id: string; at: string; summary: string; run_id: string | null }>;
    human_since: number;
    demotions_since: number;
  };
  fires: { fired_rows: number; fires: number; overrides: number; noisy: Array<{ memory_id: string; fires: number; overrides: number; enforcement: string; summary: string }> };
  episodes: { by_status: Record<EpisodeStatus, number>; closed_since: number };
  runs: { since_by_status: Partial<Record<RunStatus, number>>; facts_total: number; facts_accepted: number };
  probe: { result: string; at: string } | null;
  last_dream_at: string | null;
}

function dayOf(iso: string): string {
  return iso.slice(0, 10);
}

export function collectMemoryStats(db: SqlJsDatabase, now: string, since: string): MemoryStatsReport {
  const repository = new MemoryRepository(db);
  const proposals = new ProposalRepository(db);
  const runs = new ExtractionRunRepository(db);
  const episodes = new EpisodeRepository(db);
  const meta = new MetaRepository(db);
  const all = repository.list();

  const byType = { policy: 0, workflow: 0, pitfall: 0, architecture_constraint: 0, decision: 0 } as Record<MemoryType, number>;
  let human = 0;
  let activeAuto = 0;
  let activeHuman = 0;
  let unconfirmed = 0;
  let contested = 0;
  let needsScope = 0;
  let withSignature = 0;
  let withEmbedding = 0;
  let firedRows = 0;
  let fires = 0;
  let overrides = 0;
  const noisy: MemoryStatsReport["fires"]["noisy"] = [];
  for (const memory of all) {
    byType[memory.type] += 1;
    if (memory.authority === "human") human += 1;
    if (memory.status === "active") {
      if (memory.authority === "auto") activeAuto += 1;
      else activeHuman += 1;
    }
    if (memory.importUnconfirmed === 1) unconfirmed += 1;
    if (memory.contested === 1) contested += 1;
    if (memory.needsScope === 1) needsScope += 1;
    if (memory.triggerSignature !== null) withSignature += 1;
    if (memory.embedding !== null) withEmbedding += 1;
    if (memory.fireCount > 0) firedRows += 1;
    fires += memory.fireCount;
    overrides += memory.overrideCount;
    if (memory.overrideCount > 0) noisy.push({ memory_id: memory.id, fires: memory.fireCount, overrides: memory.overrideCount, enforcement: memory.enforcement, summary: memory.summary });
  }
  noisy.sort((left, right) => right.overrides - left.overrides || right.fires - left.fires);

  const openProposals = proposals.listOpen();
  const openByKind: Partial<Record<ProposalKind, number>> = {};
  for (const proposal of openProposals) openByKind[proposal.kind] = (openByKind[proposal.kind] ?? 0) + 1;
  const decidedSince = { accepted: 0, rejected: 0, expired: 0 };
  for (const proposal of proposals.listDecided({ since })) {
    if (proposal.status === "accepted" || proposal.status === "rejected" || proposal.status === "expired") decidedSince[proposal.status] += 1;
  }

  const items = collectReviewItems(db);
  const createdSince = items.filter((item) => item.createdAt >= since).length;
  const activeDays = new Set(
    selectAll(db, "SELECT closed_at FROM episodes WHERE closed_at >= ? AND closed_at <= ?", [since, now]).map((row) => dayOf(String(row.closed_at)))
  ).size;
  const perActiveDay = createdSince / Math.max(1, activeDays);

  const autoSince = selectAll(
    db,
    `SELECT t.memory_id, t.created_at, t.extraction_run_id, m.summary
     FROM memory_transitions t LEFT JOIN memories m ON m.id = t.memory_id
     WHERE t.actor = 'auto_rule' AND t.to_status = 'active' AND t.from_status <> t.to_status AND t.created_at >= ?
     ORDER BY t.created_at DESC LIMIT 50`,
    [since]
  ).map((row) => ({
    memory_id: String(row.memory_id),
    at: String(row.created_at),
    summary: row.summary === null || row.summary === undefined ? "" : String(row.summary),
    run_id: row.extraction_run_id === null || row.extraction_run_id === undefined ? null : String(row.extraction_run_id),
  }));
  // Same-status rows are enforcement escalations (auto_rule) or remember adoptions (human), not activations.
  const humanSince = selectCount(db, "SELECT COUNT(*) FROM memory_transitions WHERE actor = 'human' AND to_status = 'active' AND from_status <> to_status AND created_at >= ?", [since]);
  const demotionsSince = selectCount(db, "SELECT COUNT(*) FROM memory_transitions WHERE to_status IN ('stale', 'superseded', 'rejected') AND created_at >= ?", [since]);

  const runsSince: Partial<Record<RunStatus, number>> = {};
  let factsTotal = 0;
  let factsAccepted = 0;
  for (const run of runs.listRecent(500)) {
    if (run.startedAt < since) continue;
    runsSince[run.status] = (runsSince[run.status] ?? 0) + 1;
    factsTotal += run.factsTotal;
    factsAccepted += run.factsAccepted;
  }
  const closedSince = selectCount(db, "SELECT COUNT(*) FROM episodes WHERE closed_at >= ?", [since]);
  const probe = readLastProbe(db);

  return {
    now,
    since,
    memories: {
      by_status: repository.countByStatus(),
      by_authority: { human, auto: all.length - human },
      by_type: byType,
      active_auto: activeAuto,
      active_human: activeHuman,
      unconfirmed_imports: unconfirmed,
      contested,
      needs_scope: needsScope,
      with_signature: withSignature,
      with_embedding: withEmbedding,
    },
    proposals: { open: openProposals.length, open_by_kind: openByKind, expiring_7d: proposals.countExpiringWithin(now, 7), decided_since: decidedSince },
    review: {
      items: items.length,
      by_group: countByGroup(items),
      created_since: createdSince,
      active_days: activeDays,
      per_active_day: Math.round(perActiveDay * 100) / 100,
      gate_per_day: REVIEW_LOAD_GATE_PER_DAY,
      within_gate: perActiveDay <= REVIEW_LOAD_GATE_PER_DAY,
    },
    activations: { auto_since: autoSince, human_since: humanSince, demotions_since: demotionsSince },
    fires: { fired_rows: firedRows, fires, overrides, noisy: noisy.slice(0, 10) },
    episodes: { by_status: episodes.countByStatus(), closed_since: closedSince },
    runs: { since_by_status: runsSince, facts_total: factsTotal, facts_accepted: factsAccepted },
    probe: probe === null ? null : { result: probe.result, at: probe.at },
    last_dream_at: meta.get(META_KEYS.lastDreamAt),
  };
}

export function renderMemoryStats(report: MemoryStatsReport): string[] {
  const m = report.memories;
  const s = m.by_status;
  const lines = [
    `memories: candidate ${String(s.candidate)} | active ${String(s.active)} (auto ${String(m.active_auto)}, human ${String(m.active_human)}) | stale ${String(s.stale)} | superseded ${String(s.superseded)} | rejected ${String(s.rejected)}`,
    `  by type: ${Object.entries(m.by_type)
      .map(([type, count]) => `${type} ${String(count)}`)
      .join(", ")}`,
    `  signatures ${String(m.with_signature)} | embeddings ${String(m.with_embedding)} | unconfirmed imports ${String(m.unconfirmed_imports)} | contested ${String(m.contested)} | needs_scope ${String(m.needs_scope)}`,
    `proposals: open ${String(report.proposals.open)}${report.proposals.open > 0 ? ` (${Object.entries(report.proposals.open_by_kind).map(([kind, count]) => `${kind} ${String(count)}`).join(", ")})` : ""} | expiring in 7d ${String(report.proposals.expiring_7d)} | decided since ${report.since.slice(0, 10)}: accepted ${String(report.proposals.decided_since.accepted)}, rejected ${String(report.proposals.decided_since.rejected)}, expired ${String(report.proposals.decided_since.expired)}`,
    `review load: ${String(report.review.items)} item(s) pending; ${String(report.review.created_since)} created since ${report.since.slice(0, 10)} over ${String(report.review.active_days)} active day(s) = ${String(report.review.per_active_day)}/day (gate ≤ ${String(report.review.gate_per_day)}: ${report.review.within_gate ? "ok" : "EXCEEDED"})`,
  ];
  const pending = Object.entries(report.review.by_group).filter(([, count]) => count > 0);
  if (pending.length > 0) lines.push(`  ${pending.map(([group, count]) => `${REVIEW_GROUP_TITLES[group as ReviewGroup]} ${String(count)}`).join(" | ")}`);
  lines.push(`activations since ${report.since.slice(0, 10)}: auto ${String(report.activations.auto_since.length)} | human ${String(report.activations.human_since)} | demotions/removals ${String(report.activations.demotions_since)}`);
  for (const activation of report.activations.auto_since.slice(0, 10)) lines.push(`  ${activation.at}  ${shortId(activation.memory_id)}  ${clip(activation.summary, 80)}`);
  lines.push(`fires: ${String(report.fires.fires)} on ${String(report.fires.fired_rows)} row(s), overrides ${String(report.fires.overrides)}`);
  for (const noisy of report.fires.noisy.slice(0, 5)) lines.push(`  noisy ${shortId(noisy.memory_id)} ${noisy.enforcement} fired ${String(noisy.fires)}× overridden ${String(noisy.overrides)}×  ${clip(noisy.summary, 70)}`);
  const e = report.episodes.by_status;
  lines.push(`episodes: queued ${String(e.queued)} | leased ${String(e.leased)} | extracted ${String(e.extracted)} | skipped ${String(e.skipped)} | failed ${String(e.failed)} | dead ${String(e.dead)} (closed since: ${String(report.episodes.closed_since)})`);
  const runEntries = Object.entries(report.runs.since_by_status);
  lines.push(`runs since: ${runEntries.length === 0 ? "none" : runEntries.map(([status, count]) => `${status} ${String(count)}`).join(", ")} | facts accepted ${String(report.runs.facts_accepted)}/${String(report.runs.facts_total)}`);
  lines.push(`probe ${report.probe === null ? "none" : `${report.probe.result} (${report.probe.at})`} | last dream ${report.last_dream_at ?? "never"}`);
  return lines;
}

export function parseSince(value: string | null, now: string): string {
  if (value === null) return new Date(Date.parse(now) - STATS_DEFAULT_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw usageError(`--since '${value}' is not an ISO date`, "example: --since 2026-11-01");
  return new Date(parsed).toISOString();
}

export async function runMemoryStats(ctx: CommandContext): Promise<number> {
  return guard(ctx, async () => {
    const now = ctx.clock();
    const since = parseSince(flagString(ctx.args, "since"), now);
    const report = await readDb(ctx, (db) => collectMemoryStats(db, now, since));
    ctx.out.result(report, renderMemoryStats);
    return EXIT_CODES.ok;
  });
}
