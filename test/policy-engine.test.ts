import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { Database as SqlJsDatabase } from "sql.js";

import { PolicyEngine, PolicyRuleRepository } from "../src/policy";
import { createTestDb } from "./helpers/create-test-db";

describe("PolicyEngine", () => {
  let db: SqlJsDatabase;
  let repository: PolicyRuleRepository;
  let engine: PolicyEngine;

  beforeEach(async () => {
    db = await createTestDb();
    repository = new PolicyRuleRepository(db);
    engine = new PolicyEngine(repository);
  });

  afterEach(() => {
    db.close();
  });

  test("returns empty warnings when no rules exist", () => {
    const result = engine.evaluate({
      lifecycleTrigger: "before_tool",
      scopeRef: "src/core/repo.ts",
    });

    expect(result.warnings).toHaveLength(0);
    expect(result.evaluatedAt).toBeTruthy();
  });

  test("matches rules by scope glob and returns warnings", () => {
    // Insert a policy rule
    db.run(
      `INSERT INTO policy_rules (id, rule_code, severity, trigger_kind, scope_glob, message, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "rule_001",
        "EDIT_CORE_REPO",
        "warning",
        "before_tool",
        "src/core/**/*.ts",
        "Editing core repository files requires careful review",
        "2026-03-29T00:00:00.000Z",
        "2026-03-29T00:00:00.000Z",
      ]
    );

    const result = engine.evaluate({
      lifecycleTrigger: "before_tool",
      scopeRef: "src/core/repo.ts",
    });

    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toEqual({
      ruleCode: "EDIT_CORE_REPO",
      severity: "warning",
      scopeGlob: "src/core/**/*.ts",
      scopeRef: "src/core/repo.ts",
      triggerKind: "before_tool",
      message: "Editing core repository files requires careful review",
    });
  });

  test("filters rules by lifecycle trigger", () => {
    // Insert rules for different triggers
    db.run(
      `INSERT INTO policy_rules (id, rule_code, severity, trigger_kind, scope_glob, message, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "rule_001",
        "BEFORE_TOOL_RULE",
        "warning",
        "before_tool",
        "src/**/*.ts",
        "Before tool message",
        "2026-03-29T00:00:00.000Z",
        "2026-03-29T00:00:00.000Z",
      ]
    );
    db.run(
      `INSERT INTO policy_rules (id, rule_code, severity, trigger_kind, scope_glob, message, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "rule_002",
        "BEFORE_MODEL_RULE",
        "info",
        "before_model",
        "src/**/*.ts",
        "Before model message",
        "2026-03-29T00:00:00.000Z",
        "2026-03-29T00:00:00.000Z",
      ]
    );

    const beforeToolResult = engine.evaluate({
      lifecycleTrigger: "before_tool",
      scopeRef: "src/memory/repo.ts",
    });

    expect(beforeToolResult.warnings).toHaveLength(1);
    expect(beforeToolResult.warnings[0]?.ruleCode).toBe("BEFORE_TOOL_RULE");

    const beforeModelResult = engine.evaluate({
      lifecycleTrigger: "before_model",
      scopeRef: "src/memory/repo.ts",
    });

    expect(beforeModelResult.warnings).toHaveLength(1);
    expect(beforeModelResult.warnings[0]?.ruleCode).toBe("BEFORE_MODEL_RULE");
  });

  test("does not match rules with non-matching scope", () => {
    db.run(
      `INSERT INTO policy_rules (id, rule_code, severity, trigger_kind, scope_glob, message, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "rule_001",
        "DB_RULE",
        "warning",
        "before_tool",
        "src/db/**/*.ts",
        "Database file warning",
        "2026-03-29T00:00:00.000Z",
        "2026-03-29T00:00:00.000Z",
      ]
    );

    const result = engine.evaluate({
      lifecycleTrigger: "before_tool",
      scopeRef: "src/memory/repo.ts",
    });

    expect(result.warnings).toHaveLength(0);
  });

  test("returns warnings with correct severity levels", () => {
    db.run(
      `INSERT INTO policy_rules (id, rule_code, severity, trigger_kind, scope_glob, message, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "rule_001",
        "INFO_RULE",
        "info",
        "before_tool",
        "src/**/*.ts",
        "Informational message",
        "2026-03-29T00:00:00.000Z",
        "2026-03-29T00:00:00.000Z",
      ]
    );
    db.run(
      `INSERT INTO policy_rules (id, rule_code, severity, trigger_kind, scope_glob, message, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "rule_002",
        "WARNING_RULE",
        "warning",
        "before_tool",
        "src/**/*.ts",
        "Warning message",
        "2026-03-29T00:00:00.000Z",
        "2026-03-29T00:00:00.000Z",
      ]
    );

    const result = engine.evaluate({
      lifecycleTrigger: "before_tool",
      scopeRef: "src/memory/repo.ts",
    });

    expect(result.warnings).toHaveLength(2);
    const severities = result.warnings.map((w) => w.severity).sort();
    expect(severities).toEqual(["info", "warning"]);
  });

  test("returns warnings in deterministic order (created_at, id)", () => {
    db.run(
      `INSERT INTO policy_rules (id, rule_code, severity, trigger_kind, scope_glob, message, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "rule_002",
        "SECOND_RULE",
        "warning",
        "before_tool",
        "src/**/*.ts",
        "Second rule",
        "2026-03-29T00:00:01.000Z",
        "2026-03-29T00:00:01.000Z",
      ]
    );
    db.run(
      `INSERT INTO policy_rules (id, rule_code, severity, trigger_kind, scope_glob, message, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "rule_001",
        "FIRST_RULE",
        "warning",
        "before_tool",
        "src/**/*.ts",
        "First rule",
        "2026-03-29T00:00:00.000Z",
        "2026-03-29T00:00:00.000Z",
      ]
    );

    const result = engine.evaluate({
      lifecycleTrigger: "before_tool",
      scopeRef: "src/memory/repo.ts",
    });

    expect(result.warnings).toHaveLength(2);
    expect(result.warnings[0]?.ruleCode).toBe("FIRST_RULE");
    expect(result.warnings[1]?.ruleCode).toBe("SECOND_RULE");
  });

  test("normalizes scope references with backslashes", () => {
    db.run(
      `INSERT INTO policy_rules (id, rule_code, severity, trigger_kind, scope_glob, message, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "rule_001",
        "WINDOWS_PATH_RULE",
        "warning",
        "before_tool",
        "src/**/*.ts",
        "Windows path test",
        "2026-03-29T00:00:00.000Z",
        "2026-03-29T00:00:00.000Z",
      ]
    );

    const result = engine.evaluate({
      lifecycleTrigger: "before_tool",
      scopeRef: "src\\memory\\repo.ts",
    });

    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]?.scopeRef).toBe("src/memory/repo.ts");
  });
});
