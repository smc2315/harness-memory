import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { Database as SqlJsDatabase } from "sql.js";

import { ActivationEngine } from "../src/activation";
import { MemoryRepository } from "../src/memory";
import { createTestDb } from "./helpers/create-test-db";

describe("ActivationEngine", () => {
  let db: SqlJsDatabase;
  let repository: MemoryRepository;
  let engine: ActivationEngine;

  beforeEach(async () => {
    db = await createTestDb();
    repository = new MemoryRepository(db);
    engine = new ActivationEngine(repository);
  });

  afterEach(() => {
    db.close();
  });

  test("activates only active memories matching trigger and scope in stable rank order", () => {
    const highest = repository.create({
      type: "policy",
      summary: "Prefer explicit adapters",
      details: "Keep boundaries thin.",
      scopeGlob: "src/**/*.ts",
      lifecycleTriggers: ["before_model"],
      confidence: 0.9,
      importance: 0.9,
      status: "active",
      createdAt: "2026-03-28T00:00:00.000Z",
      updatedAt: "2026-03-28T00:00:00.000Z",
    });
    const second = repository.create({
      type: "workflow",
      summary: "Inspect db after migrate",
      details: "Run inspect after creating the sqlite file.",
      scopeGlob: "src/**/*.ts",
      lifecycleTriggers: ["before_model"],
      confidence: 0.8,
      importance: 0.8,
      status: "active",
      createdAt: "2026-03-28T00:10:00.000Z",
      updatedAt: "2026-03-28T00:10:00.000Z",
    });
    repository.create({
      type: "pitfall",
      summary: "Do not amend pushed commits",
      details: "Force-push risk is too high.",
      scopeGlob: "src/**/*.ts",
      lifecycleTriggers: ["before_tool"],
      status: "active",
      createdAt: "2026-03-28T00:20:00.000Z",
      updatedAt: "2026-03-28T00:20:00.000Z",
    });
    repository.create({
      type: "decision",
      summary: "Keep manual promotion in MVP",
      details: "Candidate memories stay inactive until reviewed.",
      scopeGlob: "src/**/*.ts",
      lifecycleTriggers: ["before_model"],
      status: "stale",
      createdAt: "2026-03-28T00:30:00.000Z",
      updatedAt: "2026-03-28T00:30:00.000Z",
    });

    const result = engine.activate({
      lifecycleTrigger: "before_model",
      scopeRef: "src/memory/repository.ts",
    });

    expect(result.activated.map((memory) => memory.id)).toEqual([
      highest.id,
      second.id,
    ]);
    expect(result.activated.map((memory) => memory.rank)).toEqual([1, 2]);
    expect(result.suppressed.map((entry) => entry.kind).sort()).toEqual([
      "status_inactive",
      "trigger_mismatch",
    ]);
  });

  test("suppresses non-matching scopes with explicit reasons", () => {
    repository.create({
      type: "workflow",
      summary: "Inspect db after migrate",
      details: "Run inspect after creating the sqlite file.",
      scopeGlob: "src/db/**/*.ts",
      lifecycleTriggers: ["before_model"],
      status: "active",
      createdAt: "2026-03-28T00:00:00.000Z",
      updatedAt: "2026-03-28T00:00:00.000Z",
    });

    const result = engine.activate({
      lifecycleTrigger: "before_model",
      scopeRef: "src/memory/repository.ts",
    });

    expect(result.activated).toHaveLength(0);
    expect(result.suppressed).toHaveLength(1);
    expect(result.suppressed[0]?.kind).toBe("scope_mismatch");
    expect(result.suppressed[0]?.reason).toContain("does not match");
  });

  test("enforces memory count and payload budgets deterministically", () => {
    const first = repository.create({
      type: "policy",
      summary: "A",
      details: "A detail that fits the budget.",
      scopeGlob: "src/**/*.ts",
      lifecycleTriggers: ["before_model"],
      confidence: 1,
      importance: 1,
      status: "active",
      createdAt: "2026-03-28T00:00:00.000Z",
      updatedAt: "2026-03-28T00:00:00.000Z",
    });
    const second = repository.create({
      type: "workflow",
      summary: "B",
      details: "B detail that also fits the budget.",
      scopeGlob: "src/**/*.ts",
      lifecycleTriggers: ["before_model"],
      confidence: 0.8,
      importance: 0.8,
      status: "active",
      createdAt: "2026-03-28T00:10:00.000Z",
      updatedAt: "2026-03-28T00:10:00.000Z",
    });

    const countLimited = engine.activate({
      lifecycleTrigger: "before_model",
      scopeRef: "src/memory/repository.ts",
      maxMemories: 1,
      maxPayloadBytes: 10_000,
    });
    expect(countLimited.activated.map((memory) => memory.id)).toEqual([first.id]);
    expect(countLimited.suppressed[0]?.kind).toBe("budget_limit");

    const payloadLimited = engine.activate({
      lifecycleTrigger: "before_model",
      scopeRef: "src/memory/repository.ts",
      maxMemories: 5,
      maxPayloadBytes: 10,
    });
    expect(payloadLimited.activated).toHaveLength(0);
    expect(payloadLimited.suppressed.map((entry) => entry.kind)).toEqual([
      "budget_limit",
      "budget_limit",
    ]);
    expect(payloadLimited.budget.usedPayloadBytes).toBe(0);
    expect(second.id).toBeTruthy();
  });
});
