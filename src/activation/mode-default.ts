import type { ActivationClass, MemoryType } from "../db/schema/types";
import type { MemoryRecord } from "../memory";

import { matchesScope } from "./scope";
import {
  compareMemories,
  compareRankedMemories,
  containsHangulMemory,
  getRetrievedMemoryScore,
  getScopePrefix,
  retrieveMatches,
  type ActivationContext,
  type ActivationModeHelpers,
  type PreparedActivation,
  type QueryEmbeddingCache,
  type SelectionOutcome,
} from "./retrieval-helpers";
import type { ActivationRequest, ActivationResult, RankedMemory } from "./types";

export async function activateDefaultMode(
  context: ActivationContext,
  request: ActivationRequest,
  prepared: PreparedActivation,
  helpers: ActivationModeHelpers,
  options: { audit?: boolean } = {},
): Promise<ActivationResult> {
  const {
    scopeRef,
    activeMemories,
    suppressed,
    maxMemories,
    maxPayloadBytes,
    queryText,
    broadEnglishQuery,
  } = prepared;
  const selected: RankedMemory[] = [];
  const selectedIds = new Set<string>();
  let usedPayloadBytes = 0;
  const queryEmbeddingCache: QueryEmbeddingCache = { raw: undefined };

  const tryAdd = (
    memory: MemoryRecord,
    scoreOverride?: number,
  ): SelectionOutcome => {
    if (selectedIds.has(memory.id)) {
      return "duplicate";
    }

    if (selected.length >= maxMemories) {
      return "memory_budget";
    }

    const payloadBytes = helpers.getPayloadBytes(memory);
    if (usedPayloadBytes + payloadBytes > maxPayloadBytes) {
      return "payload_budget";
    }

    usedPayloadBytes += payloadBytes;
    selectedIds.add(memory.id);
    selected.push({
      ...memory,
      score: scoreOverride ?? helpers.calculateMemoryScore(memory),
      payloadBytes,
      rank: selected.length + 1,
    });
    return "ok";
  };

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

      const added = tryAdd(
        memory,
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

    const added = tryAdd(memory);
    if (added === "ok") {
      baselineUsedBytes += payloadBytes;
      baselineCount += 1;
    }
  }

  if ((request.queryTokens?.length ?? 0) > 0) {
    const nonBaseline = activeMemories.filter(
      (memory) =>
        memory.activationClass !== "baseline" &&
        !selectedIds.has(memory.id) &&
        (scopeRef === "." || matchesScope(memory.scopeGlob, scopeRef)),
    );
    const alternateScriptSlot = broadEnglishQuery ? 1 : 0;
    const startupResults = await retrieveMatches(
      context,
      prepared,
      nonBaseline,
      Math.max(0, maxMemories - selected.length - alternateScriptSlot),
      queryEmbeddingCache,
    );

    if (broadEnglishQuery) {
      const alternateScriptResults = await retrieveMatches(
        context,
        prepared,
        nonBaseline.filter(
          (memory) =>
            containsHangulMemory(memory) &&
            !startupResults.some((result) => result.id === memory.id),
        ),
        1,
        queryEmbeddingCache,
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
        getRetrievedMemoryScore(memory, startupResult, helpers.calculateMemoryScore),
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

  const scopedCandidates = activeMemories
    .filter((memory) => !selectedIds.has(memory.id))
    .sort((left, right) => compareMemories(left, right, helpers.calculateMemoryScore));

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
        scoreOverride = helpers.calculateMemoryScore(memory) + 0.15;
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

  const scopeSeen = new Set<string>();
  const penalized = [...selected]
    .sort((left, right) => compareRankedMemories(left, right, helpers.calculateMemoryScore))
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
    .sort((left, right) => compareRankedMemories(left, right, helpers.calculateMemoryScore));

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
      const payloadBytes = helpers.getPayloadBytes(explorationCandidate);
      if (finalPayloadBytes + payloadBytes <= maxPayloadBytes) {
        finalPayloadBytes += payloadBytes;
        finalIds.add(explorationCandidate.id);
        finalSelected.push({
          ...explorationCandidate,
          score: helpers.calculateMemoryScore(explorationCandidate),
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

  return helpers.finalizeActivationResult(
    request,
    prepared,
    finalSelected,
    suppressed,
    finalPayloadBytes,
    options.audit ?? true,
  );
}
