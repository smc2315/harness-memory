import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { Database as SqlJsDatabase } from "sql.js";
import { MemoryRepository } from "../src/memory";
import { createTestDb } from "./helpers/create-test-db";

describe("memory:export-skill", () => {
  let db: SqlJsDatabase;
  let repository: MemoryRepository;

  beforeEach(async () => {
    db = await createTestDb();
    repository = new MemoryRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  test("filters active memories by confidence and importance thresholds", () => {
    repository.create({
      type: "workflow",
      summary: "High quality workflow",
      details: "Very mature.",
      scopeGlob: "**/*",
      lifecycleTriggers: ["before_model"],
      status: "active",
      confidence: 0.9,
      importance: 0.8,
    });
    repository.create({
      type: "pitfall",
      summary: "Low confidence pitfall",
      details: "Not ready.",
      scopeGlob: "src/**",
      lifecycleTriggers: ["before_tool"],
      status: "active",
      confidence: 0.3,
      importance: 0.2,
    });
    repository.create({
      type: "policy",
      summary: "Candidate policy",
      details: "Still candidate.",
      scopeGlob: "**/*",
      lifecycleTriggers: ["session_start"],
      status: "candidate",
      confidence: 0.95,
      importance: 0.9,
    });

    const allActive = repository.list({ status: "active" });
    const exportable = allActive.filter(
      (memory) => memory.confidence >= 0.8 && memory.importance >= 0.5,
    );

    expect(exportable).toHaveLength(1);
    expect(exportable[0].summary).toBe("High quality workflow");
  });

  test("generates valid SKILL.md frontmatter format", () => {
    const memory = repository.create({
      type: "workflow",
      summary: "Run tests before commit",
      details: "Always execute the full test suite before creating a commit.",
      scopeGlob: "**/*",
      lifecycleTriggers: ["before_tool"],
      relevantTools: ["bash"],
      status: "active",
      confidence: 0.9,
      importance: 0.85,
    });

    const content = [
      "---",
      'name: "run-tests-before-commit"',
      `description: "${memory.summary}"`,
      "version: 1.0.0",
      "metadata:",
      "  source: harness-memory",
      `  memory_id: "${memory.id}"`,
      `  memory_type: "${memory.type}"`,
      `  confidence: ${memory.confidence}`,
      `  importance: ${memory.importance}`,
      `  scope_glob: "${memory.scopeGlob}"`,
      `  activation_class: "${memory.activationClass}"`,
      '  lifecycle_triggers: ["before_tool"]',
      '  relevant_tools: ["bash"]',
      "---",
      "",
      `# ${memory.summary}`,
      "",
      "## Details",
      "",
      memory.details,
      "",
    ].join("\n");

    expect(content).toContain("---");
    expect(content).toContain("name:");
    expect(content).toContain("source: harness-memory");
    expect(content).toContain("# Run tests before commit");
    expect(content).toContain("## Details");
    expect(content).toContain("relevant_tools:");
  });

  test("batch export returns multiple memories", () => {
    repository.create({
      type: "workflow",
      summary: "Mature workflow A",
      details: "Details A.",
      scopeGlob: "**/*",
      lifecycleTriggers: ["before_model"],
      status: "active",
      confidence: 0.9,
      importance: 0.8,
    });
    repository.create({
      type: "policy",
      summary: "Mature policy B",
      details: "Details B.",
      scopeGlob: "**/*",
      lifecycleTriggers: ["session_start"],
      status: "active",
      confidence: 0.85,
      importance: 0.7,
    });

    const exportable = repository
      .list({ status: "active" })
      .filter((memory) => memory.confidence >= 0.8 && memory.importance >= 0.5);

    expect(exportable).toHaveLength(2);
  });
});
