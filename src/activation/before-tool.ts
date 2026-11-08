/**
 * `before_tool` decision (spec §6.2 steps 5–9, §7.2 ladder) as a pure function over the loaded
 * snapshot, the ledger tail state and the normalized tool call. `memory:why` prints the same result.
 *
 * Steps 5–6 filter candidates (status/TTL → trigger → relevant_tools → signature or scope), step 7
 * adds policy rules and drops `(memory|tool)` pairs already fired in this turn (deny stays), step 8
 * ranks (enforcement → signature match → human → score) under the type quotas and the budget, step 9
 * maps the top enforcement onto the host decision and downgrades `confirm` in non-interactive modes.
 */

import { HOOK_IO_LIMITS } from "../core/hook-types";
import { digestText } from "../core/ids";
import type { FiredLine } from "../core/ledger-types";
import type { SnapshotMemory } from "../core/snapshot-types";
import {
  ENFORCEMENT_RANK,
  type CanonicalTool,
  type Delivery,
  type Enforcement,
  type HookDecision,
  type MemoryType,
  type ShellDialect,
  type SignatureTarget,
} from "../core/vocabulary";
import type { HarnessConfig } from "../core/config";
import type { TailState } from "../dream/ledger";
import { firedKey } from "../dream/ledger";
import { PolicyEngine } from "../policy/engine";
import type { PolicyWarning } from "../policy/types";
import {
  applyBudget,
  isTtlExpired,
  itemFromSnapshotMemory,
  renderItemText,
  renderReason,
  renderSystemMessage,
  type InjectedItem,
} from "./injection";
import { snapshotMemoryScore } from "./scoring";
import { matchSignature } from "./signature";
import { scopeMatches, type LoadedSnapshot } from "./snapshot-reader";
import { toolGlobMatches } from "./tool-vocabulary";
import type { ActivationSuppressionKind } from "./types";

export type BeforeToolSuppressionKind =
  | ActivationSuppressionKind
  | "signature_required"
  | "already_fired";

export interface BeforeToolSuppression {
  id: string;
  kind: BeforeToolSuppressionKind;
  reason: string;
}

export interface BeforeToolInput {
  canonical: CanonicalTool;
  dialect: ShellDialect | null;
  /** Kind of `target` as picked by `pickTarget` (command / path / url / any). */
  targetKind: SignatureTarget;
  target: string | null;
  scopeRefs: readonly string[];
  /** Claude Code `permission_mode`; null when absent (treated as `default`). */
  permissionMode: string | null;
}

export type FiredPayload = Omit<FiredLine, "ts" | "seq" | "turn_key">;

export interface BeforeToolDecision {
  activated: InjectedItem[];
  suppressed: BeforeToolSuppression[];
  rules: PolicyWarning[];
  /** ask | deny | none — never `allow` (the hook must not auto-approve anything). */
  decision: HookDecision;
  /** Effective top enforcement after the non-interactive downgrade; null when nothing fired. */
  enforcement: Enforcement | null;
  delivery: Delivery;
  downgraded: boolean;
  reason: string | null;
  additionalContext: string | null;
  systemMessage: string | null;
  fired: FiredPayload | null;
}

/** Permission modes where `ask` has no human to answer: confirm → soft_deny (§7.2 `before_downgraded`). */
export const NON_INTERACTIVE_PERMISSION_MODES: ReadonlySet<string> = new Set(["bypassPermissions", "dontAsk"]);

export const BEFORE_TOOL_TYPE_QUOTAS: Readonly<Record<MemoryType, number>> = {
  policy: 2,
  pitfall: 2,
  workflow: 1,
  architecture_constraint: 1,
  decision: 1,
};

/** Signature-less memories fire on `before_tool` only when they are policies or pitfalls (§6.2 step 6). */
export const SIGNATURELESS_BEFORE_TOOL_TYPES: ReadonlySet<MemoryType> = new Set(["policy", "pitfall"]);

const LAST_SCOPE_REF_BONUS = 0.25;

export interface DecideBeforeToolParams {
  loaded: LoadedSnapshot;
  tailState: Pick<TailState, "firedKeys" | "lastScopeRef">;
  input: BeforeToolInput;
  config: Pick<HarnessConfig, "before_tool">;
  now: string;
}

type CandidateOutcome = { item: InjectedItem } | { suppression: BeforeToolSuppression };

function relevantToolMatches(relevantTools: readonly string[] | null, canonical: string): boolean {
  if (relevantTools === null || relevantTools.length === 0) return true;
  return relevantTools.some((pattern) => toolGlobMatches(pattern, canonical));
}

function evaluateCandidate(params: DecideBeforeToolParams, memory: SnapshotMemory, nowMs: number): CandidateOutcome {
  const { loaded, input, tailState } = params;
  const suppress = (kind: BeforeToolSuppressionKind, reason: string): CandidateOutcome => ({
    suppression: { id: memory.id, kind, reason },
  });

  if (memory.status !== "active") return suppress("status_inactive", `status ${memory.status}`);
  if (isTtlExpired(memory.ttl_expires_at, nowMs)) return suppress("ttl_expired", `ttl expired at ${memory.ttl_expires_at ?? ""}`);
  if (!memory.lifecycle_triggers.includes("before_tool")) return suppress("trigger_mismatch", "not a before_tool memory");
  if (!relevantToolMatches(memory.relevant_tools, input.canonical)) {
    return suppress("tool_mismatch", `relevant_tools [${(memory.relevant_tools ?? []).join(",")}] exclude ${input.canonical}`);
  }

  const signature = memory.signature;
  let signatureMatched = false;
  let bonus = 0;
  const scopeRefs = input.scopeRefs;
  const hasScopeRefs = scopeRefs.length > 0;
  const scopeIntersects = (): boolean => memory.scope_regex === null || scopeRefs.some((ref) => scopeMatches(loaded, memory, ref));

  if (signature !== null) {
    if (!toolGlobMatches(signature.tool, input.canonical)) {
      return suppress("signature_mismatch", `signature tool ${signature.tool} does not cover ${input.canonical}`);
    }
    if (signature.target !== "any" && signature.target !== input.targetKind) {
      return suppress("signature_mismatch", `signature targets ${signature.target}, call provides ${input.targetKind}`);
    }
    if (input.target === null) return suppress("signature_mismatch", "tool call has no target to match");
    if (!matchSignature(signature, input.target, input.dialect)) {
      return suppress("signature_mismatch", `${signature.pattern_kind} pattern ${signature.pattern} did not match`);
    }
    signatureMatched = true;
    if (hasScopeRefs) {
      if (!scopeIntersects()) return suppress("scope_mismatch", `scope ${memory.scope_glob} does not intersect [${scopeRefs.join(",")}]`);
    } else if (tailState.lastScopeRef !== null && memory.scope_regex !== null && scopeMatches(loaded, memory, tailState.lastScopeRef)) {
      bonus = LAST_SCOPE_REF_BONUS;
    }
  } else {
    if (!SIGNATURELESS_BEFORE_TOOL_TYPES.has(memory.type)) {
      return suppress("signature_required", `${memory.type} without a trigger signature does not fire on before_tool`);
    }
    if (hasScopeRefs) {
      if (!scopeIntersects()) return suppress("scope_mismatch", `scope ${memory.scope_glob} does not intersect [${scopeRefs.join(",")}]`);
    } else if (memory.scope_regex !== null) {
      return suppress("scope_mismatch", `scope ${memory.scope_glob} needs a path-like target; only global rows fire without one`);
    }
  }

  if (memory.enforcement !== "deny" && tailState.firedKeys.has(firedKey(memory.id, input.canonical))) {
    return suppress("already_fired", "already fired for this tool in the open turn");
  }

  const score = snapshotMemoryScore(memory, nowMs) + bonus;
  return { item: itemFromSnapshotMemory(memory, { score, source: signatureMatched ? "signature" : "scope", signatureMatched }) };
}

function ruleItem(warning: PolicyWarning, memory: SnapshotMemory | undefined, nowMs: number): InjectedItem {
  if (memory !== undefined) {
    const item = itemFromSnapshotMemory(memory, { score: snapshotMemoryScore(memory, nowMs), source: "rule" });
    return { ...item, enforcement: warning.enforcement };
  }
  const partial = {
    type: "policy" as const,
    authority: "human" as const,
    unconfirmed: false,
    summary: warning.message,
    details: "",
    contested: false,
  };
  const text = renderItemText(partial);
  return {
    id: `rule:${warning.ruleCode}`,
    ...partial,
    enforcement: warning.enforcement,
    score: 1,
    source: "rule",
    signatureMatched: false,
    signatureKey: "",
    text,
    bytes: Buffer.byteLength(text, "utf8"),
  };
}

export function compareBeforeToolItems(left: InjectedItem, right: InjectedItem): number {
  const enforcementDelta = ENFORCEMENT_RANK[right.enforcement] - ENFORCEMENT_RANK[left.enforcement];
  if (enforcementDelta !== 0) return enforcementDelta;
  const signatureDelta = Number(right.signatureMatched) - Number(left.signatureMatched);
  if (signatureDelta !== 0) return signatureDelta;
  const humanDelta = Number(right.authority === "human") - Number(left.authority === "human");
  if (humanDelta !== 0) return humanDelta;
  if (right.score !== left.score) return right.score - left.score;
  return left.id.localeCompare(right.id);
}

export function decideBeforeTool(params: DecideBeforeToolParams): BeforeToolDecision {
  const { loaded, input, tailState, config } = params;
  const nowMs = Date.parse(params.now);
  const suppressed: BeforeToolSuppression[] = [];
  const candidates = new Map<string, InjectedItem>();

  for (const memory of loaded.snapshot.memories) {
    const outcome = evaluateCandidate(params, memory, nowMs);
    if ("item" in outcome) candidates.set(outcome.item.id, outcome.item);
    else suppressed.push(outcome.suppression);
  }

  // Step 7: derived / manual policy rules through the shared matcher (derived rules reuse their memory's precompiled signature).
  const engine = PolicyEngine.fromSnapshotRules(loaded.snapshot.rules, loaded.byId);
  const evaluation = engine.evaluate({
    lifecycleTrigger: "before_tool",
    scopeRef: input.scopeRefs[0] ?? "",
    scopeRefs: input.scopeRefs,
    toolName: input.canonical,
    toolTarget: input.target,
    shellDialect: input.dialect,
  });
  const rules: PolicyWarning[] = [];
  for (const warning of evaluation.warnings) {
    const key = firedKey(warning.memoryId ?? `rule:${warning.ruleCode}`, input.canonical);
    if (warning.enforcement !== "deny" && tailState.firedKeys.has(key)) {
      suppressed.push({ id: warning.memoryId ?? `rule:${warning.ruleCode}`, kind: "already_fired", reason: `rule ${warning.ruleCode} already fired in the open turn` });
      continue;
    }
    rules.push(warning);
    if (warning.memoryId !== null && candidates.has(warning.memoryId)) continue;
    const memory = warning.memoryId === null ? undefined : loaded.byId.get(warning.memoryId);
    if (memory !== undefined && memory.status !== "active") continue;
    const item = ruleItem(warning, memory, nowMs);
    if (!candidates.has(item.id)) candidates.set(item.id, item);
  }

  // Step 8: ranking, quotas, budget.
  const ranked = [...candidates.values()].sort(compareBeforeToolItems);
  const typeCounts = new Map<MemoryType, number>();
  const withinQuota: InjectedItem[] = [];
  for (const item of ranked) {
    const used = typeCounts.get(item.type) ?? 0;
    if (used >= BEFORE_TOOL_TYPE_QUOTAS[item.type]) {
      suppressed.push({ id: item.id, kind: "type_balance_limit", reason: `quota ${BEFORE_TOOL_TYPE_QUOTAS[item.type]} for ${item.type} reached` });
      continue;
    }
    typeCounts.set(item.type, used + 1);
    withinQuota.push(item);
  }
  const budget = applyBudget(withinQuota, config.before_tool.max_items, config.before_tool.max_bytes);
  for (const item of budget.dropped) {
    suppressed.push({ id: item.id, kind: "budget_limit", reason: `budget ${config.before_tool.max_items} items / ${config.before_tool.max_bytes} bytes` });
  }
  const activated = budget.included;

  // Step 9: decision.
  const top = activated[0];
  if (top === undefined) {
    return {
      activated,
      suppressed,
      rules,
      decision: "none",
      enforcement: null,
      delivery: "none",
      downgraded: false,
      reason: null,
      additionalContext: null,
      systemMessage: null,
      fired: null,
    };
  }

  let effective: Enforcement = top.enforcement;
  let downgraded = false;
  if (effective === "confirm" && input.permissionMode !== null && NON_INTERACTIVE_PERMISSION_MODES.has(input.permissionMode)) {
    effective = "soft_deny";
    downgraded = true;
  }

  let decision: HookDecision;
  let delivery: Delivery;
  switch (effective) {
    case "advise":
      decision = "none";
      delivery = "with_result";
      break;
    case "confirm":
      decision = "ask";
      delivery = "before";
      break;
    case "soft_deny":
    case "deny":
      decision = "deny";
      delivery = downgraded ? "before_downgraded" : "before";
      break;
  }

  const reason = decision === "none" ? null : renderReason(top, effective);
  const contextItems = decision === "none" ? activated : activated.slice(1);
  const additionalContext = contextItems.length === 0 ? null : contextItems.map((item) => item.text).join("\n");
  const systemMessage = renderSystemMessage(top, effective);

  const memoryIds = activated.filter((item) => !item.id.startsWith("rule:")).map((item) => item.id);
  const ruleCodes = rules.map((rule) => rule.ruleCode);
  const signatureKeys = activated.map((item) => item.signatureKey).filter((key) => key.length > 0);
  const fired: FiredPayload | null =
    memoryIds.length === 0 && ruleCodes.length === 0
      ? null
      : {
          kind: "fired",
          memory_ids: memoryIds,
          rule_codes: ruleCodes,
          tool: input.canonical,
          target_digest: digestText(input.target ?? "", Math.min(120, HOOK_IO_LIMITS.target_chars)),
          delivery,
          decision,
          enforcement: effective,
          ...(signatureKeys.length > 0 ? { signature_keys: signatureKeys } : {}),
        };

  return {
    activated,
    suppressed,
    rules,
    decision,
    enforcement: effective,
    delivery,
    downgraded,
    reason,
    additionalContext,
    systemMessage,
    fired,
  };
}
