import { homedir } from "os";
import { resolve } from "path";
import { openSqlJsDatabase, saveSqlJsDatabase } from "../db/sqlite";
import {
  MemoryRepository,
  type CreateMemoryInput,
  type MemoryRecord,
} from "../memory";
import { EmbeddingService, cosineSimilarity } from "../activation/embeddings";
import type {
  ActivationClass,
  LifecycleTrigger,
  MemoryStatus,
  MemoryType,
} from "../db/schema/types";

const VALID_TYPES: readonly MemoryType[] = [
  "policy",
  "workflow",
  "pitfall",
  "architecture_constraint",
  "decision",
];

const VALID_STATUSES: readonly MemoryStatus[] = [
  "candidate",
  "active",
  "stale",
  "superseded",
];

const VALID_TRIGGERS: readonly LifecycleTrigger[] = [
  "session_start",
  "before_model",
  "before_tool",
  "after_tool",
];

const VALID_ACTIVATION_CLASSES: readonly ActivationClass[] = [
  "baseline",
  "startup",
  "scoped",
  "event",
];

interface CliOptions {
  dbPath: string;
  type: MemoryType;
  scopeGlob: string;
  summary: string;
  details: string;
  lifecycleTriggers: LifecycleTrigger[];
  status: MemoryStatus;
  activationClass: ActivationClass;
  confidence?: number;
  importance?: number;
  json: boolean;
}

function parseMemoryType(value: string): MemoryType {
  if (VALID_TYPES.includes(value as MemoryType)) {
    return value as MemoryType;
  }

  throw new Error(`Invalid memory type: ${value}`);
}

function parseMemoryStatus(value: string): MemoryStatus {
  if (VALID_STATUSES.includes(value as MemoryStatus)) {
    return value as MemoryStatus;
  }

  throw new Error(`Invalid memory status: ${value}`);
}

function parseActivationClass(value: string): ActivationClass {
  if (VALID_ACTIVATION_CLASSES.includes(value as ActivationClass)) {
    return value as ActivationClass;
  }

  throw new Error(`Invalid activation class: ${value}`);
}

function parseLifecycleTriggers(value: string): LifecycleTrigger[] {
  const parts = value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  if (parts.length === 0) {
    throw new Error("At least one lifecycle trigger is required");
  }

  return parts.map((part) => {
    if (VALID_TRIGGERS.includes(part as LifecycleTrigger)) {
      return part as LifecycleTrigger;
    }

    throw new Error(`Invalid lifecycle trigger: ${part}`);
  });
}

function parseScore(value: string, field: "confidence" | "importance"): number {
  const parsed = Number(value);

  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error(`${field} must be between 0 and 1`);
  }

  return parsed;
}

function parseArgs(argv: string[]): CliOptions {
  let dbPath = ".harness-memory/memory.sqlite";
  let isGlobal = false;
  let type: MemoryType | null = null;
  let scopeGlob = "**/*";
  let summary = "";
  let details = "";
  let lifecycleTriggers: LifecycleTrigger[] = ["before_model"];
  let status: MemoryStatus = "candidate";
  let activationClass: ActivationClass = "scoped";
  let confidence: number | undefined;
  let importance: number | undefined;
  let json = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--db" && index + 1 < argv.length) {
      dbPath = argv[index + 1];
      index += 1;
      continue;
    }

    if (arg === "--global") {
      isGlobal = true;
      continue;
    }

    if (arg === "--type" && index + 1 < argv.length) {
      type = parseMemoryType(argv[index + 1]);
      index += 1;
      continue;
    }

    if (arg === "--scope" && index + 1 < argv.length) {
      scopeGlob = argv[index + 1];
      index += 1;
      continue;
    }

    if (arg === "--summary" && index + 1 < argv.length) {
      summary = argv[index + 1];
      index += 1;
      continue;
    }

    if (arg === "--details" && index + 1 < argv.length) {
      details = argv[index + 1];
      index += 1;
      continue;
    }

    if (arg === "--triggers" && index + 1 < argv.length) {
      lifecycleTriggers = parseLifecycleTriggers(argv[index + 1]);
      index += 1;
      continue;
    }

    if (arg === "--status" && index + 1 < argv.length) {
      status = parseMemoryStatus(argv[index + 1]);
      index += 1;
      continue;
    }

    if (arg === "--activation-class" && index + 1 < argv.length) {
      activationClass = parseActivationClass(argv[index + 1]);
      index += 1;
      continue;
    }

    if (arg === "--confidence" && index + 1 < argv.length) {
      confidence = parseScore(argv[index + 1], "confidence");
      index += 1;
      continue;
    }

    if (arg === "--importance" && index + 1 < argv.length) {
      importance = parseScore(argv[index + 1], "importance");
      index += 1;
      continue;
    }

    if (arg === "--json") {
      json = true;
    }
  }

  if (type === null) {
    throw new Error("Missing required --type <memory-type> argument");
  }

  if (scopeGlob.length === 0) {
    throw new Error("Missing required --scope <glob> argument");
  }

  if (summary.length === 0) {
    throw new Error("Missing required --summary <text> argument");
  }

  if (details.length === 0) {
    throw new Error("Missing required --details <text> argument");
  }

  // If --global, switch to global DB path
  if (isGlobal) {
    dbPath = resolve(homedir(), ".harness-memory", "global.sqlite");
  }

  return {
    dbPath,
    type,
    scopeGlob,
    summary,
    details,
    lifecycleTriggers,
    status,
    activationClass,
    confidence,
    importance,
    json,
  };
}

function renderMemory(memory: MemoryRecord): string {
  return [
    memory.id,
    memory.status,
    memory.type,
    memory.scopeGlob,
    memory.summary,
  ].join("\t");
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const db = await openSqlJsDatabase(options.dbPath, { requireExists: true });

  try {
    const repository = new MemoryRepository(db);

    // Embedding-based dedup: skip if a very similar memory already exists.
    const existingMemories = repository.list({});
    const memoriesWithEmbeddings = existingMemories.filter(
      (m) =>
        m.embedding !== null &&
        (m.status === "active" || m.status === "candidate"),
    );

    if (memoriesWithEmbeddings.length > 0) {
      try {
        const embeddingService = new EmbeddingService();
        await embeddingService.warmup();

        const newText = `${options.summary} ${options.details}`;
        const newEmbedding = await embeddingService.embedPassage(newText);

        let maxSimilarity = 0;
        let mostSimilarSummary = "";

        for (const existing of memoriesWithEmbeddings) {
          if (existing.embedding === null) {
            continue;
          }

          const sim = cosineSimilarity(newEmbedding, existing.embedding);

          if (sim > maxSimilarity) {
            maxSimilarity = sim;
            mostSimilarSummary = existing.summary;
          }
        }

        if (maxSimilarity > 0.85) {
          const message = `Skipped: similar memory already exists (similarity=${maxSimilarity.toFixed(3)}, "${mostSimilarSummary}")`;

          if (options.json) {
            console.log(JSON.stringify({ skipped: true, reason: message, similarity: maxSimilarity }));
          } else {
            console.log(message);
          }

          return;
        }
      } catch {
        // Embedding not available — proceed without dedup check.
      }
    }

    const created = repository.create({
      type: options.type,
      scopeGlob: options.scopeGlob,
      summary: options.summary,
      details: options.details,
      lifecycleTriggers: options.lifecycleTriggers,
      status: options.status,
      activationClass: options.activationClass,
      confidence: options.confidence,
      importance: options.importance,
    } satisfies CreateMemoryInput);

    saveSqlJsDatabase(db, options.dbPath);

    if (options.json) {
      console.log(JSON.stringify(created, null, 2));
      return;
    }

    console.log(renderMemory(created));
  } finally {
    db.close();
  }
}

await main();
