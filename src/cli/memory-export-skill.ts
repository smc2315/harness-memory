import { existsSync, mkdirSync, writeFileSync } from "fs";
import { dirname, resolve } from "path";
import { openSqlJsDatabase } from "../db/sqlite";
import { MemoryRepository, type MemoryRecord } from "../memory";

interface CliOptions {
  dbPath: string;
  memoryId: string | null;
  outputPath: string;
  format: "skill-md";
  minConfidence: number;
  minImportance: number;
  json: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  let dbPath = ".harness-memory/memory.sqlite";
  let memoryId: string | null = null;
  let outputPath = "./skills";
  let format: "skill-md" = "skill-md";
  let minConfidence = 0.8;
  let minImportance = 0.5;
  let json = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--db" && index + 1 < argv.length) {
      dbPath = argv[index + 1];
      index += 1;
      continue;
    }

    if (arg === "--memory" && index + 1 < argv.length) {
      memoryId = argv[index + 1];
      index += 1;
      continue;
    }

    if (arg === "--output" && index + 1 < argv.length) {
      outputPath = argv[index + 1];
      index += 1;
      continue;
    }

    if (arg === "--format" && index + 1 < argv.length) {
      format = argv[index + 1] as "skill-md";
      index += 1;
      continue;
    }

    if (arg === "--min-confidence" && index + 1 < argv.length) {
      minConfidence = Number(argv[index + 1]);
      if (!Number.isFinite(minConfidence) || minConfidence < 0 || minConfidence > 1) {
        throw new Error("--min-confidence must be between 0 and 1");
      }
      index += 1;
      continue;
    }

    if (arg === "--min-importance" && index + 1 < argv.length) {
      minImportance = Number(argv[index + 1]);
      if (!Number.isFinite(minImportance) || minImportance < 0 || minImportance > 1) {
        throw new Error("--min-importance must be between 0 and 1");
      }
      index += 1;
      continue;
    }

    if (arg === "--json") {
      json = true;
    }
  }

  return { dbPath, memoryId, outputPath, format, minConfidence, minImportance, json };
}

function formatSkillMarkdown(memory: MemoryRecord): string {
  const safeName = memory.summary
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);

  const lines: string[] = [
    "---",
    `name: "${safeName}"`,
    `description: "${memory.summary.replace(/"/g, '\\"')}"`,
    "version: 1.0.0",
    "metadata:",
    "  source: harness-memory",
    `  memory_id: "${memory.id}"`,
    `  memory_type: "${memory.type}"`,
    `  confidence: ${memory.confidence}`,
    `  importance: ${memory.importance}`,
    `  scope_glob: "${memory.scopeGlob}"`,
    `  activation_class: "${memory.activationClass}"`,
    `  lifecycle_triggers: [${memory.lifecycleTriggers.map((trigger) => `"${trigger}"`).join(", ")}]`,
  ];

  if (memory.relevantTools !== null) {
    lines.push(`  relevant_tools: [${memory.relevantTools.map((tool) => `"${tool}"`).join(", ")}]`);
  }

  lines.push("---");
  lines.push("");
  lines.push(`# ${memory.summary}`);
  lines.push("");
  lines.push("## Details");
  lines.push("");
  lines.push(memory.details);
  lines.push("");

  return lines.join("\n");
}

function sanitizeFilename(summary: string): string {
  return `${summary
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)}.md`;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const db = await openSqlJsDatabase(options.dbPath, { requireExists: true });

  try {
    const repository = new MemoryRepository(db);
    let memories: MemoryRecord[];

    if (options.memoryId !== null) {
      const memory = repository.getById(options.memoryId);
      if (memory === null) {
        throw new Error(`Memory not found: ${options.memoryId}`);
      }
      if (memory.status !== "active") {
        throw new Error(`Only active memories can be exported (got ${memory.status})`);
      }
      memories = [memory];
    } else {
      memories = repository
        .list({ status: "active" })
        .filter((memory) => memory.confidence >= options.minConfidence && memory.importance >= options.minImportance);
    }

    if (memories.length === 0) {
      if (options.json) {
        console.log(JSON.stringify({ exported: 0, files: [] }));
      } else {
        console.log("No memories match export criteria.");
      }
      return;
    }

    const exportedFiles: Array<{ memoryId: string; path: string; summary: string }> = [];

    if (options.memoryId !== null && memories.length === 1) {
      const outputDir = dirname(options.outputPath);
      if (!existsSync(outputDir)) {
        mkdirSync(outputDir, { recursive: true });
      }

      const content = formatSkillMarkdown(memories[0]);
      const filePath = options.outputPath.endsWith(".md")
        ? options.outputPath
        : `${options.outputPath}.md`;
      writeFileSync(filePath, content, "utf-8");
      exportedFiles.push({
        memoryId: memories[0].id,
        path: filePath,
        summary: memories[0].summary,
      });
    } else {
      if (!existsSync(options.outputPath)) {
        mkdirSync(options.outputPath, { recursive: true });
      }

      for (const memory of memories) {
        const filename = sanitizeFilename(memory.summary);
        const filePath = resolve(options.outputPath, filename);
        const content = formatSkillMarkdown(memory);
        writeFileSync(filePath, content, "utf-8");
        exportedFiles.push({
          memoryId: memory.id,
          path: filePath,
          summary: memory.summary,
        });
      }
    }

    if (options.json) {
      console.log(JSON.stringify({ exported: exportedFiles.length, files: exportedFiles }, null, 2));
    } else {
      console.log(`Exported ${exportedFiles.length} skill(s):`);
      for (const file of exportedFiles) {
        console.log(`  ${file.path}\t${file.summary}`);
      }
    }
  } finally {
    db.close();
  }
}

await main();
