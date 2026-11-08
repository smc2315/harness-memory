/**
 * Extraction contract between the worker and the LLM provider (spec §5.5) plus validation codes (§5.6).
 * The JSON schema is passed verbatim to `claude -p --json-schema` / `codex exec --output-schema`.
 */

import type { LifecycleTrigger, MemoryType } from "../db/schema/types";
import type { CanonicalToolFamily, ExtractedKnowledgeKind, TriggerSignature } from "./vocabulary";

/** Bump when the prompt or schema changes in a way that should re-run old episodes. */
export const EXTRACTOR_VERSION = "2026.11.v1";

export const EXTRACTION_LIMITS = {
  max_facts: 8,
  prompt_chars: 24_000,
  existing_memories: 40,
  summary_min: 12,
  summary_max: 160,
  details_max: 1_200,
  min_confidence: 0.6,
} as const;

export const FACT_ACTIONS = ["create", "reinforce", "propose_supersede", "propose_stale"] as const;
export type FactAction = (typeof FACT_ACTIONS)[number];

export interface ExtractionFact {
  action: FactAction;
  target_memory_id: string | null;
  type: MemoryType;
  summary: string;
  details: string;
  scope_glob: string;
  relevant_tools: CanonicalToolFamily[];
  trigger_signature: TriggerSignature | null;
  lifecycle_triggers: LifecycleTrigger[];
  confidence: number;
  /** `e<seq>` references into the rendered episode; context_ref lines are not citable. */
  evidence_refs: string[];
  knowledge_kind: ExtractedKnowledgeKind;
  rationale: string;
  /** Short synonyms / other-language keywords (e.g. Korean) indexed for lexical recall. */
  aliases: string[];
}

export interface ExtractionOutput {
  episode_summary: string;
  nothing_to_learn: boolean;
  facts: ExtractionFact[];
}

export const EXTRACTION_SCHEMA: Readonly<Record<string, unknown>> = {
  type: "object",
  required: ["episode_summary", "nothing_to_learn", "facts"],
  additionalProperties: false,
  properties: {
    episode_summary: { type: "string", maxLength: 400 },
    nothing_to_learn: { type: "boolean" },
    facts: {
      type: "array",
      maxItems: EXTRACTION_LIMITS.max_facts,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "action",
          "target_memory_id",
          "type",
          "summary",
          "details",
          "scope_glob",
          "relevant_tools",
          "trigger_signature",
          "lifecycle_triggers",
          "confidence",
          "evidence_refs",
          "knowledge_kind",
          "rationale",
          "aliases",
        ],
        properties: {
          action: { enum: ["create", "reinforce", "propose_supersede", "propose_stale"] },
          target_memory_id: { type: ["string", "null"] },
          type: { enum: ["policy", "workflow", "pitfall", "architecture_constraint", "decision"] },
          summary: { type: "string", minLength: EXTRACTION_LIMITS.summary_min, maxLength: EXTRACTION_LIMITS.summary_max },
          details: { type: "string", maxLength: EXTRACTION_LIMITS.details_max },
          scope_glob: { type: "string", minLength: 1, maxLength: 200 },
          relevant_tools: {
            type: "array",
            maxItems: 6,
            items: { enum: ["bash", "edit", "write", "read", "grep", "glob", "fetch", "task", "mcp", "other"] },
          },
          trigger_signature: {
            type: ["object", "null"],
            additionalProperties: false,
            required: ["tool", "target", "pattern_kind", "pattern"],
            properties: {
              tool: { type: "string", maxLength: 60 },
              target: { enum: ["command", "path", "url", "any"] },
              pattern_kind: { enum: ["cmd", "glob", "regex", "substring"] },
              pattern: { type: "string", minLength: 1, maxLength: 200 },
              negate: { type: "boolean" },
            },
          },
          lifecycle_triggers: {
            type: "array",
            minItems: 1,
            maxItems: 4,
            items: { enum: ["session_start", "before_model", "before_tool", "after_tool"] },
          },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          evidence_refs: {
            type: "array",
            minItems: 1,
            maxItems: 8,
            items: { type: "string", pattern: "^e[0-9]{1,4}$" },
          },
          knowledge_kind: { enum: ["correction", "failure_resolution", "convention", "decision"] },
          rationale: { type: "string", maxLength: 300 },
          aliases: { type: "array", maxItems: 8, items: { type: "string", minLength: 2, maxLength: 40 } },
        },
      },
    },
  },
};

export const EXTRACTION_SCHEMA_JSON = JSON.stringify(EXTRACTION_SCHEMA);

/** Per-fact rejection codes (V1–V12 of §5.6; V12 added in the verification round). */
export const REJECTION_CODES = [
  "schema", // V1
  "evidence_ref", // V2
  "scope_mismatch", // V3
  "scope_outside_repo", // V3 / reconcile step 2
  "signature_tool", // V4
  "regex_unsafe", // V5
  "security", // V6
  "self_reference", // V6
  "rejected_no_target", // V7
  "restatement", // V8
  "duplicate_in_batch", // V9
  "trigger_unreachable", // V10 (signature dropped and nothing left for before_tool)
  "signature_matches_resolution", // V12 (the signature would fire on the command that fixed the cited failure)
  "low_confidence",
  "skipped_recent_reject",
] as const;
export type RejectionCode = (typeof REJECTION_CODES)[number];

export type FactOutcomeKind =
  | "created"
  | "reinforced"
  | "proposed"
  | "superseded_proposed"
  | "activated"
  | "candidate"
  | "rejected"
  | "skipped";

export interface FactOutcome {
  ordinal: number;
  action: FactAction | "unknown";
  outcome: FactOutcomeKind;
  memory_id?: string;
  proposal_id?: string;
  rejection?: RejectionCode;
  /** e.g. `tool_not_hooked`, `policy_to_pitfall`, `signature_dropped` */
  relabel?: string;
  detail?: string;
}

/** Run-level circuit breaker thresholds (§5.6). */
export const SUSPECT_THRESHOLDS = {
  max_facts: EXTRACTION_LIMITS.max_facts,
  hallucinated_ref_ratio: 0.5,
} as const;
