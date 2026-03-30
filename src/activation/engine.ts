import type { MemoryType } from "../db/schema/types";
import {
  MemoryRepository,
  type ListMemoriesInput,
  type MemoryRecord,
} from "../memory";

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

export class ActivationEngine {
  readonly repository: MemoryRepository;

  constructor(repository: MemoryRepository) {
    this.repository = repository;
  }

  activate(request: ActivationRequest): ActivationResult {
    const scopeRef = normalizeScopeRef(request.scopeRef);
    const memories = this.repository.list(buildTypeFilter(request.types));
    const eligible: MemoryRecord[] = [];
    const suppressed: SuppressedMemory[] = [];

    for (const memory of memories) {
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

      if (!DEFAULT_ACTIVE_STATUSES.includes(memory.status)) {
        suppressed.push({
          memory,
          kind: "status_inactive",
          reason: `Memory status ${memory.status} is not eligible for activation`,
        });
        continue;
      }

      eligible.push(memory);
    }

    eligible.sort(compareMemories);
    const conflicts: ActivationConflict[] = this.repository
      .listLineageConflicts(eligible.map((memory) => memory.id))
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

    const maxMemories = request.maxMemories ?? DEFAULT_ACTIVATION_LIMITS.maxMemories;
    const maxPayloadBytes =
      request.maxPayloadBytes ?? DEFAULT_ACTIVATION_LIMITS.maxPayloadBytes;
    const activated: RankedMemory[] = [];
    const perTypeCounts = new Map<string, number>();
    const maxPerType = Math.max(1, Math.ceil(maxMemories * 0.6));
    let usedPayloadBytes = 0;

    for (const memory of eligible) {
      const payloadBytes = getPayloadBytes(memory);
      const typeCount = perTypeCounts.get(memory.type) ?? 0;

      if (typeCount >= maxPerType && eligible.some((item) => item.type !== memory.type)) {
        suppressed.push({
          memory,
          kind: "type_balance_limit",
          reason: `Activation type balance limit exceeded for ${memory.type}`,
        });
        continue;
      }

      if (activated.length >= maxMemories) {
        suppressed.push({
          memory,
          kind: "budget_limit",
          reason: `Activation memory budget exceeded at ${maxMemories} memories`,
        });
        continue;
      }

      if (usedPayloadBytes + payloadBytes > maxPayloadBytes) {
        suppressed.push({
          memory,
          kind: "budget_limit",
          reason: `Activation payload budget exceeded at ${maxPayloadBytes} bytes`,
        });
        continue;
      }

      usedPayloadBytes += payloadBytes;
      perTypeCounts.set(memory.type, typeCount + 1);
      activated.push({
        ...memory,
        score: calculateMemoryScore(memory),
        payloadBytes,
        rank: activated.length + 1,
      });
    }

    return {
      activated,
      suppressed,
      conflicts,
      budget: {
        maxMemories,
        maxPayloadBytes,
        usedMemories: activated.length,
        usedPayloadBytes,
      },
    };
  }
}
