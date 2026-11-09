/**
 * PolicyEngine (spec §10): returns the rules that apply to a lifecycle trigger + tool call.
 *
 * A rule matches when
 *   trigger_kind = request.lifecycleTrigger
 *   ∧ toolGlobMatches(tool_pattern, canonical tool)            (no tool in the request → only `*` rules)
 *   ∧ (scope regex/glob matches a scope ref ∨ scope is global ∨ (arg_pattern present ∧ no scope ref))
 *   ∧ (arg_pattern is null ∨ the shared signature matcher accepts the tool target)
 *
 * The matcher is `src/activation/signature.ts`, the same code that evaluates memory signatures, so a
 * derived rule and its policy memory can never disagree. Rules come either from `policy_rules` rows
 * (`PolicyRuleRepository`, CLI / tests) or from the snapshot (`PolicyEngine.fromSnapshotRules`, hooks).
 * Hooks never open SQLite, and the snapshot path never compiles patterns: a derived rule's `arg_pattern`
 * is matched with its policy memory's precompiled signature (`fromSnapshotRules(rules, loaded.byId)`),
 * so a PreToolUse process loads no minimatch and runs no regex-safety sampling. Only a manual rule
 * (memory_id NULL) that carries an `arg_pattern` is compiled lazily.
 *
 * Warning-only: nothing here blocks execution; the adapter maps `enforcement` onto §7.2.
 */

import { isGlobalScope, type ShellDialect, type TriggerSignature } from "../core/vocabulary";
import type { CompiledSignature, SnapshotMemory, SnapshotRule } from "../core/snapshot-types";
import { compileSignature, globMatchesPath, globRegexFlags, matchSignature } from "../activation/signature";
import { toolGlobMatches } from "../activation/tool-vocabulary";
import type { LifecycleTrigger } from "../db/schema/types";
import type {
  PolicyEvaluationRequest,
  PolicyEvaluationResult,
  PolicyRuleRecord,
  PolicyWarning,
} from "./types";

/** Anything that can list rules per trigger: the SQLite repository or an in-memory snapshot source. */
export interface PolicyRuleSource {
  list(triggerKind?: LifecycleTrigger): PolicyRuleRecord[];
  /** Precompiled matcher for a rule's `arg_pattern` when the source already holds one (snapshot path); undefined → compile. */
  precompiledSignature?(rule: PolicyRuleRecord): CompiledSignature | undefined;
}

/** Snapshot memories by id (`LoadedSnapshot.byId`): a derived rule's `arg_pattern` is its policy memory's compiled signature. */
export type SnapshotMemorySignatures = ReadonlyMap<string, Pick<SnapshotMemory, "signature">>;

export function normalizeScopeRef(scopeRef: string): string {
  return scopeRef.trim().replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^(\.\/)+/, "");
}

/** Snapshot rule → repository-shaped record (the snapshot carries the precompiled scope regex). */
export function snapshotRuleToRecord(rule: SnapshotRule): PolicyRuleRecord {
  return {
    id: rule.id,
    memoryId: rule.memory_id,
    ruleCode: rule.rule_code,
    severity: rule.severity,
    triggerKind: rule.trigger_kind,
    scopeGlob: rule.scope_glob,
    scopeRegex: rule.scope_regex,
    message: rule.message,
    toolPattern: rule.tool_pattern,
    targetKind: rule.target_kind,
    patternKind: rule.pattern_kind,
    argPattern: rule.arg_pattern,
    enforcement: rule.enforcement,
    derivedAt: null,
    createdAt: "",
    updatedAt: "",
  };
}

class SnapshotRuleSource implements PolicyRuleSource {
  private readonly rules: PolicyRuleRecord[];
  /** rule id → the policy memory's precompiled signature (derived rules whose memory is in the snapshot). */
  private readonly precompiled = new Map<string, CompiledSignature>();

  constructor(rules: readonly SnapshotRule[], memories?: SnapshotMemorySignatures) {
    this.rules = rules.map(snapshotRuleToRecord);
    if (memories === undefined) return;
    for (const rule of rules) {
      if (rule.memory_id === null || rule.pattern_kind === null || rule.arg_pattern === null) continue;
      const signature = memories.get(rule.memory_id)?.signature ?? null;
      // derive.ts copies the compiled pattern_kind / canonical pattern into the rule; anything else falls back to compiling.
      if (signature !== null && signature.pattern_kind === rule.pattern_kind && signature.pattern === rule.arg_pattern) {
        this.precompiled.set(rule.id, signature);
      }
    }
  }

  list(triggerKind?: LifecycleTrigger): PolicyRuleRecord[] {
    return triggerKind === undefined ? [...this.rules] : this.rules.filter((rule) => rule.triggerKind === triggerKind);
  }

  precompiledSignature(rule: PolicyRuleRecord): CompiledSignature | undefined {
    return this.precompiled.get(rule.id);
  }
}

const SCOPE_REGEX_CACHE = new Map<string, RegExp | null>();

function scopeRegExp(source: string): RegExp | null {
  const key = `${globRegexFlags()}:${source}`;
  const cached = SCOPE_REGEX_CACHE.get(key);
  if (cached !== undefined) return cached;
  let regex: RegExp | null;
  try {
    regex = new RegExp(source, globRegexFlags());
  } catch {
    regex = null;
  }
  SCOPE_REGEX_CACHE.set(key, regex);
  return regex;
}

function ruleScopeMatches(rule: PolicyRuleRecord, ref: string): boolean {
  if (typeof rule.scopeRegex === "string" && rule.scopeRegex.length > 0) {
    const regex = scopeRegExp(rule.scopeRegex);
    if (regex === null) return false;
    regex.lastIndex = 0;
    return regex.test(ref);
  }
  if (rule.scopeRegex === null) return true;
  return globMatchesPath(rule.scopeGlob, ref);
}

export class PolicyEngine {
  readonly repository: PolicyRuleSource;
  private readonly compiledArgPatterns = new Map<string, CompiledSignature | null>();

  constructor(repository: PolicyRuleSource) {
    this.repository = repository;
  }

  /**
   * Hook-side engine over the rules embedded in `snapshot/active.v1.json`. With `memories` (the snapshot's
   * `byId` map) derived rules match through their memory's precompiled signature instead of recompiling.
   */
  static fromSnapshotRules(rules: readonly SnapshotRule[], memories?: SnapshotMemorySignatures): PolicyEngine {
    return new PolicyEngine(new SnapshotRuleSource(rules, memories));
  }

  /**
   * Evaluate policy rules for a given trigger, scope and (optionally) tool call.
   * Returns warnings for all matching rules. Never throws; always returns a result.
   */
  evaluate(request: PolicyEvaluationRequest): PolicyEvaluationResult {
    const primaryRef = normalizeScopeRef(request.scopeRef);
    const refs = [primaryRef, ...(request.scopeRefs ?? []).map(normalizeScopeRef)].filter((ref) => ref.length > 0);
    const warnings: PolicyWarning[] = [];

    let rules: PolicyRuleRecord[];
    try {
      rules = this.repository.list(request.lifecycleTrigger);
    } catch {
      rules = [];
    }

    for (const rule of rules) {
      if (!this.ruleMatches(rule, request, refs)) continue;
      warnings.push({
        ruleCode: rule.ruleCode,
        severity: rule.severity,
        scopeGlob: rule.scopeGlob,
        scopeRef: primaryRef,
        triggerKind: rule.triggerKind,
        message: rule.message,
        enforcement: rule.enforcement,
        memoryId: rule.memoryId,
      });
    }

    return {
      warnings,
      evaluatedAt: new Date().toISOString(),
    };
  }

  /** The §10 predicate for one rule (exported for `memory:why` and tests through `evaluate`). */
  ruleMatches(rule: PolicyRuleRecord, request: PolicyEvaluationRequest, normalizedRefs?: readonly string[]): boolean {
    if (rule.triggerKind !== request.lifecycleTrigger) return false;

    const toolName = request.toolName;
    if (toolName !== undefined && toolName.length > 0) {
      if (!toolGlobMatches(rule.toolPattern, toolName)) return false;
    } else if (rule.toolPattern.trim() !== "*") {
      return false;
    }

    const refs =
      normalizedRefs ??
      [normalizeScopeRef(request.scopeRef), ...(request.scopeRefs ?? []).map(normalizeScopeRef)].filter((ref) => ref.length > 0);
    const hasArgPattern = rule.argPattern !== null && rule.argPattern.length > 0;
    const scopeOk =
      isGlobalScope(rule.scopeGlob) ||
      (refs.length > 0 ? refs.some((ref) => ruleScopeMatches(rule, ref)) : hasArgPattern);
    if (!scopeOk) return false;

    if (!hasArgPattern) return true;
    const compiled = this.compiledArgPattern(rule);
    if (compiled === null) return false;
    const target = request.toolTarget ?? null;
    if (target === null) return false;
    return matchSignature(compiled, target, request.shellDialect ?? dialectFromInput(request.toolInput));
  }

  private compiledArgPattern(rule: PolicyRuleRecord): CompiledSignature | null {
    const key = `${rule.id}|${rule.toolPattern}|${rule.targetKind}|${rule.patternKind ?? ""}|${rule.argPattern ?? ""}`;
    const cached = this.compiledArgPatterns.get(key);
    if (cached !== undefined) return cached;
    let compiled: CompiledSignature | null = this.repository.precompiledSignature?.(rule) ?? null;
    if (compiled === null && rule.argPattern !== null && rule.patternKind !== null) {
      const signature: TriggerSignature = {
        tool: rule.toolPattern,
        target: rule.targetKind,
        pattern_kind: rule.patternKind,
        pattern: rule.argPattern,
      };
      const result = compileSignature(signature);
      compiled = result.ok ? result.compiled : null;
    }
    this.compiledArgPatterns.set(key, compiled);
    return compiled;
  }
}

function dialectFromInput(toolInput: unknown): ShellDialect | null {
  if (typeof toolInput !== "object" || toolInput === null) return null;
  const dialect = (toolInput as Record<string, unknown>).shell_dialect;
  return dialect === "bash" || dialect === "powershell" || dialect === "cmd" || dialect === "unknown" ? dialect : null;
}
