import { matchesScope, normalizeScopeRef } from "../activation/scope";
import type {
  PolicyEvaluationRequest,
  PolicyEvaluationResult,
  PolicyWarning,
} from "./types";
import { PolicyRuleRepository } from "./repository";

/**
 * PolicyEngine evaluates policy rules and returns warnings.
 * 
 * This engine is completely separate from ActivationEngine:
 * - It queries policy_rules table directly
 * - It returns warnings only (never blocks execution)
 * - It does not interact with memory activation
 * - Matching rules do not affect model/tool execution
 */
export class PolicyEngine {
  readonly repository: PolicyRuleRepository;

  constructor(repository: PolicyRuleRepository) {
    this.repository = repository;
  }

  /**
   * Evaluate policy rules for a given trigger and scope.
   * Returns warnings for all matching rules.
   * Never throws; always returns a result.
   */
  evaluate(request: PolicyEvaluationRequest): PolicyEvaluationResult {
    const scopeRef = normalizeScopeRef(request.scopeRef);
    const rules = this.repository.list(request.lifecycleTrigger);
    const warnings: PolicyWarning[] = [];

    for (const rule of rules) {
      if (matchesScope(rule.scopeGlob, scopeRef)) {
        warnings.push({
          ruleCode: rule.ruleCode,
          severity: rule.severity,
          scopeGlob: rule.scopeGlob,
          scopeRef,
          triggerKind: rule.triggerKind,
          message: rule.message,
        });
      }
    }

    return {
      warnings,
      evaluatedAt: new Date().toISOString(),
    };
  }
}
