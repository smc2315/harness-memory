import type { MemoryType } from "../db/schema/types";
import {
  MemoryRepository,
  type ListMemoriesInput,
  type MemoryRecord,
} from "../memory";
import type { SummaryRepository } from "../retrieval/summary-repository";

import type { AuditLogger } from "../audit/logger";
import { activateCrossSessionMode } from "./mode-cross-session";
import { activateDefaultMode } from "./mode-default";
import { activateStartupMode } from "./mode-startup";
import { activateTemporalMode } from "./mode-temporal";
import {
  isBroadScopeRef,
  isEnglishLikeQuery,
  type ActivationContext,
  type ActivationModeHelpers,
  type PreparedActivation,
  type SelectionOutcome,
  type SelectionState,
} from "./retrieval-helpers";
import { LexicalIndex } from "./lexical";
import { normalizeScopeRef } from "./scope";
import {
  DEFAULT_ACTIVE_STATUSES,
  DEFAULT_ACTIVATION_LIMITS,
  type ActivationConflict,
  type ActivationRequest,
  type ActivationResult,
  type RankedMemory,
  type SuppressedMemory,
} from "./types";
import { type EmbeddingService } from "./embeddings";

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

export class ActivationEngine {
  readonly repository: MemoryRepository;
  private embeddingService: EmbeddingService | null;
  private auditLogger: AuditLogger | null;
  private summaryRepository: SummaryRepository | null;

  constructor(repository: MemoryRepository, embeddingService?: EmbeddingService, auditLogger?: AuditLogger) {
    this.repository = repository;
    this.embeddingService = embeddingService ?? null;
    this.auditLogger = auditLogger ?? null;
    this.summaryRepository = null;
  }

  /**
   * Set the summary repository for hierarchical retrieval.
   * Optional — when not set, temporal/cross-session modes degrade gracefully.
   */
  setSummaryRepository(repo: SummaryRepository): void {
    this.summaryRepository = repo;
  }

  async activate(request: ActivationRequest): Promise<ActivationResult> {
    const mode = request.activationMode ?? "default";
    const prepared = this.prepareActivation(
      request,
      mode === "temporal" ? true : (request.includeSuperseded ?? false),
    );

    // Store mode in prepared for audit logging
    prepared.activationMode = mode;
    const context = this.getActivationContext();
    const helpers = this.getModeHelpers();

    switch (mode) {
      case "startup":
        return activateStartupMode(context, request, prepared, helpers);
      case "temporal":
        return activateTemporalMode(context, request, prepared, helpers);
      case "cross_session":
        return activateCrossSessionMode(context, request, prepared, helpers);
      case "default":
      default:
        return activateDefaultMode(context, request, prepared, helpers);
    }
  }

  private getActivationContext(): ActivationContext {
    return {
      repository: this.repository,
      embeddingService: this.embeddingService,
      auditLogger: this.auditLogger,
      summaryRepository: this.summaryRepository,
    };
  }

  private getModeHelpers(): ActivationModeHelpers {
    return {
      calculateMemoryScore,
      getPayloadBytes,
      tryAddSelection: (...args) => this.tryAddSelection(...args),
      pushBudgetSuppression: (...args) => this.pushBudgetSuppression(...args),
      finalizeActivationResult: (...args) => this.finalizeActivationResult(...args),
    };
  }

  private prepareActivation(
    request: ActivationRequest,
    includeSuperseded: boolean,
  ): PreparedActivation {
    const activationStart = Date.now();
    const scopeRef = normalizeScopeRef(request.scopeRef);
    const allMemories = this.repository.list(buildTypeFilter(request.types));
    const activeMemories: MemoryRecord[] = [];
    const suppressed: SuppressedMemory[] = [];
    const allowedStatuses = includeSuperseded
      ? [...DEFAULT_ACTIVE_STATUSES, "superseded" as const]
      : DEFAULT_ACTIVE_STATUSES;

    for (const memory of allMemories) {
      if (!allowedStatuses.includes(memory.status)) {
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

    return {
      activationStart,
      scopeRef,
      activeMemories,
      suppressed,
      sharedLexicalIndex,
      maxMemories,
      maxPayloadBytes,
      queryText,
      broadEnglishQuery: isBroadScopeRef(scopeRef) && isEnglishLikeQuery(queryText),
      activationMode: "default", // overwritten by activate() after dispatch
    };
  }

  private tryAddSelection(
    selection: SelectionState,
    memory: MemoryRecord,
    maxMemories: number,
    maxPayloadBytes: number,
    scoreOverride?: number,
  ): SelectionOutcome {
    if (selection.selectedIds.has(memory.id)) {
      return "duplicate";
    }

    if (selection.selected.length >= maxMemories) {
      return "memory_budget";
    }

    const payloadBytes = getPayloadBytes(memory);
    if (selection.usedPayloadBytes + payloadBytes > maxPayloadBytes) {
      return "payload_budget";
    }

    selection.usedPayloadBytes += payloadBytes;
    selection.selectedIds.add(memory.id);
    selection.selected.push({
      ...memory,
      score: scoreOverride ?? calculateMemoryScore(memory),
      payloadBytes,
      rank: selection.selected.length + 1,
    });
    return "ok";
  }

  private pushBudgetSuppression(
    suppressed: SuppressedMemory[],
    memory: MemoryRecord,
    outcome: SelectionOutcome,
    maxMemories: number,
    maxPayloadBytes: number,
  ): void {
    if (outcome === "memory_budget") {
      suppressed.push({
        memory,
        kind: "budget_limit",
        reason: `Activation memory budget exceeded at ${maxMemories} memories`,
      });
    } else if (outcome === "payload_budget") {
      suppressed.push({
        memory,
        kind: "budget_limit",
        reason: `Activation payload budget exceeded at ${maxPayloadBytes} bytes`,
      });
    }
  }

  private finalizeActivationResult(
    request: ActivationRequest,
    prepared: PreparedActivation,
    activated: RankedMemory[],
    suppressed: SuppressedMemory[],
    usedPayloadBytes: number,
    audit = true,
  ): ActivationResult {
    activated.forEach((memory, index) => {
      memory.rank = index + 1;
    });

    const conflicts: ActivationConflict[] = this.repository
      .listLineageConflicts(activated.map((memory) => memory.id))
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
      activated,
      suppressed,
      conflicts,
      budget: {
        maxMemories: prepared.maxMemories,
        maxPayloadBytes: prepared.maxPayloadBytes,
        usedMemories: activated.length,
        usedPayloadBytes,
      },
    };

    if (audit && this.auditLogger !== null) {
      this.auditLogger.logActivation(
        undefined,
        prepared.scopeRef,
        {
          trigger: request.lifecycleTrigger,
          scopeRef: prepared.scopeRef,
          queryTokens: request.queryTokens ?? [],
          activationMode: prepared.activationMode,
          queryType: request.activationMode ?? "default",
          startupPackInjected: prepared.activationMode === "startup",
          candidateCount: prepared.activeMemories.length,
          activatedCount: activated.length,
          suppressedCount: suppressed.length,
          activated: activated.map((memory) => ({
            id: memory.id,
            type: memory.type,
            summary: memory.summary,
            score: memory.score,
          })),
          suppressed: suppressed.map((entry) => ({
            id: entry.memory.id,
            kind: entry.kind,
            reason: entry.reason,
          })),
          budgetUsedBytes: usedPayloadBytes,
          budgetMaxBytes: prepared.maxPayloadBytes,
          durationMs: Date.now() - prepared.activationStart,
        },
      );
    }

    return result;
  }
}
