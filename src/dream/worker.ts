import { basename, extname } from "path";

import type { DreamEvidenceTypeGuess, DreamTrigger, LifecycleTrigger } from "../db/schema/types";
import { MemoryRepository, createDeterministicId } from "../memory";

import { DreamRepository } from "./repository";
import type {
  DreamCandidateSuggestion,
  DreamEvidenceEventRecord,
  DreamRunRequest,
  DreamRunResult,
} from "./types";

const DEFAULT_EVIDENCE_LIMIT = 50;
const DEFAULT_WINDOW_HOURS = 24;

function nowIsoString(): string {
  return new Date().toISOString();
}

function isoHoursAgo(hours: number, reference: string): string {
  return new Date(Date.parse(reference) - hours * 60 * 60 * 1000).toISOString();
}

function deriveScopeGlob(scopeRef: string): string {
  const normalized = scopeRef.replace(/\\/g, "/");
  if (extname(normalized).length > 0) {
    return normalized;
  }

  return normalized.endsWith("/") ? `${normalized}**/*` : `${normalized}/**/*`;
}

function lifecycleForType(typeGuess: DreamEvidenceTypeGuess): LifecycleTrigger[] {
  return typeGuess === "workflow"
    ? ["before_model", "after_tool"]
    : ["before_tool"];
}

function buildGroupKey(event: DreamEvidenceEventRecord): string {
  return [event.typeGuess, event.scopeRef, event.topicGuess].join("|");
}

function buildCandidateSummary(
  typeGuess: DreamEvidenceTypeGuess,
  scopeRef: string,
  topicGuess: string
): string {
  if (typeGuess === "pitfall") {
    return `Pitfall around ${basename(scopeRef)} (${topicGuess})`;
  }

  return `Workflow for ${basename(scopeRef)} (${topicGuess})`;
}

function buildCandidateDetails(events: readonly DreamEvidenceEventRecord[]): string {
  const lines = [
    "Dream consolidation candidate built from recent evidence:",
    ...events.map(
      (event) =>
        `- ${event.createdAt} :: ${event.toolName} :: ${event.title} :: ${event.excerpt}`
    ),
  ];

  return lines.join("\n");
}

function buildSuggestionId(
  typeGuess: DreamEvidenceTypeGuess,
  scopeRef: string,
  topicGuess: string
): string {
  return createDeterministicId(`dream-candidate:${typeGuess}:${scopeRef}:${topicGuess}`);
}

function scoreEvents(events: readonly DreamEvidenceEventRecord[]): {
  aggregate: number;
  confidence: number;
  importance: number;
} {
  const count = events.length;
  const salienceAverage = events.reduce((acc, event) => acc + event.salience, 0) / count;
  const noveltyAverage = events.reduce((acc, event) => acc + event.novelty, 0) / count;
  const contradictionBoost = events.some((event) => event.contradictionSignal) ? 0.15 : 0;
  const recurrenceBoost = Math.max(0, count - 1) * 0.25;
  const aggregate = salienceAverage + noveltyAverage + contradictionBoost + recurrenceBoost;

  return {
    aggregate,
    confidence: Math.min(0.95, 0.45 + aggregate / 3),
    importance: Math.min(0.95, 0.4 + recurrenceBoost + contradictionBoost + salienceAverage * 0.2),
  };
}

function shouldMaterializeCandidate(
  events: readonly DreamEvidenceEventRecord[],
  aggregateScore: number
): boolean {
  if (events.length >= 2) {
    return true;
  }

  return aggregateScore >= 1.55;
}

function groupEvents(events: readonly DreamEvidenceEventRecord[]): Map<string, DreamEvidenceEventRecord[]> {
  const groups = new Map<string, DreamEvidenceEventRecord[]>();

  for (const event of events) {
    const key = buildGroupKey(event);
    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, [event]);
      continue;
    }

    existing.push(event);
  }

  return groups;
}

export class DreamWorker {
  readonly dreamRepository: DreamRepository;
  readonly memoryRepository: MemoryRepository;

  constructor(dreamRepository: DreamRepository, memoryRepository: MemoryRepository) {
    this.dreamRepository = dreamRepository;
    this.memoryRepository = memoryRepository;
  }

  run(request: DreamRunRequest): DreamRunResult {
    const now = request.now ?? nowIsoString();
    const createdAfter = request.createdAfter ?? isoHoursAgo(DEFAULT_WINDOW_HOURS, now);
    const evidence = this.dreamRepository.listEvidenceEvents({
      status: "pending",
      createdAfter,
      limit: request.limit ?? DEFAULT_EVIDENCE_LIMIT,
    });
    const run = this.dreamRepository.createDreamRun({
      trigger: request.trigger,
      windowStart: createdAfter,
      windowEnd: now,
      evidenceCount: evidence.length,
      summary: `Dream run queued with ${evidence.length} pending evidence events`,
    });

    const suggestions: DreamCandidateSuggestion[] = [];
    const consumedEvidenceIds: string[] = [];
    const skippedEvidenceIds: string[] = [];

    for (const events of groupEvents(evidence).values()) {
      const { aggregate, confidence, importance } = scoreEvents(events);
      if (!shouldMaterializeCandidate(events, aggregate)) {
        skippedEvidenceIds.push(...events.map((event) => event.id));
        continue;
      }

      const lead = events[0]!;
      const memoryId = buildSuggestionId(lead.typeGuess, lead.scopeRef, lead.topicGuess);
      const summary = buildCandidateSummary(lead.typeGuess, lead.scopeRef, lead.topicGuess);
      const details = buildCandidateDetails(events);
      const scopeGlob = deriveScopeGlob(lead.scopeRef);
      const lifecycleTriggers = lifecycleForType(lead.typeGuess);
      const existing = this.memoryRepository.getById(memoryId);

      const memory =
        existing === null
          ? this.memoryRepository.create({
              id: memoryId,
              type: lead.typeGuess,
              summary,
              details,
              scopeGlob,
              lifecycleTriggers,
              confidence,
              importance,
              status: "candidate",
              lastVerifiedAt: events[events.length - 1]?.createdAt ?? now,
              createdAt: now,
              updatedAt: now,
            })
          : this.memoryRepository.update(memoryId, {
              summary,
              details,
              scopeGlob,
              lifecycleTriggers,
              confidence,
              importance,
              updatedAt: now,
              lastVerifiedAt: events[events.length - 1]?.createdAt ?? now,
            })!;

      suggestions.push({
        memoryId,
        type: lead.typeGuess,
        action: existing === null ? "created" : "updated",
        scopeGlob,
        lifecycleTriggers,
        summary,
        confidence,
        importance,
        evidenceEventIds: events.map((event) => event.id),
        memory,
      });
      consumedEvidenceIds.push(...events.map((event) => event.id));
    }

    if (consumedEvidenceIds.length > 0) {
      this.dreamRepository.markEvidenceEventsConsumed(consumedEvidenceIds, run.id, now);
    }

    const summary =
      suggestions.length === 0
        ? `No candidate memories created from ${evidence.length} recent evidence events`
        : `Created or refreshed ${suggestions.length} candidate memories from ${consumedEvidenceIds.length} evidence events`;
    const completedRun = this.dreamRepository.completeDreamRun(run.id, {
      status: "completed",
      summary,
      candidateCount: suggestions.length,
      completedAt: now,
    });

    return {
      run: completedRun,
      processedEvidenceCount: evidence.length,
      consumedEvidenceIds,
      suggestions,
      skippedEvidenceIds,
    };
  }
}
