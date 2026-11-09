import type { LifecycleTrigger, PolicySeverity } from "../db/schema/types";
import type { Enforcement, PatternKind, ShellDialect, SignatureTarget } from "../core/vocabulary";

/**
 * Policy rule record - typed representation of a policy rule from the database (migration 020 shape).
 * `scopeRegex` is only present on rules that come from the snapshot (precompiled by the builder).
 */
export interface PolicyRuleRecord {
  id: string;
  memoryId: string | null;
  ruleCode: string;
  severity: PolicySeverity;
  triggerKind: LifecycleTrigger;
  scopeGlob: string;
  message: string;
  /** Glob over canonical tool names (`*`, `bash`, `write|edit`, `mcp:server/*`). */
  toolPattern: string;
  targetKind: SignatureTarget;
  patternKind: PatternKind | null;
  argPattern: string | null;
  enforcement: Enforcement;
  /** NULL = manual rule; otherwise rewritten from active policy memories by `derivePolicyRules`. */
  derivedAt: string | null;
  scopeRegex?: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Policy warning - result of evaluating a matching policy rule. `enforcement` is mapped onto the
 * host delivery ladder (§7.2) by the hook adapter.
 */
export interface PolicyWarning {
  ruleCode: string;
  severity: PolicySeverity;
  scopeGlob: string;
  scopeRef: string;
  triggerKind: LifecycleTrigger;
  message: string;
  enforcement: Enforcement;
  memoryId: string | null;
}

/**
 * Policy evaluation request (spec §10). `scopeRef` is the primary path-like reference; `scopeRefs`
 * may list every path token of the call (any match counts). `toolTarget` is the string an
 * `arg_pattern` is matched against (command text, repository-relative path, URL or MCP JSON digest).
 */
export interface PolicyEvaluationRequest {
  lifecycleTrigger: LifecycleTrigger;
  scopeRef: string;
  scopeRefs?: readonly string[];
  toolName?: string;
  toolTarget?: string | null;
  toolInput?: unknown;
  shellDialect?: ShellDialect | null;
}

/**
 * Policy evaluation result - warning-only, never blocks
 */
export interface PolicyEvaluationResult {
  warnings: PolicyWarning[];
  evaluatedAt: string;
}
