/**
 * `hm memory:history <id>` — transitions, provenance, manual evidence notes, lineage (supersedes chain),
 * proposals and the archived v0.5 dream history of one memory (spec §4.5, §11).
 * `hm memory:trace <id>` — the episodes and extraction runs behind it (provenance → episodes → runs).
 */

import type { Database as SqlJsDatabase } from "sql.js";

import { EXIT_CODES } from "../../core/errors";
import { EpisodeRepository, type EpisodeRecord } from "../../db/repositories/episodes";
import { ProposalRepository, type ProposalRecord } from "../../db/repositories/proposals";
import { ProvenanceRepository, type ProvenanceRecord } from "../../db/repositories/provenance";
import { ExtractionRunRepository, type ExtractionRunRecord } from "../../db/repositories/runs";
import { TransitionRepository, type TransitionRecord } from "../../db/repositories/transitions";
import { readLegacyHistory, type LegacyHistory } from "../../dream/legacy-reader";
import { MemoryRepository, type EvidenceRecord, type MemoryHistoryRelation, type MemoryRecord } from "../../memory/repository";
import type { CommandContext } from "../context";
import type { OptionSpecs } from "../lib/args";
import { guard } from "../lib/cli-error";
import { readDb } from "../lib/db-access";
import { resolveMemory, shortId } from "../lib/lookup";
import { clip, memoryLine, memoryToJson, type MemoryJson } from "../lib/memory-render";
import { requirePositional } from "../lib/options";

export const memoryHistoryOptions: OptionSpecs = {};
export const memoryTraceOptions: OptionSpecs = {};

export interface MemoryHistoryReport {
  memory: MemoryJson;
  transitions: TransitionRecord[];
  provenance: ProvenanceRecord[];
  evidence: EvidenceRecord[];
  lineage: Array<{ relation: MemoryHistoryRelation; memory: MemoryJson }>;
  proposals: ProposalRecord[];
  legacy: LegacyHistory;
}

export function collectMemoryHistory(db: SqlJsDatabase, ref: string): { memory: MemoryRecord; report: MemoryHistoryReport } {
  const repository = new MemoryRepository(db);
  const memory = resolveMemory(db, ref, repository);
  const lineage = repository.getHistory(memory.id).map((entry) => ({ relation: entry.relation, memory: memoryToJson(entry.memory) }));
  const report: MemoryHistoryReport = {
    memory: memoryToJson(memory),
    transitions: new TransitionRepository(db).listForMemory(memory.id),
    provenance: new ProvenanceRepository(db).listForMemory(memory.id),
    evidence: repository.listEvidence(memory.id),
    lineage,
    proposals: new ProposalRepository(db).listForMemory(memory.id),
    legacy: readLegacyHistory(db, memory.id),
  };
  return { memory, report };
}

export function renderMemoryHistory(memory: MemoryRecord, report: MemoryHistoryReport): string[] {
  const lines = [memoryLine(memory, 100), ""];
  lines.push(`transitions (${String(report.transitions.length)}):`);
  for (const transition of report.transitions) {
    const refs = [transition.proposalId === null ? null : `proposal ${shortId(transition.proposalId)}`, transition.extractionRunId === null ? null : `run ${shortId(transition.extractionRunId)}`].filter((part): part is string => part !== null);
    lines.push(`  ${transition.createdAt}  ${transition.fromStatus} → ${transition.toStatus}  by ${transition.actor}  ${transition.reason}${refs.length > 0 ? `  (${refs.join(", ")})` : ""}`);
  }
  if (report.transitions.length === 0) lines.push("  none");
  lines.push("", `provenance (${String(report.provenance.length)}):`);
  for (const row of report.provenance) {
    lines.push(`  ${row.createdAt}  ${row.relation.padEnd(9)} episode ${shortId(row.episodeId)} e${String(row.eventSeq)} conf ${row.confidence.toFixed(2)}${row.excerpt.length > 0 ? `  ${clip(row.excerpt, 90)}` : ""}`);
  }
  if (report.provenance.length === 0) lines.push("  none");
  if (report.evidence.length > 0) {
    lines.push("", `evidence notes (${String(report.evidence.length)}):`);
    for (const note of report.evidence) lines.push(`  ${note.createdAt}  ${note.sourceKind} ${note.sourceRef}  ${clip(note.excerpt, 100)}`);
  }
  const related = report.lineage.filter((entry) => entry.relation !== "focus");
  if (related.length > 0) {
    lines.push("", "lineage:");
    for (const entry of related) lines.push(`  ${entry.relation.padEnd(10)} ${shortId(entry.memory.id)} ${entry.memory.status} ${clip(entry.memory.summary, 90)}`);
  }
  if (report.proposals.length > 0) {
    lines.push("", `proposals (${String(report.proposals.length)}):`);
    for (const proposal of report.proposals) {
      lines.push(`  ${proposal.createdAt}  ${shortId(proposal.id)} ${proposal.kind} ${proposal.status}${proposal.decidedBy === null ? "" : ` by ${proposal.decidedBy}`}  support ${String(proposal.supportCount)}/${String(proposal.supportSessions)}`);
    }
  }
  if (report.legacy.available && (report.legacy.links.length > 0 || report.legacy.runs.length > 0)) {
    lines.push("", `legacy dream history: ${String(report.legacy.links.length)} evidence link(s), ${String(report.legacy.runs.length)} run(s)`);
    for (const link of report.legacy.links.slice(0, 20)) {
      const event = link.event;
      lines.push(`  ${link.createdAt}  run ${shortId(link.dreamRunId)}  ${event === null ? `event ${shortId(link.evidenceEventId)} (removed)` : `${event.toolName} ${clip(event.title, 70)}`}`);
    }
    if (report.legacy.links.length > 20) lines.push(`  … ${String(report.legacy.links.length - 20)} more`);
  }
  return lines;
}

export async function runMemoryHistory(ctx: CommandContext): Promise<number> {
  return guard(ctx, async () => {
    const ref = requirePositional(ctx, 0, "id");
    const { memory, report } = await readDb(ctx, (db) => collectMemoryHistory(db, ref));
    ctx.out.result(report, () => renderMemoryHistory(memory, report));
    return EXIT_CODES.ok;
  });
}

export interface MemoryTraceEpisode {
  episode_id: string;
  episode: EpisodeRecord | null;
  provenance: ProvenanceRecord[];
  runs: ExtractionRunRecord[];
}

export interface MemoryTraceReport {
  memory: MemoryJson;
  episodes: MemoryTraceEpisode[];
  transitions: TransitionRecord[];
}

export function collectMemoryTrace(db: SqlJsDatabase, ref: string): { memory: MemoryRecord; report: MemoryTraceReport } {
  const repository = new MemoryRepository(db);
  const memory = resolveMemory(db, ref, repository);
  const episodes = new EpisodeRepository(db);
  const runs = new ExtractionRunRepository(db);
  const byEpisode = new Map<string, ProvenanceRecord[]>();
  for (const row of new ProvenanceRepository(db).listForMemory(memory.id)) {
    const bucket = byEpisode.get(row.episodeId) ?? [];
    bucket.push(row);
    byEpisode.set(row.episodeId, bucket);
  }
  const report: MemoryTraceReport = {
    memory: memoryToJson(memory),
    episodes: [...byEpisode.entries()].map(([episodeId, provenance]) => ({
      episode_id: episodeId,
      episode: episodes.getById(episodeId),
      provenance,
      runs: runs.listForEpisode(episodeId),
    })),
    transitions: new TransitionRepository(db).listForMemory(memory.id),
  };
  return { memory, report };
}

function flagsOf(episode: EpisodeRecord): string {
  const flags = Object.entries(episode.flags)
    .filter(([, value]) => value === 1)
    .map(([key]) => key);
  return flags.length === 0 ? "-" : flags.join(",");
}

export function renderMemoryTrace(memory: MemoryRecord, report: MemoryTraceReport): string[] {
  const lines = [memoryLine(memory, 100), "", `episodes (${String(report.episodes.length)}):`];
  for (const entry of report.episodes) {
    const episode = entry.episode;
    if (episode === null) {
      lines.push(`  episode ${shortId(entry.episode_id)} (row gone)  ${entry.provenance.map((row) => row.relation).join(",")}`);
      continue;
    }
    lines.push(
      `  episode ${shortId(episode.id)} ${episode.host} session ${clip(episode.sessionId, 24)} closed ${episode.closedAt} (${episode.closeReason}) weight ${String(episode.evidenceWeight)} flags ${flagsOf(episode)} status ${episode.status}`
    );
    lines.push(`    ${episode.ledgerRef}`);
    for (const row of entry.provenance) lines.push(`    ${row.relation.padEnd(9)} e${String(row.eventSeq)} conf ${row.confidence.toFixed(2)}${row.excerpt.length > 0 ? `  ${clip(row.excerpt, 80)}` : ""}`);
    for (const run of entry.runs) {
      lines.push(`    run ${shortId(run.id)} ${run.provider}${run.model === null ? "" : `/${run.model}`} ${run.status} facts ${String(run.factsAccepted)}/${String(run.factsTotal)} ${run.finishedAt ?? run.startedAt}${run.rawOutputRef === null ? "" : `  ${run.rawOutputRef}`}`);
    }
  }
  if (report.episodes.length === 0) lines.push("  none (no provenance rows)");
  const withRuns = report.transitions.filter((transition) => transition.extractionRunId !== null);
  if (withRuns.length > 0) {
    lines.push("", "transitions by extraction runs:");
    for (const transition of withRuns) lines.push(`  ${transition.createdAt}  ${transition.fromStatus} → ${transition.toStatus} (${transition.actor}, run ${shortId(transition.extractionRunId)})`);
  }
  return lines;
}

export async function runMemoryTrace(ctx: CommandContext): Promise<number> {
  return guard(ctx, async () => {
    const ref = requirePositional(ctx, 0, "id");
    const { memory, report } = await readDb(ctx, (db) => collectMemoryTrace(db, ref));
    ctx.out.result(report, () => renderMemoryTrace(memory, report));
    return EXIT_CODES.ok;
  });
}
