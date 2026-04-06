import type { ActivationClass } from "../db/schema/types";

import { matchesScope } from "./scope";
import {
  compareMemories,
  containsHangulMemory,
  getRetrievedMemoryScore,
  isBroadScopeRef,
  listSessionSummaryWindows,
  retrieveMatches,
  type ActivationContext,
  type ActivationModeHelpers,
  type PreparedActivation,
  type QueryEmbeddingCache,
  type SelectionState,
} from "./retrieval-helpers";
import type { ActivationRequest, ActivationResult } from "./types";

export async function activateStartupMode(
  context: ActivationContext,
  request: ActivationRequest,
  prepared: PreparedActivation,
  helpers: ActivationModeHelpers,
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
    .sort((left, right) => compareMemories(left, right, helpers.calculateMemoryScore));
  const baselineCap = 2;
  const baselinePayloadCap = 2_048;
  let baselineUsedBytes = 0;
  let baselineCount = 0;

  if (broadEnglishQuery) {
    const alternateScriptBaseline = await retrieveMatches(
      context,
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

      const payloadBytes = helpers.getPayloadBytes(memory);
      if (baselineUsedBytes + payloadBytes > baselinePayloadCap) {
        continue;
      }

      const added = helpers.tryAddSelection(
        selection,
        memory,
        maxMemories,
        maxPayloadBytes,
        getRetrievedMemoryScore(memory, match, helpers.calculateMemoryScore),
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

    const payloadBytes = helpers.getPayloadBytes(memory);
    if (baselineUsedBytes + payloadBytes > baselinePayloadCap) {
      continue;
    }

    const added = helpers.tryAddSelection(selection, memory, maxMemories, maxPayloadBytes);
    if (added === "ok") {
      baselineUsedBytes += payloadBytes;
      baselineCount += 1;
    }
  }

  const recentSessionMemoryIds = new Set<string>();
  if (context.summaryRepository !== null) {
    const recentSummaryIds = new Set(
      context.summaryRepository.listSessionSummaries({ limit: 3 }).map((summary) => summary.id),
    );

    if (recentSummaryIds.size > 0) {
      for (const window of listSessionSummaryWindows(context)) {
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
        (helpers.calculateMemoryScore(right) + (recentSessionMemoryIds.has(right.id) ? 0.15 : 0)) -
        (helpers.calculateMemoryScore(left) + (recentSessionMemoryIds.has(left.id) ? 0.15 : 0));
      if (scoreDelta !== 0) {
        return scoreDelta;
      }

      return compareMemories(left, right, helpers.calculateMemoryScore);
    });

  for (const memory of startupCandidates) {
    const added = helpers.tryAddSelection(
      selection,
      memory,
      maxMemories,
      maxPayloadBytes,
      helpers.calculateMemoryScore(memory) + (recentSessionMemoryIds.has(memory.id) ? 0.15 : 0),
    );
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
