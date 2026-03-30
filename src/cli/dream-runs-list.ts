import { openSqlJsDatabase } from "../db/sqlite";
import { DreamRepository } from "../dream";

interface CliOptions {
  dbPath: string;
  limit?: number;
  json: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  let dbPath = ".harness-memory/memory.sqlite";
  let limit: number | undefined;
  let json = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--db" && index + 1 < argv.length) {
      dbPath = argv[index + 1];
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

  return { dbPath, limit, json };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const db = await openSqlJsDatabase(options.dbPath, { requireExists: true });

  try {
    const repository = new DreamRepository(db);
    const runs = repository.listDreamRuns({ limit: options.limit });

    if (options.json) {
      console.log(JSON.stringify(runs, null, 2));
      return;
    }

    for (const run of runs) {
      console.log(
        [
          run.id,
          run.trigger,
          run.status,
          `evidence=${run.evidenceCount}`,
          `candidates=${run.candidateCount}`,
          run.summary,
        ].join("\t")
      );
    }
  } finally {
    db.close();
  }
}

await main();
