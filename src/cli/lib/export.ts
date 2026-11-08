/**
 * Pure rendering helpers behind `memory:export-skill` (SKILL.md files) and `memory:export` (SQL dump).
 *
 * Salvaged in Phase A6 from the v0.5 scripts src/cli/memory-export-skill.ts and src/cli/memory-export.ts;
 * the CLI commands themselves are rebuilt in Phase C1 on top of these functions. No I/O happens here:
 * callers read the rows and write the files.
 */

import type { Database as SqlJsDatabase } from "sql.js";

// ---------------------------------------------------------------------------------------------
// SKILL.md export (`memory:export-skill`)
// ---------------------------------------------------------------------------------------------

/**
 * The slice of a memory row the SKILL.md renderer needs. Structural on purpose: a repository
 * `MemoryRecord` satisfies it, but this module does not depend on the record's full shape.
 */
export interface SkillExportMemory {
  id: string;
  type: string;
  status: string;
  summary: string;
  details: string;
  scopeGlob: string;
  activationClass: string;
  lifecycleTriggers: readonly string[];
  relevantTools: readonly string[] | null;
  confidence: number;
  importance: number;
}

export interface SkillExportThresholds {
  /** Inclusive lower bound on `confidence`. */
  minConfidence: number;
  /** Inclusive lower bound on `importance`. */
  minImportance: number;
}

export const DEFAULT_SKILL_EXPORT_THRESHOLDS: Readonly<SkillExportThresholds> = {
  minConfidence: 0.8,
  minImportance: 0.5,
};

export const SKILL_NAME_MAX_CHARS = 60;

type SkillSelectionInput = Pick<SkillExportMemory, "status" | "confidence" | "importance">;

/** Only mature (confidence/importance above the thresholds), active memories become skills. */
export function isExportableSkill(
  memory: SkillSelectionInput,
  thresholds: Readonly<SkillExportThresholds> = DEFAULT_SKILL_EXPORT_THRESHOLDS
): boolean {
  return (
    memory.status === "active" &&
    memory.confidence >= thresholds.minConfidence &&
    memory.importance >= thresholds.minImportance
  );
}

export function selectExportableSkills<T extends SkillSelectionInput>(
  memories: readonly T[],
  thresholds: Readonly<SkillExportThresholds> = DEFAULT_SKILL_EXPORT_THRESHOLDS
): T[] {
  return memories.filter((memory) => isExportableSkill(memory, thresholds));
}

/**
 * Lower-case ASCII slug of the summary, at most SKILL_NAME_MAX_CHARS characters. Summaries without
 * ASCII letters or digits (e.g. Korean-only) fall back to `memory-<id>` so the name is never empty.
 */
export function skillName(memory: Pick<SkillExportMemory, "id" | "summary">): string {
  const slug = memory.summary
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SKILL_NAME_MAX_CHARS)
    .replace(/-+$/g, "");

  return slug.length > 0 ? slug : `memory-${memory.id}`;
}

export function skillFileName(memory: Pick<SkillExportMemory, "id" | "summary">): string {
  return `${skillName(memory)}.md`;
}

function yamlQuote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function yamlStringList(values: readonly string[]): string {
  return `[${values.map((value) => yamlQuote(value)).join(", ")}]`;
}

/** Renders one memory as a SKILL.md document: YAML frontmatter followed by a Markdown body. */
export function formatSkillMarkdown(memory: SkillExportMemory): string {
  const lines: string[] = [
    "---",
    `name: ${yamlQuote(skillName(memory))}`,
    `description: ${yamlQuote(memory.summary)}`,
    "version: 1.0.0",
    "metadata:",
    "  source: harness-memory",
    `  memory_id: ${yamlQuote(memory.id)}`,
    `  memory_type: ${yamlQuote(memory.type)}`,
    `  confidence: ${memory.confidence}`,
    `  importance: ${memory.importance}`,
    `  scope_glob: ${yamlQuote(memory.scopeGlob)}`,
    `  activation_class: ${yamlQuote(memory.activationClass)}`,
    `  lifecycle_triggers: ${yamlStringList(memory.lifecycleTriggers)}`,
  ];

  if (memory.relevantTools !== null) {
    lines.push(`  relevant_tools: ${yamlStringList(memory.relevantTools)}`);
  }

  lines.push("---", "", `# ${memory.summary}`, "", "## Details", "", memory.details, "");

  return lines.join("\n");
}

// ---------------------------------------------------------------------------------------------
// SQL dump (`memory:export`)
// ---------------------------------------------------------------------------------------------

export function escapeSqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function quoteSqlIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** One cell as a SQL literal: NULL, a number, a quoted string, 0/1 for booleans, X'..' for blobs. */
export function formatSqlValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "NULL";
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : "NULL";
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  if (typeof value === "string") {
    return escapeSqlString(value);
  }

  if (typeof value === "boolean") {
    return value ? "1" : "0";
  }

  if (value instanceof Uint8Array) {
    return `X'${Buffer.from(value).toString("hex")}'`;
  }

  return escapeSqlString(String(value));
}

interface DumpTable {
  name: string;
  sql: string;
}

function listUserTables(db: SqlJsDatabase): DumpTable[] {
  const tables: DumpTable[] = [];
  const stmt = db.prepare(
    "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
  );

  try {
    while (stmt.step()) {
      const row = stmt.getAsObject();
      if (typeof row.name === "string" && typeof row.sql === "string") {
        tables.push({ name: row.name, sql: row.sql });
      }
    }
  } finally {
    stmt.free();
  }

  return tables;
}

function readUserVersion(db: SqlJsDatabase): number {
  const stmt = db.prepare("PRAGMA user_version");

  try {
    if (!stmt.step()) {
      return 0;
    }
    const value = stmt.get()[0];
    return typeof value === "number" ? value : 0;
  } finally {
    stmt.free();
  }
}

/**
 * Whole-database dump as executable SQL: each user table's CREATE statement followed by one INSERT per
 * row, wrapped in a transaction and closed with the `user_version` pragma. Indexes and triggers are not
 * included (the migrations recreate them). Tables are emitted by name and rows in table-scan order, so
 * identical databases produce identical bytes (spec §13.2 (d)).
 */
export function renderSqlDump(db: SqlJsDatabase): string {
  const lines: string[] = ["BEGIN TRANSACTION;"];

  for (const table of listUserTables(db)) {
    lines.push(`${table.sql};`);

    const identifier = quoteSqlIdentifier(table.name);
    const stmt = db.prepare(`SELECT * FROM ${identifier}`);

    try {
      while (stmt.step()) {
        const values = stmt.get().map((value) => formatSqlValue(value)).join(", ");
        lines.push(`INSERT INTO ${identifier} VALUES (${values});`);
      }
    } finally {
      stmt.free();
    }
  }

  lines.push(`PRAGMA user_version = ${readUserVersion(db)};`);
  lines.push("COMMIT;");

  return lines.join("\n");
}
