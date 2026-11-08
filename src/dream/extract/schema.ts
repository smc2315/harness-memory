/**
 * Extraction output contract (spec §5.5) and the small hand-written structural validator (V1).
 * No JSON-schema library: the provider already enforces the schema; this guards replayed and
 * hand-edited outputs and keeps per-fact ordinals so rejections can be recorded.
 */

import {
  EXTRACTION_LIMITS,
  EXTRACTION_SCHEMA,
  EXTRACTION_SCHEMA_JSON,
  FACT_ACTIONS,
  type ExtractionFact,
  type ExtractionOutput,
  type FactAction,
} from "../../core/extraction-types";
import {
  CANONICAL_TOOL_FAMILIES,
  EXTRACTED_KNOWLEDGE_KINDS,
  LIFECYCLE_TRIGGERS,
  MEMORY_TYPES,
  PATTERN_KINDS,
  SIGNATURE_TARGETS,
  toolFamily,
  type CanonicalToolFamily,
  type ExtractedKnowledgeKind,
  type LifecycleTrigger,
  type MemoryType,
  type PatternKind,
  type SignatureTarget,
  type TriggerSignature,
} from "../../core/vocabulary";

export { EXTRACTION_LIMITS, EXTRACTION_SCHEMA, EXTRACTION_SCHEMA_JSON };
export type { ExtractionFact, ExtractionOutput };

export interface InvalidFact {
  /** Index in the raw `facts` array. */
  ordinal: number;
  detail: string;
}

export interface ParsedExtractionOk {
  ok: true;
  /** Only the facts that passed V1, in original order. */
  output: ExtractionOutput;
  /** Original index of `output.facts[i]`. */
  factOrdinals: number[];
  invalidFacts: InvalidFact[];
  /** Number of facts before V1 (the `> 8` circuit breaker looks at this). */
  rawFactCount: number;
}

export interface ParsedExtractionError {
  ok: false;
  code: "not_json" | "schema";
  detail: string;
}

export type ParsedExtraction = ParsedExtractionOk | ParsedExtractionError;

const EVIDENCE_REF = /^e[0-9]{1,4}$/;
const EPISODE_SUMMARY_MAX = 400;
const SCOPE_GLOB_MAX = 200;
const ALIAS_MIN = 2;
const ALIAS_MAX = 40;
const ALIASES_MAX = 8;
const RELEVANT_TOOLS_MAX = 6;
const RATIONALE_MAX = 300;
const SIGNATURE_TOOL_MAX = 60;
const SIGNATURE_PATTERN_MAX = 200;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clipText(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

function stripFences(raw: string): string {
  let text = raw.trim();
  const fence = /^```[a-zA-Z]*\s*\n([\s\S]*?)\n```\s*$/.exec(text);
  if (fence !== null) text = fence[1]!.trim();
  return text;
}

type FactShapeResult = { ok: true; fact: ExtractionFact } | { ok: false; detail: string };

function parseSignature(value: unknown): { ok: true; signature: TriggerSignature | null } | { ok: false; detail: string } {
  if (value === null || value === undefined) return { ok: true, signature: null };
  if (!isRecord(value)) return { ok: false, detail: "trigger_signature must be an object or null" };
  const tool = value.tool;
  if (typeof tool !== "string" || tool.trim().length === 0 || tool.length > SIGNATURE_TOOL_MAX) {
    return { ok: false, detail: "trigger_signature.tool must be a non-empty string" };
  }
  const target = value.target;
  if (typeof target !== "string" || !(SIGNATURE_TARGETS as readonly string[]).includes(target)) {
    return { ok: false, detail: `trigger_signature.target must be one of ${SIGNATURE_TARGETS.join("|")}` };
  }
  const kind = value.pattern_kind;
  if (typeof kind !== "string" || !(PATTERN_KINDS as readonly string[]).includes(kind)) {
    return { ok: false, detail: `trigger_signature.pattern_kind must be one of ${PATTERN_KINDS.join("|")}` };
  }
  const pattern = value.pattern;
  if (typeof pattern !== "string" || pattern.trim().length === 0 || pattern.length > SIGNATURE_PATTERN_MAX) {
    return { ok: false, detail: "trigger_signature.pattern must be a string of 1..200 chars" };
  }
  if (value.negate !== undefined && typeof value.negate !== "boolean") {
    return { ok: false, detail: "trigger_signature.negate must be boolean" };
  }
  const signature: TriggerSignature = {
    tool: tool.trim(),
    target: target as SignatureTarget,
    pattern_kind: kind as PatternKind,
    pattern,
  };
  if (value.negate === true) signature.negate = true;
  return { ok: true, signature };
}

/** V1 for one fact: wrong types / enums / missing citations reject; over-long text is clipped, unknown list items dropped. */
export function validateFactShape(value: unknown): FactShapeResult {
  if (!isRecord(value)) return { ok: false, detail: "fact is not an object" };

  const action = value.action;
  if (typeof action !== "string" || !(FACT_ACTIONS as readonly string[]).includes(action)) {
    return { ok: false, detail: `action must be one of ${FACT_ACTIONS.join("|")}` };
  }
  const type = value.type;
  if (typeof type !== "string" || !(MEMORY_TYPES as readonly string[]).includes(type)) {
    return { ok: false, detail: `type must be one of ${MEMORY_TYPES.join("|")}` };
  }
  const summary = typeof value.summary === "string" ? value.summary.trim() : "";
  if (summary.length < EXTRACTION_LIMITS.summary_min) {
    return { ok: false, detail: `summary must have at least ${EXTRACTION_LIMITS.summary_min} chars` };
  }
  const scopeGlob = typeof value.scope_glob === "string" ? value.scope_glob.trim() : "";
  if (scopeGlob.length === 0 || scopeGlob.length > SCOPE_GLOB_MAX) {
    return { ok: false, detail: "scope_glob must be a string of 1..200 chars" };
  }
  const confidence = value.confidence;
  if (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    return { ok: false, detail: "confidence must be a number in [0, 1]" };
  }
  if (!Array.isArray(value.evidence_refs)) return { ok: false, detail: "evidence_refs must be an array" };
  const evidenceRefs = value.evidence_refs.filter((ref): ref is string => typeof ref === "string" && EVIDENCE_REF.test(ref));
  if (evidenceRefs.length === 0) return { ok: false, detail: "evidence_refs must contain at least one e<seq> reference" };
  if (evidenceRefs.length !== value.evidence_refs.length) return { ok: false, detail: "evidence_refs must all match ^e[0-9]{1,4}$" };
  const knowledgeKind = value.knowledge_kind;
  if (typeof knowledgeKind !== "string" || !(EXTRACTED_KNOWLEDGE_KINDS as readonly string[]).includes(knowledgeKind)) {
    return { ok: false, detail: `knowledge_kind must be one of ${EXTRACTED_KNOWLEDGE_KINDS.join("|")}` };
  }
  if (!Array.isArray(value.lifecycle_triggers)) return { ok: false, detail: "lifecycle_triggers must be an array" };
  const triggers = [...new Set(value.lifecycle_triggers.filter((t): t is LifecycleTrigger => typeof t === "string" && (LIFECYCLE_TRIGGERS as readonly string[]).includes(t)))];
  if (triggers.length === 0) return { ok: false, detail: "lifecycle_triggers must contain at least one known trigger" };
  const signature = parseSignature(value.trigger_signature);
  if (!signature.ok) return { ok: false, detail: signature.detail };

  const targetMemoryId =
    typeof value.target_memory_id === "string" && value.target_memory_id.trim().length > 0 ? value.target_memory_id.trim() : null;
  const relevantTools = Array.isArray(value.relevant_tools)
    ? [...new Set(
        value.relevant_tools
          .filter((tool): tool is string => typeof tool === "string")
          .map((tool) => toolFamily(tool.trim().toLowerCase()))
          .filter((family): family is CanonicalToolFamily => (CANONICAL_TOOL_FAMILIES as readonly string[]).includes(family))
      )].slice(0, RELEVANT_TOOLS_MAX)
    : [];
  const aliases = Array.isArray(value.aliases)
    ? [...new Set(
        value.aliases
          .filter((alias): alias is string => typeof alias === "string")
          .map((alias) => alias.trim())
          .filter((alias) => alias.length >= ALIAS_MIN && alias.length <= ALIAS_MAX)
      )].slice(0, ALIASES_MAX)
    : [];

  const fact: ExtractionFact = {
    action: action as FactAction,
    target_memory_id: targetMemoryId,
    type: type as MemoryType,
    summary: clipText(summary, EXTRACTION_LIMITS.summary_max),
    details: clipText(typeof value.details === "string" ? value.details.trim() : "", EXTRACTION_LIMITS.details_max),
    scope_glob: scopeGlob,
    relevant_tools: relevantTools,
    trigger_signature: signature.signature,
    lifecycle_triggers: triggers,
    confidence,
    evidence_refs: [...new Set(evidenceRefs)],
    knowledge_kind: knowledgeKind as ExtractedKnowledgeKind,
    rationale: clipText(typeof value.rationale === "string" ? value.rationale.trim() : "", RATIONALE_MAX),
    aliases,
  };
  return { ok: true, fact };
}

/**
 * Parses a provider's raw text (or an already-parsed object). Markdown fences are tolerated; the
 * top-level shape must hold (`schema`), individual facts that fail V1 are listed in `invalidFacts`.
 */
export function parseExtractionOutput(raw: string | unknown): ParsedExtraction {
  let value: unknown = raw;
  if (typeof raw === "string") {
    const text = stripFences(raw);
    if (text.length === 0) return { ok: false, code: "not_json", detail: "empty output" };
    try {
      value = JSON.parse(text);
    } catch {
      const start = text.indexOf("{");
      const end = text.lastIndexOf("}");
      if (start === -1 || end <= start) return { ok: false, code: "not_json", detail: "output is not JSON" };
      try {
        value = JSON.parse(text.slice(start, end + 1));
      } catch {
        return { ok: false, code: "not_json", detail: "output is not JSON" };
      }
    }
  }
  if (!isRecord(value)) return { ok: false, code: "schema", detail: "output is not an object" };

  const factsRaw = value.facts;
  if (!Array.isArray(factsRaw)) return { ok: false, code: "schema", detail: "facts must be an array" };
  const episodeSummary = typeof value.episode_summary === "string" ? clipText(value.episode_summary.trim(), EPISODE_SUMMARY_MAX) : null;
  if (episodeSummary === null) return { ok: false, code: "schema", detail: "episode_summary must be a string" };
  const nothingToLearn = typeof value.nothing_to_learn === "boolean" ? value.nothing_to_learn : factsRaw.length === 0;

  const facts: ExtractionFact[] = [];
  const factOrdinals: number[] = [];
  const invalidFacts: InvalidFact[] = [];
  factsRaw.forEach((entry, ordinal) => {
    const result = validateFactShape(entry);
    if (result.ok) {
      facts.push(result.fact);
      factOrdinals.push(ordinal);
    } else {
      invalidFacts.push({ ordinal, detail: result.detail });
    }
  });

  return {
    ok: true,
    output: { episode_summary: episodeSummary, nothing_to_learn: nothingToLearn, facts },
    factOrdinals,
    invalidFacts,
    rawFactCount: factsRaw.length,
  };
}
