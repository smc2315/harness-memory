import type { MemoryRecord, MemoryRepository } from "../memory";
import type { AuditLogger } from "../audit/logger";
import type {
  SummaryRepository,
  SessionSummaryRecord,
} from "../retrieval/summary-repository";

import { type EmbeddingService, findTopK } from "./embeddings";
import { RRF_K, rrfFusion, type FusionCandidate } from "./fusion";
import type { LexicalIndex } from "./lexical";
import { matchesScope } from "./scope";
import type {
  ActivationRequest,
  ActivationResult,
  RankedMemory,
  SuppressedMemory,
} from "./types";

type StartupScoreSource = "vector" | "lexical" | "hybrid";
const SCOPE_BOOST = 0.05;
export const HEURISTIC_SESSION_GAP_MS = 6 * 60 * 60 * 1000;

export interface ActivationContext {
  repository: MemoryRepository;
  embeddingService: EmbeddingService | null;
  auditLogger: AuditLogger | null;
  summaryRepository: SummaryRepository | null;
}

export interface RetrievalMatch {
  id: string;
  score: number;
  source: StartupScoreSource;
}

export interface PreparedActivation {
  activationStart: number;
  scopeRef: string;
  activeMemories: MemoryRecord[];
  suppressed: SuppressedMemory[];
  sharedLexicalIndex: LexicalIndex;
  maxMemories: number;
  maxPayloadBytes: number;
  queryText: string;
  broadEnglishQuery: boolean;
  activationMode: string;
}

export interface SelectionState {
  selected: RankedMemory[];
  selectedIds: Set<string>;
  usedPayloadBytes: number;
}

export type SelectionOutcome = "ok" | "duplicate" | "memory_budget" | "payload_budget";

export interface QueryEmbeddingCache {
  raw: Float32Array | null | undefined;
}

export interface SummaryWindow {
  summary: SessionSummaryRecord;
  startAtMs: number;
  endAtMs: number;
}

export interface ScoredMemoryCandidate {
  memory: MemoryRecord;
  score: number;
  sessionKey: string | null;
}

export interface ActivationModeHelpers {
  calculateMemoryScore(memory: MemoryRecord): number;
  getPayloadBytes(memory: MemoryRecord): number;
  tryAddSelection(
    selection: SelectionState,
    memory: MemoryRecord,
    maxMemories: number,
    maxPayloadBytes: number,
    scoreOverride?: number,
  ): SelectionOutcome;
  pushBudgetSuppression(
    suppressed: SuppressedMemory[],
    memory: MemoryRecord,
    outcome: SelectionOutcome,
    maxMemories: number,
    maxPayloadBytes: number,
  ): void;
  finalizeActivationResult(
    request: ActivationRequest,
    prepared: PreparedActivation,
    activated: RankedMemory[],
    suppressed: SuppressedMemory[],
    usedPayloadBytes: number,
    audit?: boolean,
  ): ActivationResult;
}

function containsHangul(text: string): boolean {
  return /[\u3131-\u318e\uac00-\ud7a3]/i.test(text);
}

export function isBroadScopeRef(scopeRef: string): boolean {
  return scopeRef === ".";
}

export function containsHangulMemory(memory: MemoryRecord): boolean {
  return containsHangul(`${memory.summary} ${memory.details}`);
}

export function isEnglishLikeQuery(text: string): boolean {
  return /[A-Za-z]/.test(text) && !containsHangul(text);
}

export function getScopePrefix(scopeGlob: string): string {
  const normalized = scopeGlob.replace(/\\/g, "/").replace(/^\.?\//, "");
  const [prefix] = normalized.split("/");
  return prefix ?? "";
}

export function compareMemories(
  left: MemoryRecord,
  right: MemoryRecord,
  calculateMemoryScore: (memory: MemoryRecord) => number,
): number {
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

export function compareRankedMemories(
  left: RankedMemory,
  right: RankedMemory,
  calculateMemoryScore: (memory: MemoryRecord) => number,
): number {
  const scoreDelta = right.score - left.score;
  if (scoreDelta !== 0) {
    return scoreDelta;
  }

  return compareMemories(left, right, calculateMemoryScore);
}

export function compareMemoriesByCreatedAt(left: MemoryRecord, right: MemoryRecord): number {
  const createdAtDelta = Date.parse(left.createdAt) - Date.parse(right.createdAt);
  if (createdAtDelta !== 0) {
    return createdAtDelta;
  }

  return left.id.localeCompare(right.id);
}

export function compareMemoriesByUpdatedAtDesc(left: MemoryRecord, right: MemoryRecord): number {
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

export function compareSessionSummariesByCreatedAt(
  left: SessionSummaryRecord,
  right: SessionSummaryRecord,
): number {
  const createdAtDelta = Date.parse(left.createdAt) - Date.parse(right.createdAt);
  if (createdAtDelta !== 0) {
    return createdAtDelta;
  }

  return left.id.localeCompare(right.id);
}

export function normalizeStartupRetrievalScore(
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

export function calculateStartupActivationScore(
  memory: MemoryRecord,
  retrievalScore: number,
  source: StartupScoreSource,
  calculateMemoryScore: (memory: MemoryRecord) => number,
): number {
  const memoryBase = calculateMemoryScore(memory);
  const retrieval = normalizeStartupRetrievalScore(retrievalScore, source);

  return memoryBase * 0.4 + retrieval * 0.6;
}

export function getRetrievedMemoryScore(
  memory: MemoryRecord,
  match: RetrievalMatch,
  calculateMemoryScore: (memory: MemoryRecord) => number,
): number {
  return calculateStartupActivationScore(memory, match.score, match.source, calculateMemoryScore);
}

export async function getQueryEmbedding(
  context: ActivationContext,
  queryText: string,
  cache: QueryEmbeddingCache,
): Promise<Float32Array | null> {
  if (cache.raw !== undefined) {
    return cache.raw;
  }

  if (!context.embeddingService?.isReady || queryText.length === 0) {
    cache.raw = null;
    return cache.raw;
  }

  try {
    cache.raw = await context.embeddingService.embedQuery(queryText);
  } catch {
    cache.raw = null;
  }

  return cache.raw;
}

export async function retrieveMatches(
  context: ActivationContext,
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
    ? await getQueryEmbedding(context, prepared.queryText, queryEmbeddingCache)
    : (context.embeddingService?.isReady && expandedQueryText.length > 0
      ? await context.embeddingService.embedQuery(expandedQueryText).catch(() => null)
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

export function listSessionSummaryWindows(context: ActivationContext): SummaryWindow[] {
  if (context.summaryRepository === null) {
    return [];
  }

  const summaries = context.summaryRepository
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

export function getMemoriesForSummaryWindow(
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

export async function searchSessionSummaries(
  context: ActivationContext,
  queryText: string,
  limit: number,
): Promise<SessionSummaryRecord[]> {
  if (context.summaryRepository === null || limit <= 0 || queryText.length === 0) {
    return [];
  }

  if (!context.embeddingService?.isReady) {
    return [];
  }

  const summaries = context.summaryRepository.listSessionSummaries({ orderBy: "created_at" });
  if (summaries.length === 0) {
    return [];
  }

  const queryEmbedding = await context.embeddingService.embedQuery(queryText).catch(() => null);
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

export function ensureMinimumSessionSummaries(
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

export function buildHeuristicSessionKeys(
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

export function interleaveCandidateGroups(
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

export function diversifyBySession<T extends { id: string }>(
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
