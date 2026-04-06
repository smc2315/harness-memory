import { basename, extname } from "path";

import type {
  ActionDistribution,
  DreamEvidenceTypeGuess,
  LifecycleTrigger,
  SignalTag,
} from "../db/schema/types";
import type { MemoryRecord } from "../memory";
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
const LATENT_TTL_DAYS = 14;
const TIME_ADJACENCY_WINDOW_MS = 5 * 60 * 1000;

const SIGNAL_PATTERNS: ReadonlyArray<{
  tag: SignalTag;
  pattern: RegExp;
  field: "excerpt" | "args";
}> = [
  { tag: "failure_signal", pattern: /error|failed|exception|timeout|refused/i, field: "excerpt" },
  {
    tag: "success_signal",
    pattern: /passed|resolved|fixed|completed|migrated|created|updated/i,
    field: "excerpt",
  },
  {
    tag: "decision_signal",
    pattern: /decided|chose|switched|replaced|deprecated|changed\s.*\sto/i,
    field: "excerpt",
  },
  {
    tag: "convention_signal",
    pattern: /always|never|convention|must|should|standard|rule/i,
    field: "excerpt",
  },
  {
    tag: "architecture_signal",
    pattern: /architecture|boundary|layer|component|module|structure/i,
    field: "excerpt",
  },
  {
    tag: "temporal_cue",
    pattern: /before|after|previously|used to|switched from/i,
    field: "excerpt",
  },
  {
    tag: "explicit_marker",
    pattern: /do not|always use|fixed by|known error/i,
    field: "excerpt",
  },
  { tag: "has_file_context", pattern: /path|file|src\//i, field: "args" },
];

function nowIsoString(): string {
  return new Date().toISOString();
}

function isoHoursAgo(hours: number, reference: string): string {
  return new Date(Date.parse(reference) - hours * 60 * 60 * 1000).toISOString();
}

function normalizePathLike(value: string): string {
  return value.replace(/\\/g, "/");
}

function deriveScopeGlob(scopeRef: string): string {
  const normalized = normalizePathLike(scopeRef);
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

function buildStructuralGroupKey(event: DreamEvidenceEventRecord): string {
  // Stage 1 groups structurally; stage 2 can add lexical/embedding batch merges.
  return [event.sessionId, event.scopeRef, event.toolName].join("|");
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
 * language - they are reference data, not the primary search target.
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

function extractSignalTags(events: readonly DreamEvidenceEventRecord[]): SignalTag[] {
  const tags = new Set<SignalTag>();
  for (const event of events) {
    for (const { tag, pattern, field } of SIGNAL_PATTERNS) {
      const text = field === "excerpt" ? event.excerpt : parseArgsJson(event);
      if (pattern.test(text)) {
        tags.add(tag);
      }
    }
  }

  return [...tags];
}

function deriveConfidenceFromTier(tier: 1 | 2 | 3, eventCount: number): number {
  if (tier === 1) {
    return Math.min(0.95, 0.8 + eventCount * 0.02);
  }

  if (tier === 2) {
    return Math.min(0.85, 0.6 + eventCount * 0.05);
  }

  return 0.4;
}

function deriveImportanceFromTags(tags: readonly SignalTag[], eventCount: number): number {
  let importance = 0.4;
  if (tags.includes("failure_signal")) {
    importance += 0.15;
  }
  if (tags.includes("decision_signal")) {
    importance += 0.1;
  }
  if (tags.includes("architecture_signal")) {
    importance += 0.1;
  }
  if (tags.includes("convention_signal")) {
    importance += 0.05;
  }
  importance += Math.min(0.2, (eventCount - 1) * 0.1);
  return Math.min(0.95, importance);
}

function classifyTier(events: readonly DreamEvidenceEventRecord[], tags: readonly SignalTag[]): 1 | 2 | 3 {
  if (events.length >= 3) {
    return 1;
  }
  if (tags.includes("failure_signal") && tags.includes("has_file_context")) {
    return 1;
  }
  if (events.length >= 2) {
    return 2;
  }
  if (tags.length > 0) {
    return 2;
  }
  return 3;
}

function compareEventsByCreatedAt(
  left: DreamEvidenceEventRecord,
  right: DreamEvidenceEventRecord
): number {
  const createdAtDelta = Date.parse(left.createdAt) - Date.parse(right.createdAt);
  if (createdAtDelta !== 0) {
    return createdAtDelta;
  }

  return left.id.localeCompare(right.id);
}

function groupEventsStructurally(
  events: readonly DreamEvidenceEventRecord[]
): Map<string, DreamEvidenceEventRecord[]> {
  const groups = new Map<string, DreamEvidenceEventRecord[]>();

  for (const event of events) {
    const key = buildStructuralGroupKey(event);
    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, [event]);
      continue;
    }

    existing.push(event);
  }

  for (const [key, groupedEvents] of groups) {
    groups.set(key, [...groupedEvents].sort(compareEventsByCreatedAt));
  }

  return groups;
}

function mergeTimeAdjacentGroups(
  groups: Map<string, DreamEvidenceEventRecord[]>
): Map<string, DreamEvidenceEventRecord[]> {
  type GroupEntry = {
    key: string;
    events: DreamEvidenceEventRecord[];
  };

  const buckets = new Map<string, GroupEntry[]>();
  for (const [key, events] of groups) {
    const firstEvent = events[0];
    if (firstEvent === undefined) {
      continue;
    }

    const bucketKey = [firstEvent.sessionId, firstEvent.scopeRef].join("|");
    const bucket = buckets.get(bucketKey) ?? [];
    bucket.push({ key, events: [...events].sort(compareEventsByCreatedAt) });
    buckets.set(bucketKey, bucket);
  }

  const merged = new Map<string, DreamEvidenceEventRecord[]>();

  for (const entries of buckets.values()) {
    entries.sort((left, right) => compareEventsByCreatedAt(left.events[0]!, right.events[0]!));

    let current = entries[0];
    if (current === undefined) {
      continue;
    }

    for (const next of entries.slice(1)) {
      const currentLatest = current.events[current.events.length - 1];
      const nextEarliest = next.events[0];
      if (currentLatest === undefined || nextEarliest === undefined) {
        continue;
      }

      const gap = Date.parse(nextEarliest.createdAt) - Date.parse(currentLatest.createdAt);
      if (gap < TIME_ADJACENCY_WINDOW_MS) {
        const mergedEvents = [...current.events, ...next.events].sort(compareEventsByCreatedAt);
        const preferredKey = next.events.length > current.events.length ? next.key : current.key;
        current = {
          key: preferredKey,
          events: mergedEvents,
        };
        continue;
      }

      merged.set(current.key, current.events);
      current = next;
    }

    merged.set(current.key, current.events);
  }

  return merged;
}

function createActionDistribution(): ActionDistribution {
  return {
    create: 0,
    reinforce: 0,
    supersede: 0,
    stale: 0,
    latent: 0,
    skip: 0,
  };
}

function isNoiseEvent(event: DreamEvidenceEventRecord): boolean {
  return (
    event.title.trim().length === 0 &&
    event.excerpt.trim().length === 0 &&
    parseArgsJson(event).trim().length === 0
  );
}

function latestEventTimestamp(events: readonly DreamEvidenceEventRecord[], fallback: string): string {
  const latestEvent = [...events].sort(compareEventsByCreatedAt)[events.length - 1];
  return latestEvent?.createdAt ?? fallback;
}

function isOlderThanDays(reference: string, now: string, days: number): boolean {
  return Date.parse(now) - Date.parse(reference) > days * 24 * 60 * 60 * 1000;
}

function matchesMemoryScope(event: DreamEvidenceEventRecord, memory: MemoryRecord): boolean {
  const normalizedScopeRef = normalizePathLike(event.scopeRef);
  const derivedScopeGlob = deriveScopeGlob(normalizedScopeRef);
  const memoryScopeGlob = normalizePathLike(memory.scopeGlob);

  if (
    memoryScopeGlob === normalizedScopeRef ||
    memoryScopeGlob === derivedScopeGlob ||
    memoryScopeGlob === "**/*"
  ) {
    return true;
  }

  if (memoryScopeGlob.endsWith("/**/*")) {
    const prefix = memoryScopeGlob.slice(0, -5);
    return normalizedScopeRef === prefix || normalizedScopeRef.startsWith(`${prefix}/`);
  }

  return false;
}

function hasContradictingEvidence(
  events: readonly DreamEvidenceEventRecord[],
  tags: readonly SignalTag[]
): boolean {
  if (events.some((event) => event.contradictionSignal)) {
    return true;
  }

  return (
    (tags.includes("decision_signal") && tags.includes("temporal_cue")) ||
    (tags.includes("explicit_marker") && tags.includes("temporal_cue"))
  );
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
      summary: `Dream run queued with ${evidence.length} processable evidence events`,
    });

    const suggestions: DreamCandidateSuggestion[] = [];
    const actionDistribution = createActionDistribution();
    const materializedEvidenceIds = new Set<string>();
    const latentEvidenceIds = new Set<string>();
    const discardedEvidenceIds = new Set<string>();
    const skippedEvidenceIds: string[] = [];
    const retainedEvidence: DreamEvidenceEventRecord[] = [];
    const groupedEvidenceIds = new Set<string>();
    const supersedeTargetIdsByEvidenceId = new Map<string, string[]>();
    const claimedEvidenceIds = new Set<string>();

    for (const event of evidence) {
      if (isNoiseEvent(event)) {
        skippedEvidenceIds.push(event.id);
        discardedEvidenceIds.add(event.id);
        actionDistribution.skip += 1;
        continue;
      }

      retainedEvidence.push(event);
    }

    if (retainedEvidence.length > 0) {
      this.dreamRepository.markEvidenceEventsRetained(
        retainedEvidence.map((event) => event.id),
        run.id,
        now
      );
    }

    const atRiskMemories = this.dreamRepository.listAtRiskMemories({
      staleAfterDays: 7,
      minConfidence: 0.7,
    });

    for (const atRiskMemory of atRiskMemories) {
      const memory = this.memoryRepository.getById(atRiskMemory.id);
      if (memory === null) {
        continue;
      }

      const matchingEvidence = retainedEvidence.filter(
        (event) =>
          !claimedEvidenceIds.has(event.id) &&
          event.typeGuess === memory.type &&
          matchesMemoryScope(event, memory)
      );

      if (matchingEvidence.length > 0) {
        const tags = extractSignalTags(matchingEvidence);
        if (hasContradictingEvidence(matchingEvidence, tags)) {
          for (const event of matchingEvidence) {
            claimedEvidenceIds.add(event.id);
            const existingTargets = supersedeTargetIdsByEvidenceId.get(event.id) ?? [];
            existingTargets.push(memory.id);
            supersedeTargetIdsByEvidenceId.set(event.id, existingTargets);
          }
        } else {
          const verifiedAt = latestEventTimestamp(matchingEvidence, now);
          const newConfidence = Math.min(0.99, memory.confidence + 0.05);
          this.memoryRepository.update(memory.id, {
            confidence: newConfidence,
            lastVerifiedAt: verifiedAt,
            updatedAt: now,
          });
          this.dreamRepository.createEvidenceLinks(
            memory.id,
            matchingEvidence.map((event) => event.id),
            run.id,
            now
          );

          for (const event of matchingEvidence) {
            claimedEvidenceIds.add(event.id);
            materializedEvidenceIds.add(event.id);
          }

          actionDistribution.reinforce += matchingEvidence.length;
        }

        continue;
      }

      const verificationReference = memory.lastVerifiedAt ?? memory.updatedAt ?? memory.createdAt;
      if (isOlderThanDays(verificationReference, now, LATENT_TTL_DAYS)) {
        this.memoryRepository.update(memory.id, {
          status: "stale",
          updatedAt: now,
        });
        actionDistribution.stale += 1;
      }
    }

    const groupableEvidence = retainedEvidence.filter(
      (event) => supersedeTargetIdsByEvidenceId.has(event.id) || !claimedEvidenceIds.has(event.id)
    );
    const mergedGroups = mergeTimeAdjacentGroups(groupEventsStructurally(groupableEvidence));

    for (const events of mergedGroups.values()) {
      for (const event of events) {
        groupedEvidenceIds.add(event.id);
      }
    }

    if (groupedEvidenceIds.size > 0) {
      this.dreamRepository.markEvidenceEventsGrouped([...groupedEvidenceIds], run.id, now);
    }

    const appliedSupersedeTargets = new Set<string>();

    for (const events of mergedGroups.values()) {
      const tags = extractSignalTags(events);
      const supersedeTargetIds = [...new Set(
        events.flatMap((event) => supersedeTargetIdsByEvidenceId.get(event.id) ?? [])
      )];
      const classifiedTier = classifyTier(events, tags);
      const tier: 1 | 2 | 3 =
        supersedeTargetIds.length > 0 && classifiedTier === 3 ? 2 : classifiedTier;

      if (tier === 3) {
        for (const event of events) {
          latentEvidenceIds.add(event.id);
        }
        actionDistribution.latent += events.length;
        continue;
      }

      const lead = events[0]!;
      const confidence = deriveConfidenceFromTier(tier, events.length);
      const importance = deriveImportanceFromTags(tags, events.length);
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
                existing.relevantTools !== null
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

      for (const event of events) {
        materializedEvidenceIds.add(event.id);
      }

      if (supersedeTargetIds.length > 0) {
        for (const targetMemoryId of supersedeTargetIds) {
          if (appliedSupersedeTargets.has(targetMemoryId)) {
            continue;
          }

          this.memoryRepository.update(targetMemoryId, {
            status: "stale",
            updatedAt: now,
          });
          appliedSupersedeTargets.add(targetMemoryId);
        }
        actionDistribution.supersede += events.length;
      } else {
        actionDistribution.create += events.length;
      }
    }

    if (skippedEvidenceIds.length > 0) {
      this.dreamRepository.markEvidenceEventsDiscarded(skippedEvidenceIds, run.id, now);
    }
    if (materializedEvidenceIds.size > 0) {
      this.dreamRepository.markEvidenceEventsMaterialized([...materializedEvidenceIds], run.id, now);
    }
    if (latentEvidenceIds.size > 0) {
      this.dreamRepository.markEvidenceEventsLatent([...latentEvidenceIds], run.id, now);
    }

    const expiredLatentEvidenceIds = this.dreamRepository.cleanupExpiredLatentEvidence(LATENT_TTL_DAYS, now);
    for (const evidenceId of expiredLatentEvidenceIds) {
      discardedEvidenceIds.add(evidenceId);
    }

    const summary =
      `Dream run processed ${evidence.length} evidence events: ` +
      `create ${actionDistribution.create}, ` +
      `reinforce ${actionDistribution.reinforce}, ` +
      `supersede ${actionDistribution.supersede}, ` +
      `stale ${actionDistribution.stale}, ` +
      `latent ${actionDistribution.latent}, ` +
      `skip ${actionDistribution.skip}`;
    const completedRun = this.dreamRepository.completeDreamRun(run.id, {
      status: "completed",
      summary,
      candidateCount: suggestions.length,
      completedAt: now,
    });

    const orderedMaterializedEvidenceIds = [...materializedEvidenceIds].sort();
    const orderedLatentEvidenceIds = [...latentEvidenceIds].sort();
    const orderedDiscardedEvidenceIds = [...discardedEvidenceIds].sort();

    return {
      run: completedRun,
      processedEvidenceCount: evidence.length,
      consumedEvidenceIds: orderedMaterializedEvidenceIds,
      materializedEvidenceIds: orderedMaterializedEvidenceIds,
      latentEvidenceIds: orderedLatentEvidenceIds,
      deferredEvidenceIds: [],
      discardedEvidenceIds: orderedDiscardedEvidenceIds,
      suggestions,
      skippedEvidenceIds,
      actionDistribution,
    };
  }
}
