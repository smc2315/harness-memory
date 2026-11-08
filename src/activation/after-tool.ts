/**
 * `after_tool` hints (spec §6.1): on a tool failure, `snapshot.failure_index[failure_class]` names the
 * memories that addressed this failure class before; up to 2 hints / 1 KB are returned as
 * `additionalContext` alongside the tool result.
 */

import type { HarnessConfig } from "../core/config";
import type { SnapshotMemory } from "../core/snapshot-types";
import type { FailureClass } from "../core/vocabulary";
import { applyBudget, isTtlExpired, itemFromSnapshotMemory, type InjectedItem } from "./injection";
import { compareSnapshotMemories, snapshotMemoryScore } from "./scoring";
import type { LoadedSnapshot } from "./snapshot-reader";
import { toolGlobMatches } from "./tool-vocabulary";

export interface AfterToolParams {
  loaded: LoadedSnapshot;
  failureClass: FailureClass | string;
  /** Canonical tool of the failed call; rows whose `relevant_tools` exclude it are skipped. */
  canonical: string | null;
  config: Pick<HarnessConfig, "after_tool">;
  now: string;
}

export interface AfterToolResult {
  items: InjectedItem[];
  text: string | null;
  /** Ids listed in the failure index that were not injected (inactive, expired, wrong tool, budget). */
  skipped: string[];
}

function toolAllowed(memory: SnapshotMemory, canonical: string | null): boolean {
  if (canonical === null || memory.relevant_tools === null || memory.relevant_tools.length === 0) return true;
  return memory.relevant_tools.some((pattern) => toolGlobMatches(pattern, canonical));
}

export function selectAfterToolHints(params: AfterToolParams): AfterToolResult {
  const { loaded, config } = params;
  const nowMs = Date.parse(params.now);
  const ids = loaded.snapshot.failure_index[params.failureClass] ?? [];
  const skipped: string[] = [];
  const memories: SnapshotMemory[] = [];
  const seen = new Set<string>();

  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    const memory = loaded.byId.get(id);
    if (memory === undefined || memory.status !== "active" || isTtlExpired(memory.ttl_expires_at, nowMs) || !toolAllowed(memory, params.canonical)) {
      skipped.push(id);
      continue;
    }
    memories.push(memory);
  }

  const scoreOf = new Map(memories.map((memory) => [memory.id, snapshotMemoryScore(memory, nowMs)] as const));
  memories.sort((left, right) => compareSnapshotMemories(left, right, scoreOf.get(left.id) ?? 0, scoreOf.get(right.id) ?? 0));
  const items = memories.map((memory) => itemFromSnapshotMemory(memory, { score: scoreOf.get(memory.id) ?? 0, source: "failure_index" }));
  const budget = applyBudget(items, config.after_tool.max_items, config.after_tool.max_bytes);
  for (const item of budget.dropped) skipped.push(item.id);

  return { items: budget.included, text: budget.text, skipped };
}
