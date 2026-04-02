/**
 * CLI: memory:demote
 *
 * Transitions an active memory to stale status.
 * Useful for reverting auto-promoted memories or marking manually-promoted
 * memories as no longer relevant.
 *
 * Usage:
 *   npx harness-memory memory:demote --memory <id> [--reason "..."] [--json]
 */

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
    const existing = repository.getById(options.memoryId);

    if (existing === null) {
      const message = `Memory ${options.memoryId} not found`;

      if (options.json) {
        console.log(JSON.stringify({ error: message }));
      } else {
        console.error(message);
      }

      process.exitCode = 1;
      return;
    }

    if (existing.status !== "active") {
      const message = `Memory ${options.memoryId} is ${existing.status}, not active. Only active memories can be demoted.`;

      if (options.json) {
        console.log(JSON.stringify({ error: message }));
      } else {
        console.error(message);
      }

      process.exitCode = 1;
      return;
    }

    const updated = repository.update(options.memoryId, {
      status: "stale",
      updatedAt: new Date().toISOString(),
    });

    saveSqlJsDatabase(db, options.dbPath);

    if (updated === null) {
      console.error("Failed to demote memory");
      process.exitCode = 1;
      return;
    }

    if (options.json) {
      console.log(JSON.stringify({
        id: updated.id,
        status: updated.status,
        promotionSource: updated.promotionSource,
        summary: updated.summary,
        reason: options.reason ?? "demoted by user",
      }));
    } else {
      console.log(`Demoted: ${updated.summary}`);
      console.log(`  Status: active → stale`);
      console.log(`  Source: ${updated.promotionSource}`);

      if (options.reason !== undefined) {
        console.log(`  Reason: ${options.reason}`);
      }
    }
  } finally {
    db.close();
  }
}

await main();
