import { openSqlJsDatabase, saveSqlJsDatabase } from "../db/sqlite";
import type { DreamTrigger } from "../db/schema/types";
import { DreamRepository, DreamWorker } from "../dream";
import { MemoryRepository } from "../memory";

const VALID_TRIGGERS: readonly DreamTrigger[] = [
  "manual",
  "precompact",
  "task_end",
  "session_end",
  "idle",
];

interface CliOptions {
  dbPath: string;
  trigger: DreamTrigger;
  limit?: number;
  createdAfter?: string;
  json: boolean;
}

function parseTrigger(value: string): DreamTrigger {
  if (VALID_TRIGGERS.includes(value as DreamTrigger)) {
    return value as DreamTrigger;
  }

  throw new Error(`Invalid dream trigger: ${value}`);
}

function parseArgs(argv: string[]): CliOptions {
  let dbPath = ".harness-memory/memory.sqlite";
  let trigger: DreamTrigger = "manual";
  let limit: number | undefined;
  let createdAfter: string | undefined;
  let json = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--db" && index + 1 < argv.length) {
      dbPath = argv[index + 1];
      index += 1;
      continue;
    }

    if (arg === "--trigger" && index + 1 < argv.length) {
      trigger = parseTrigger(argv[index + 1]);
      index += 1;
      continue;
    }

    if (arg === "--limit" && index + 1 < argv.length) {
      limit = Number(argv[index + 1]);
      index += 1;
      continue;
    }

    if (arg === "--created-after" && index + 1 < argv.length) {
      createdAfter = argv[index + 1];
      index += 1;
      continue;
    }

    if (arg === "--json") {
      json = true;
    }
  }

  return { dbPath, trigger, limit, createdAfter, json };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const db = await openSqlJsDatabase(options.dbPath, { requireExists: true });

  try {
    const dreamRepository = new DreamRepository(db);
    const memoryRepository = new MemoryRepository(db);
    const worker = new DreamWorker(dreamRepository, memoryRepository);
    const result = worker.run({
      trigger: options.trigger,
      limit: options.limit,
      createdAfter: options.createdAfter,
    });

    saveSqlJsDatabase(db, options.dbPath);

    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    console.log(`run\t${result.run.id}`);
    console.log(`trigger\t${result.run.trigger}`);
    console.log(`status\t${result.run.status}`);
    console.log(`evidence\t${result.processedEvidenceCount}`);
    console.log(`candidates\t${result.suggestions.length}`);
    console.log(`summary\t${result.run.summary}`);
    console.log("suggestions");
    for (const suggestion of result.suggestions) {
      console.log(
        [
          suggestion.action,
          suggestion.type,
          suggestion.memoryId,
          suggestion.scopeGlob,
          suggestion.summary,
        ].join("\t")
      );
    }
  } finally {
    db.close();
  }
}

await main();
