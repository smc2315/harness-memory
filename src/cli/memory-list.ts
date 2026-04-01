import { MemoryRepository, CompositeMemoryRepository } from "../memory";
import { openSqlJsDatabase } from "../db/sqlite";
import { existsSync } from "fs";
import { resolve } from "path";
import { homedir } from "os";

interface CliOptions {
  dbPath: string;
  json: boolean;
  global: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  let dbPath = ".harness-memory/memory.sqlite";
  let json = false;
  let global = false;

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

    if (arg === "--global") {
      global = true;
    }
  }

  return { dbPath, json, global };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  if (options.global) {
    // Show only global memories
    const globalDbPath = resolve(homedir(), ".harness-memory", "global.sqlite");

    if (!existsSync(globalDbPath)) {
      console.log("No global memory database found. Run `npx harness-memory install` first.");
      return;
    }

    const globalDb = await openSqlJsDatabase(globalDbPath, { requireExists: true });

    try {
      const repo = new MemoryRepository(globalDb);
      const memories = repo.list();

      if (options.json) {
        console.log(JSON.stringify(memories.map((m) => ({ ...m, tier: "global" })), null, 2));
        return;
      }

      for (const memory of memories) {
        console.log(["[G]", memory.id, memory.status, memory.type, memory.summary].join("\t"));
      }
    } finally {
      globalDb.close();
    }

    return;
  }

  // Default: show both tiers
  const db = await openSqlJsDatabase(options.dbPath, { requireExists: true });

  try {
    const projectRepo = new MemoryRepository(db);
    const projectMemories = projectRepo.list();

    // Try to load global memories too
    const globalDbPath = resolve(homedir(), ".harness-memory", "global.sqlite");
    let globalMemories: Array<{ id: string; status: string; type: string; scopeGlob: string; summary: string }> = [];

    if (existsSync(globalDbPath)) {
      try {
        const globalDb = await openSqlJsDatabase(globalDbPath, { requireExists: true });
        const globalRepo = new MemoryRepository(globalDb);
        globalMemories = globalRepo.list();
        globalDb.close();
      } catch {
        // Global DB not available, just show project
      }
    }

    if (options.json) {
      const all = [
        ...globalMemories.map((m) => ({ ...m, tier: "global" })),
        ...projectMemories.map((m) => ({ ...m, tier: "project" })),
      ];
      console.log(JSON.stringify(all, null, 2));
      return;
    }

    if (globalMemories.length > 0) {
      for (const memory of globalMemories) {
        console.log(["[G]", memory.id, memory.status, memory.type, memory.summary].join("\t"));
      }
    }

    for (const memory of projectMemories) {
      console.log(["[P]", memory.id, memory.status, memory.type, memory.summary].join("\t"));
    }
  } finally {
    db.close();
  }
}

await main();
