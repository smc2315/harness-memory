/**
 * derivePolicyRules (spec §10): the derived rows equal derive(active policies) after every call,
 * manual rules survive, and a confirm policy with a path signature becomes a confirm rule.
 */

import { beforeEach, describe, expect, test } from "vitest";
import type { Database as SqlJsDatabase } from "sql.js";

import { selectAll } from "../src/db/sql";
import { MemoryRepository } from "../src/memory/repository";
import { derivePolicyRules, derivedRuleCode, derivedRulesConsistent, expectedDerivedRules, readDerivedRules, rulesForMemory } from "../src/policy/derive";
import { transitionMemory } from "../src/promotion/transitions";
import { createTestDb } from "./helpers/create-test-db";
import { T0, autoMemory, humanMemory } from "./helpers/memory-fixtures";

let db: SqlJsDatabase;
let memories: MemoryRepository;

beforeEach(async () => {
  db = await createTestDb({ now: T0 });
  memories = new MemoryRepository(db, { clock: () => T0 });
});

describe("derivePolicyRules", () => {
  test("NO_COMMIT_SECRETS-style policy yields one confirm rule per trigger with the signature fields", () => {
    const policy = memories.create(
      humanMemory({
        type: "policy",
        summary: "Never commit .env files",
        details: "Secrets live in the vault; .env files must not be written or edited.",
        scopeGlob: "**/*",
        lifecycleTriggers: ["before_tool", "before_model"],
        policySubtype: "hard",
        enforcement: "confirm",
        triggerSignature: { tool: "write|edit", target: "path", pattern_kind: "glob", pattern: "**/.env*" },
      })
    );
    const result = derivePolicyRules(db, { now: T0 });
    expect(result.inserted).toBe(2);
    const rows = readDerivedRules(db);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.ruleCode).sort()).toEqual([derivedRuleCode(policy.id, "before_model"), derivedRuleCode(policy.id, "before_tool")].sort());
    const beforeTool = rows.find((row) => row.triggerKind === "before_tool")!;
    expect(beforeTool).toMatchObject({
      memoryId: policy.id,
      severity: "warning",
      scopeGlob: "**/*",
      toolPattern: "write|edit",
      targetKind: "path",
      patternKind: "glob",
      argPattern: "**/.env*",
      enforcement: "confirm",
    });
    expect(beforeTool.message.startsWith("Never commit .env files — Secrets live")).toBe(true);
    expect(derivedRulesConsistent(db)).toBe(true);
  });

  test("manual rules are preserved; derived rows follow status changes (invariant)", () => {
    db.run(
      `INSERT INTO policy_rules (id, memory_id, rule_code, severity, trigger_kind, scope_glob, message, created_at, updated_at)
       VALUES ('manual-1', NULL, 'MANUAL-1', 'info', 'before_model', '**/*', 'hand-written rule', ?, ?)`,
      [T0, T0]
    );
    const active = memories.create(humanMemory({ type: "policy", summary: "Active policy", relevantTools: ["bash", "edit"] }));
    const candidate = memories.create(autoMemory({ type: "policy", summary: "Candidate policy" }));
    memories.create(humanMemory({ type: "workflow", summary: "Not a policy" }));

    derivePolicyRules(db, { now: T0 });
    expect(derivedRulesConsistent(db)).toBe(true);
    let derived = readDerivedRules(db);
    expect(derived).toHaveLength(1);
    expect(derived[0]).toMatchObject({ memoryId: active.id, toolPattern: "bash|edit", targetKind: "any", patternKind: null, argPattern: null, severity: "info", enforcement: "advise" });
    expect(selectAll(db, "SELECT rule_code FROM policy_rules WHERE derived_at IS NULL").map((row) => row.rule_code)).toEqual(["MANUAL-1"]);

    transitionMemory(db, { memoryId: candidate.id, to: "active", actor: "human", reason: "test", now: T0 });
    expect(derivedRulesConsistent(db)).toBe(false);
    derivePolicyRules(db, { now: T0 });
    expect(derivedRulesConsistent(db)).toBe(true);
    derived = readDerivedRules(db);
    expect(derived.map((row) => row.memoryId).sort()).toEqual([active.id, candidate.id].sort());

    transitionMemory(db, { memoryId: active.id, to: "stale", actor: "human", reason: "test", now: T0 });
    const again = derivePolicyRules(db, { now: T0 });
    expect(again.deleted).toBe(2);
    expect(again.inserted).toBe(1);
    expect(readDerivedRules(db).map((row) => row.memoryId)).toEqual([candidate.id]);
    expect(selectAll(db, "SELECT COUNT(*) AS n FROM policy_rules WHERE derived_at IS NULL")[0]?.n).toBe(1);
    expect(expectedDerivedRules(db)).toHaveLength(1);
  });

  test("rulesForMemory is empty for non-policy or non-active rows and repeatable", () => {
    const workflow = memories.create(humanMemory({ type: "workflow" }));
    const candidate = memories.create(autoMemory({ type: "policy" }));
    expect(rulesForMemory(workflow)).toEqual([]);
    expect(rulesForMemory(candidate)).toEqual([]);
    derivePolicyRules(db, { now: T0 });
    const first = readDerivedRules(db);
    derivePolicyRules(db, { now: "2026-11-09T00:00:00.000Z" });
    expect(readDerivedRules(db)).toEqual(first);
  });
});
