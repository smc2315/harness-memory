/**
 * Operations suite (spec §13.4): snapshot unreachable invariant and policy_rules derived invariant.
 *   - every active row is either in the snapshot (and reachable by a hooked trigger) or counted in
 *     `counts.unreachable`; nothing non-active ever appears; the build is deterministic;
 *   - after every Store write the derived policy rules equal derive(active policies), manual rules survive,
 *     and the snapshot's `rules` mirror the table.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { Database as SqlJsDatabase } from "sql.js";

import { DEFAULT_CONFIG } from "../src/core/config";
import { resolvePaths, stateDirectories, type HarnessPaths } from "../src/core/paths";
import type { ActiveSnapshot } from "../src/core/snapshot-types";
import { selectAll } from "../src/db/sql";
import { buildSnapshot, buildSnapshotData } from "../src/db/snapshot";
import { composeStore, silentWorkerLogger } from "../src/dream/worker";
import { MemoryRepository } from "../src/memory/repository";
import { derivePolicyRules, derivedRulesConsistent, expectedDerivedRules, readDerivedRules } from "../src/policy/derive";
import { isReachableTrigger } from "../src/promotion/authority";
import { transitionMemory } from "../src/promotion/transitions";
import { createTestDb } from "./helpers/create-test-db";
import { T0, autoMemory, humanMemory } from "./helpers/memory-fixtures";

let root: string;
let paths: HarnessPaths;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "hm-ops-snap-"));
  paths = resolvePaths(root);
  for (const dir of stateDirectories(paths)) mkdirSync(dir, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function activeIds(db: SqlJsDatabase): string[] {
  return selectAll(db, "SELECT id FROM memories WHERE status = 'active' ORDER BY id").map((row) => String(row.id));
}

/** The invariant every snapshot build must satisfy, checked against the database it was built from. */
function assertSnapshotInvariant(db: SqlJsDatabase, snapshot: ActiveSnapshot, unreachable: readonly { id: string }[]): void {
  const inSnapshot = snapshot.memories.map((memory) => memory.id).sort();
  const excluded = unreachable.map((entry) => entry.id).sort();
  expect(snapshot.counts.unreachable).toBe(unreachable.length);
  expect(snapshot.counts.active).toBe(snapshot.memories.length);
  expect([...inSnapshot, ...excluded].sort()).toEqual(activeIds(db));
  expect(inSnapshot.filter((id) => excluded.includes(id))).toEqual([]);
  for (const memory of snapshot.memories) {
    expect(memory.status).toBe("active");
    expect(isReachableTrigger({ type: memory.type, hasSignature: memory.signature !== null, signatureTool: memory.signature?.tool ?? null, lifecycleTriggers: memory.lifecycle_triggers })).toBe(true);
  }
  const rows = selectAll(db, "SELECT id, status FROM memories");
  for (const row of rows) {
    if (row.status !== "active") expect(inSnapshot).not.toContain(String(row.id));
  }
}

describe("snapshot unreachable invariant", () => {
  test("active rows are partitioned into reachable (in the snapshot) and unreachable (counted); non-active rows never appear; the build is deterministic", async () => {
    const db = await createTestDb({ now: T0 });
    const memories = new MemoryRepository(db, { clock: () => T0 });
    // reachable
    memories.create(autoMemory({ status: "active", summary: "Reachable cmd pitfall", triggerSignature: { tool: "bash", target: "command", pattern_kind: "cmd", pattern: "npm test" }, signatureKey: "bash|command|cmd|pm test" }));
    memories.create(humanMemory({ type: "policy", summary: "Signature-less policy on before_tool (reachable: policy)", lifecycleTriggers: ["before_tool"] }));
    memories.create(humanMemory({ type: "workflow", summary: "Workflow on before_model", lifecycleTriggers: ["before_model"] }));
    memories.create(humanMemory({ type: "pitfall", summary: "Path policy via write|edit glob", lifecycleTriggers: ["before_tool"], triggerSignature: { tool: "write|edit", target: "path", pattern_kind: "glob", pattern: "**/.env*" } }));
    // unreachable
    const unreachableWorkflow = memories.create(autoMemory({ type: "workflow", status: "active", summary: "Workflow before_tool-only without a signature", lifecycleTriggers: ["before_tool"], knowledgeKind: "convention" }));
    const readTool = memories.create(autoMemory({ status: "active", summary: "Signature on a tool that never reaches PreToolUse", lifecycleTriggers: ["before_tool"], triggerSignature: { tool: "read", target: "path", pattern_kind: "glob", pattern: "docs/**/*.md" }, knowledgeKind: "convention" }));
    const brokenRegex = memories.create(humanMemory({ type: "workflow", summary: "Workflow whose only trigger is a regex that no longer compiles", lifecycleTriggers: ["before_tool"], triggerSignature: { tool: "bash", target: "command", pattern_kind: "regex", pattern: "(a+)+$" } }));
    // non-active
    memories.create(autoMemory({ summary: "Candidate stays out" }));
    const stale = memories.create(autoMemory({ status: "active", summary: "Will be stale", triggerSignature: { tool: "bash", target: "command", pattern_kind: "cmd", pattern: "npm run stale" }, signatureKey: "bash|command|cmd|pm stale" }));
    transitionMemory(db, { memoryId: stale.id, to: "stale", actor: "human", reason: "test", now: T0 });

    const first = buildSnapshot(db, paths, { now: T0, config: DEFAULT_CONFIG });
    assertSnapshotInvariant(db, first.active, first.unreachable);
    expect(first.unreachable.map((entry) => entry.id).sort()).toEqual([unreachableWorkflow.id, readTool.id, brokenRegex.id].sort());
    // A signature that no longer compiles is dropped first; with no other trigger left the row is excluded as signature_invalid.
    expect(first.unreachable.find((entry) => entry.id === brokenRegex.id)?.reason).toBe("signature_invalid");
    expect(first.unreachable.find((entry) => entry.id === unreachableWorkflow.id)?.reason).toBe("trigger_unreachable");
    expect(first.signatureDropped).toEqual([brokenRegex.id]);
    expect(first.active.counts.active).toBe(4);
    expect(first.active.counts.candidates).toBe(1);

    const onDisk = JSON.parse(readFileSync(paths.snapshotActive, "utf8")) as ActiveSnapshot;
    expect(onDisk.counts).toEqual(first.active.counts);
    expect(onDisk.memories.map((memory) => memory.id)).toEqual(first.active.memories.map((memory) => memory.id));

    const second = buildSnapshotData(db, paths, { now: T0, config: DEFAULT_CONFIG });
    expect(JSON.stringify({ ...second.active, source: null })).toBe(JSON.stringify({ ...first.active, source: null }));

    // Making an unreachable row reachable (adding before_model) moves it into the snapshot; dropping a trigger moves it out.
    memories.update(unreachableWorkflow.id, { lifecycleTriggers: ["before_tool", "before_model"] });
    const third = buildSnapshotData(db, paths, { now: T0, config: DEFAULT_CONFIG });
    assertSnapshotInvariant(db, third.active, third.unreachable);
    expect(third.active.memories.map((memory) => memory.id)).toContain(unreachableWorkflow.id);
    expect(third.unreachable).toHaveLength(2);
    db.close();
  });
});

describe("policy_rules derived invariant through the Store", () => {
  test("every write re-derives the rules; manual rules survive; the snapshot mirrors the table; demotion removes them", async () => {
    const config = structuredClone(DEFAULT_CONFIG);
    writeFileSync(paths.config, JSON.stringify(config), "utf8");
    const store = composeStore({ paths, config, logger: silentWorkerLogger, clock: () => T0 });
    let policyId = "";
    await store.withWriteLock("seed", 5_000, (db) => {
      db.run(
        `INSERT INTO policy_rules (id, memory_id, rule_code, severity, trigger_kind, scope_glob, message, created_at, updated_at)
         VALUES ('manual-1', NULL, 'MANUAL-1', 'info', 'before_model', '**/*', 'hand-written rule', ?, ?)`,
        [T0, T0]
      );
      const memories = new MemoryRepository(db, { clock: () => T0 });
      const policy = memories.create(
        humanMemory({
          type: "policy",
          summary: "Never commit .env files",
          details: "Secrets live in the vault.",
          scopeGlob: "**/*",
          lifecycleTriggers: ["before_tool", "before_model"],
          policySubtype: "hard",
          enforcement: "confirm",
          triggerSignature: { tool: "write|edit", target: "path", pattern_kind: "glob", pattern: "**/.env*" },
        })
      );
      policyId = policy.id;
      memories.create(autoMemory({ type: "policy", summary: "A candidate policy yields no rule" }));
      memories.create(humanMemory({ type: "workflow", summary: "Not a policy" }));
      // Rules are derived by the Store AFTER this callback, so inside it the table is still inconsistent.
      expect(derivedRulesConsistent(db)).toBe(false);
      return { id: "seed:1", kind: "seed", noop: false, wrote: true };
    });

    const readState = () =>
      store.read((db) => ({
        consistent: derivedRulesConsistent(db),
        derived: readDerivedRules(db).map((rule) => ({ memoryId: rule.memoryId, triggerKind: rule.triggerKind, ruleCode: rule.ruleCode, enforcement: rule.enforcement })),
        expected: expectedDerivedRules(db).length,
        manual: selectAll(db, "SELECT rule_code FROM policy_rules WHERE derived_at IS NULL").map((row) => String(row.rule_code)),
      }));
    const snapshotRules = () => (JSON.parse(readFileSync(paths.snapshotActive, "utf8")) as ActiveSnapshot).rules;

    let state = await readState();
    expect(state.consistent).toBe(true);
    expect(state.derived.map((rule) => rule.triggerKind).sort()).toEqual(["before_model", "before_tool"]);
    expect(state.derived.every((rule) => rule.memoryId === policyId && rule.enforcement === "confirm")).toBe(true);
    expect(state.manual).toEqual(["MANUAL-1"]);
    let rules = snapshotRules();
    expect(rules.map((rule) => rule.rule_code).sort()).toEqual([...state.derived.map((rule) => rule.ruleCode), "MANUAL-1"].sort());
    expect(rules.find((rule) => rule.rule_code !== "MANUAL-1")).toMatchObject({ memory_id: policyId, tool_pattern: "write|edit", target_kind: "path", pattern_kind: "glob", arg_pattern: "**/.env*", enforcement: "confirm" });

    // Demote the policy: the derived rows disappear, the manual rule stays.
    await store.withWriteLock("demote", 5_000, (db, ctx) => {
      transitionMemory(db, { memoryId: policyId, to: "stale", actor: "human", reason: "ops test", now: ctx.now });
      return { id: "demote:1", kind: "demote", noop: false, wrote: true };
    });
    state = await readState();
    expect(state.consistent).toBe(true);
    expect(state.derived).toEqual([]);
    expect(state.expected).toBe(0);
    expect(state.manual).toEqual(["MANUAL-1"]);
    rules = snapshotRules();
    expect(rules.map((rule) => rule.rule_code)).toEqual(["MANUAL-1"]);

    // Restore it: the rules come back identical to a direct derive on the same database.
    await store.withWriteLock("restore", 5_000, (db, ctx) => {
      transitionMemory(db, { memoryId: policyId, to: "active", actor: "human", reason: "ops test", now: ctx.now });
      return { id: "restore:1", kind: "restore", noop: false, wrote: true };
    });
    state = await readState();
    expect(state.consistent).toBe(true);
    expect(state.derived).toHaveLength(2);
    await store.read((db) => {
      const before = readDerivedRules(db).map((rule) => rule.id).sort();
      // A noop re-derivation must not change anything (idempotent for the same active set).
      derivePolicyRules(db, { now: "2026-12-01T00:00:00.000Z" });
      expect(readDerivedRules(db).map((rule) => rule.id).sort()).toEqual(before);
    });
  });
});
