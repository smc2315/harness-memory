import { MemoryRepository } from "../memory";
import { openSqlJsDatabase, saveSqlJsDatabase } from "../db/sqlite";

function parseDbPath(argv: string[]): string {
  let dbPath = "memory.sqlite";

  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--db" && index + 1 < argv.length) {
      dbPath = argv[index + 1];
      index += 1;
    }
  }

  return dbPath;
}

async function main(): Promise<void> {
  const dbPath = parseDbPath(process.argv.slice(2));
  const db = await openSqlJsDatabase(dbPath, { requireExists: true });

  try {
    const repository = new MemoryRepository(db);
    const first = repository.createOrGet({
      type: "policy",
      summary: "Prefer explicit adapters",
      details: "Keep repository and adapter boundaries thin.",
      scopeGlob: "src/**/*.ts",
      lifecycleTriggers: ["before_model", "session_start"],
      confidence: 0.9,
      importance: 0.8,
      status: "active",
      createdAt: "2026-03-28T00:00:00.000Z",
      updatedAt: "2026-03-28T00:00:00.000Z",
    });
    const duplicate = repository.createOrGet({
      type: "policy",
      summary: "Prefer explicit adapters",
      details: "Keep repository and adapter boundaries thin.",
      scopeGlob: "src/**/*.ts",
      lifecycleTriggers: ["session_start", "before_model"],
      confidence: 0.9,
      importance: 0.8,
      status: "active",
      createdAt: "2026-03-28T00:05:00.000Z",
      updatedAt: "2026-03-28T00:05:00.000Z",
    });

    saveSqlJsDatabase(db, dbPath);

    console.log(
      JSON.stringify(
        {
          firstId: first.memory.id,
          duplicateId: duplicate.memory.id,
          duplicateIsNew: duplicate.isNew,
          totalMemories: repository.list().length,
        },
        null,
        2
      )
    );
  } finally {
    db.close();
  }
}

await main();
