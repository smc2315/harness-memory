import type { Database as SqlJsDatabase } from "sql.js";

import type { LifecycleTrigger, PolicySeverity } from "../db/schema/types";
import {
  ENFORCEMENTS,
  LIFECYCLE_TRIGGERS,
  PATTERN_KINDS,
  SIGNATURE_TARGETS,
  type Enforcement,
  type PatternKind,
  type SignatureTarget,
} from "../core/vocabulary";
import type { PolicyRuleRecord } from "./types";

type SqlParameter = string | number | null;
type SqlParameters = Record<string, SqlParameter>;

const POLICY_RULE_SELECT_COLUMNS = [
  "id",
  "memory_id",
  "rule_code",
  "severity",
  "trigger_kind",
  "scope_glob",
  "message",
  "created_at",
  "updated_at",
  "tool_pattern",
  "target_kind",
  "pattern_kind",
  "arg_pattern",
  "enforcement",
  "derived_at",
].join(", ");

const POLICY_SEVERITIES = new Set<PolicySeverity>(["info", "warning"]);

function isPolicySeverity(value: string): value is PolicySeverity {
  return POLICY_SEVERITIES.has(value as PolicySeverity);
}

function expectString(value: unknown, column: string): string {
  if (typeof value !== "string") {
    throw new Error(`Expected ${column} to be a string`);
  }

  return value;
}

function expectNullableString(value: unknown, column: string): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  return expectString(value, column);
}

function expectPolicySeverity(value: unknown): PolicySeverity {
  const severity = expectString(value, "severity");

  if (!isPolicySeverity(severity)) {
    throw new Error(`Invalid policy severity: ${severity}`);
  }

  return severity;
}

function expectLifecycleTrigger(value: unknown): LifecycleTrigger {
  const trigger = expectString(value, "trigger_kind");

  if (!LIFECYCLE_TRIGGERS.includes(trigger as LifecycleTrigger)) {
    throw new Error(`Invalid lifecycle trigger: ${trigger}`);
  }

  return trigger as LifecycleTrigger;
}

function expectEnum<T extends string>(value: unknown, allowed: readonly T[], column: string, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  const text = expectString(value, column);
  if (!(allowed as readonly string[]).includes(text)) {
    throw new Error(`Invalid ${column}: ${text}`);
  }
  return text as T;
}

function expectNullableEnum<T extends string>(value: unknown, allowed: readonly T[], column: string): T | null {
  if (value === null || value === undefined) return null;
  return expectEnum(value, allowed, column, allowed[0]!);
}

export class PolicyRuleRepository {
  readonly db: SqlJsDatabase;

  constructor(db: SqlJsDatabase) {
    this.db = db;
    this.db.run("PRAGMA foreign_keys = ON;");
  }

  /**
   * List all policy rules, optionally filtered by trigger kind
   */
  list(triggerKind?: LifecycleTrigger): PolicyRuleRecord[] {
    const params: SqlParameters = {};
    const where: string[] = [
      "(memory_id IS NULL OR EXISTS (SELECT 1 FROM memories m WHERE m.id = policy_rules.memory_id AND m.status = 'active'))",
    ];

    if (triggerKind !== undefined) {
      where.push("trigger_kind = $triggerKind");
      params.$triggerKind = triggerKind;
    }

    const sql = `SELECT ${POLICY_RULE_SELECT_COLUMNS} FROM policy_rules WHERE ${where.join(" AND ")} ORDER BY created_at ASC, id ASC`;

    return this.selectMany(sql, params);
  }

  /**
   * Get a single policy rule by ID
   */
  getById(id: string): PolicyRuleRecord | null {
    return this.selectOne(
      `SELECT ${POLICY_RULE_SELECT_COLUMNS} FROM policy_rules WHERE id = $id`,
      { $id: id }
    );
  }

  /**
   * Get a single policy rule by rule code
   */
  getByRuleCode(ruleCode: string): PolicyRuleRecord | null {
    return this.selectOne(
      `SELECT ${POLICY_RULE_SELECT_COLUMNS} FROM policy_rules WHERE rule_code = $ruleCode`,
      { $ruleCode: ruleCode }
    );
  }

  private selectOne(sql: string, params: SqlParameters): PolicyRuleRecord | null {
    const statement = this.db.prepare(sql);

    try {
      statement.bind(params);

      if (!statement.step()) {
        return null;
      }

      return this.mapPolicyRuleRow(statement.get() as unknown[]);
    } finally {
      statement.free();
    }
  }

  private selectMany(sql: string, params: SqlParameters): PolicyRuleRecord[] {
    const statement = this.db.prepare(sql);

    try {
      statement.bind(params);

      const rows: PolicyRuleRecord[] = [];

      while (statement.step()) {
        rows.push(this.mapPolicyRuleRow(statement.get() as unknown[]));
      }

      return rows;
    } finally {
      statement.free();
    }
  }

  private mapPolicyRuleRow(row: unknown[]): PolicyRuleRecord {
    return {
      id: expectString(row[0], "id"),
      memoryId: expectNullableString(row[1], "memory_id"),
      ruleCode: expectString(row[2], "rule_code"),
      severity: expectPolicySeverity(row[3]),
      triggerKind: expectLifecycleTrigger(row[4]),
      scopeGlob: expectString(row[5], "scope_glob"),
      message: expectString(row[6], "message"),
      createdAt: expectString(row[7], "created_at"),
      updatedAt: expectString(row[8], "updated_at"),
      toolPattern: typeof row[9] === "string" && row[9].length > 0 ? row[9] : "*",
      targetKind: expectEnum<SignatureTarget>(row[10], SIGNATURE_TARGETS, "target_kind", "any"),
      patternKind: expectNullableEnum<PatternKind>(row[11], PATTERN_KINDS, "pattern_kind"),
      argPattern: expectNullableString(row[12], "arg_pattern"),
      enforcement: expectEnum<Enforcement>(row[13], ENFORCEMENTS, "enforcement", "advise"),
      derivedAt: expectNullableString(row[14], "derived_at"),
    };
  }
}
