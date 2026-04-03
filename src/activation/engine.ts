import type { ActivationClass, MemoryType } from "../db/schema/types";
import {
  MemoryRepository,
  type ListMemoriesInput,
  type MemoryRecord,
} from "../memory";

import { LexicalIndex } from "./lexical";
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
import { RRF_K, rrfFusion, type FusionCandidate } from "./fusion";
import type { AuditLogger } from "../audit/logger";

type StartupScoreSource = "vector" | "lexical" | "hybrid";
const SCOPE_BOOST = 0.05;

interface RetrievalMatch {
  id: string;
  score: number;
  source: StartupScoreSource;
}

function calculateMemoryScore(memory: MemoryRecord): number {
  const base = memory.importance * memory.confidence;
  const freshnessReference = memory.lastVerifiedAt ?? memory.updatedAt ?? memory.createdAt;
  const ageDays = Math.max(
    0,
    (Date.now() - Date.parse(freshnessReference)) / (1000 * 60 * 60 * 24)
  );
  const freshnessMultiplier = Math.max(0.75, 1 - ageDays * 0.01);
  const trustMultiplier =
    memory.promotionSource === "manual"
      ? 1
      : memory.validationCount === 0
        ? 0.65
        : memory.validationCount === 1
          ? 0.8
          : 0.95;

  return base * freshnessMultiplier * trustMultiplier;
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

function isBroadScopeRef(scopeRef: string): boolean {
  return scopeRef === ".";
}

function containsHangul(text: string): boolean {
  return /[\u3131-\u318e\uac00-\ud7a3]/i.test(text);
}

function containsHangulMemory(memory: MemoryRecord): boolean {
  return containsHangul(`${memory.summary} ${memory.details}`);
}

function isEnglishLikeQuery(text: string): boolean {
  return /[A-Za-z]/.test(text) && !containsHangul(text);
}

function normalizeStartupRetrievalScore(
  score: number,
  source: StartupScoreSource,
): number {
  if (source === "vector") {
    return Math.max(0, Math.min(1, score));
  }

  if (source === "hybrid") {
    return Math.min(1, score * (RRF_K + 1));
  }

  if (score <= 0) {
    return 0;
  }

  return score / (score + 1);
}

function calculateStartupActivationScore(
  memory: MemoryRecord,
  retrievalScore: number,
  source: StartupScoreSource,
): number {
  return calculateMemoryScore(memory) + normalizeStartupRetrievalScore(retrievalScore, source);
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
    const activeMemories: MemoryRecord[] = [];
    const suppressed: SuppressedMemory[] = [];

    for (const memory of allMemories) {
      if (!DEFAULT_ACTIVE_STATUSES.includes(memory.status)) {
        suppressed.push({
          memory,
          kind: "status_inactive",
          reason: `Memory status ${memory.status} is not eligible for activation`,
        });
        continue;
      }

      if (memory.ttlExpiresAt !== null && new Date(memory.ttlExpiresAt) < new Date()) {
        suppressed.push({
          memory,
          kind: "ttl_expired",
          reason: `Auto-promoted memory TTL expired at ${memory.ttlExpiresAt}`,
        });
        continue;
      }

      activeMemories.push(memory);
    }

    const sharedLexicalIndex = new LexicalIndex();
    sharedLexicalIndex.rebuild(
      activeMemories.map((memory) => ({
        id: memory.id,
        summary: memory.summary,
        details: memory.details,
      })),
    );

    const maxMemories = request.maxMemories ?? DEFAULT_ACTIVATION_LIMITS.maxMemories;
    const maxPayloadBytes =
      request.maxPayloadBytes ?? DEFAULT_ACTIVATION_LIMITS.maxPayloadBytes;
    const queryText = (request.queryTokens ?? []).join(" ").trim();
    const broadEnglishQuery = isBroadScopeRef(scopeRef) && isEnglishLikeQuery(queryText);
    const selected: RankedMemory[] = [];
    const selectedIds = new Set<string>();
    let usedPayloadBytes = 0;
    let cachedQueryEmbedding: Float32Array | null | undefined;

    const tryAdd = (
      memory: MemoryRecord,
      scoreOverride?: number,
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
        score: scoreOverride ?? calculateMemoryScore(memory),
        payloadBytes,
        rank: selected.length + 1,
      });
      return "ok";
    };

    const getQueryEmbedding = async (): Promise<Float32Array | null> => {
      if (cachedQueryEmbedding !== undefined) {
        return cachedQueryEmbedding;
      }

      if (!this.embeddingService?.isReady || queryText.length === 0) {
        cachedQueryEmbedding = null;
        return cachedQueryEmbedding;
      }

      try {
        cachedQueryEmbedding = await this.embeddingService.embedQuery(queryText);
      } catch {
        cachedQueryEmbedding = null;
      }

      return cachedQueryEmbedding;
    };

    const getRetrievedMemoryScore = (
      memory: MemoryRecord,
      match: RetrievalMatch,
    ): number => calculateStartupActivationScore(memory, match.score, match.source);

    const retrieveMatches = async (
      candidates: readonly MemoryRecord[],
      limit: number,
    ): Promise<RetrievalMatch[]> => {
      if (limit <= 0 || candidates.length === 0 || queryText.length === 0) {
        return [];
      }

      const expandedQueryText = isBroadScopeRef(scopeRef)
        ? queryText
        : `${scopeRef.replace(/[/\\]/g, " ").replace(/\.[^.]+$/, "")}: ${queryText}`;
      const candidateIdSet = new Set(candidates.map((memory) => memory.id));
      const memoryById = new Map(candidates.map((memory) => [memory.id, memory]));
      const widerLimit = Math.min(candidates.length, limit * 2);

      const denseResults: FusionCandidate[] = [];
      const denseQueryEmbedding = isBroadScopeRef(scopeRef)
        ? await getQueryEmbedding()
        : (this.embeddingService?.isReady && expandedQueryText.length > 0
          ? await this.embeddingService.embedQuery(expandedQueryText).catch(() => null)
          : null);
      if (denseQueryEmbedding !== null) {
        const memoriesWithEmbeddings = candidates.filter(
          (memory) => memory.embedding !== null || memory.embeddingSummary !== null
        );
        if (memoriesWithEmbeddings.length > 0) {
          const fullEmbeddings = memoriesWithEmbeddings
            .filter((memory) => memory.embedding !== null)
            .map((memory) => ({
              id: memory.id,
              embedding: memory.embedding as Float32Array,
            }));
          const fullResults = fullEmbeddings.length > 0
            ? findTopK(denseQueryEmbedding, fullEmbeddings, widerLimit)
            : [];

          const summaryEmbeddings = memoriesWithEmbeddings
            .filter((memory) => memory.embeddingSummary !== null)
            .map((memory) => ({
              id: memory.id,
              embedding: memory.embeddingSummary as Float32Array,
            }));
          const summaryResults = summaryEmbeddings.length > 0
            ? findTopK(denseQueryEmbedding, summaryEmbeddings, widerLimit)
            : [];

          const scoreById = new Map<string, number>();
          for (const result of fullResults) {
            scoreById.set(result.id, result.score);
          }
          for (const result of summaryResults) {
            const existingScore = scoreById.get(result.id);
            scoreById.set(
              result.id,
              existingScore === undefined ? result.score : Math.max(existingScore, result.score),
            );
          }

          const mergedResults = [...scoreById.entries()]
            .sort((left, right) => right[1] - left[1])
            .slice(0, widerLimit);

          for (const [id, score] of mergedResults) {
            denseResults.push({
              id,
              score,
              source: "vector",
            });
          }
        }
      }

      const lexicalResults: FusionCandidate[] = sharedLexicalIndex
        .search(queryText, widerLimit, candidateIdSet)
        .map((result) => ({
          id: result.id,
          score: result.score,
          source: "lexical" as const,
        }));

      if (denseResults.length === 0 && lexicalResults.length === 0) {
        return [];
      }

      if (denseResults.length === 0) {
        return lexicalResults.slice(0, limit).map((result) => ({
          id: result.id,
          score: result.score,
          source: "lexical" as const,
        }));
      }

      if (lexicalResults.length === 0) {
        return denseResults.slice(0, limit).map((result) => ({
          id: result.id,
          score: result.score,
          source: "vector" as const,
        }));
      }

      const denseById = new Map(denseResults.map((result) => [result.id, result]));
      const lexicalById = new Map(lexicalResults.map((result) => [result.id, result]));

      const fusedResults = rrfFusion([denseResults, lexicalResults], limit).map((result) => {
        const denseResult = denseById.get(result.id);
        const lexicalResult = lexicalById.get(result.id);

        if (denseResult !== undefined && lexicalResult !== undefined) {
          return {
            id: result.id,
            score: result.score,
            source: "hybrid" as const,
          };
        }

        if (denseResult !== undefined) {
          return {
            id: result.id,
            score: denseResult.score,
            source: "vector" as const,
          };
        }

        return {
          id: result.id,
          score: lexicalResult?.score ?? 0,
          source: "lexical" as const,
        };
      });

      const boostedResults = fusedResults
        .map((result) => {
          const memory = memoryById.get(result.id);
          if (memory === undefined || !matchesScope(memory.scopeGlob, scopeRef)) {
            return result;
          }

          return {
            ...result,
            score: result.score + SCOPE_BOOST,
          };
        })
        .sort((left, right) => {
          const scoreDelta = right.score - left.score;
          if (scoreDelta !== 0) {
            return scoreDelta;
          }

          return left.id.localeCompare(right.id);
        });

      return boostedResults.slice(0, limit);
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

    if (broadEnglishQuery) {
      const alternateScriptBaseline = await retrieveMatches(
        baselineMemories.filter(containsHangulMemory),
        1,
      );

      for (const match of alternateScriptBaseline) {
        const memory = baselineMemories.find((candidate) => candidate.id === match.id);
        if (memory === undefined) {
          continue;
        }

        const payloadBytes = getPayloadBytes(memory);
        if (baselineUsedBytes + payloadBytes > baselinePayloadCap) {
          continue;
        }

        const added = tryAdd(
          memory,
          getRetrievedMemoryScore(memory, match),
        );
        if (added === "ok") {
          baselineUsedBytes += payloadBytes;
          baselineCount += 1;
        }
      }
    }

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

    // Layer B: Startup priors via hybrid retrieval (dense + lexical fusion)
    if ((request.queryTokens?.length ?? 0) > 0) {
      const nonBaseline = activeMemories.filter(
        (memory) =>
          memory.activationClass !== "baseline" &&
          !selectedIds.has(memory.id) &&
          (isBroadScopeRef(scopeRef) || matchesScope(memory.scopeGlob, scopeRef))
      );
      const alternateScriptSlot = broadEnglishQuery ? 1 : 0;
      const startupResults = await retrieveMatches(
        nonBaseline,
        Math.max(0, maxMemories - selected.length - alternateScriptSlot),
      );

      if (broadEnglishQuery) {
        const alternateScriptResults = await retrieveMatches(
          nonBaseline.filter(
            (memory) =>
              containsHangulMemory(memory) &&
              !startupResults.some((result) => result.id === memory.id),
          ),
          1,
        );
        startupResults.push(...alternateScriptResults);
      }

      const memoryById = new Map(nonBaseline.map((memory) => [memory.id, memory]));

      for (const startupResult of startupResults) {
        const memory = memoryById.get(startupResult.id);
        if (memory === undefined) {
          continue;
        }

        const added = tryAdd(
          memory,
          getRetrievedMemoryScore(memory, startupResult),
        );
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

      if (
        request.toolName !== undefined &&
        memory.relevantTools !== null &&
        !memory.relevantTools.includes(request.toolName)
      ) {
        suppressed.push({
          memory,
          kind: "tool_mismatch",
          reason: `Memory relevant tools [${memory.relevantTools.join(",")}] do not include ${request.toolName}`,
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
        .filter((memory) =>
          request.toolName === undefined ||
          memory.relevantTools === null ||
          memory.relevantTools.includes(request.toolName)
        )
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
