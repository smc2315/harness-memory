import { openSqlJsDatabase, saveSqlJsDatabase } from "../db/sqlite";
import { MemoryRepository } from "../memory";

interface CliOptions {
  dbPath: string;
  memoryId: string;
  json: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  let dbPath = ".harness-memory/memory.sqlite";
  let memoryId = "";
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

    if (arg === "--json") {
      json = true;
    }
  }

  if (memoryId.length === 0) {
    throw new Error("Missing required --memory <id> argument");
  }

  return { dbPath, memoryId, json };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const db = await openSqlJsDatabase(options.dbPath, { requireExists: true });

  try {
    const repository = new MemoryRepository(db);
    const current = repository.getById(options.memoryId);

    if (current === null) {
      throw new Error(`Memory not found: ${options.memoryId}`);
    }

    if (current.status !== "candidate") {
      throw new Error(`Only candidate memories can be promoted (got ${current.status})`);
    }

    const updated = repository.update(options.memoryId, {
      status: "active",
      updatedAt: new Date().toISOString(),
      lastVerifiedAt: new Date().toISOString(),
    });

    if (updated === null) {
      throw new Error(`Failed to promote memory: ${options.memoryId}`);
    }

    saveSqlJsDatabase(db, options.dbPath);

    if (options.json) {
      console.log(JSON.stringify(updated, null, 2));
      return;
    }

    console.log([updated.id, updated.status, updated.type, updated.summary].join("\t"));
  } finally {
    db.close();
  }
}

await main();
