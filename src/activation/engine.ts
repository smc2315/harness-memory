import type { ActivationClass, MemoryType } from "../db/schema/types";
import {
  MemoryRepository,
  type ListMemoriesInput,
  type MemoryRecord,
} from "../memory";
import type { SummaryRepository, SessionSummaryRecord } from "../retrieval/summary-repository";

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
  const memoryBase = calculateMemoryScore(memory);
  const retrieval = normalizeStartupRetrievalScore(retrievalScore, source);

  // Weight retrieval match 1.5× higher than base memory score.
  // This ensures query-relevant memories rank above high-importance but irrelevant ones.
  return memoryBase * 0.4 + retrieval * 0.6;
}

function compareRankedMemories(left: RankedMemory, right: RankedMemory): number {
  const scoreDelta = right.score - left.score;
  if (scoreDelta !== 0) {
    return scoreDelta;
  }

  return compareMemories(left, right);
}

const HEURISTIC_SESSION_GAP_MS = 6 * 60 * 60 * 1000;

interface PreparedActivation {
  activationStart: number;
  scopeRef: string;
  activeMemories: MemoryRecord[];
  suppressed: SuppressedMemory[];
  sharedLexicalIndex: LexicalIndex;
  maxMemories: number;
  maxPayloadBytes: number;
  queryText: string;
  broadEnglishQuery: boolean;
  /** Activation mode for audit logging. Set by activate() after preparation. */
  activationMode: string;
}

interface SelectionState {
  selected: RankedMemory[];
  selectedIds: Set<string>;
  usedPayloadBytes: number;
}

interface QueryEmbeddingCache {
  raw: Float32Array | null | undefined;
}

interface SummaryWindow {
  summary: SessionSummaryRecord;
  startAtMs: number;
  endAtMs: number;
}

interface ScoredMemoryCandidate {
  memory: MemoryRecord;
  score: number;
  sessionKey: string | null;
}

function compareMemoriesByCreatedAt(left: MemoryRecord, right: MemoryRecord): number {
  const createdAtDelta = Date.parse(left.createdAt) - Date.parse(right.createdAt);
  if (createdAtDelta !== 0) {
    return createdAtDelta;
  }

  return left.id.localeCompare(right.id);
}

function compareMemoriesByUpdatedAtDesc(left: MemoryRecord, right: MemoryRecord): number {
  const updatedAtDelta = Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
  if (updatedAtDelta !== 0) {
    return updatedAtDelta;
  }

  const createdAtDelta = Date.parse(right.createdAt) - Date.parse(left.createdAt);
  if (createdAtDelta !== 0) {
    return createdAtDelta;
  }

  return left.id.localeCompare(right.id);
}

function compareSessionSummariesByCreatedAt(
  left: SessionSummaryRecord,
  right: SessionSummaryRecord,
): number {
  const createdAtDelta = Date.parse(left.createdAt) - Date.parse(right.createdAt);
  if (createdAtDelta !== 0) {
    return createdAtDelta;
  }

  return left.id.localeCompare(right.id);
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

    switch (mode) {
      case "startup":
        return this.activateStartupMode(request, prepared);
      case "temporal":
        return this.activateTemporalMode(request, prepared);
      case "cross_session":
        return this.activateCrossSessionMode(request, prepared);
      case "default":
      default:
        return this.activateDefaultMode(request, prepared);
    }
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
  ): "ok" | "duplicate" | "memory_budget" | "payload_budget" {
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
    outcome: "ok" | "duplicate" | "memory_budget" | "payload_budget",
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

  private async getQueryEmbedding(
    queryText: string,
    cache: QueryEmbeddingCache,
  ): Promise<Float32Array | null> {
    if (cache.raw !== undefined) {
      return cache.raw;
    }

    if (!this.embeddingService?.isReady || queryText.length === 0) {
      cache.raw = null;
      return cache.raw;
    }

    try {
      cache.raw = await this.embeddingService.embedQuery(queryText);
    } catch {
      cache.raw = null;
    }

    return cache.raw;
  }

  private getRetrievedMemoryScore(memory: MemoryRecord, match: RetrievalMatch): number {
    return calculateStartupActivationScore(memory, match.score, match.source);
  }

  private async retrieveMatches(
    prepared: PreparedActivation,
    candidates: readonly MemoryRecord[],
    limit: number,
    queryEmbeddingCache: QueryEmbeddingCache,
  ): Promise<RetrievalMatch[]> {
    if (limit <= 0 || candidates.length === 0 || prepared.queryText.length === 0) {
      return [];
    }

    const expandedQueryText = isBroadScopeRef(prepared.scopeRef)
      ? prepared.queryText
      : `${prepared.scopeRef.replace(/[/\\]/g, " ").replace(/\.[^.]+$/, "")}: ${prepared.queryText}`;
    const candidateIdSet = new Set(candidates.map((memory) => memory.id));
    const memoryById = new Map(candidates.map((memory) => [memory.id, memory]));
    const widerLimit = Math.min(candidates.length, limit * 2);

    const denseResults: FusionCandidate[] = [];
    const denseQueryEmbedding = isBroadScopeRef(prepared.scopeRef)
      ? await this.getQueryEmbedding(prepared.queryText, queryEmbeddingCache)
      : (this.embeddingService?.isReady && expandedQueryText.length > 0
        ? await this.embeddingService.embedQuery(expandedQueryText).catch(() => null)
        : null);
    if (denseQueryEmbedding !== null) {
      const memoriesWithEmbeddings = candidates.filter(
        (memory) => memory.embedding !== null || memory.embeddingSummary !== null,
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

    const lexicalResults: FusionCandidate[] = prepared.sharedLexicalIndex
      .search(prepared.queryText, widerLimit, candidateIdSet)
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
        if (memory === undefined || !matchesScope(memory.scopeGlob, prepared.scopeRef)) {
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
  }

  private listSessionSummaryWindows(): SummaryWindow[] {
    if (this.summaryRepository === null) {
      return [];
    }

    const summaries = this.summaryRepository
      .listSessionSummaries({ orderBy: "created_at" })
      .sort(compareSessionSummariesByCreatedAt);
    let previousEndAtMs = Number.NEGATIVE_INFINITY;

    return summaries.map((summary) => {
      const window: SummaryWindow = {
        summary,
        startAtMs: previousEndAtMs,
        endAtMs: Date.parse(summary.createdAt),
      };
      previousEndAtMs = window.endAtMs;
      return window;
    });
  }

  private getMemoriesForSummaryWindow(
    summary: SessionSummaryRecord,
    windows: readonly SummaryWindow[],
    memories: readonly MemoryRecord[],
  ): MemoryRecord[] {
    const window = windows.find((candidate) => candidate.summary.id === summary.id);
    if (window === undefined) {
      return [];
    }

    return memories.filter((memory) => {
      const createdAtMs = Date.parse(memory.createdAt);
      return createdAtMs > window.startAtMs && createdAtMs <= window.endAtMs;
    });
  }

  private async searchSessionSummaries(
    queryText: string,
    limit: number,
  ): Promise<SessionSummaryRecord[]> {
    if (this.summaryRepository === null || limit <= 0 || queryText.length === 0) {
      return [];
    }

    if (!this.embeddingService?.isReady) {
      return [];
    }

    const summaries = this.summaryRepository.listSessionSummaries({ orderBy: "created_at" });
    if (summaries.length === 0) {
      return [];
    }

    const queryEmbedding = await this.embeddingService.embedQuery(queryText).catch(() => null);
    if (queryEmbedding === null) {
      return [];
    }

    const summariesWithEmbeddings = summaries
      .filter((summary) => summary.embedding !== null)
      .map((summary) => ({
        id: summary.id,
        embedding: summary.embedding as Float32Array,
      }));
    if (summariesWithEmbeddings.length === 0) {
      return [];
    }

    const summaryById = new Map(summaries.map((summary) => [summary.id, summary]));
    return findTopK(
      queryEmbedding,
      summariesWithEmbeddings,
      Math.min(limit, summariesWithEmbeddings.length),
    )
      .map((match) => summaryById.get(match.id))
      .filter((summary): summary is SessionSummaryRecord => summary !== undefined);
  }

  private ensureMinimumSessionSummaries(
    selected: readonly SessionSummaryRecord[],
    allSummaries: readonly SessionSummaryRecord[],
    minimumCount: number,
  ): SessionSummaryRecord[] {
    const ensured = [...selected];
    const seenSessionIds = new Set(ensured.map((summary) => summary.sessionId));
    const recencySorted = [...allSummaries].sort((left, right) => {
      const updatedAtDelta = Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
      if (updatedAtDelta !== 0) {
        return updatedAtDelta;
      }

      return left.id.localeCompare(right.id);
    });

    for (const summary of recencySorted) {
      if (ensured.length >= minimumCount) {
        break;
      }

      if (seenSessionIds.has(summary.sessionId)) {
        continue;
      }

      ensured.push(summary);
      seenSessionIds.add(summary.sessionId);
    }

    return ensured;
  }

  private buildHeuristicSessionKeys(
    memories: readonly MemoryRecord[],
  ): Map<string, string> {
    const sorted = [...memories].sort(compareMemoriesByCreatedAt);
    const sessionKeyById = new Map<string, string>();
    let previousCreatedAtMs: number | null = null;
    let sessionIndex = 0;

    for (const memory of sorted) {
      const createdAtMs = Date.parse(memory.createdAt);
      if (
        previousCreatedAtMs !== null &&
        createdAtMs - previousCreatedAtMs > HEURISTIC_SESSION_GAP_MS
      ) {
        sessionIndex += 1;
      }

      sessionKeyById.set(memory.id, `heuristic:${sessionIndex}`);
      previousCreatedAtMs = createdAtMs;
    }

    return sessionKeyById;
  }

  private interleaveCandidateGroups(
    groups: readonly ScoredMemoryCandidate[][],
  ): ScoredMemoryCandidate[] {
    const queues = groups.map((group) => [...group]);
    const interleaved: ScoredMemoryCandidate[] = [];
    let added = true;

    while (added) {
      added = false;

      for (const queue of queues) {
        const next = queue.shift();
        if (next === undefined) {
          continue;
        }

        interleaved.push(next);
        added = true;
      }
    }

    return interleaved;
  }

  private diversifyBySession<T extends { id: string }>(
    candidates: readonly T[],
    sessionKeyById: Map<string, string>,
    maxPerSession: number,
  ): T[] {
    const grouped = new Map<string, T[]>();
    const groupOrder: string[] = [];

    for (const candidate of candidates) {
      const sessionKey = sessionKeyById.get(candidate.id) ?? `memory:${candidate.id}`;
      const existing = grouped.get(sessionKey);
      if (existing === undefined) {
        grouped.set(sessionKey, [candidate]);
        groupOrder.push(sessionKey);
        continue;
      }

      existing.push(candidate);
    }

    const result: T[] = [];
    const counts = new Map<string, number>();
    let added = true;

    while (added) {
      added = false;

      for (const sessionKey of groupOrder) {
        const usedCount = counts.get(sessionKey) ?? 0;
        if (usedCount >= maxPerSession) {
          continue;
        }

        const group = grouped.get(sessionKey);
        const next = group?.shift();
        if (next === undefined) {
          continue;
        }

        result.push(next);
        counts.set(sessionKey, usedCount + 1);
        added = true;
      }
    }

    return result;
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

  private async activateDefaultMode(
    request: ActivationRequest,
    prepared: PreparedActivation,
    options: { audit?: boolean } = {},
  ): Promise<ActivationResult> {
    const {
      scopeRef,
      activeMemories,
      suppressed,
      sharedLexicalIndex,
      maxMemories,
      maxPayloadBytes,
      queryText,
      broadEnglishQuery,
    } = prepared;
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
          (memory) => memory.embedding !== null || memory.embeddingSummary !== null,
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
    const baselineCap = 2;
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
          (isBroadScopeRef(scopeRef) || matchesScope(memory.scopeGlob, scopeRef)),
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

      let scoreOverride: number | undefined;

      if (request.lifecycleTrigger === "before_tool") {
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

        if (
          request.toolName !== undefined &&
          memory.relevantTools !== null &&
          memory.relevantTools.includes(request.toolName)
        ) {
          scoreOverride = calculateMemoryScore(memory) + 0.15;
        }
      } else if (
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

      const added = tryAdd(memory, scoreOverride);
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
    const reserveExplorationSlot = maxMemories > 1 && queryText.length === 0;
    const coreTarget = reserveExplorationSlot ? maxMemories - 1 : maxMemories;
    const finalSelected: RankedMemory[] = [];
    const finalIds = new Set<string>();
    let finalPayloadBytes = 0;

    for (const memory of penalized) {
      if (finalSelected.length >= coreTarget) {
        break;
      }

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
          memory.lifecycleTriggers.includes(request.lifecycleTrigger),
        )
        .filter((memory) => matchesScope(memory.scopeGlob, scopeRef))
        .filter((memory) =>
          request.toolName === undefined ||
          memory.relevantTools === null ||
          memory.relevantTools.includes(request.toolName),
        )
        .sort(
          (left, right) =>
            Date.parse(right.updatedAt) - Date.parse(left.updatedAt),
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

    return this.finalizeActivationResult(
      request,
      prepared,
      finalSelected,
      suppressed,
      finalPayloadBytes,
      options.audit ?? true,
    );
  }

  private async activateStartupMode(
    request: ActivationRequest,
    prepared: PreparedActivation,
  ): Promise<ActivationResult> {
    const { scopeRef, activeMemories, suppressed, maxMemories, maxPayloadBytes, broadEnglishQuery } = prepared;
    const selection: SelectionState = {
      selected: [],
      selectedIds: new Set<string>(),
      usedPayloadBytes: 0,
    };
    const queryEmbeddingCache: QueryEmbeddingCache = { raw: undefined };

    const baselineClasses: readonly ActivationClass[] = ["baseline"];
    const baselineMemories = activeMemories
      .filter((memory) => baselineClasses.includes(memory.activationClass))
      .sort(compareMemories);
    const baselineCap = 2;
    const baselinePayloadCap = 2_048;
    let baselineUsedBytes = 0;
    let baselineCount = 0;

    if (broadEnglishQuery) {
      const alternateScriptBaseline = await this.retrieveMatches(
        prepared,
        baselineMemories.filter(containsHangulMemory),
        1,
        queryEmbeddingCache,
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

        const added = this.tryAddSelection(
          selection,
          memory,
          maxMemories,
          maxPayloadBytes,
          this.getRetrievedMemoryScore(memory, match),
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

      const added = this.tryAddSelection(selection, memory, maxMemories, maxPayloadBytes);
      if (added === "ok") {
        baselineUsedBytes += payloadBytes;
        baselineCount += 1;
      }
    }

    const recentSessionMemoryIds = new Set<string>();
    if (this.summaryRepository !== null) {
      const recentSummaryIds = new Set(
        this.summaryRepository.listSessionSummaries({ limit: 3 }).map((summary) => summary.id),
      );

      if (recentSummaryIds.size > 0) {
        for (const window of this.listSessionSummaryWindows()) {
          if (!recentSummaryIds.has(window.summary.id)) {
            continue;
          }

          for (const memory of activeMemories) {
            const createdAtMs = Date.parse(memory.createdAt);
            if (createdAtMs > window.startAtMs && createdAtMs <= window.endAtMs) {
              recentSessionMemoryIds.add(memory.id);
            }
          }
        }
      }
    }

    const startupCandidates = activeMemories
      .filter(
        (memory) =>
          memory.activationClass !== "baseline" &&
          !selection.selectedIds.has(memory.id) &&
          (isBroadScopeRef(scopeRef) || matchesScope(memory.scopeGlob, scopeRef)),
      )
      .sort((left, right) => {
        const startupDelta =
          Number(right.activationClass === "startup") -
          Number(left.activationClass === "startup");
        if (startupDelta !== 0) {
          return startupDelta;
        }

        const scoreDelta =
          (calculateMemoryScore(right) + (recentSessionMemoryIds.has(right.id) ? 0.15 : 0)) -
          (calculateMemoryScore(left) + (recentSessionMemoryIds.has(left.id) ? 0.15 : 0));
        if (scoreDelta !== 0) {
          return scoreDelta;
        }

        return compareMemories(left, right);
      });

    for (const memory of startupCandidates) {
      const added = this.tryAddSelection(
        selection,
        memory,
        maxMemories,
        maxPayloadBytes,
        calculateMemoryScore(memory) + (recentSessionMemoryIds.has(memory.id) ? 0.15 : 0),
      );
      this.pushBudgetSuppression(suppressed, memory, added, maxMemories, maxPayloadBytes);
    }

    return this.finalizeActivationResult(
      request,
      prepared,
      selection.selected,
      suppressed,
      selection.usedPayloadBytes,
    );
  }

  private async activateTemporalMode(
    request: ActivationRequest,
    prepared: PreparedActivation,
  ): Promise<ActivationResult> {
    const { activeMemories, suppressed, maxMemories, maxPayloadBytes } = prepared;
    const queryEmbeddingCache: QueryEmbeddingCache = { raw: undefined };
    const summaryWindows = this.listSessionSummaryWindows();
    const matchedSummaries = await this.searchSessionSummaries(prepared.queryText, 5);

    if (summaryWindows.length === 0 || matchedSummaries.length === 0) {
      return this.activateTemporalFallback(request, prepared);
    }

    const perSessionLimit = Math.max(1, Math.ceil(maxMemories / matchedSummaries.length) + 1);
    const combined: ScoredMemoryCandidate[] = [];

    for (const summary of [...matchedSummaries].sort(compareSessionSummariesByCreatedAt)) {
      const sessionMemories = this.getMemoriesForSummaryWindow(summary, summaryWindows, activeMemories)
        .sort(compareMemoriesByCreatedAt);
      if (sessionMemories.length === 0) {
        continue;
      }

      const sessionMatches = await this.retrieveMatches(
        prepared,
        sessionMemories,
        perSessionLimit,
        queryEmbeddingCache,
      );
      if (sessionMatches.length === 0) {
        combined.push(
          ...sessionMemories.slice(0, perSessionLimit).map((memory) => ({
            memory,
            score: calculateMemoryScore(memory),
            sessionKey: summary.sessionId,
          })),
        );
        continue;
      }

      const memoryById = new Map(sessionMemories.map((memory) => [memory.id, memory]));
      for (const match of sessionMatches) {
        const memory = memoryById.get(match.id);
        if (memory === undefined) {
          continue;
        }

        combined.push({
          memory,
          score: this.getRetrievedMemoryScore(memory, match),
          sessionKey: summary.sessionId,
        });
      }
    }

    if (combined.length === 0) {
      return this.activateTemporalFallback(request, prepared);
    }

    const selection: SelectionState = {
      selected: [],
      selectedIds: new Set<string>(),
      usedPayloadBytes: 0,
    };
    const chronological = combined.sort((left, right) => {
      const createdAtDelta = Date.parse(left.memory.createdAt) - Date.parse(right.memory.createdAt);
      if (createdAtDelta !== 0) {
        return createdAtDelta;
      }

      return left.memory.id.localeCompare(right.memory.id);
    });

    for (const candidate of chronological) {
      const added = this.tryAddSelection(
        selection,
        candidate.memory,
        maxMemories,
        maxPayloadBytes,
        candidate.score,
      );
      this.pushBudgetSuppression(suppressed, candidate.memory, added, maxMemories, maxPayloadBytes);
    }

    return this.finalizeActivationResult(
      request,
      prepared,
      selection.selected,
      suppressed,
      selection.usedPayloadBytes,
    );
  }

  private activateTemporalFallback(
    request: ActivationRequest,
    prepared: PreparedActivation,
  ): ActivationResult {
    const { activeMemories, suppressed, maxMemories, maxPayloadBytes } = prepared;
    const selection: SelectionState = {
      selected: [],
      selectedIds: new Set<string>(),
      usedPayloadBytes: 0,
    };

    for (const memory of [...activeMemories].sort(compareMemoriesByUpdatedAtDesc)) {
      const added = this.tryAddSelection(selection, memory, maxMemories, maxPayloadBytes);
      this.pushBudgetSuppression(suppressed, memory, added, maxMemories, maxPayloadBytes);
    }

    return this.finalizeActivationResult(
      request,
      prepared,
      selection.selected,
      suppressed,
      selection.usedPayloadBytes,
    );
  }

  private async activateCrossSessionMode(
    request: ActivationRequest,
    prepared: PreparedActivation,
  ): Promise<ActivationResult> {
    const summaryWindows = this.listSessionSummaryWindows();
    const allSummaries = summaryWindows.map((window) => window.summary);

    if (allSummaries.length === 0) {
      return this.activateCrossSessionFallback(request, prepared);
    }

    const matchedSummaries = await this.searchSessionSummaries(prepared.queryText, 8);
    const selectedSummaries = this.ensureMinimumSessionSummaries(
      matchedSummaries,
      allSummaries,
      3,
    );
    if (selectedSummaries.length === 0) {
      return this.activateCrossSessionFallback(request, prepared);
    }

    const { activeMemories, suppressed, maxMemories, maxPayloadBytes } = prepared;
    const queryEmbeddingCache: QueryEmbeddingCache = { raw: undefined };
    const perSessionLimit = Math.max(1, Math.ceil(maxMemories / selectedSummaries.length));
    const candidateGroups: ScoredMemoryCandidate[][] = [];

    for (const summary of selectedSummaries) {
      const sessionMemories = this.getMemoriesForSummaryWindow(summary, summaryWindows, activeMemories);
      if (sessionMemories.length === 0) {
        continue;
      }

      const sessionMatches = await this.retrieveMatches(
        prepared,
        sessionMemories,
        perSessionLimit,
        queryEmbeddingCache,
      );
      if (sessionMatches.length === 0) {
        candidateGroups.push(
          [...sessionMemories]
            .sort(compareMemories)
            .slice(0, perSessionLimit)
            .map((memory) => ({
              memory,
              score: calculateMemoryScore(memory),
              sessionKey: summary.sessionId,
            })),
        );
        continue;
      }

      const memoryById = new Map(sessionMemories.map((memory) => [memory.id, memory]));
      const sessionCandidates: ScoredMemoryCandidate[] = [];

      for (const match of sessionMatches) {
        const memory = memoryById.get(match.id);
        if (memory === undefined) {
          continue;
        }

        sessionCandidates.push({
          memory,
          score: this.getRetrievedMemoryScore(memory, match),
          sessionKey: summary.sessionId,
        });
      }

      if (sessionCandidates.length > 0) {
        candidateGroups.push(sessionCandidates);
      }
    }

    if (candidateGroups.length === 0) {
      return this.activateCrossSessionFallback(request, prepared);
    }

    const selection: SelectionState = {
      selected: [],
      selectedIds: new Set<string>(),
      usedPayloadBytes: 0,
    };
    const interleaved = this.interleaveCandidateGroups(candidateGroups);

    for (const candidate of interleaved) {
      const added = this.tryAddSelection(
        selection,
        candidate.memory,
        maxMemories,
        maxPayloadBytes,
        candidate.score,
      );
      this.pushBudgetSuppression(suppressed, candidate.memory, added, maxMemories, maxPayloadBytes);
    }

    return this.finalizeActivationResult(
      request,
      prepared,
      selection.selected,
      suppressed,
      selection.usedPayloadBytes,
    );
  }

  private async activateCrossSessionFallback(
    request: ActivationRequest,
    prepared: PreparedActivation,
  ): Promise<ActivationResult> {
    const defaultResult = await this.activateDefaultMode(request, prepared, { audit: false });
    const sessionKeyById = this.buildHeuristicSessionKeys(defaultResult.activated);
    const diversified = this.diversifyBySession(defaultResult.activated, sessionKeyById, 2)
      .map((memory) => ({ ...memory }));
    const usedPayloadBytes = diversified.reduce(
      (total, memory) => total + memory.payloadBytes,
      0,
    );

    return this.finalizeActivationResult(
      request,
      prepared,
      diversified,
      [...defaultResult.suppressed],
      usedPayloadBytes,
    );
  }
}
