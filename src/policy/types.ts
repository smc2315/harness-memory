import type { LifecycleTrigger, PolicySeverity } from "../db/schema/types";

/**
 * Policy rule record - typed representation of a policy rule from the database
 */
export interface PolicyRuleRecord {
  id: string;
  memoryId: string | null;
  ruleCode: string;
  severity: PolicySeverity;
  triggerKind: LifecycleTrigger;
  scopeGlob: string;
  message: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Policy warning - result of evaluating a matching policy rule
 */
export interface PolicyWarning {
  ruleCode: string;
  severity: PolicySeverity;
  scopeGlob: string;
  scopeRef: string;
  triggerKind: LifecycleTrigger;
  message: string;
}

/**
 * Policy evaluation request
 */
export interface PolicyEvaluationRequest {
  lifecycleTrigger: LifecycleTrigger;
  scopeRef: string;
}

/**
 * Policy evaluation result - warning-only, never blocks
 */
export interface PolicyEvaluationResult {
  warnings: PolicyWarning[];
  evaluatedAt: string;
}
