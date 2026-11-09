/**
 * Pure authority rules: default enforcement per §7.3 and the automatic tier decision per §7.4.
 * No database; the worker's reconcile step feeds it the row it just created or reinforced. The only
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
  type KnowledgeKind,
  type LifecycleTrigger,
  type MemoryType,
} from "../core/vocabulary";

export const ACTIVATION_MIN_CONFIDENCE = 0.7;
export const ACTIVATION_MIN_EVIDENCE = 2;

/** Same numbers as src/promotion/revalidate.ts (kept duplicated so this module does not depend on the A2 layer). */
export function baseTtlDays(kind: KnowledgeKind | null | undefined): number {
  return kind === "correction" || kind === "failure_resolution" ? 30 : 7;
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
}

const STRONG_IMPORT_WORDING = /\b(?:never|must not|always|do not)\b|절대|반드시|항상/i;

/**
 * | memory | authority | default |
 * | policy hard + signature; confirmed import rule with strong wording + signature | human | `before_tool.hard_policy` (confirm) |
 * | policy soft or no signature; import `--yes` and other imports | human | advise |
 * | auto pitfall + signature + knowledge_kind ∈ {correction, failure_resolution} + V10 ok | auto | `before_tool.auto_enforcement` (advise by default since A′; `soft_deny` stays selectable) |
 * | everything else (other auto pitfalls, auto workflow, decision, architecture_constraint) | — | advise |
 *
 * A′ ladder: the auto row of the third line is born at `before_tool.auto_enforcement` and climbs to `soft_deny`
 * only when another session reinforces it (src/promotion/escalation.ts); a row the user asked to remember takes
 * the human defaults instead (src/promotion/remember.ts).
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
  if (
    input.type === "pitfall" &&
    input.hasSignature &&
    input.specificityOk &&
    (input.knowledgeKind === "correction" || input.knowledgeKind === "failure_resolution")
  ) {
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
  capsRemaining: { episode: number; day: number };
  autonomyLevel: AutonomyLevel;
  knowledgeKind: KnowledgeKind | null;
  /** `supersedes_memory_id` points at a live row or the row is an open proposal's candidate (§5.7 step 7). */
  isReplacementRow: boolean;
  now: string;
  /** Scanner verdict on the stored text (defaults to true: the validator already rejected unsafe facts). */
  scanSafe?: boolean;
}

export type TierReason = "evidence" | "cap" | "type" | "replacement" | "autonomy" | "confidence" | "scope" | "trigger" | "security";

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

/**
 * §7.4, evaluated in this order: replacement row → policy (activate_policy proposal) → signature-less
 * global scope (activate_global proposal) → decision / architecture_constraint → autonomy off → scope,
 * trigger, scanner, confidence, evidence, caps → active with TTL (shadow autonomy reports `shadow`).
 */
export function decideTier(input: DecideTierInput): TierDecision {
  const { memory } = input;
  if (input.isReplacementRow) return { status: "candidate", reason: "replacement" };
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

  const ttlDays = baseTtlDays(input.knowledgeKind);
  return {
    status: "active",
    ttlExpiresAt: addDays(input.now, ttlDays),
    revalidateAfter: addDays(input.now, ttlDays / 2),
  };
}
