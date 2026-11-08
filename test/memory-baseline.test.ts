import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { Database as SqlJsDatabase } from "sql.js";

import { MemoryRepository } from "../src/memory";
import { transitionMemory } from "../src/promotion";
import { createTestDb } from "./helpers/create-test-db";

const NOW = "2026-11-08T12:00:00.000Z";

describe("memory:baseline behavior", () => {
  let db: SqlJsDatabase;
  let repository: MemoryRepository;

  beforeEach(async () => {
    db = await createTestDb();
    repository = new MemoryRepository(db, { clock: () => NOW });
  });

  afterEach(() => {
    db.close();
  });

  test("sets activation_class to baseline on active memory", () => {
    const memory = repository.create({
      type: "policy",
      summary: "Critical policy",
      details: "Always enforce this.",
      scopeGlob: "**/*",
      lifecycleTriggers: ["session_start", "before_model"],
      status: "active",
      activationClass: "scoped",
      authority: "human",
      sourceKind: "manual",
    });
    const updated = repository.update(memory.id, { activationClass: "baseline" });
    expect(updated?.activationClass).toBe("baseline");
  });

  test("sets activation_class to startup on candidate memory", () => {
    const memory = repository.create({
      type: "workflow",
      summary: "Common workflow",
      details: "Frequently used.",
      scopeGlob: "src/**",
      lifecycleTriggers: ["before_model"],
      status: "candidate",
      authority: "human",
      sourceKind: "manual",
    });
    const updated = repository.update(memory.id, { activationClass: "startup" });
    expect(updated?.activationClass).toBe("startup");
  });

  test("promote goes through transitionMemory and the class through update", () => {
    const memory = repository.create({
      type: "pitfall",
      summary: "Watch out",
      details: "Careful here.",
      scopeGlob: "**/*",
      lifecycleTriggers: ["before_tool"],
      status: "candidate",
      authority: "auto",
      sourceKind: "extraction",
    });
    const promoted = transitionMemory(db, {
      memoryId: memory.id,
      to: "active",
      actor: "human",
      reason: "cli:memory:promote",
      now: NOW,
    });
    const updated = repository.update(memory.id, { activationClass: "baseline", updatedAt: NOW });

    expect(promoted.status).toBe("active");
    expect(promoted.authority).toBe("human");
    expect(promoted.lastVerifiedAt).toBe(NOW);
    expect(updated?.status).toBe("active");
    expect(updated?.activationClass).toBe("baseline");
  });
});
