import type { ActivationClass, MemoryType } from "../db/schema/types";
import {
  MemoryRepository,
  type ListMemoriesInput,
  type MemoryRecord,
} from "../memory";

import { LexicalIndex, type LexicalDocument } from "./lexical";
import { matchesScope, normalizeScopeRef } from "./scope";
import {
  DEFAULT_ACTIVE_STATUSES,
  DEFAULT_ACTIVATION_LIMITS,
  type ActivationConflict,
  type ActivationRequest,
  type ActivationResult,
  type RankedMemory,
  type SuppressedMemory,
} from "./types";
import { EmbeddingService, findTopK } from "./embeddings";
import type { AuditLogger } from "../audit/logger";

function calculateMemoryScore(memory: MemoryRecord): number {
  const base = memory.importance * memory.confidence;
  const freshnessReference = memory.lastVerifiedAt ?? memory.updatedAt ?? memory.createdAt;
  const ageDays = Math.max(
    0,
    (Date.now() - Date.parse(freshnessReference)) / (1000 * 60 * 60 * 24)
  );
  const freshnessMultiplier = Math.max(0.75, 1 - ageDays * 0.01);

  return base * freshnessMultiplier;
}

function compareMemories(left: MemoryRecord, right: MemoryRecord): number {
  const scoreDelta = calculateMemoryScore(right) - calculateMemoryScore(left);
  if (scoreDelta !== 0) {
    return scoreDelta;
  }

  const importanceDelta = right.importance - left.importance;
  if (importanceDelta !== 0) {
    return importanceDelta;
  }

  const confidenceDelta = right.confidence - left.confidence;
  if (confidenceDelta !== 0) {
    return confidenceDelta;
  }

  const updatedAtDelta =
    Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
  if (updatedAtDelta !== 0) {
    return updatedAtDelta;
  }

  const createdAtDelta = Date.parse(right.createdAt) - Date.parse(left.createdAt);
  if (createdAtDelta !== 0) {
    return createdAtDelta;
  }

  return left.id.localeCompare(right.id);
}

function getPayloadBytes(memory: MemoryRecord): number {
  return Buffer.byteLength(
    JSON.stringify({
      id: memory.id,
      type: memory.type,
      summary: memory.summary,
      details: memory.details,
      scopeGlob: memory.scopeGlob,
      lifecycleTriggers: memory.lifecycleTriggers,
      status: memory.status,
    }),
    "utf8"
  );
}

function buildTypeFilter(types: readonly MemoryType[] | undefined): ListMemoriesInput {
  if (types === undefined || types.length === 0) {
    return {};
  }

  return { type: types };
}

function buildConflictReason(conflict: ActivationConflict): string {
  if (conflict.memories.length === 2) {
    return `Active lineage conflict between ${conflict.memories[0].id} and ${conflict.memories[1].id}`;
  }

  return `Active lineage conflict across ${conflict.memories.length} memories rooted at ${conflict.root.id}`;
}

function getScopePrefix(scopeGlob: string): string {
  const normalized = scopeGlob.replace(/\\/g, "/").replace(/^\.?\//, "");
  const [prefix] = normalized.split("/");
  return prefix ?? "";
}

function compareRankedMemories(left: RankedMemory, right: RankedMemory): number {
  const scoreDelta = right.score - left.score;
  if (scoreDelta !== 0) {
    return scoreDelta;
  }

  return compareMemories(left, right);
}

export class ActivationEngine {
  readonly repository: MemoryRepository;
  private embeddingService: EmbeddingService | null;
  private auditLogger: AuditLogger | null;

  constructor(repository: MemoryRepository, embeddingService?: EmbeddingService, auditLogger?: AuditLogger) {
    this.repository = repository;
    this.embeddingService = embeddingService ?? null;
    this.auditLogger = auditLogger ?? null;
  }

  async activate(request: ActivationRequest): Promise<ActivationResult> {
    const activationStart = Date.now();
    const scopeRef = normalizeScopeRef(request.scopeRef);
    const allMemories = this.repository.list(buildTypeFilter(request.types));
    const activeMemories = allMemories.filter((memory) =>
      DEFAULT_ACTIVE_STATUSES.includes(memory.status)
    );
    const suppressed: SuppressedMemory[] = [];

    for (const memory of allMemories) {
      if (!DEFAULT_ACTIVE_STATUSES.includes(memory.status)) {
        suppressed.push({
          memory,
          kind: "status_inactive",
          reason: `Memory status ${memory.status} is not eligible for activation`,
        });
      }
    }

    const maxMemories = request.maxMemories ?? DEFAULT_ACTIVATION_LIMITS.maxMemories;
    const maxPayloadBytes =
      request.maxPayloadBytes ?? DEFAULT_ACTIVATION_LIMITS.maxPayloadBytes;
    const selected: RankedMemory[] = [];
    const selectedIds = new Set<string>();
    let usedPayloadBytes = 0;

    const tryAdd = (
      memory: MemoryRecord
    ): "ok" | "duplicate" | "memory_budget" | "payload_budget" => {
      if (selectedIds.has(memory.id)) {
        return "duplicate";
      }

      if (selected.length >= maxMemories) {
        return "memory_budget";
      }

      const payloadBytes = getPayloadBytes(memory);
      if (usedPayloadBytes + payloadBytes > maxPayloadBytes) {
        return "payload_budget";
      }

      usedPayloadBytes += payloadBytes;
      selectedIds.add(memory.id);
      selected.push({
        ...memory,
        score: calculateMemoryScore(memory),
        payloadBytes,
        rank: selected.length + 1,
      });
      return "ok";
    };

    // Layer A: Baseline memories (always inject)
    const baselineClasses: readonly ActivationClass[] = ["baseline"];
    const baselineMemories = activeMemories
      .filter((memory) => baselineClasses.includes(memory.activationClass))
      .sort(compareMemories);
    const baselineCap = 3;
    const baselinePayloadCap = 2_048;
    let baselineUsedBytes = 0;
    let baselineCount = 0;

    for (const memory of baselineMemories) {
      if (baselineCount >= baselineCap) {
        break;
      }

      const payloadBytes = getPayloadBytes(memory);
      if (baselineUsedBytes + payloadBytes > baselinePayloadCap) {
        continue;
      }

      const added = tryAdd(memory);
      if (added === "ok") {
        baselineUsedBytes += payloadBytes;
        baselineCount += 1;
      }
    }

    // Layer B: Startup priors via vector retrieval (preferred) or lexical fallback
    if ((request.queryTokens?.length ?? 0) > 0) {
      const nonBaseline = activeMemories.filter(
        (memory) =>
          memory.activationClass !== "baseline" && !selectedIds.has(memory.id)
      );
      let startupResults: { id: string; score: number }[] = [];

      const queryText = (request.queryTokens ?? []).join(" ");
      if (this.embeddingService?.isReady) {
        const memoriesWithEmbeddings = nonBaseline.filter(
          (memory) => memory.embedding !== null
        );
        if (memoriesWithEmbeddings.length > 0) {
          try {
            const queryEmbedding = await this.embeddingService.embedQuery(queryText);
            startupResults = findTopK(
              queryEmbedding,
              memoriesWithEmbeddings.map((memory) => ({
                id: memory.id,
                embedding: memory.embedding as Float32Array,
              })),
              Math.max(0, maxMemories - selected.length)
            );
          } catch {
            // Fall through to lexical search.
          }
        }
      }

      if (startupResults.length === 0) {
        const lexical = new LexicalIndex();
        const lexicalDocs: LexicalDocument[] = nonBaseline.map((memory) => ({
          id: memory.id,
          summary: memory.summary,
          details: memory.details,
        }));

        lexical.rebuild(lexicalDocs);
        const queryTerms = [
          ...(request.queryTokens ?? []),
          ...(request.repoFingerprint ?? []),
        ];
        startupResults = lexical.search(
          queryTerms.join(" "),
          Math.max(0, maxMemories - selected.length)
        );
      }

      const memoryById = new Map(nonBaseline.map((memory) => [memory.id, memory]));

      for (const startupResult of startupResults) {
        const memory = memoryById.get(startupResult.id);
        if (memory === undefined) {
          continue;
        }

        const added = tryAdd(memory);
        if (added === "memory_budget") {
          suppressed.push({
            memory,
            kind: "budget_limit",
            reason: `Activation memory budget exceeded at ${maxMemories} memories`,
          });
        } else if (added === "payload_budget") {
          suppressed.push({
            memory,
            kind: "budget_limit",
            reason: `Activation payload budget exceeded at ${maxPayloadBytes} bytes`,
          });
        }
      }
    }

    // Layer C: Scoped retrieval with trigger + scope checks (excluding A/B)
    const scopedCandidates = activeMemories
      .filter((memory) => !selectedIds.has(memory.id))
      .sort(compareMemories);

    for (const memory of scopedCandidates) {
      if (!memory.lifecycleTriggers.includes(request.lifecycleTrigger)) {
        suppressed.push({
          memory,
          kind: "trigger_mismatch",
          reason: `Memory does not activate on ${request.lifecycleTrigger}`,
        });
        continue;
      }

      if (!matchesScope(memory.scopeGlob, scopeRef)) {
        suppressed.push({
          memory,
          kind: "scope_mismatch",
          reason: `Scope glob ${memory.scopeGlob} does not match ${scopeRef}`,
        });
        continue;
      }

      const added = tryAdd(memory);
      if (added === "memory_budget") {
        suppressed.push({
          memory,
          kind: "budget_limit",
          reason: `Activation memory budget exceeded at ${maxMemories} memories`,
        });
      } else if (added === "payload_budget") {
        suppressed.push({
          memory,
          kind: "budget_limit",
          reason: `Activation payload budget exceeded at ${maxPayloadBytes} bytes`,
        });
      }
    }

    // Layer D: Diversity rerank + exploration slot
    const scopeSeen = new Set<string>();
    const penalized = [...selected]
      .sort(compareRankedMemories)
      .map((memory) => {
        const scopePrefix = getScopePrefix(memory.scopeGlob);
        const hasPrefixCollision = scopePrefix.length > 0 && scopeSeen.has(scopePrefix);

        if (scopePrefix.length > 0) {
          scopeSeen.add(scopePrefix);
        }

        if (!hasPrefixCollision) {
          return memory;
        }

        return {
          ...memory,
          score: memory.score * 0.7,
        };
      })
      .sort(compareRankedMemories);

    const typeQuotas: Record<MemoryType, number> = {
      policy: 3,
      workflow: 3,
      pitfall: 2,
      architecture_constraint: 1,
      decision: 1,
    };
    const typeCounts = new Map<MemoryType, number>();
    const reserveExplorationSlot = maxMemories > 1;
    const coreTarget = reserveExplorationSlot ? maxMemories - 1 : maxMemories;
    const finalSelected: RankedMemory[] = [];
    const finalIds = new Set<string>();
    let finalPayloadBytes = 0;

    for (const memory of penalized) {
      if (finalSelected.length >= coreTarget) {
        break;
      }

      // Baseline memories are NEVER removed by type quotas.
      // They still count toward the quota so scoped memories don't flood.
      const isBaseline = memory.activationClass === "baseline";

      if (!isBaseline) {
        const currentCount = typeCounts.get(memory.type) ?? 0;
        const quota = typeQuotas[memory.type] ?? 2;
        if (currentCount >= quota) {
          suppressed.push({
            memory,
            kind: "type_balance_limit",
            reason: `Type quota exceeded for ${memory.type}`,
          });
          continue;
        }
      }

      if (finalPayloadBytes + memory.payloadBytes > maxPayloadBytes) {
        suppressed.push({
          memory,
          kind: "budget_limit",
          reason: `Activation payload budget exceeded at ${maxPayloadBytes} bytes`,
        });
        continue;
      }

      typeCounts.set(memory.type, (typeCounts.get(memory.type) ?? 0) + 1);
      finalPayloadBytes += memory.payloadBytes;
      finalIds.add(memory.id);
      finalSelected.push(memory);
    }

    let explorationAdded = false;
    if (reserveExplorationSlot && finalSelected.length < maxMemories) {
      const explorationCandidate = activeMemories
        .filter((memory) => !finalIds.has(memory.id))
        .filter((memory) =>
          memory.lifecycleTriggers.includes(request.lifecycleTrigger)
        )
        .filter((memory) => matchesScope(memory.scopeGlob, scopeRef))
        .sort(
          (left, right) =>
            Date.parse(right.updatedAt) - Date.parse(left.updatedAt)
        )[0];

      if (explorationCandidate !== undefined) {
        const payloadBytes = getPayloadBytes(explorationCandidate);
        if (finalPayloadBytes + payloadBytes <= maxPayloadBytes) {
          finalPayloadBytes += payloadBytes;
          finalIds.add(explorationCandidate.id);
          finalSelected.push({
            ...explorationCandidate,
            score: calculateMemoryScore(explorationCandidate),
            payloadBytes,
            rank: finalSelected.length + 1,
          });
          explorationAdded = true;
        }
      }
    }

    if (!explorationAdded && finalSelected.length < maxMemories) {
      for (const memory of penalized) {
        if (finalIds.has(memory.id)) {
          continue;
        }

        if (finalPayloadBytes + memory.payloadBytes > maxPayloadBytes) {
          continue;
        }

        finalPayloadBytes += memory.payloadBytes;
        finalIds.add(memory.id);
        finalSelected.push(memory);
        break;
      }
    }

    finalSelected.forEach((memory, index) => {
      memory.rank = index + 1;
    });

    const conflicts: ActivationConflict[] = this.repository
      .listLineageConflicts(finalSelected.map((memory) => memory.id))
      .map((conflict): ActivationConflict => {
        const activationConflict: ActivationConflict = {
          kind: "lineage_conflict",
          root: conflict.root,
          memories: conflict.memories,
          reason: "",
        };

        return {
          ...activationConflict,
          reason: buildConflictReason(activationConflict),
        };
      });

    const result: ActivationResult = {
      activated: finalSelected,
      suppressed,
      conflicts,
      budget: {
        maxMemories,
        maxPayloadBytes,
        usedMemories: finalSelected.length,
        usedPayloadBytes: finalPayloadBytes,
      },
    };

    // Audit log: record the full activation decision for later analysis.
    if (this.auditLogger !== null) {
      this.auditLogger.logActivation(
        undefined,
        scopeRef,
        {
          trigger: request.lifecycleTrigger,
          scopeRef,
          queryTokens: request.queryTokens ?? [],
          candidateCount: activeMemories.length,
          activatedCount: finalSelected.length,
          suppressedCount: suppressed.length,
          activated: finalSelected.map((m) => ({
            id: m.id,
            type: m.type,
            summary: m.summary,
            score: m.score,
          })),
          suppressed: suppressed.map((s) => ({
            id: s.memory.id,
            kind: s.kind,
            reason: s.reason,
          })),
          budgetUsedBytes: finalPayloadBytes,
          budgetMaxBytes: maxPayloadBytes,
          durationMs: Date.now() - activationStart,
        },
      );
    }

    return result;
  }
}
