import type { Database as SqlJsDatabase } from "sql.js";

import type { LifecycleTrigger, PolicySeverity } from "../db/schema/types";
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
  if (value === null) {
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
  const validTriggers: readonly LifecycleTrigger[] = [
    "session_start",
    "before_model",
    "before_tool",
    "after_tool",
  ];

  if (!validTriggers.includes(trigger as LifecycleTrigger)) {
    throw new Error(`Invalid lifecycle trigger: ${trigger}`);
  }

  return trigger as LifecycleTrigger;
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
    const where: string[] = [];

    if (triggerKind !== undefined) {
      where.push("trigger_kind = $triggerKind");
      params.$triggerKind = triggerKind;
    }

    const clauses = [
      `SELECT ${POLICY_RULE_SELECT_COLUMNS} FROM policy_rules`,
      where.length > 0 ? `WHERE ${where.join(" AND ")}` : "",
      "ORDER BY created_at ASC, id ASC",
    ].filter((clause) => clause.length > 0);

    return this.selectMany(clauses.join(" "), params);
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
    };
  }
}
