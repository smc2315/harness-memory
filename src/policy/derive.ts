/**
 * derivePolicyRules — rewrites the derived rows of `policy_rules` from the active `policy` memories at
 * the end of every writer commit (spec §10, §12 D5). Manual rules (`derived_at IS NULL`) are preserved.
 *
 *   rule_code    = 'POL-' + memory_id.slice(0, 8) + '-' + trigger      (one row per lifecycle trigger)
 *   severity     = enforcement === 'advise' ? 'info' : 'warning'
 *   tool_pattern = signature.tool ?? relevant_tools.join('|') ?? '*'
 *   target_kind  = signature.target ?? 'any'
 *   pattern_kind / arg_pattern = the compiled signature (canonical pattern), enforcement = memory.enforcement
 *   message      = summary (+ ' — ' + details.slice(0, 200))
 *
 * Invariant (tested): `policy_rules WHERE derived_at IS NOT NULL` equals `expectedDerivedRules(db)`.
 */

import type { Database as SqlJsDatabase } from "sql.js";

import { compileSignature } from "../activation/signature";
import { createDeterministicId } from "../core/ids";
import type { Enforcement, PatternKind, SignatureTarget } from "../core/vocabulary";
import type { LifecycleTrigger } from "../db/schema/types";
import { selectAll } from "../db/sql";
import { MemoryRepository, type MemoryRecord } from "../memory/repository";

export const DERIVED_RULE_PREFIX = "POL-";
const MESSAGE_DETAILS_CHARS = 200;

export interface DerivedRule {
  id: string;
  memoryId: string;
  ruleCode: string;
  severity: "info" | "warning";
  triggerKind: LifecycleTrigger;
  scopeGlob: string;
  toolPattern: string;
  targetKind: SignatureTarget;
  patternKind: PatternKind | null;
  argPattern: string | null;
  enforcement: Enforcement;
  message: string;
}

export interface DeriveRulesResult {
  deleted: number;
  inserted: number;
  rules: DerivedRule[];
}

export function derivedRuleCode(memoryId: string, trigger: LifecycleTrigger): string {
  return `${DERIVED_RULE_PREFIX}${memoryId.slice(0, 8)}-${trigger}`;
}

export function derivedRuleId(memoryId: string, trigger: LifecycleTrigger): string {
  return createDeterministicId(`policy-rule:${memoryId}:${trigger}`);
}

export function ruleMessage(memory: Pick<MemoryRecord, "summary" | "details">): string {
  const details = memory.details.trim();
  return details.length === 0 ? memory.summary : `${memory.summary} — ${details.slice(0, MESSAGE_DETAILS_CHARS)}`;
}

/** The rules an active policy memory yields (pure; the invariant test compares against the table). */
export function rulesForMemory(memory: MemoryRecord): DerivedRule[] {
  if (memory.type !== "policy" || memory.status !== "active") return [];
  let toolPattern = "*";
  let targetKind: SignatureTarget = "any";
  let patternKind: PatternKind | null = null;
  let argPattern: string | null = null;

  if (memory.triggerSignature !== null) {
    const compiled = compileSignature(memory.triggerSignature);
    if (compiled.ok) {
      toolPattern = compiled.compiled.tool;
      targetKind = compiled.compiled.target;
      patternKind = compiled.compiled.pattern_kind;
      argPattern = compiled.compiled.pattern;
    } else {
      toolPattern = memory.triggerSignature.tool.trim().toLowerCase() || "*";
      targetKind = memory.triggerSignature.target;
    }
  } else if (memory.relevantTools !== null && memory.relevantTools.length > 0) {
    toolPattern = [...new Set(memory.relevantTools)].join("|");
  }

  const severity: "info" | "warning" = memory.enforcement === "advise" ? "info" : "warning";
  const message = ruleMessage(memory);
  const triggers = [...new Set(memory.lifecycleTriggers)];

  return triggers.map((trigger) => ({
    id: derivedRuleId(memory.id, trigger),
    memoryId: memory.id,
    ruleCode: derivedRuleCode(memory.id, trigger),
    severity,
    triggerKind: trigger,
    scopeGlob: memory.scopeGlob,
    toolPattern,
    targetKind,
    patternKind,
    argPattern,
    enforcement: memory.enforcement,
    message,
  }));
}

/** What the derived rows must look like for the current active policies (sorted by rule_code). */
export function expectedDerivedRules(db: SqlJsDatabase): DerivedRule[] {
  const repository = new MemoryRepository(db);
  const rules = repository.list({ type: "policy", status: "active" }).flatMap((memory) => rulesForMemory(memory));
  return rules.sort((left, right) => left.ruleCode.localeCompare(right.ruleCode));
}

/** Current `derived_at IS NOT NULL` rows in the same shape as expectedDerivedRules. */
export function readDerivedRules(db: SqlJsDatabase): DerivedRule[] {
  return selectAll(
    db,
    `SELECT id, memory_id, rule_code, severity, trigger_kind, scope_glob, tool_pattern, target_kind, pattern_kind, arg_pattern, enforcement, message
     FROM policy_rules WHERE derived_at IS NOT NULL ORDER BY rule_code ASC`
  ).map((row) => ({
    id: String(row.id),
    memoryId: String(row.memory_id),
    ruleCode: String(row.rule_code),
    severity: row.severity as "info" | "warning",
    triggerKind: row.trigger_kind as LifecycleTrigger,
    scopeGlob: String(row.scope_glob),
    toolPattern: String(row.tool_pattern),
    targetKind: row.target_kind as SignatureTarget,
    patternKind: (row.pattern_kind ?? null) as PatternKind | null,
    argPattern: row.arg_pattern === null || row.arg_pattern === undefined ? null : String(row.arg_pattern),
    enforcement: row.enforcement as Enforcement,
    message: String(row.message),
  }));
}

/** Deletes every derived row and inserts one per active policy memory per lifecycle trigger. */
export function derivePolicyRules(db: SqlJsDatabase, options: { now: string }): DeriveRulesResult {
  const before = selectAll(db, "SELECT COUNT(*) AS n FROM policy_rules WHERE derived_at IS NOT NULL");
  const deleted = before.length === 0 ? 0 : Number(before[0]!.n ?? 0);
  db.run("DELETE FROM policy_rules WHERE derived_at IS NOT NULL");

  const rules = expectedDerivedRules(db);
  let inserted = 0;
  for (const rule of rules) {
    // A manual rule may already own the code (UNIQUE): leave it alone rather than fail the commit.
    db.run(
      `INSERT OR IGNORE INTO policy_rules (
         id, memory_id, rule_code, severity, trigger_kind, scope_glob, message,
         tool_pattern, target_kind, pattern_kind, arg_pattern, enforcement, derived_at, created_at, updated_at
       ) VALUES (
         $id, $memoryId, $ruleCode, $severity, $triggerKind, $scopeGlob, $message,
         $toolPattern, $targetKind, $patternKind, $argPattern, $enforcement, $now, $now, $now
       )`,
      {
        $id: rule.id,
        $memoryId: rule.memoryId,
        $ruleCode: rule.ruleCode,
        $severity: rule.severity,
        $triggerKind: rule.triggerKind,
        $scopeGlob: rule.scopeGlob,
        $message: rule.message,
        $toolPattern: rule.toolPattern,
        $targetKind: rule.targetKind,
        $patternKind: rule.patternKind,
        $argPattern: rule.argPattern,
        $enforcement: rule.enforcement,
        $now: options.now,
      }
    );
    const changed = selectAll(db, "SELECT changes() AS n");
    inserted += changed.length === 0 ? 0 : Number(changed[0]!.n ?? 0);
  }

  return { deleted, inserted, rules };
}

/** True when the derived rows match `expectedDerivedRules` field by field (ids excluded from the comparison). */
export function derivedRulesConsistent(db: SqlJsDatabase): boolean {
  const strip = (rule: DerivedRule): Omit<DerivedRule, "id"> => {
    const { id: _id, ...rest } = rule;
    return rest;
  };
  const expected = expectedDerivedRules(db).map(strip);
  const actual = readDerivedRules(db).map(strip);
  return JSON.stringify(expected) === JSON.stringify(actual);
}
