import { MemoryRepository } from "../memory";
import { openSqlJsDatabase } from "../db/sqlite";

interface CliOptions {
  dbPath: string;
  json: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  let dbPath = "memory.sqlite";
  let json = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--db" && index + 1 < argv.length) {
      dbPath = argv[index + 1];
      index += 1;
      continue;
    }

    if (arg === "--json") {
      json = true;
    }
  }

  return { dbPath, json };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const db = await openSqlJsDatabase(options.dbPath, { requireExists: true });

  try {
    const repository = new MemoryRepository(db);
    const memories = repository.list();

    if (options.json) {
      console.log(JSON.stringify(memories, null, 2));
      return;
    }

    for (const memory of memories) {
      console.log(
        [
          memory.id,
          memory.status,
          memory.type,
          memory.scopeGlob,
          memory.summary,
        ].join("\t")
      );
    }
  } finally {
    db.close();
  }
}

await main();
