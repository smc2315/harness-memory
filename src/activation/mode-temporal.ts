import {
  compareMemoriesByCreatedAt,
  compareMemoriesByUpdatedAtDesc,
  compareSessionSummariesByCreatedAt,
  getMemoriesForSummaryWindow,
  getRetrievedMemoryScore,
  listSessionSummaryWindows,
  retrieveMatches,
  searchSessionSummaries,
  type ActivationContext,
  type ActivationModeHelpers,
  type PreparedActivation,
  type QueryEmbeddingCache,
  type ScoredMemoryCandidate,
  type SelectionState,
} from "./retrieval-helpers";
import type { ActivationRequest, ActivationResult } from "./types";

function activateTemporalFallback(
  request: ActivationRequest,
  prepared: PreparedActivation,
  helpers: ActivationModeHelpers,
): ActivationResult {
  const { activeMemories, suppressed, maxMemories, maxPayloadBytes } = prepared;
  const selection: SelectionState = {
    selected: [],
    selectedIds: new Set<string>(),
    usedPayloadBytes: 0,
  };

  for (const memory of [...activeMemories].sort(compareMemoriesByUpdatedAtDesc)) {
    const added = helpers.tryAddSelection(selection, memory, maxMemories, maxPayloadBytes);
    helpers.pushBudgetSuppression(suppressed, memory, added, maxMemories, maxPayloadBytes);
  }

  return helpers.finalizeActivationResult(
    request,
    prepared,
    selection.selected,
    suppressed,
    selection.usedPayloadBytes,
  );
}

export async function activateTemporalMode(
  context: ActivationContext,
  request: ActivationRequest,
  prepared: PreparedActivation,
  helpers: ActivationModeHelpers,
): Promise<ActivationResult> {
  const { activeMemories, suppressed, maxMemories, maxPayloadBytes } = prepared;
  const queryEmbeddingCache: QueryEmbeddingCache = { raw: undefined };
  const summaryWindows = listSessionSummaryWindows(context);
  const matchedSummaries = await searchSessionSummaries(context, prepared.queryText, 5);

  if (summaryWindows.length === 0 || matchedSummaries.length === 0) {
    return activateTemporalFallback(request, prepared, helpers);
  }

  const perSessionLimit = Math.max(1, Math.ceil(maxMemories / matchedSummaries.length) + 1);
  const combined: ScoredMemoryCandidate[] = [];

  for (const summary of [...matchedSummaries].sort(compareSessionSummariesByCreatedAt)) {
    const sessionMemories = getMemoriesForSummaryWindow(summary, summaryWindows, activeMemories)
      .sort(compareMemoriesByCreatedAt);
    if (sessionMemories.length === 0) {
      continue;
    }

    const sessionMatches = await retrieveMatches(
      context,
      prepared,
      sessionMemories,
      perSessionLimit,
      queryEmbeddingCache,
    );
    if (sessionMatches.length === 0) {
      combined.push(
        ...sessionMemories.slice(0, perSessionLimit).map((memory) => ({
          memory,
          score: helpers.calculateMemoryScore(memory),
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
        score: getRetrievedMemoryScore(memory, match, helpers.calculateMemoryScore),
        sessionKey: summary.sessionId,
      });
    }
  }

  if (combined.length === 0) {
    return activateTemporalFallback(request, prepared, helpers);
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
    const added = helpers.tryAddSelection(
      selection,
      candidate.memory,
      maxMemories,
      maxPayloadBytes,
      candidate.score,
    );
    helpers.pushBudgetSuppression(suppressed, candidate.memory, added, maxMemories, maxPayloadBytes);
  }

  return helpers.finalizeActivationResult(
    request,
    prepared,
    selection.selected,
    suppressed,
    selection.usedPayloadBytes,
  );
}
