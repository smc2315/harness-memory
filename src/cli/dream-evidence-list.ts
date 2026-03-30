import { openSqlJsDatabase } from "../db/sqlite";
import { DreamRepository } from "../dream";

interface CliOptions {
  dbPath: string;
  status?: string;
  limit?: number;
  json: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  let dbPath = ".harness-memory/memory.sqlite";
  let status: string | undefined;
  let limit: number | undefined;
  let json = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--db" && index + 1 < argv.length) {
      dbPath = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--status" && index + 1 < argv.length) {
      status = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--limit" && index + 1 < argv.length) {
      limit = Number(argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg === "--json") {
      json = true;
    }
  }

  return { dbPath, status, limit, json };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const db = await openSqlJsDatabase(options.dbPath, { requireExists: true });

  try {
    const repository = new DreamRepository(db);
    const entries = repository.listEvidenceEvents({
      status: options.status as never,
      limit: options.limit,
    });

    if (options.json) {
      console.log(JSON.stringify(entries, null, 2));
      return;
    }

    for (const entry of entries) {
      console.log(
        [
          entry.id,
          entry.status,
          `retry=${entry.retryCount}`,
          `next=${entry.nextReviewAt ?? '-'}`,
          entry.toolName,
          entry.topicGuess,
          entry.excerpt,
        ].join("\t")
      );
    }
  } finally {
    db.close();
  }
}

await main();
