import { ActivationEngine } from "../activation";
import { openSqlJsDatabase } from "../db/sqlite";
import { MemoryRepository } from "../memory";
import type { LifecycleTrigger } from "../db/schema/types";

interface CliOptions {
  dbPath: string;
  scopeRef: string;
  lifecycleTrigger: LifecycleTrigger;
  json: boolean;
}

const VALID_TRIGGERS: readonly LifecycleTrigger[] = [
  "session_start",
  "before_model",
  "before_tool",
  "after_tool",
];

function parseTrigger(value: string): LifecycleTrigger {
  if (VALID_TRIGGERS.includes(value as LifecycleTrigger)) {
    return value as LifecycleTrigger;
  }

  throw new Error(`Invalid lifecycle trigger: ${value}`);
}

function parseArgs(argv: string[]): CliOptions {
  let dbPath = "memory.sqlite";
  let scopeRef = ".";
  let lifecycleTrigger: LifecycleTrigger = "before_model";
  let json = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--db" && index + 1 < argv.length) {
      dbPath = argv[index + 1];
      index += 1;
      continue;
    }

    if (arg === "--scope" && index + 1 < argv.length) {
      scopeRef = argv[index + 1];
      index += 1;
      continue;
    }

    if (arg === "--trigger" && index + 1 < argv.length) {
      lifecycleTrigger = parseTrigger(argv[index + 1]);
      index += 1;
      continue;
    }

    if (arg === "--json") {
      json = true;
    }
  }

  return {
    dbPath,
    scopeRef,
    lifecycleTrigger,
    json,
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const db = await openSqlJsDatabase(options.dbPath, { requireExists: true });

  try {
    const repository = new MemoryRepository(db);
    const engine = new ActivationEngine(repository);
    const result = engine.activate({
      lifecycleTrigger: options.lifecycleTrigger,
      scopeRef: options.scopeRef,
    });

    const output = {
      scopeRef: options.scopeRef,
      lifecycleTrigger: options.lifecycleTrigger,
      conflicts: result.conflicts.map((conflict) => ({
        marker: "CONFLICT",
        kind: conflict.kind,
        reason: conflict.reason,
        rootId: conflict.root.id,
        memoryIds: conflict.memories.map((memory) => memory.id),
      })),
      activated: result.activated.map((memory) => ({
        id: memory.id,
        type: memory.type,
        summary: memory.summary,
        rank: memory.rank,
        score: memory.score,
        payloadBytes: memory.payloadBytes,
      })),
      suppressed: result.suppressed.map((entry) => ({
        id: entry.memory.id,
        type: entry.memory.type,
        summary: entry.memory.summary,
        kind: entry.kind,
        reason: entry.reason,
      })),
      budget: result.budget,
    };

    if (options.json) {
      console.log(JSON.stringify(output, null, 2));
      return;
    }

    console.log(`scope\t${output.scopeRef}`);
    console.log(`trigger\t${output.lifecycleTrigger}`);
    console.log("conflicts");
    for (const conflict of output.conflicts) {
      console.log(
        `${conflict.marker}\t${conflict.kind}\t${conflict.rootId}\t${conflict.memoryIds.join(",") || "-"}\t${conflict.reason}`
      );
    }
    console.log("activated");
    for (const memory of output.activated) {
      console.log(
        `${memory.rank}\t${memory.type}\t${memory.id}\t${memory.score}\t${memory.summary}`
      );
    }
    console.log("suppressed");
    for (const entry of output.suppressed) {
      console.log(
        `${entry.kind}\t${entry.type}\t${entry.id}\t${entry.reason}`
      );
    }
  } finally {
    db.close();
  }
}

await main();
