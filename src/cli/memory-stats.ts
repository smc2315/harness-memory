import { openSqlJsDatabase } from "../db/sqlite";
import { MemoryRepository } from "../memory";

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
    const statusCounts = new Map<string, number>();
    const typeCounts = new Map<string, number>();

    for (const memory of memories) {
      statusCounts.set(memory.status, (statusCounts.get(memory.status) ?? 0) + 1);
      typeCounts.set(memory.type, (typeCounts.get(memory.type) ?? 0) + 1);
    }

    const output = {
      totalMemories: memories.length,
      byStatus: Object.fromEntries(
        Array.from(statusCounts.entries()).sort(([left], [right]) =>
          left.localeCompare(right)
        )
      ),
      byType: Object.fromEntries(
        Array.from(typeCounts.entries()).sort(([left], [right]) =>
          left.localeCompare(right)
        )
      ),
    };

    if (options.json) {
      console.log(JSON.stringify(output, null, 2));
      return;
    }

    console.log(`total\t${output.totalMemories}`);
    console.log("byStatus");
    for (const [status, count] of Object.entries(output.byStatus)) {
      console.log(`${status}\t${count}`);
    }
    console.log("byType");
    for (const [type, count] of Object.entries(output.byType)) {
      console.log(`${type}\t${count}`);
    }
  } finally {
    db.close();
  }
}

await main();
