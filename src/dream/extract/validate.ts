/**
 * Fact validation V1–V12 (spec §5.6; V12 from the verification round) with the precedence rules for the scope/tool intersection
 * sets (correction_for union → import rule → tool-less correction/remember episodes) and the
 * run-level circuit breaker (non-JSON, > 8 facts, > 50 % hallucinated refs → `suspect`).
 *
 * Pure: no database. The worker supplies the existing memory ids and, for `correction_for`
 * episodes, the corrected episode's scope_refs / tools.
 */

import {
  canonicalizeCommand,
  commandPatternHasPath,
  compileSignature,
  globMatchesPath,
  matchSignature,
  normalizeSignatureTool,
  primaryLiteralProgram,
} from "../../activation/signature";
import { toolGlobFamilies, toolGlobMatches } from "../../activation/tool-vocabulary";
import type { EpisodeDescriptor } from "../../core/episode-types";
import {
  EXTRACTION_LIMITS,
  SUSPECT_THRESHOLDS,
  type ExtractionFact,
  type ExtractionOutput,
  type FactOutcome,
  type RejectionCode,
} from "../../core/extraction-types";
import { normalizeScopeGlob, normalizeSummary, semanticKey } from "../../core/ids";
import type { LedgerLine, ToolFailLine } from "../../core/ledger-types";
import type { CompiledSignature } from "../../core/snapshot-types";
import {
  CANONICAL_TOOL_FAMILIES,
  GLOBAL_SCOPE,
  PRE_TOOL_HOOKED_FAMILIES,
  isGlobalScope,
  toolFamily,
  type CanonicalToolFamily,
  type LifecycleTrigger,
  type TriggerSignature,
} from "../../core/vocabulary";
import { citesRememberPrompt } from "../../promotion/remember";
import { scanMemoryContent } from "../../security/scanner";
import { parseExtractionOutput, type InvalidFact } from "./schema";

export type Scanner = (summary: string, details: string) => { safe: boolean };

export interface CorrectionForEpisode {
  scope_refs: readonly string[];
  tools: readonly string[];
}

export interface ValidateExtractionInput {
  output: ExtractionOutput;
  descriptor: EpisodeDescriptor;
  seqMap: ReadonlyMap<string, LedgerLine>;
  existingMemoryIds: ReadonlySet<string>;
  scanner?: Scanner;
  nowIso: string;
  /** scope_refs / tools of the corrected episode when `descriptor.correction_for` is set (§5.6 union rule). */
  correctionForEpisode?: CorrectionForEpisode | null;
  /** From parseExtractionOutput: original index of `output.facts[i]` (defaults to `i`). */
  factOrdinals?: readonly number[];
  /** Facts that failed V1 in parseExtractionOutput; recorded as `rejected(schema)`. */
  schemaRejects?: readonly InvalidFact[];
  /** Number of facts before V1 (breaker: more than EXTRACTION_LIMITS.max_facts → suspect). */
  rawFactCount?: number;
}

export interface ValidatedFact extends ExtractionFact {
  /** Index in the provider's facts array. */
  ordinal: number;
  compiledSignature: CompiledSignature | null;
  semanticKey: string;
  /** Normalized scope; `**\/*` for command signatures whose pattern names no path (reconcile step 2). */
  normalizedScope: string;
  /** e.g. `signature_dropped`, `tool_not_hooked`, `no_target_create` */
  relabels: string[];
}

export type SuspectReason = "not_json" | "schema" | "too_many_facts" | "hallucinated_refs";

export interface ValidationResult {
  accepted: ValidatedFact[];
  /** One entry per rejected or skipped fact (accepted facts carry their relabels themselves). */
  outcomes: FactOutcome[];
  suspect: boolean;
  suspectReason?: SuspectReason;
}

type ScopeMode =
  | { kind: "normal"; scopeRefs: readonly string[]; tools: readonly string[] }
  | { kind: "union"; scopeRefs: readonly string[]; tools: readonly string[] }
  | { kind: "import"; scopeRefs: readonly string[]; tools: readonly string[] }
  | { kind: "toolless"; scopeRefs: readonly string[]; tools: readonly string[] };

interface FactContext {
  descriptor: EpisodeDescriptor;
  seqMap: ReadonlyMap<string, LedgerLine>;
  existingMemoryIds: ReadonlySet<string>;
  scanner: Scanner;
  mode: ScopeMode;
}

type FactResult = { ok: true; fact: ValidatedFact } | { ok: false; outcome: FactOutcome };

const ALL_TOOLS: readonly string[] = CANONICAL_TOOL_FAMILIES.map((family) => (family === "mcp" ? "mcp:server/tool" : family));
const PACKAGE_MANAGER_WORDS = new Set(["npm", "pnpm", "yarn", "bun", "npx", "bunx"]);
const SELF_REFERENCE =
  /harness[-_ ]?memory|\.harness-memory|\bhm\s+(?:review|memory(?::[a-z-]+)?|proposals?(?::[a-z-]+)?|status|doctor|install|uninstall|import|queue|extract|dream|trace|snapshot(?::[a-z-]+)?|db:[a-z-]+)\b|\[M:[^\]]*\]|\bmemory[_ ]ids?\b/i;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;
const RESTATEMENT_OVERLAP = 0.8;
const RESTATEMENT_MIN_TOKENS = 8;
const WORD = /[\p{L}\p{N}_]+/gu;
const PATH_WORD = /[\\/]|^\.{1,2}$|^[\w@.-]+\.[A-Za-z][A-Za-z0-9]{0,7}$/;

function defaultScanner(summary: string, details: string): { safe: boolean } {
  return scanMemoryContent(summary, details);
}

function union(a: readonly string[], b: readonly string[]): string[] {
  return [...new Set([...a, ...b])];
}

function resolveMode(descriptor: EpisodeDescriptor, correctionFor: CorrectionForEpisode | null | undefined): ScopeMode {
  if (descriptor.correction_for !== null) {
    const scopeRefs = union(descriptor.scope_refs, correctionFor?.scope_refs ?? []);
    const tools = union(descriptor.tools, correctionFor?.tools ?? []);
    if (scopeRefs.length > 0 || tools.length > 0) return { kind: "union", scopeRefs, tools };
  }
  if (descriptor.host === "import") return { kind: "import", scopeRefs: descriptor.scope_refs, tools: ALL_TOOLS };
  if (descriptor.tools.length === 0 && (descriptor.flags.correction === 1 || descriptor.flags.remember === 1)) {
    return { kind: "toolless", scopeRefs: descriptor.scope_refs, tools: ALL_TOOLS };
  }
  return { kind: "normal", scopeRefs: descriptor.scope_refs, tools: descriptor.tools };
}

function tokensOf(text: string): string[] {
  return (text.match(WORD) ?? []).filter((token) => token.length >= 2);
}

/** V8: a verbatim copy of the prompt, or a long summary whose tokens are ≥ 80 % prompt tokens. */
export function isRestatement(summary: string, promptText: string | null | undefined): boolean {
  if (promptText === null || promptText === undefined || promptText.trim().length === 0) return false;
  const normalizedSummary = normalizeSummary(summary);
  const normalizedPrompt = normalizeSummary(promptText);
  if (normalizedSummary.length >= EXTRACTION_LIMITS.summary_min && normalizedPrompt.includes(normalizedSummary)) return true;
  const summaryTokens = [...new Set(tokensOf(normalizedSummary))];
  if (summaryTokens.length < RESTATEMENT_MIN_TOKENS) return false;
  const promptTokens = new Set(tokensOf(normalizedPrompt));
  const overlap = summaryTokens.filter((token) => promptTokens.has(token)).length / summaryTokens.length;
  return overlap >= RESTATEMENT_OVERLAP;
}

/** V6 self-reference: facts about harness-memory, its CLI or memory ids are never stored. */
export function isSelfReference(text: string, existingMemoryIds: ReadonlySet<string>): boolean {
  if (SELF_REFERENCE.test(text) || UUID.test(text)) return true;
  for (const id of existingMemoryIds) {
    if (id.length >= 8 && text.includes(id)) return true;
  }
  return false;
}

/** Repository-relative glob: no absolute path, drive letter, home prefix or `..` segment. */
export function isRepoRelativeGlob(glob: string): boolean {
  if (glob.length === 0) return false;
  if (glob.startsWith("/") || glob.startsWith("~") || /^[A-Za-z]:/.test(glob) || glob.includes("\u0000")) return false;
  return !glob.split("/").includes("..");
}

function scopeIntersects(glob: string, refs: readonly string[]): boolean {
  return refs.some((ref) => globMatchesPath(glob, ref) || glob.startsWith(`${ref.replace(/\/+$/, "")}/`));
}

type ScopeCheck = { ok: true; normalized: string } | { ok: false; rejection: RejectionCode; detail: string };

function checkScope(scopeGlob: string, type: ExtractionFact["type"], hasSignature: boolean, mode: ScopeMode): ScopeCheck {
  const normalized = normalizeScopeGlob(scopeGlob);
  if (!isRepoRelativeGlob(normalized)) return { ok: false, rejection: "scope_outside_repo", detail: `scope ${normalized} is outside the repository` };
  if (mode.kind === "import" || mode.kind === "toolless") return { ok: true, normalized };
  if (hasSignature) return { ok: true, normalized };
  if (isGlobalScope(normalized)) {
    if (type === "decision" || type === "architecture_constraint") return { ok: true, normalized };
    return { ok: false, rejection: "scope_mismatch", detail: "global scope without a signature is only allowed for decision / architecture_constraint" };
  }
  if (scopeIntersects(normalized, mode.scopeRefs)) return { ok: true, normalized };
  return {
    ok: false,
    rejection: "scope_mismatch",
    detail: `scope ${normalized} does not intersect episode files [${mode.scopeRefs.join(", ")}]`,
  };
}

function patternTokens(signature: TriggerSignature): string[] {
  const command = canonicalizeCommand(signature.pattern, "bash");
  return command.segments[0] ?? [];
}

/** Does free text contain the command pattern in canonical form (`pnpm test` cites `pm test`)? */
export function textCitesCommand(text: string, tokens: readonly string[]): boolean {
  if (tokens.length === 0) return false;
  const program = tokens[0]!;
  const words = text.split(/[\s,.;:!?()"'`“”‘’]+/).filter((word) => word.length > 0);
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i]!.toLowerCase();
    const candidate = word === program || ((program === "pm" || program === "bin") && PACKAGE_MANAGER_WORDS.has(word));
    if (!candidate) continue;
    const window = words.slice(i, i + tokens.length + 3).join(" ");
    const canonical = canonicalizeCommand(window, "bash");
    if (canonical.segments.some((segment) => segment[0] === program && tokens.slice(1).every((token) => segment.includes(token)))) {
      return true;
    }
  }
  return false;
}

function patternCited(signature: TriggerSignature, promptText: string): boolean {
  const text = promptText;
  if (text.trim().length === 0) return false;
  if (signature.pattern_kind === "cmd") {
    if (text.toLowerCase().includes(signature.pattern.trim().toLowerCase())) return true;
    return textCitesCommand(text, patternTokens(signature));
  }
  return text.toLowerCase().includes(signature.pattern.trim().toLowerCase());
}

function checkSignatureTool(signature: TriggerSignature, ctx: FactContext): { ok: true } | { ok: false; detail: string } {
  const toolGlob = normalizeSignatureTool(signature.tool);
  if (!ctx.mode.tools.some((tool) => toolGlobMatches(toolGlob, tool))) {
    return { ok: false, detail: `signature tool ${toolGlob} is not in the episode tool set [${ctx.mode.tools.join(", ")}]` };
  }
  if ((ctx.mode.kind === "import" || ctx.mode.kind === "toolless") && !patternCited(signature, ctx.descriptor.prompt_text ?? "")) {
    return { ok: false, detail: "signature pattern is not quoted in the prompt text" };
  }
  return { ok: true };
}

function isBeforeToolOnly(triggers: readonly LifecycleTrigger[]): boolean {
  return triggers.length > 0 && triggers.every((trigger) => trigger === "before_tool");
}

function signatureReachesHook(signature: TriggerSignature): boolean {
  return toolGlobFamilies(signature.tool).some((family) => (PRE_TOOL_HOOKED_FAMILIES as readonly string[]).includes(family));
}

function commandSignatureNamesPath(compiled: CompiledSignature): boolean {
  if (compiled.target !== "command") return true;
  if (compiled.pattern_kind === "cmd") return commandPatternHasPath(compiled.tokens ?? []);
  return compiled.pattern.split(/\s+/).some((token) => token.length > 0 && !token.startsWith("-") && PATH_WORD.test(token));
}

function normalizeRelevantTools(tools: readonly string[]): CanonicalToolFamily[] {
  return [...new Set(tools.map((tool) => toolFamily(String(tool).trim().toLowerCase())))];
}

/**
 * V12: among the cited lines, a `tool_ok` that resolved a failure of a *different program* and whose command the
 * signature also matches (`npm test` failed, `pnpm test` fixed it, pattern `pm test`). A fix that keeps the program
 * (flags, environment, a `cd`) is not a conflict, and when the failing line lies outside this episode nothing can be
 * proven. Returns the rejection detail, else null.
 */
function resolutionConflict(compiled: CompiledSignature, refs: readonly string[], seqMap: ReadonlyMap<string, LedgerLine>): string | null {
  if (compiled.target !== "command") return null;
  let failures: ToolFailLine[] | null = null;
  for (const ref of refs) {
    const line = seqMap.get(ref);
    if (line === undefined || line.kind !== "tool_ok" || line.resolution_of === null) continue;
    const resolving = line.input_digest;
    if (resolving.length === 0 || !matchSignature(compiled, resolving, line.shell_dialect)) continue;
    if (failures === null) failures = [...seqMap.values()].filter((candidate): candidate is ToolFailLine => candidate.kind === "tool_fail");
    const failing = failures.find((candidate) => candidate.failure_sig === line.resolution_of);
    if (failing === undefined) continue;
    const failedProgram = primaryLiteralProgram(failing.input_digest, failing.shell_dialect);
    const fixedProgram = primaryLiteralProgram(resolving, line.shell_dialect);
    if (failedProgram === null || fixedProgram === null || failedProgram === fixedProgram) continue;
    return `the signature also matches the command that resolved the failure (${resolving}: ${fixedProgram} instead of ${failedProgram}); name the failing program literally ("${failedProgram} …", not "pm …") or drop the signature`;
  }
  return null;
}

function validateFact(original: ExtractionFact, ordinal: number, ctx: FactContext): FactResult {
  const relabels: string[] = [];
  let fact: ExtractionFact = {
    ...original,
    relevant_tools: normalizeRelevantTools(original.relevant_tools),
    lifecycle_triggers: [...new Set(original.lifecycle_triggers)],
  };
  const reject = (rejection: RejectionCode, detail?: string): FactResult => ({
    ok: false,
    outcome: {
      ordinal,
      action: original.action,
      outcome: "rejected",
      rejection,
      ...(relabels.length > 0 ? { relabel: relabels.join(",") } : {}),
      ...(detail !== undefined ? { detail } : {}),
    },
  });

  if (fact.confidence < EXTRACTION_LIMITS.min_confidence) {
    return reject("low_confidence", `confidence ${fact.confidence} < ${EXTRACTION_LIMITS.min_confidence}`);
  }

  // V2 — every citation must resolve to a rendered line of this episode.
  const missingRefs = fact.evidence_refs.filter((ref) => !ctx.seqMap.has(ref));
  if (missingRefs.length > 0) return reject("evidence_ref", `unknown refs: ${missingRefs.join(", ")}`);

  // Import mode (§11): the extractor is restricted to `action = create`. A bullet states the file's own rule; it
  // never proposes against stored memories (a replacement row born active/human would bypass §5.7 step 7), and
  // the CLI's import upgrade path decides supersedes by lexical similarity.
  if (ctx.mode.kind === "import" && (fact.action === "propose_supersede" || fact.action === "propose_stale")) {
    fact = { ...fact, action: "create", target_memory_id: null };
    relabels.push("import_create_only");
  }

  // V7 — targets must exist: reinforce downgrades to create, propose_* is rejected.
  if (fact.action === "reinforce" || fact.action === "propose_supersede" || fact.action === "propose_stale") {
    const exists = fact.target_memory_id !== null && ctx.existingMemoryIds.has(fact.target_memory_id);
    if (!exists) {
      if (fact.action !== "reinforce") return reject("rejected_no_target", `target ${fact.target_memory_id ?? "null"} does not exist`);
      fact = { ...fact, action: "create", target_memory_id: null };
      relabels.push("no_target_create");
    }
  } else if (fact.target_memory_id !== null) {
    fact = { ...fact, target_memory_id: null };
  }

  // V6 — scanner and self-reference.
  if (!ctx.scanner(fact.summary, fact.details).safe) return reject("security");
  if (isSelfReference(`${fact.summary}\n${fact.details}\n${fact.aliases.join(" ")}`, ctx.existingMemoryIds)) return reject("self_reference");

  // V8 — not a restatement of the prompt.
  if (isRestatement(fact.summary, ctx.descriptor.prompt_text)) return reject("restatement");

  // V5 — compile the signature (V10 specificity is reported by the same call and applied below).
  let signature: TriggerSignature | null = fact.trigger_signature;
  let compiled: CompiledSignature | null = null;
  let unspecificDetail: string | null = null;
  if (signature !== null) {
    const result = compileSignature(signature);
    if (result.ok) {
      compiled = result.compiled;
      signature = { ...signature, tool: compiled.tool };
    } else if (result.code === "signature_unspecific") {
      unspecificDetail = result.detail;
    } else if (result.code === "regex_unsafe") {
      return reject("regex_unsafe", result.detail);
    } else {
      return reject("schema", result.detail);
    }
  }

  // V3 — scope (a signature makes any repository glob acceptable). A create that cites an explicit remember request
  // ("from now on …, remember this", "기억해") is the user's own rule: a repository-wide glob without a signature is
  // what they asked for, so it passes too (Phase F, direction A′); reconcile turns it into a human row.
  const rememberCreate = citesRememberPrompt(ctx.descriptor.flags, { action: fact.action, evidence_refs: fact.evidence_refs }, ctx.seqMap);
  let scope = checkScope(fact.scope_glob, fact.type, signature !== null || rememberCreate, ctx.mode);
  if (!scope.ok) return reject(scope.rejection, scope.detail);

  // V4 — signature tool must be in the (mode-dependent) tool set; import / tool-less need a citation.
  if (signature !== null) {
    const toolCheck = checkSignatureTool(signature, ctx);
    if (!toolCheck.ok) return reject("signature_tool", toolCheck.detail);
  }

  // V10 — unspecific signature: drop it and re-validate scope without it.
  if (unspecificDetail !== null) {
    relabels.push("signature_dropped");
    if (isBeforeToolOnly(fact.lifecycle_triggers)) return reject("trigger_unreachable", unspecificDetail);
    signature = null;
    compiled = null;
    scope = checkScope(fact.scope_glob, fact.type, rememberCreate, ctx.mode);
    if (!scope.ok) return reject(scope.rejection, scope.detail);
  }

  // V11 — before_tool must be reachable: hooked tool family, or a scope-only policy / pitfall.
  let triggers: LifecycleTrigger[] = [...fact.lifecycle_triggers];
  if (triggers.includes("before_tool")) {
    const reachable = signature !== null ? signatureReachesHook(signature) : fact.type === "policy" || fact.type === "pitfall";
    if (!reachable) {
      triggers = [...new Set(triggers.map((trigger) => (trigger === "before_tool" ? ("before_model" as LifecycleTrigger) : trigger)))];
      relabels.push("tool_not_hooked");
    }
  }

  // V12 — a signature must not fire on the command that resolved the cited failure: "X fails, use Y" written as a
  // pattern that also matches Y (`pm test` covers `pnpm test`) would block the fix the user asked for. The same literal
  // command succeeding later (an environment fix) is fine; reinforce never changes a stored signature.
  if (compiled !== null && (fact.action === "create" || fact.action === "propose_supersede")) {
    const conflict = resolutionConflict(compiled, fact.evidence_refs, ctx.seqMap);
    if (conflict !== null) return reject("signature_matches_resolution", conflict);
  }

  const normalizedScope = compiled !== null && !commandSignatureNamesPath(compiled) ? GLOBAL_SCOPE : scope.normalized;
  const key = semanticKey(fact.type, normalizedScope, compiled?.signature_key ?? "", fact.summary);

  return {
    ok: true,
    fact: {
      ...fact,
      trigger_signature: signature,
      lifecycle_triggers: triggers,
      scope_glob: normalizedScope,
      ordinal,
      compiledSignature: compiled,
      semanticKey: key,
      normalizedScope,
      relabels,
    },
  };
}

function suspectResult(reason: SuspectReason, ordinals: readonly { ordinal: number; action: FactOutcome["action"] }[]): ValidationResult {
  return {
    accepted: [],
    outcomes: ordinals.map(({ ordinal, action }) => ({ ordinal, action, outcome: "skipped", detail: `suspect_run:${reason}` })),
    suspect: true,
    suspectReason: reason,
  };
}

/** Runs V2–V11 over parsed facts and applies the circuit breaker. V1 failures arrive via `schemaRejects`. */
export function validateExtraction(input: ValidateExtractionInput): ValidationResult {
  const facts = input.output.facts;
  const schemaRejects = input.schemaRejects ?? [];
  const ordinalOf = (index: number): number => input.factOrdinals?.[index] ?? index;
  const allOrdinals = [
    ...facts.map((fact, index) => ({ ordinal: ordinalOf(index), action: fact.action })),
    ...schemaRejects.map((reject) => ({ ordinal: reject.ordinal, action: "unknown" as const })),
  ].sort((a, b) => a.ordinal - b.ordinal);

  const rawFactCount = input.rawFactCount ?? facts.length + schemaRejects.length;
  if (rawFactCount > SUSPECT_THRESHOLDS.max_facts) return suspectResult("too_many_facts", allOrdinals);

  let totalRefs = 0;
  let unknownRefs = 0;
  for (const fact of facts) {
    for (const ref of fact.evidence_refs) {
      totalRefs += 1;
      if (!input.seqMap.has(ref)) unknownRefs += 1;
    }
  }
  if (totalRefs > 0 && unknownRefs / totalRefs > SUSPECT_THRESHOLDS.hallucinated_ref_ratio) {
    return suspectResult("hallucinated_refs", allOrdinals);
  }

  const ctx: FactContext = {
    descriptor: input.descriptor,
    seqMap: input.seqMap,
    existingMemoryIds: input.existingMemoryIds,
    scanner: input.scanner ?? defaultScanner,
    mode: resolveMode(input.descriptor, input.correctionForEpisode),
  };

  const outcomes: FactOutcome[] = schemaRejects.map((reject) => ({
    ordinal: reject.ordinal,
    action: "unknown",
    outcome: "rejected",
    rejection: "schema",
    detail: reject.detail,
  }));
  const accepted: ValidatedFact[] = [];
  const seenKeys = new Map<string, number>();

  facts.forEach((fact, index) => {
    const ordinal = ordinalOf(index);
    const result = validateFact(fact, ordinal, ctx);
    if (!result.ok) {
      outcomes.push(result.outcome);
      return;
    }
    // V9 — fold duplicates within the batch by semantic key (first occurrence wins).
    const first = seenKeys.get(result.fact.semanticKey);
    if (first !== undefined) {
      outcomes.push({
        ordinal,
        action: fact.action,
        outcome: "rejected",
        rejection: "duplicate_in_batch",
        detail: `same semantic key as fact ${first}`,
      });
      return;
    }
    seenKeys.set(result.fact.semanticKey, ordinal);
    accepted.push(result.fact);
  });

  outcomes.sort((a, b) => a.ordinal - b.ordinal);
  return { accepted, outcomes, suspect: false };
}

export type ValidateRawExtractionInput = Omit<ValidateExtractionInput, "output" | "factOrdinals" | "schemaRejects" | "rawFactCount"> & {
  raw: string | unknown;
};

/** Parse (V1) + validate in one call; non-JSON or an invalid top-level shape is a suspect run with nothing applied. */
export function validateRawExtraction(input: ValidateRawExtractionInput): ValidationResult & { output: ExtractionOutput | null } {
  const parsed = parseExtractionOutput(input.raw);
  if (!parsed.ok) {
    return { ...suspectResult(parsed.code === "not_json" ? "not_json" : "schema", []), output: null };
  }
  const { raw: _raw, ...rest } = input;
  const result = validateExtraction({
    ...rest,
    output: parsed.output,
    factOrdinals: parsed.factOrdinals,
    schemaRejects: parsed.invalidFacts,
    rawFactCount: parsed.rawFactCount,
  });
  return { ...result, output: parsed.output };
}
