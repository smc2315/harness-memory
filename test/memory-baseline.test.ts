import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { Database as SqlJsDatabase } from "sql.js";
import { MemoryRepository } from "../src/memory";
import { createTestDb } from "./helpers/create-test-db";

describe("memory:baseline behavior", () => {
  let db: SqlJsDatabase;
  let repository: MemoryRepository;

  beforeEach(async () => {
    db = await createTestDb();
    repository = new MemoryRepository(db);
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
    });
    const updated = repository.update(memory.id, { activationClass: "startup" });
    expect(updated?.activationClass).toBe("startup");
  });

  test("promote with activation_class sets both status and class", () => {
    const memory = repository.create({
      type: "pitfall",
      summary: "Watch out",
      details: "Careful here.",
      scopeGlob: "**/*",
      lifecycleTriggers: ["before_tool"],
      status: "candidate",
    });
    const updated = repository.update(memory.id, {
      status: "active",
      activationClass: "baseline",
      updatedAt: new Date().toISOString(),
      lastVerifiedAt: new Date().toISOString(),
    });
    expect(updated?.status).toBe("active");
    expect(updated?.activationClass).toBe("baseline");
  });
});
