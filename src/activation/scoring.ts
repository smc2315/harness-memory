/**
 * Scoring shared by the snapshot read path (hooks) and `memory:why`: the same base × freshness ×
 * trust product the activation engine uses on repository records (§6.2 step 8, §6.4), computed on
 * `SnapshotMemory` rows with an injected clock so tests never depend on wall time.
 */

import type { SnapshotMemory } from "../core/snapshot-types";
import { trustMultiplier } from "../promotion/revalidate";

export { trustMultiplier };

const DAY_MS = 24 * 60 * 60 * 1000;
export const FRESHNESS_FLOOR = 0.75;
export const FRESHNESS_DECAY_PER_DAY = 0.01;

export function freshnessMultiplier(referenceIso: string | null, nowMs: number): number {
  if (referenceIso === null) return FRESHNESS_FLOOR;
  const referenceMs = Date.parse(referenceIso);
  if (Number.isNaN(referenceMs)) return FRESHNESS_FLOOR;
  const ageDays = Math.max(0, (nowMs - referenceMs) / DAY_MS);
  return Math.max(FRESHNESS_FLOOR, 1 - ageDays * FRESHNESS_DECAY_PER_DAY);
}

export type ScorableSnapshotMemory = Pick<
  SnapshotMemory,
  "importance" | "confidence" | "last_verified_at" | "updated_at" | "created_at" | "authority" | "validation_count"
>;

/** importance × confidence × freshness(last_verified_at ?? updated_at ?? created_at) × trust(authority, validation_count). */
export function snapshotMemoryScore(memory: ScorableSnapshotMemory, nowMs: number): number {
  const base = memory.importance * memory.confidence;
  const reference = memory.last_verified_at ?? memory.updated_at ?? memory.created_at;
  return base * freshnessMultiplier(reference, nowMs) * trustMultiplier(memory.authority, memory.validation_count);
}

/** Deterministic tie-break after the score: newer first, then id. */
export function compareSnapshotMemories(
  left: Pick<SnapshotMemory, "id" | "updated_at">,
  right: Pick<SnapshotMemory, "id" | "updated_at">,
  leftScore: number,
  rightScore: number
): number {
  if (rightScore !== leftScore) return rightScore - leftScore;
  const updatedDelta = Date.parse(right.updated_at) - Date.parse(left.updated_at);
  if (updatedDelta !== 0 && !Number.isNaN(updatedDelta)) return updatedDelta;
  return left.id.localeCompare(right.id);
}
