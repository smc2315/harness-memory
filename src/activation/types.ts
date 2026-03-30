import {
  ACTIVATION_BUDGET,
  type LifecycleTrigger,
  type MemoryStatus,
  type MemoryType,
} from "../db/schema/types";
import type { MemoryRecord } from "../memory";

export type ActivationSuppressionKind =
  | "trigger_mismatch"
  | "scope_mismatch"
  | "status_inactive"
  | "budget_limit";

export type ActivationConflictKind = "lineage_conflict";

export interface ActivationRequest {
  lifecycleTrigger: LifecycleTrigger;
  scopeRef: string;
  types?: readonly MemoryType[];
  maxMemories?: number;
  maxPayloadBytes?: number;
}

export interface RankedMemory extends MemoryRecord {
  score: number;
  payloadBytes: number;
  rank: number;
}

export interface SuppressedMemory {
  memory: MemoryRecord;
  kind: ActivationSuppressionKind;
  reason: string;
}

export interface ActivationConflict {
  kind: ActivationConflictKind;
  root: MemoryRecord;
  memories: MemoryRecord[];
  reason: string;
}

export interface ActivationBudgetSummary {
  maxMemories: number;
  maxPayloadBytes: number;
  usedMemories: number;
  usedPayloadBytes: number;
}

export interface ActivationResult {
  activated: RankedMemory[];
  suppressed: SuppressedMemory[];
  conflicts: ActivationConflict[];
  budget: ActivationBudgetSummary;
}

export const DEFAULT_ACTIVE_STATUSES: readonly MemoryStatus[] = ["active"];

export const DEFAULT_ACTIVATION_LIMITS = {
  maxMemories: ACTIVATION_BUDGET.MAX_MEMORIES,
  maxPayloadBytes: ACTIVATION_BUDGET.MAX_PAYLOAD_BYTES,
} as const;
