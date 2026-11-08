/**
 * `hm memory:export [--out <file>]` — byte-deterministic SQL dump of the whole database (renderSqlDump; two
 * identical databases give identical bytes, spec §13.2 (d)); to stdout when `--out` is absent.
 * `hm memory:export-skill [--out <dir>] [--min-confidence <n>] [--min-importance <n>]` — mature active
 * memories as SKILL.md files (selectExportableSkills / formatSkillMarkdown / skillFileName).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { EXIT_CODES } from "../../core/errors";
import { MemoryRepository } from "../../memory/repository";
import type { CommandContext } from "../context";
import { flagNumber, flagString, type OptionSpecs } from "../lib/args";
import { guard, usageError } from "../lib/cli-error";
import { readDb } from "../lib/db-access";
import { DEFAULT_SKILL_EXPORT_THRESHOLDS, formatSkillMarkdown, renderSqlDump, selectExportableSkills, skillFileName } from "../lib/export";
import { shortId } from "../lib/lookup";
import { clip } from "../lib/memory-render";
import { formatBytes } from "../lib/output";

export const memoryExportOptions: OptionSpecs = {
  out: { type: "string", description: "Write the dump to this file instead of stdout", placeholder: "<file>" },
};

export const memoryExportSkillOptions: OptionSpecs = {
  out: { type: "string", description: "Directory for the SKILL.md files (default .harness-memory/skills)", placeholder: "<dir>" },
  "min-confidence": { type: "number", description: `Inclusive confidence threshold (default ${String(DEFAULT_SKILL_EXPORT_THRESHOLDS.minConfidence)})`, placeholder: "<n>" },
  "min-importance": { type: "number", description: `Inclusive importance threshold (default ${String(DEFAULT_SKILL_EXPORT_THRESHOLDS.minImportance)})`, placeholder: "<n>" },
};

export interface MemoryExportReport {
  out: string | null;
  bytes: number;
  tables: number;
  /** The dump itself when no --out was given (JSON mode). */
  sql?: string;
}

export async function runMemoryExport(ctx: CommandContext): Promise<number> {
  return guard(ctx, async () => {
    const sql = await readDb(ctx, (db) => renderSqlDump(db));
    const bytes = Buffer.byteLength(sql, "utf8");
    const tables = (sql.match(/^CREATE TABLE/gm) ?? []).length;
    const outFlag = flagString(ctx.args, "out");
    if (outFlag !== null) {
      const out = resolve(ctx.cwd, outFlag);
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, `${sql}\n`, "utf8");
      const report: MemoryExportReport = { out, bytes, tables };
      ctx.out.result(report, () => [`wrote ${formatBytes(bytes)} (${String(tables)} tables) to ${out}`]);
      return EXIT_CODES.ok;
    }
    const report: MemoryExportReport = { out: null, bytes, tables, sql };
    ctx.out.result(report, () => [sql]);
    return EXIT_CODES.ok;
  });
}

export interface MemoryExportSkillReport {
  out: string;
  thresholds: { minConfidence: number; minImportance: number };
  considered: number;
  files: Array<{ memory_id: string; file: string; summary: string }>;
}

export async function runMemoryExportSkill(ctx: CommandContext): Promise<number> {
  return guard(ctx, async () => {
    const minConfidence = flagNumber(ctx.args, "min-confidence") ?? DEFAULT_SKILL_EXPORT_THRESHOLDS.minConfidence;
    const minImportance = flagNumber(ctx.args, "min-importance") ?? DEFAULT_SKILL_EXPORT_THRESHOLDS.minImportance;
    for (const [name, value] of [
      ["--min-confidence", minConfidence],
      ["--min-importance", minImportance],
    ] as const) {
      if (value < 0 || value > 1) throw usageError(`${name} must be between 0 and 1`);
    }
    const out = resolve(ctx.cwd, flagString(ctx.args, "out") ?? join(ctx.paths.dir, "skills"));
    const active = await readDb(ctx, (db) => new MemoryRepository(db).list({ status: "active" }));
    const selected = selectExportableSkills(active, { minConfidence, minImportance });
    mkdirSync(out, { recursive: true });
    const files: MemoryExportSkillReport["files"] = [];
    for (const memory of selected) {
      const file = join(out, skillFileName(memory));
      writeFileSync(file, formatSkillMarkdown(memory), "utf8");
      files.push({ memory_id: memory.id, file, summary: memory.summary });
    }
    const report: MemoryExportSkillReport = { out, thresholds: { minConfidence, minImportance }, considered: active.length, files };
    ctx.out.result(report, () => {
      const lines = [`exported ${String(files.length)} of ${String(active.length)} active memories as SKILL.md files to ${out}`];
      for (const entry of files) lines.push(`  ${shortId(entry.memory_id)}  ${clip(entry.summary, 60)}  → ${entry.file}`);
      return lines;
    });
    return EXIT_CODES.ok;
  });
}
