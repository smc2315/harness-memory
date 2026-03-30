import { openSqlJsDatabase, saveSqlJsDatabase } from "../db/sqlite";
import { MemoryRepository } from "../memory";

interface CliOptions {
  dbPath: string;
  memoryId: string;
  reason?: string;
  json: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  let dbPath = ".harness-memory/memory.sqlite";
  let memoryId = "";
  let reason: string | undefined;
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

    if (arg === "--reason" && index + 1 < argv.length) {
      reason = argv[index + 1];
      index += 1;
      continue;
    }

    if (arg === "--json") {
      json = true;
    }
  }

  if (memoryId.length === 0) {
    throw new Error("Missing required --memory <id> argument");
  }

  return { dbPath, memoryId, reason, json };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const db = await openSqlJsDatabase(options.dbPath, { requireExists: true });

  try {
    const repository = new MemoryRepository(db);
    const result = repository.rejectMemory({
      memoryId: options.memoryId,
      reason: options.reason,
      sourceRef: "memory:reject",
      updatedAt: new Date().toISOString(),
      lastVerifiedAt: new Date().toISOString(),
    });

    saveSqlJsDatabase(db, options.dbPath);

    const output = {
      memory: result.memory,
      evidence: result.evidence,
    };

    if (options.json) {
      console.log(JSON.stringify(output, null, 2));
      return;
    }

    console.log(
      [
        result.memory.id,
        result.memory.status,
        result.memory.type,
        result.memory.summary,
      ].join("\t")
    );
    if (result.evidence !== null) {
      console.log(["evidence", result.evidence.id, result.evidence.sourceRef].join("\t"));
    }
  } finally {
    db.close();
  }
}

await main();
