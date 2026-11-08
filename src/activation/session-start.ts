/**
 * `session_start` injection (spec §6.1): rows whose `lifecycle_triggers` contain `session_start`
 * and whose type is a baseline row, `decision`, `architecture_constraint` or `workflow`; rows imported
 * from a host-loaded file are skipped (native de-duplication). Budget 5 items / 3 KB from config.
 * Also the once-a-day proposal digest for `systemMessage` (§8.2, throttled by `state.last_digest_date`).
 */

import type { HarnessConfig } from "../core/config";
import type { SnapshotCounts, SnapshotMemory } from "../core/snapshot-types";
import type { Host, MemoryType } from "../core/vocabulary";
import { applyBudget, isHostLoadedFile, isTtlExpired, itemFromSnapshotMemory, type InjectedItem } from "./injection";
import { compareSnapshotMemories, snapshotMemoryScore } from "./scoring";
import type { LoadedSnapshot } from "./snapshot-reader";

export const SESSION_START_TYPES: ReadonlySet<MemoryType> = new Set(["decision", "architecture_constraint", "workflow"]);

export type SessionStartSuppressionKind =
  | "status_inactive"
  | "ttl_expired"
  | "trigger_mismatch"
  | "type_excluded"
  | "host_loaded"
  | "budget_limit";

export interface SessionStartSuppression {
  id: string;
  kind: SessionStartSuppressionKind;
  reason: string;
}

export interface SessionStartParams {
  loaded: LoadedSnapshot;
  host: Host;
  config: Pick<HarnessConfig, "session_start">;
  now: string;
}

export interface SessionStartResult {
  items: InjectedItem[];
  suppressed: SessionStartSuppression[];
  text: string | null;
}

export function isSessionStartRow(memory: SnapshotMemory): boolean {
  return memory.activation_class === "baseline" || SESSION_START_TYPES.has(memory.type);
}

export function selectSessionStartItems(params: SessionStartParams): SessionStartResult {
  const { loaded, host, config } = params;
  const nowMs = Date.parse(params.now);
  const suppressed: SessionStartSuppression[] = [];
  const eligible: SnapshotMemory[] = [];

  for (const memory of loaded.snapshot.memories) {
    if (memory.status !== "active") {
      suppressed.push({ id: memory.id, kind: "status_inactive", reason: `status ${memory.status}` });
      continue;
    }
    if (isTtlExpired(memory.ttl_expires_at, nowMs)) {
      suppressed.push({ id: memory.id, kind: "ttl_expired", reason: `ttl expired at ${memory.ttl_expires_at ?? ""}` });
      continue;
    }
    if (!memory.lifecycle_triggers.includes("session_start")) {
      suppressed.push({ id: memory.id, kind: "trigger_mismatch", reason: "not a session_start memory" });
      continue;
    }
    if (!isSessionStartRow(memory)) {
      suppressed.push({ id: memory.id, kind: "type_excluded", reason: `${memory.type} rows are not injected at session start` });
      continue;
    }
    if (isHostLoadedFile(host, memory.source_file)) {
      suppressed.push({ id: memory.id, kind: "host_loaded", reason: `${memory.source_file ?? ""} is loaded by the host` });
      continue;
    }
    eligible.push(memory);
  }

  const scoreOf = new Map(eligible.map((memory) => [memory.id, snapshotMemoryScore(memory, nowMs)] as const));
  eligible.sort((left, right) => {
    const baselineDelta = Number(right.activation_class === "baseline") - Number(left.activation_class === "baseline");
    if (baselineDelta !== 0) return baselineDelta;
    return compareSnapshotMemories(left, right, scoreOf.get(left.id) ?? 0, scoreOf.get(right.id) ?? 0);
  });

  const items = eligible.map((memory) =>
    itemFromSnapshotMemory(memory, {
      score: scoreOf.get(memory.id) ?? 0,
      source: memory.activation_class === "baseline" ? "baseline" : "startup",
    })
  );
  const budget = applyBudget(items, config.session_start.max_items, config.session_start.max_bytes);
  for (const item of budget.dropped) {
    suppressed.push({ id: item.id, kind: "budget_limit", reason: `budget ${config.session_start.max_items} items / ${config.session_start.max_bytes} bytes` });
  }

  return { items: budget.included, suppressed, text: budget.text };
}

/** `harness-memory: 3 proposals open, 1 expiring within 7 days — run \`hm review\``; null when nothing to say or already sent today. */
export function buildDigestMessage(
  counts: Pick<SnapshotCounts, "open_proposals" | "expiring_7d">,
  lastDigestDate: string | undefined,
  now: string
): string | null {
  const today = now.slice(0, 10);
  if (lastDigestDate === today) return null;
  if (counts.open_proposals <= 0 && counts.expiring_7d <= 0) return null;
  const proposals = `${counts.open_proposals} proposal${counts.open_proposals === 1 ? "" : "s"} open`;
  const expiring = counts.expiring_7d > 0 ? `, ${counts.expiring_7d} expiring within 7 days` : "";
  return `harness-memory: ${proposals}${expiring} — run \`hm review\``;
}
