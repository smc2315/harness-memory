/**
 * Pure authority rules: default enforcement per §7.3 and the automatic tier decision per §7.4, plus the
 * 0.6.0-rc.2 `full` autonomy level (docs/redesign/full-autonomy-0.6.0-rc.2.md §1, §3: everything activates on its
 * own at advise under caps and TTLs; soft_deny is born only where the mistake is exactly identifiable and succeeds
 * silently). No database; the worker's reconcile step feeds it the row it just created or reinforced. The only
 * dependency above core is the pure tool vocabulary (tool-glob resolution shared with the hooks and V11).
 */

import { toolGlobFamilies } from "../activation/tool-vocabulary";
import type { HarnessConfig } from "../core/config";
import {
  PRE_TOOL_HOOKED_FAMILIES,
  isGlobalScope,
  type Authority,
  type AutonomyLevel,
  type Enforcement,
  type Horizon,
  type KnowledgeKind,
  type LifecycleTrigger,
  type MemoryType,
  type SideEffect,
  type SignaturePrecision,
} from "../core/vocabulary";

export const ACTIVATION_MIN_CONFIDENCE = 0.7;
/** Evidence score a pitfall / workflow needs to activate under `standard` (and that a soft_deny birth needs under any level). */
export const ACTIVATION_MIN_EVIDENCE = 2;
/** 0.6.0-rc.2 (`autonomy_level` full, design §1): a pitfall / workflow / policy activates at advise from its first evidence episode. */
export const FULL_ACTIVATION_MIN_EVIDENCE = 1;
/** 0.6.0-rc.2 (design §3 rule 1): evidence score a silent-write row needs to be born at `before_tool.auto_enforcement_silent_write`. */
export const SILENT_WRITE_MIN_EVIDENCE = 2;
/** TTL of an auto-activated decision / architecture_constraint row (0.6.0-rc.2 `full`): reviewed by expiry, not by a human. */
export const KNOWLEDGE_TTL_DAYS = 30;
/** TTL of a `task`-horizon row (design §2): knowledge about the current task's state, whatever its type or kind. */
export const TASK_TTL_DAYS = 7;

/** Same numbers as src/promotion/revalidate.ts (kept duplicated so this module does not depend on the A2 layer). */
export function baseTtlDays(kind: KnowledgeKind | null | undefined): number {
  return kind === "correction" || kind === "failure_resolution" ? 30 : 7;
}

/**
 * TTL (days) decideTier gives a row it activates: horizon `task` → TASK_TTL_DAYS whatever the type; decision /
 * architecture_constraint → KNOWLEDGE_TTL_DAYS; everything else → baseTtlDays(kind). `revalidate_after` is half of
 * it. A null / undefined horizon is unknown and read as durable (rows from before migration 023).
 */
export function tierTtlDays(kind: KnowledgeKind | null | undefined, horizon: Horizon | null | undefined, type: MemoryType): number {
  if (horizon === "task") return TASK_TTL_DAYS;
  if (type === "decision" || type === "architecture_constraint") return KNOWLEDGE_TTL_DAYS;
  return baseTtlDays(kind);
}

export function addDays(iso: string, days: number): string {
  const time = new Date(iso).getTime();
  return new Date(time + days * 24 * 60 * 60 * 1000).toISOString();
}

// ---------------------------------------------------------------------------------------------
// §7.3 enforcementDefault
// ---------------------------------------------------------------------------------------------

export interface EnforcementDefaultInput {
  type: MemoryType;
  authority: Authority;
  policySubtype: "hard" | "soft" | null;
  hasSignature: boolean;
  /** V10 passed for the signature (always false without one). */
  specificityOk: boolean;
  knowledgeKind: KnowledgeKind | null;
  importUnconfirmed: boolean | 0 | 1;
  config: Pick<HarnessConfig, "before_tool">;
  /** Used for the confirmed-import strong-wording row (`never|must not|always|do not|절대|반드시|항상`). */
  summary?: string;
  /**
   * 0.6.0-rc.2 (migration 023, design §2–§3). Omitted / null = unknown, read as `noun`, `read`, `durable`: a row from
   * before 023, or one whose caller does not know these, can therefore never be born at soft_deny by the silent-write
   * rule. Only the auto rules read them; the human defaults are unchanged.
   */
  signaturePrecision?: SignaturePrecision | null;
  sideEffect?: SideEffect | null;
  horizon?: Horizon | null;
  /** Evidence score the row has at birth (sum of evidence_weight over its evidence episodes); default 0. */
  evidenceScore?: number;
}

const STRONG_IMPORT_WORDING = /\b(?:never|must not|always|do not)\b|절대|반드시|항상/i;

/**
 * | memory | authority | default |
 * | policy hard + signature; confirmed import rule with strong wording + signature | human | `before_tool.hard_policy` (confirm) |
 * | policy soft or no signature; import `--yes` and other imports | human | advise |
 * | horizon `task`, whatever else holds | auto | advise (design §2: the current task's state never exceeds advise through the auto rules) |
 * | pitfall / policy + signature + V10 ok + signature_precision `mistake_exact` + side_effect `write` + knowledge_kind ∈ {correction, failure_resolution} + evidence_score ≥ 2 | auto | `before_tool.auto_enforcement_silent_write` (soft_deny by default: a mistake that succeeds silently, design §3 rule 1; `advise` turns the rule off and the row takes the next line) |
 * | pitfall + signature + knowledge_kind ∈ {correction, failure_resolution} + V10 ok | auto | `before_tool.auto_enforcement` (advise by default since A′; `soft_deny` stays selectable) |
 * | everything else (other auto pitfalls, auto workflow, auto policy, decision, architecture_constraint) | — | advise |
 *
 * A′ ladder: the auto row of the pitfall line is born at `before_tool.auto_enforcement` and climbs to `soft_deny`
 * only when another session reinforces it and its signature is `mistake_exact` (src/promotion/escalation.ts); a row
 * the user asked to remember takes the human defaults instead (src/promotion/remember.ts). The silent-write line is
 * the only automatic soft_deny birth; the inputs it reads (precision, side effect, horizon, evidence) are optional and
 * unknown by default, so a caller that does not pass them gets exactly the pre-rc.2 answers.
 */
export function enforcementDefault(input: EnforcementDefaultInput): Enforcement {
  const unconfirmed = input.importUnconfirmed === true || input.importUnconfirmed === 1;
  if (input.authority === "human") {
    if (!input.hasSignature) return "advise";
    if (input.type === "policy" && input.policySubtype === "hard") return input.config.before_tool.hard_policy;
    if (
      input.knowledgeKind === "import" &&
      !unconfirmed &&
      typeof input.summary === "string" &&
      STRONG_IMPORT_WORDING.test(input.summary)
    ) {
      return input.config.before_tool.hard_policy;
    }
    return "advise";
  }
  // Auto rules. Knowledge about the current task's state is advisory however it was learned (design §2).
  if (input.horizon === "task") return "advise";
  const correctionDerived = input.knowledgeKind === "correction" || input.knowledgeKind === "failure_resolution";
  // Rule 1 (design §3): a mistake that succeeds silently. `auto_enforcement_silent_write: "advise"` turns the rule
  // off — the row falls through to rule 2 rather than being pinned at advise by a rule that is meant to be absent.
  const silentWrite = input.config.before_tool.auto_enforcement_silent_write;
  if (
    silentWrite !== "advise" &&
    (input.type === "pitfall" || input.type === "policy") &&
    input.hasSignature &&
    input.specificityOk &&
    input.signaturePrecision === "mistake_exact" &&
    input.sideEffect === "write" &&
    correctionDerived &&
    (input.evidenceScore ?? 0) >= SILENT_WRITE_MIN_EVIDENCE
  ) {
    return silentWrite;
  }
  if (input.type === "pitfall" && input.hasSignature && input.specificityOk && correctionDerived) {
    return input.config.before_tool.auto_enforcement;
  }
  return "advise";
}

// ---------------------------------------------------------------------------------------------
// §7.4 decideTier
// ---------------------------------------------------------------------------------------------

export interface DecideTierMemory {
  type: MemoryType;
  scopeGlob: string;
  hasSignature: boolean;
  /** Signature tool glob, used to confirm the before_tool trigger reaches a hooked family. */
  signatureTool?: string | null;
  relevantTools: readonly string[] | null;
  lifecycleTriggers: readonly LifecycleTrigger[];
  confidence: number;
  authority: Authority;
}

export interface DecideTierInput {
  memory: DecideTierMemory;
  /** Sum of evidence_weight over the row's evidence episodes (recomputed in the same savepoint). */
  evidenceScore: number;
  /** Auto-activation budget left for pitfall / workflow / policy rows (extraction.max_auto_activations_per_episode / _per_day minus what this run / day activated). */
  capsRemaining: { episode: number; day: number };
  autonomyLevel: AutonomyLevel;
  knowledgeKind: KnowledgeKind | null;
  /** `supersedes_memory_id` points at a live row or the row is an open proposal's candidate (§5.7 step 7). */
  isReplacementRow: boolean;
  now: string;
  /** Scanner verdict on the stored text (defaults to true: the validator already rejected unsafe facts). */
  scanSafe?: boolean;
  /**
   * 0.6.0-rc.2 (`full` only): daily budget left for decision / architecture_constraint activations
   * (extraction.max_auto_knowledge_activations_per_day minus what today activated). Default `{ day: 0 }`: a caller
   * that does not track the knowledge cap cannot activate informational rows (they stay candidate `knowledge_cap`).
   * Ignored under `standard`, `shadow` and `off`, where those types are candidate `type`.
   */
  knowledgeCapsRemaining?: { day: number };
  /** 0.6.0-rc.2: the row's horizon; null / omitted = unknown = durable. A `task` row gets the 7-day TTL (tierTtlDays). */
  horizon?: Horizon | null;
}

/** `knowledge_cap` (0.6.0-rc.2) is returned only under `full`; `type` (informational types wait for review) only under the other levels. */
export type TierReason = "evidence" | "cap" | "type" | "replacement" | "autonomy" | "confidence" | "scope" | "trigger" | "security" | "knowledge_cap";

export interface TierDecision {
  status: "active" | "candidate";
  reason?: TierReason;
  proposal?: "activate_policy" | "activate_global";
  ttlExpiresAt?: string;
  revalidateAfter?: string;
  /** `shadow` autonomy: the status `standard` would have produced (logged, not applied). */
  shadow?: "active";
}

const HOOKED_FAMILIES: ReadonlySet<string> = new Set(PRE_TOOL_HOOKED_FAMILIES);

/**
 * V11's tool-glob test, resolved with the same `toolGlobFamilies` the extractor's validator and the
 * PreToolUse matcher use (spec §4.6 / §10: one glob semantics on the write and read side). A glob such
 * as `wr*` or `*sh` reaches the hook because it matches `write` / `bash`, exactly as it would at match time.
 */
function toolGlobReachesHook(toolGlob: string): boolean {
  return toolGlobFamilies(toolGlob).some((family) => HOOKED_FAMILIES.has(family));
}

/** V11 as a predicate on the stored row: at least one trigger that the hooks can actually deliver. */
export function isReachableTrigger(memory: Pick<DecideTierMemory, "type" | "hasSignature" | "signatureTool" | "lifecycleTriggers">): boolean {
  if (memory.lifecycleTriggers.length === 0) return false;
  const others = memory.lifecycleTriggers.filter((trigger) => trigger !== "before_tool");
  if (others.length > 0) return true;
  if (memory.hasSignature) {
    return memory.signatureTool === undefined || memory.signatureTool === null ? true : toolGlobReachesHook(memory.signatureTool);
  }
  return memory.type === "policy" || memory.type === "pitfall";
}

function isValidScope(scopeGlob: string): boolean {
  const scope = scopeGlob.trim().replace(/\\/g, "/");
  if (scope.length === 0) return false;
  if (scope.startsWith("/") || scope.startsWith("~") || /^[A-Za-z]:/.test(scope)) return false;
  return !scope.split("/").includes("..");
}

function activeDecision(now: string, ttlDays: number): TierDecision {
  return {
    status: "active",
    ttlExpiresAt: addDays(now, ttlDays),
    revalidateAfter: addDays(now, ttlDays / 2),
  };
}

/**
 * `full` (0.6.0-rc.2, design §1): no proposal is ever opened and `type` / `autonomy` are never returned.
 * Order: replacement row (checked by the caller) → scope valid → scanner → confidence → then by type:
 *   - decision / architecture_constraint: knowledge cap (`knowledge_cap`) → active. No evidence or trigger
 *     requirement — the decision marker that made the episode eligible is their evidence.
 *   - pitfall / workflow / policy: trigger (signature or relevant_tools, and reachable) → evidence ≥ 1 →
 *     activation caps → active. A policy takes the same path as a pitfall, and a repo-wide (global-scope) row
 *     without a signature is not special here; soft_deny for a policy comes only from enforcementDefault's
 *     silent-write rule.
 */
function decideTierFull(input: DecideTierInput): TierDecision {
  const { memory } = input;
  if (!isValidScope(memory.scopeGlob)) return { status: "candidate", reason: "scope" };
  if (input.scanSafe === false) return { status: "candidate", reason: "security" };
  if (memory.confidence < ACTIVATION_MIN_CONFIDENCE) return { status: "candidate", reason: "confidence" };
  if (memory.type === "decision" || memory.type === "architecture_constraint") {
    // Delivered on session_start / before_model only: a row with no trigger at all could never surface.
    if (memory.lifecycleTriggers.length === 0) return { status: "candidate", reason: "trigger" };
    if ((input.knowledgeCapsRemaining?.day ?? 0) <= 0) return { status: "candidate", reason: "knowledge_cap" };
  } else {
    const hasTools = memory.relevantTools !== null && memory.relevantTools.length > 0;
    if (!memory.hasSignature && !hasTools) return { status: "candidate", reason: "trigger" };
    if (!isReachableTrigger(memory)) return { status: "candidate", reason: "trigger" };
    if (input.evidenceScore < FULL_ACTIVATION_MIN_EVIDENCE) return { status: "candidate", reason: "evidence" };
    if (input.capsRemaining.episode <= 0 || input.capsRemaining.day <= 0) return { status: "candidate", reason: "cap" };
  }
  return activeDecision(input.now, tierTtlDays(input.knowledgeKind, input.horizon, memory.type));
}

/**
 * §7.4 under `standard` (and its `shadow` dry run / `off`), evaluated in this order: replacement row → policy
 * (activate_policy proposal) → signature-less global scope (activate_global proposal) → decision /
 * architecture_constraint → autonomy off → scope, trigger, scanner, confidence, evidence ≥ 2, caps → active with
 * TTL (shadow autonomy reports `shadow`). Under `full` the replacement check is followed by decideTierFull.
 * The TTL of an active row is tierTtlDays(kind, horizon, type) under every level: with the horizon unknown that is
 * baseTtlDays(kind), exactly the pre-rc.2 number.
 */
export function decideTier(input: DecideTierInput): TierDecision {
  const { memory } = input;
  if (input.isReplacementRow) return { status: "candidate", reason: "replacement" };
  if (input.autonomyLevel === "full") return decideTierFull(input);
  if (memory.type === "policy") return { status: "candidate", reason: "type", proposal: "activate_policy" };
  if (!memory.hasSignature && isGlobalScope(memory.scopeGlob)) return { status: "candidate", reason: "scope", proposal: "activate_global" };
  if (memory.type === "decision" || memory.type === "architecture_constraint") return { status: "candidate", reason: "type" };
  if (input.autonomyLevel === "off") return { status: "candidate", reason: "autonomy" };
  if (!isValidScope(memory.scopeGlob)) return { status: "candidate", reason: "scope" };
  const hasTools = memory.relevantTools !== null && memory.relevantTools.length > 0;
  if (!memory.hasSignature && !hasTools) return { status: "candidate", reason: "trigger" };
  if (!isReachableTrigger(memory)) return { status: "candidate", reason: "trigger" };
  if (input.scanSafe === false) return { status: "candidate", reason: "security" };
  if (memory.confidence < ACTIVATION_MIN_CONFIDENCE) return { status: "candidate", reason: "confidence" };
  if (input.evidenceScore < ACTIVATION_MIN_EVIDENCE) return { status: "candidate", reason: "evidence" };
  if (input.capsRemaining.episode <= 0 || input.capsRemaining.day <= 0) return { status: "candidate", reason: "cap" };
  if (input.autonomyLevel === "shadow") return { status: "candidate", reason: "autonomy", shadow: "active" };

  return activeDecision(input.now, tierTtlDays(input.knowledgeKind, input.horizon, memory.type));
}
