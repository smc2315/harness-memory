import { describe, expect, test } from "vitest";
import initSqlJs from "sql.js";

import {
  DEFAULT_SKILL_EXPORT_THRESHOLDS,
  SKILL_NAME_MAX_CHARS,
  escapeSqlString,
  formatSkillMarkdown,
  formatSqlValue,
  isExportableSkill,
  quoteSqlIdentifier,
  renderSqlDump,
  selectExportableSkills,
  skillFileName,
  skillName,
  type SkillExportMemory,
} from "../src/cli/lib/export";
import { TARGET_USER_VERSION } from "../src/core/paths";
import { createTestDb } from "./helpers/create-test-db";

function memoryFixture(overrides: Partial<SkillExportMemory> = {}): SkillExportMemory {
  return {
    id: "mem_fixture_001",
    type: "workflow",
    status: "active",
    summary: "Run tests before commit",
    details: "Always execute the full test suite before creating a commit.",
    scopeGlob: "**/*",
    activationClass: "scoped",
    lifecycleTriggers: ["before_tool"],
    relevantTools: ["bash"],
    confidence: 0.9,
    importance: 0.85,
    ...overrides,
  };
}

describe("cli/lib/export: skill selection", () => {
  test("filters active memories by confidence and importance thresholds", () => {
    const memories = [
      memoryFixture({ id: "mem_high", summary: "High quality workflow", confidence: 0.9, importance: 0.8 }),
      memoryFixture({
        id: "mem_low",
        type: "pitfall",
        summary: "Low confidence pitfall",
        scopeGlob: "src/**",
        confidence: 0.3,
        importance: 0.2,
      }),
      memoryFixture({
        id: "mem_candidate",
        type: "policy",
        status: "candidate",
        summary: "Candidate policy",
        lifecycleTriggers: ["session_start"],
        confidence: 0.95,
        importance: 0.9,
      }),
    ];

    const exportable = selectExportableSkills(memories);

    expect(exportable.map((memory) => memory.id)).toEqual(["mem_high"]);
  });

  test("thresholds are inclusive and configurable", () => {
    const edge = memoryFixture({ confidence: 0.8, importance: 0.5 });

    expect(DEFAULT_SKILL_EXPORT_THRESHOLDS).toEqual({ minConfidence: 0.8, minImportance: 0.5 });
    expect(isExportableSkill(edge)).toBe(true);
    expect(isExportableSkill(edge, { minConfidence: 0.81, minImportance: 0.5 })).toBe(false);
    expect(isExportableSkill(edge, { minConfidence: 0.8, minImportance: 0.51 })).toBe(false);
    expect(isExportableSkill({ ...edge, status: "stale" })).toBe(false);
  });

  test("batch selection keeps every qualifying memory", () => {
    const memories = [
      memoryFixture({ id: "mem_a", summary: "Mature workflow A", confidence: 0.9, importance: 0.8 }),
      memoryFixture({
        id: "mem_b",
        type: "policy",
        summary: "Mature policy B",
        lifecycleTriggers: ["session_start"],
        confidence: 0.85,
        importance: 0.7,
      }),
    ];

    expect(selectExportableSkills(memories)).toHaveLength(2);
  });
});

describe("cli/lib/export: SKILL.md rendering", () => {
  test("generates frontmatter and a Markdown body", () => {
    const memory = memoryFixture();

    const content = formatSkillMarkdown(memory);
    const lines = content.split("\n");

    expect(lines[0]).toBe("---");
    expect(lines).toContain('name: "run-tests-before-commit"');
    expect(lines).toContain('description: "Run tests before commit"');
    expect(lines).toContain("version: 1.0.0");
    expect(lines).toContain("  source: harness-memory");
    expect(lines).toContain('  memory_id: "mem_fixture_001"');
    expect(lines).toContain('  memory_type: "workflow"');
    expect(lines).toContain("  confidence: 0.9");
    expect(lines).toContain("  importance: 0.85");
    expect(lines).toContain('  scope_glob: "**/*"');
    expect(lines).toContain('  activation_class: "scoped"');
    expect(lines).toContain('  lifecycle_triggers: ["before_tool"]');
    expect(lines).toContain('  relevant_tools: ["bash"]');
    expect(content).toContain("---\n\n# Run tests before commit\n\n## Details\n\n");
    expect(content.endsWith(`${memory.details}\n`)).toBe(true);
  });

  test("omits relevant_tools when null and escapes quotes and backslashes", () => {
    const content = formatSkillMarkdown(
      memoryFixture({
        summary: 'Prefer "double" quotes in C:\\paths',
        relevantTools: null,
        lifecycleTriggers: ["before_model", "session_start"],
      })
    );

    expect(content).not.toContain("relevant_tools:");
    expect(content).toContain('description: "Prefer \\"double\\" quotes in C:\\\\paths"');
    expect(content).toContain('  lifecycle_triggers: ["before_model", "session_start"]');
    expect(content).toContain('# Prefer "double" quotes in C:\\paths');
  });

  test("skillName slugifies, caps the length and falls back for non-ASCII summaries", () => {
    expect(skillName(memoryFixture({ summary: "  Run Tests -- Before Commit!! " }))).toBe("run-tests-before-commit");
    expect(skillFileName(memoryFixture({ summary: "Run tests before commit" }))).toBe("run-tests-before-commit.md");

    const long = skillName(memoryFixture({ summary: "word ".repeat(40) }));
    expect(long.length).toBeLessThanOrEqual(SKILL_NAME_MAX_CHARS);
    expect(long.endsWith("-")).toBe(false);

    expect(skillName(memoryFixture({ id: "mem_ko", summary: "커밋 전에 테스트 실행" }))).toBe("memory-mem_ko");
    expect(skillFileName(memoryFixture({ id: "mem_ko", summary: "커밋 전에 테스트 실행" }))).toBe("memory-mem_ko.md");
  });
});

describe("cli/lib/export: SQL dump", () => {
  test("formatSqlValue renders SQL literals", () => {
    expect(formatSqlValue(null)).toBe("NULL");
    expect(formatSqlValue(undefined)).toBe("NULL");
    expect(formatSqlValue(42)).toBe("42");
    expect(formatSqlValue(0.5)).toBe("0.5");
    expect(formatSqlValue(Number.NaN)).toBe("NULL");
    expect(formatSqlValue(Number.POSITIVE_INFINITY)).toBe("NULL");
    expect(formatSqlValue("it's")).toBe("'it''s'");
    expect(formatSqlValue(true)).toBe("1");
    expect(formatSqlValue(false)).toBe("0");
    expect(formatSqlValue(new Uint8Array([0, 255, 16]))).toBe("X'00ff10'");
    expect(escapeSqlString("a'b")).toBe("'a''b'");
    expect(quoteSqlIdentifier('we"ird')).toBe('"we""ird"');
  });

  test("renderSqlDump produces a transaction that reloads into an empty database", async () => {
    const db = await createTestDb();
    const probeValue = `it's "quoted"`;

    try {
      db.run("INSERT INTO meta (key, value) VALUES ('export_probe', $value)", { $value: probeValue });
      db.run(
        "INSERT INTO write_ops (id, kind, generation, applied_at) VALUES ('op-1', 'run', 1, '2026-11-08T00:00:00.000Z')"
      );

      const dump = renderSqlDump(db);
      const lines = dump.split("\n");

      expect(lines[0]).toBe("BEGIN TRANSACTION;");
      expect(lines[lines.length - 2]).toBe(`PRAGMA user_version = ${TARGET_USER_VERSION};`);
      expect(lines[lines.length - 1]).toBe("COMMIT;");
      expect(dump).toContain(`INSERT INTO "meta" VALUES ('db_generation', '0');`);
      expect(dump).toContain(`INSERT INTO "meta" VALUES ('export_probe', 'it''s "quoted"');`);
      expect(dump).toContain(`INSERT INTO "write_ops" VALUES ('op-1', 'run', 1, '2026-11-08T00:00:00.000Z');`);
      expect(dump).not.toContain("sqlite_sequence");

      // Identical databases produce identical bytes (spec §13.2 (d) relies on this for memory:export).
      expect(renderSqlDump(db)).toBe(dump);

      const SQL = await initSqlJs();
      const copy = new SQL.Database();

      try {
        copy.run("PRAGMA foreign_keys = OFF");
        copy.exec(dump);

        const version = copy.exec("PRAGMA user_version")[0]?.values[0]?.[0];
        expect(version).toBe(TARGET_USER_VERSION);

        const probe = copy.exec("SELECT value FROM meta WHERE key = 'export_probe'")[0]?.values[0]?.[0];
        expect(probe).toBe(probeValue);

        const ops = copy.exec("SELECT COUNT(*) FROM write_ops")[0]?.values[0]?.[0];
        expect(ops).toBe(1);

        const countTablesSql =
          "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'";
        expect(copy.exec(countTablesSql)[0]?.values[0]?.[0]).toBe(db.exec(countTablesSql)[0]?.values[0]?.[0]);
      } finally {
        copy.close();
      }
    } finally {
      db.close();
    }
  });
});
