import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { resolve } from "path";

import {
  getBundledBaselineScorecardPath,
  getBundledTaskCorpusPath,
  resolveBaselineOutputDir,
} from "../runtime/package-paths";

interface BaselineScorecardRow {
  task_id: string;
  baseline_condition: string;
  miss_type: string;
  severity: string;
  notes: string;
}

interface BaselineScenarioLog {
  task_id: number;
  title: string;
  baseline_condition: string;
  miss_type: string;
  severity: string;
  notes: string;
}

export interface BaselineEvalOptions {
  baselineScorecardPath?: string;
  taskCorpusPath?: string;
  outputDir?: string;
}

export interface BaselineEvalSummary {
  condition: "md-only";
  generatedAt: string;
  outputDir: string;
  scenarioCount: number;
  importantPolicyMisses: number;
  byMissType: Record<string, number>;
  bySeverity: Record<string, number>;
  scenarioFiles: string[];
}

function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];

    if (char === '"') {
      if (inQuotes && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === "," && !inQuotes) {
      result.push(current);
      current = "";
      continue;
    }

    current += char;
  }

  result.push(current);
  return result;
}

function readBaselineRows(baselineScorecardPath: string): BaselineScorecardRow[] {
  const content = readFileSync(baselineScorecardPath, "utf-8").trim();
  const lines = content.split(/\r?\n/);
  const [, ...dataLines] = lines;

  return dataLines.map((line) => {
    const [task_id, baseline_condition, miss_type, severity, notes] =
      parseCsvLine(line);
    return {
      task_id,
      baseline_condition,
      miss_type,
      severity,
      notes,
    };
  });
}

function readScenarioTitles(taskCorpusPath: string): Map<number, string> {
  const content = readFileSync(taskCorpusPath, "utf-8");
  const matches = content.matchAll(/^## Scenario\s+(\d+):\s+(.+)$/gm);
  const map = new Map<number, string>();

  for (const match of matches) {
    const id = Number(match[1]);
    const title = match[2]?.trim() ?? `Scenario ${id}`;
    map.set(id, title);
  }

  return map;
}

function resetOutputDirectory(outputDir: string): void {
  mkdirSync(outputDir, { recursive: true });

  for (const entry of readdirSync(outputDir)) {
    if (entry.endsWith(".json")) {
      rmSync(resolve(outputDir, entry), { force: true });
    }
  }
}

function writeScenarioLogs(
  logs: readonly BaselineScenarioLog[],
  outputDir: string,
  outputLabel: string
): string[] {
  const files: string[] = [];

  for (const log of logs) {
    const fileName = `baseline-s${String(log.task_id).padStart(2, "0")}.json`;
    writeFileSync(
      resolve(outputDir, fileName),
      `${JSON.stringify(log, null, 2)}\n`,
      "utf-8"
    );
    files.push(`${outputLabel}/${fileName}`);
  }

  return files;
}

export function runBaselineEval(
  options: BaselineEvalOptions = {}
): BaselineEvalSummary {
  const baselineScorecardPath =
    options.baselineScorecardPath ?? getBundledBaselineScorecardPath();
  const taskCorpusPath = options.taskCorpusPath ?? getBundledTaskCorpusPath();
  const outputDir = resolveBaselineOutputDir(options.outputDir);

  const rows = readBaselineRows(baselineScorecardPath);
  const titles = readScenarioTitles(taskCorpusPath);
  resetOutputDirectory(outputDir);

  const logs: BaselineScenarioLog[] = rows.map((row) => ({
    task_id: Number(row.task_id),
    title: titles.get(Number(row.task_id)) ?? `Scenario ${row.task_id}`,
    baseline_condition: row.baseline_condition,
    miss_type: row.miss_type,
    severity: row.severity,
    notes: row.notes,
  }));

  const byMissType = Object.fromEntries(
    Array.from(
      logs
        .reduce(
          (map, log) =>
            map.set(log.miss_type, (map.get(log.miss_type) ?? 0) + 1),
          new Map<string, number>()
        )
        .entries()
    ).sort(([left], [right]) => left.localeCompare(right))
  );

  const bySeverity = Object.fromEntries(
    Array.from(
      logs
        .reduce(
          (map, log) =>
            map.set(log.severity, (map.get(log.severity) ?? 0) + 1),
          new Map<string, number>()
        )
        .entries()
    ).sort(([left], [right]) => left.localeCompare(right))
  );

  const importantPolicyMisses = logs.filter(
    (log) =>
      log.miss_type === "policy_miss" &&
      (log.severity === "critical" || log.severity === "high")
  ).length;

  const outputLabel = outputDir.replaceAll("\\", "/");
  const scenarioFiles = writeScenarioLogs(logs, outputDir, outputLabel);
  const summary: BaselineEvalSummary = {
    condition: "md-only",
    generatedAt: new Date().toISOString(),
    outputDir: outputLabel,
    scenarioCount: logs.length,
    importantPolicyMisses,
    byMissType,
    bySeverity,
    scenarioFiles,
  };

  writeFileSync(
    resolve(outputDir, "baseline-summary.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
    "utf-8"
  );

  return summary;
}
