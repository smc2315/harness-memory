import { basename, extname } from "path";

import type { DreamEvidenceTypeGuess, LifecycleTrigger } from "../db/schema/types";
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
const MAX_DEFER_RETRIES = 2;

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
  switch (typeGuess) {
    case "workflow":
      return ["before_model", "after_tool"];
    case "pitfall":
      return ["before_tool"];
    case "policy":
      return ["before_tool", "before_model"];
    case "architecture_constraint":
      return ["session_start", "before_model"];
    case "decision":
      return ["session_start", "before_model"];
  }
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

  if (typeGuess === "policy") {
    return `Policy for ${basename(scopeRef)} (${topicGuess})`;
  }

  if (typeGuess === "architecture_constraint") {
    return `Architecture constraint for ${basename(scopeRef)} (${topicGuess})`;
  }

  if (typeGuess === "decision") {
    return `Decision for ${basename(scopeRef)} (${topicGuess})`;
  }

  return `Workflow for ${basename(scopeRef)} (${topicGuess})`;
}

/**
 * Build the details text for a dream candidate memory.
 *
 * Convention: synthesized summaries (from buildCandidateSummary) are always
 * English. Raw evidence excerpts in details may remain in their original
 * language — they are reference data, not the primary search target.
 * The LLM extraction path (llm-extract.ts) enforces English output.
 */
function buildCandidateDetails(
  events: readonly DreamEvidenceEventRecord[],
  previousSummary: string | null
): string {
  const lines: string[] = [];

  if (previousSummary !== null) {
    lines.push("Previous understanding:");
    lines.push(previousSummary);
    lines.push("");
    lines.push("New evidence:");
  } else {
    lines.push("Dream consolidation candidate built from recent evidence:");
  }

  lines.push(
    ...events.map(
      (event) =>
        `- ${event.createdAt} :: ${event.toolName} :: ${event.title} :: ${event.excerpt}`
    )
  );

  return lines.join("\n");
}

function buildSuggestionId(
  typeGuess: DreamEvidenceTypeGuess,
  scopeRef: string,
  topicGuess: string
): string {
  return createDeterministicId(`dream-candidate:${typeGuess}:${scopeRef}:${topicGuess}`);
}

function parseArgsJson(event: DreamEvidenceEventRecord): string {
  try {
    return event.argsJson.toLowerCase();
  } catch {
    return event.argsJson.toLowerCase();
  }
}

function scoreEvents(events: readonly DreamEvidenceEventRecord[]): {
  aggregate: number;
  confidence: number;
  importance: number;
} {
  const count = events.length;
  const salienceAverage = events.reduce((acc, event) => acc + event.salience, 0) / count;
  const noveltyAverage = events.reduce((acc, event) => acc + event.novelty, 0) / count;
  const salienceBoostMax = Math.max(...events.map((event) => event.salienceBoost));
  const contradictionBoost = events.some((event) => event.contradictionSignal) ? 0.15 : 0;
  const recurrenceBoost = Math.max(0, count - 1) * 0.25;
  const failureBoost = events.some((event) => /error|failed|exception|timeout|refused/i.test(event.excerpt))
    ? 0.15
    : 0;
  const successBoost = events.some((event) => /passed|resolved|fixed|completed|migrated/i.test(event.excerpt))
    ? 0.1
    : 0;
  const breadthBoost = events.some((event) => /path|file|src\//i.test(parseArgsJson(event)))
    ? 0.05
    : 0;
  const aggregate =
    salienceAverage +
    noveltyAverage +
    salienceBoostMax +
    contradictionBoost +
    recurrenceBoost +
    failureBoost +
    successBoost +
    breadthBoost;

  return {
    aggregate,
      confidence: Math.min(0.95, 0.45 + aggregate / 3),
      importance: Math.min(
        0.95,
        0.4 + recurrenceBoost + contradictionBoost + failureBoost + successBoost + salienceAverage * 0.2
      ),
    };
}

function hoursFromNow(reference: string, hours: number): string {
  return new Date(Date.parse(reference) + hours * 60 * 60 * 1000).toISOString();
}

function computeBackoffHours(retryCount: number): number {
  return Math.min(24, 2 ** retryCount * 6);
}

function shouldDiscardDeferred(
  events: readonly DreamEvidenceEventRecord[],
  aggregateScore: number,
  now: string
): boolean {
  if (events.every((event) => event.retryCount >= MAX_DEFER_RETRIES)) {
    return true;
  }

  const oldestEvent = events[0];
  if (oldestEvent === undefined) {
    return false;
  }

  const ageHours = (Date.parse(now) - Date.parse(oldestEvent.createdAt)) / (1000 * 60 * 60);
  return ageHours >= 72 && aggregateScore < 1.1;
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
    const evidence = this.dreamRepository.listProcessableEvidenceEvents(now, {
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
    const deferredEvidenceIds: string[] = [];
    const discardedEvidenceIds: string[] = [];
    const skippedEvidenceIds: string[] = [];
    const deferredItems: Array<{ id: string; nextReviewAt: string }> = [];

    for (const events of groupEvents(evidence).values()) {
      const { aggregate, confidence, importance } = scoreEvents(events);
      if (!shouldMaterializeCandidate(events, aggregate)) {
        skippedEvidenceIds.push(...events.map((event) => event.id));
        if (shouldDiscardDeferred(events, aggregate, now)) {
          discardedEvidenceIds.push(...events.map((event) => event.id));
        } else {
          for (const event of events) {
            const nextReviewAt = hoursFromNow(now, computeBackoffHours(event.retryCount));
            deferredItems.push({ id: event.id, nextReviewAt });
            deferredEvidenceIds.push(event.id);
          }
        }
        continue;
      }

      const lead = events[0]!;
      const memoryId = buildSuggestionId(lead.typeGuess, lead.scopeRef, lead.topicGuess);
      const summary = buildCandidateSummary(lead.typeGuess, lead.scopeRef, lead.topicGuess);
      const scopeGlob = deriveScopeGlob(lead.scopeRef);
      const lifecycleTriggers = lifecycleForType(lead.typeGuess);
      const inferredTools = [...new Set(events.map((event) => event.toolName))].sort();
      const existing = this.memoryRepository.getById(memoryId);
      const previousSummary = existing !== null ? existing.summary : null;
      const details = buildCandidateDetails(events, previousSummary);

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
              relevantTools: inferredTools,
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
              relevantTools:
                existing !== null && existing.relevantTools !== null
                  ? [...new Set([...existing.relevantTools, ...inferredTools])].sort()
                  : inferredTools,
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
        previousSummary,
      });
      this.dreamRepository.createEvidenceLinks(
        memory.id,
        events.map((event) => event.id),
        run.id,
        now
      );
      consumedEvidenceIds.push(...events.map((event) => event.id));
    }

    if (consumedEvidenceIds.length > 0) {
      this.dreamRepository.markEvidenceEventsConsumed(consumedEvidenceIds, run.id, now);
    }
    if (deferredItems.length > 0) {
      this.dreamRepository.markEvidenceEventsDeferred(deferredItems, run.id, now);
    }
    if (discardedEvidenceIds.length > 0) {
      this.dreamRepository.markEvidenceEventsDiscarded(discardedEvidenceIds, run.id, now);
    }

    const summary =
      suggestions.length === 0
        ? `No candidate memories created from ${evidence.length} recent evidence events; deferred ${deferredEvidenceIds.length}, discarded ${discardedEvidenceIds.length}`
        : `Created or refreshed ${suggestions.length} candidate memories from ${consumedEvidenceIds.length} evidence events; deferred ${deferredEvidenceIds.length}, discarded ${discardedEvidenceIds.length}`;
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
      deferredEvidenceIds,
      discardedEvidenceIds,
      suggestions,
      skippedEvidenceIds,
    };
  }
}
