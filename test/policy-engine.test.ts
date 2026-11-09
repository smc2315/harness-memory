import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { Database as SqlJsDatabase } from "sql.js";

import { compileGlobSource } from "../src/activation/signature";
import { MemoryRepository } from "../src/memory";
import { PolicyEngine, PolicyRuleRepository } from "../src/policy";
import { createTestDb } from "./helpers/create-test-db";

describe("PolicyEngine", () => {
  let db: SqlJsDatabase;
  let memoryRepository: MemoryRepository;
  let repository: PolicyRuleRepository;
  let engine: PolicyEngine;

  beforeEach(async () => {
    db = await createTestDb();
    memoryRepository = new MemoryRepository(db);
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
      enforcement: "advise",
      memoryId: null,
    });
  });

  test("matches tool_pattern against the canonical tool and carries enforcement (§10)", () => {
    db.run(
      `INSERT INTO policy_rules (id, rule_code, severity, trigger_kind, scope_glob, message, tool_pattern, enforcement, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "rule_write_env",
        "NO_COMMIT_SECRETS",
        "warning",
        "before_tool",
        "**/*",
        "Never write secrets into .env files",
        "write|edit",
        "confirm",
        "2026-03-29T00:00:00.000Z",
        "2026-03-29T00:00:00.000Z",
      ]
    );

    const bash = engine.evaluate({ lifecycleTrigger: "before_tool", scopeRef: ".env", toolName: "bash", toolTarget: "cat .env" });
    expect(bash.warnings).toHaveLength(0);

    const write = engine.evaluate({ lifecycleTrigger: "before_tool", scopeRef: ".env", toolName: "write", toolTarget: ".env" });
    expect(write.warnings).toHaveLength(1);
    expect(write.warnings[0]?.enforcement).toBe("confirm");

    // No tool in the request: only `*` rules apply.
    const noTool = engine.evaluate({ lifecycleTrigger: "before_tool", scopeRef: ".env" });
    expect(noTool.warnings).toHaveLength(0);
  });

  test("arg_pattern uses the shared signature matcher; a scope-less call matches only through the pattern", () => {
    db.run(
      `INSERT INTO policy_rules (id, rule_code, severity, trigger_kind, scope_glob, message, tool_pattern, target_kind, pattern_kind, arg_pattern, enforcement, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "rule_force_push",
        "NO_FORCE_PUSH",
        "warning",
        "before_tool",
        "src/**",
        "Do not force-push shared branches",
        "bash",
        "command",
        "cmd",
        "git push --force",
        "soft_deny",
        "2026-03-29T00:00:00.000Z",
        "2026-03-29T00:00:00.000Z",
      ]
    );

    const matching = engine.evaluate({ lifecycleTrigger: "before_tool", scopeRef: "", toolName: "bash", toolTarget: "cd src && git push --force origin main" });
    expect(matching.warnings.map((warning) => warning.ruleCode)).toEqual(["NO_FORCE_PUSH"]);
    expect(matching.warnings[0]?.enforcement).toBe("soft_deny");

    const otherCommand = engine.evaluate({ lifecycleTrigger: "before_tool", scopeRef: "", toolName: "bash", toolTarget: "git push origin main" });
    expect(otherCommand.warnings).toHaveLength(0);

    // Scope refs present but outside the rule's scope → the pattern alone does not rescue the rule.
    const outsideScope = engine.evaluate({ lifecycleTrigger: "before_tool", scopeRef: "docs/readme.md", toolName: "bash", toolTarget: "git push --force" });
    expect(outsideScope.warnings).toHaveLength(0);
  });

  test("fromSnapshotRules evaluates precompiled snapshot rules without a database", () => {
    const snapshotEngine = PolicyEngine.fromSnapshotRules([
      {
        id: "snap_1",
        rule_code: "POL-abc12345-before_tool",
        memory_id: "abc12345-0000-0000-0000-000000000000",
        severity: "warning",
        trigger_kind: "before_tool",
        scope_glob: "src/db/**",
        scope_regex: compileGlobSource("src/db/**"),
        tool_pattern: "edit|write",
        target_kind: "path",
        pattern_kind: null,
        arg_pattern: null,
        enforcement: "advise",
        message: "Database files need a migration",
      },
      {
        id: "snap_2",
        rule_code: "GLOBAL_RULE",
        memory_id: null,
        severity: "info",
        trigger_kind: "before_model",
        scope_glob: "**/*",
        scope_regex: null,
        tool_pattern: "*",
        target_kind: "any",
        pattern_kind: null,
        arg_pattern: null,
        enforcement: "advise",
        message: "Global reminder",
      },
    ]);

    const edit = snapshotEngine.evaluate({ lifecycleTrigger: "before_tool", scopeRef: "src/db/store.ts", toolName: "edit", toolTarget: "src/db/store.ts" });
    expect(edit.warnings.map((warning) => warning.ruleCode)).toEqual(["POL-abc12345-before_tool"]);
    expect(edit.warnings[0]?.memoryId).toBe("abc12345-0000-0000-0000-000000000000");

    const elsewhere = snapshotEngine.evaluate({ lifecycleTrigger: "before_tool", scopeRef: "src/memory/repo.ts", toolName: "edit", toolTarget: "src/memory/repo.ts" });
    expect(elsewhere.warnings).toHaveLength(0);

    const model = snapshotEngine.evaluate({ lifecycleTrigger: "before_model", scopeRef: "anything.ts" });
    expect(model.warnings.map((warning) => warning.ruleCode)).toEqual(["GLOBAL_RULE"]);
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

  test("ignores rules linked to non-active memories", () => {
    const staleMemory = memoryRepository.create({
      authority: "human",
      sourceKind: "manual",
      id: "mem_policy_stale",
      type: "policy",
      summary: "Legacy deployment policy",
      details: "Old deployment policy that should not fire.",
      scopeGlob: "src/**/*.ts",
      lifecycleTriggers: ["before_tool"],
      status: "stale",
      createdAt: "2026-03-29T00:00:00.000Z",
      updatedAt: "2026-03-29T00:00:00.000Z",
    });
    db.run(
      `INSERT INTO policy_rules (id, memory_id, rule_code, severity, trigger_kind, scope_glob, message, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "rule_stale_memory",
        staleMemory.id,
        "STALE_POLICY",
        "warning",
        "before_tool",
        "src/**/*.ts",
        "This stale rule should not fire",
        "2026-03-29T00:00:00.000Z",
        "2026-03-29T00:00:00.000Z",
      ]
    );

    const result = engine.evaluate({
      lifecycleTrigger: "before_tool",
      scopeRef: "src/core/repo.ts",
    });

    expect(result.warnings).toHaveLength(0);
  });
});
