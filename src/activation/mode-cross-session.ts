import { activateDefaultMode } from "./mode-default";
import {
  buildHeuristicSessionKeys,
  compareMemories,
  diversifyBySession,
  ensureMinimumSessionSummaries,
  getMemoriesForSummaryWindow,
  getRetrievedMemoryScore,
  interleaveCandidateGroups,
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

async function activateCrossSessionFallback(
  context: ActivationContext,
  request: ActivationRequest,
  prepared: PreparedActivation,
  helpers: ActivationModeHelpers,
): Promise<ActivationResult> {
  const defaultResult = await activateDefaultMode(context, request, prepared, helpers, { audit: false });
  const sessionKeyById = buildHeuristicSessionKeys(defaultResult.activated);
  const diversified = diversifyBySession(defaultResult.activated, sessionKeyById, 2)
    .map((memory) => ({ ...memory }));
  const usedPayloadBytes = diversified.reduce(
    (total, memory) => total + memory.payloadBytes,
    0,
  );

  return helpers.finalizeActivationResult(
    request,
    prepared,
    diversified,
    [...defaultResult.suppressed],
    usedPayloadBytes,
  );
}

export async function activateCrossSessionMode(
  context: ActivationContext,
  request: ActivationRequest,
  prepared: PreparedActivation,
  helpers: ActivationModeHelpers,
): Promise<ActivationResult> {
  const summaryWindows = listSessionSummaryWindows(context);
  const allSummaries = summaryWindows.map((window) => window.summary);

  if (allSummaries.length === 0) {
    return activateCrossSessionFallback(context, request, prepared, helpers);
  }

  const matchedSummaries = await searchSessionSummaries(context, prepared.queryText, 8);
  const selectedSummaries = ensureMinimumSessionSummaries(
    matchedSummaries,
    allSummaries,
    3,
  );
  if (selectedSummaries.length === 0) {
    return activateCrossSessionFallback(context, request, prepared, helpers);
  }

  const { activeMemories, suppressed, maxMemories, maxPayloadBytes } = prepared;
  const queryEmbeddingCache: QueryEmbeddingCache = { raw: undefined };
  const perSessionLimit = Math.max(1, Math.ceil(maxMemories / selectedSummaries.length));
  const candidateGroups: ScoredMemoryCandidate[][] = [];

  for (const summary of selectedSummaries) {
    const sessionMemories = getMemoriesForSummaryWindow(summary, summaryWindows, activeMemories);
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
      candidateGroups.push(
        [...sessionMemories]
          .sort((left, right) => compareMemories(left, right, helpers.calculateMemoryScore))
          .slice(0, perSessionLimit)
          .map((memory) => ({
            memory,
            score: helpers.calculateMemoryScore(memory),
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
        score: getRetrievedMemoryScore(memory, match, helpers.calculateMemoryScore),
        sessionKey: summary.sessionId,
      });
    }

    if (sessionCandidates.length > 0) {
      candidateGroups.push(sessionCandidates);
    }
  }

  if (candidateGroups.length === 0) {
    return activateCrossSessionFallback(context, request, prepared, helpers);
  }

  const selection: SelectionState = {
    selected: [],
    selectedIds: new Set<string>(),
    usedPayloadBytes: 0,
  };
  const interleaved = interleaveCandidateGroups(candidateGroups);

  for (const candidate of interleaved) {
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
