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
  | "tool_mismatch"
  | "status_inactive"
  | "ttl_expired"
  | "budget_limit"
  | "type_balance_limit";

export type ActivationConflictKind = "lineage_conflict";

export interface ActivationRequest {
  lifecycleTrigger: LifecycleTrigger;
  scopeRef: string;
  types?: readonly MemoryType[];
  queryTokens?: string[];
  repoFingerprint?: string[];
  toolName?: string;
  maxMemories?: number;
  maxPayloadBytes?: number;
  /** When true, include superseded memories for temporal context (e.g., showing what changed) */
  includeSuperseded?: boolean;
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
