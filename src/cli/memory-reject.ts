import { openSqlJsDatabase, saveSqlJsDatabase } from "../db/sqlite";
import { MemoryRepository } from "../memory";

interface CliOptions {
  dbPath: string;
  memoryId: string | null;
  reason?: string;
  all: boolean;
  maxConfidence: number;
  json: boolean;
}

function parseScore(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error(`${flag} must be a number between 0 and 1`);
  }

  return parsed;
}

function parseArgs(argv: string[]): CliOptions {
  let dbPath = ".harness-memory/memory.sqlite";
  let memoryId: string | null = null;
  let reason: string | undefined;
  let all = false;
  let maxConfidence = 0.5;
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

    if (arg === "--all") {
      all = true;
      continue;
    }

    if (arg === "--max-confidence" && index + 1 < argv.length) {
      maxConfidence = parseScore(argv[index + 1], "--max-confidence");
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

  if (all && memoryId !== null) {
    throw new Error("Use either --memory <id> or --all, not both");
  }

  if (!all && memoryId === null) {
    throw new Error("Missing required --memory <id> argument");
  }

  return { dbPath, memoryId, reason, all, maxConfidence, json };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const db = await openSqlJsDatabase(options.dbPath, { requireExists: true });

  try {
    const repository = new MemoryRepository(db);

    if (options.all) {
      const candidates = repository
        .list({ status: "candidate" })
        .filter((candidate) => candidate.confidence <= options.maxConfidence);
      const rejected = candidates.map((candidate) =>
        repository.rejectMemory({
          memoryId: candidate.id,
          reason: options.reason,
          sourceRef: "memory:reject",
          updatedAt: new Date().toISOString(),
          lastVerifiedAt: new Date().toISOString(),
        })
      );

      saveSqlJsDatabase(db, options.dbPath);

      if (options.json) {
        console.log(
          JSON.stringify(
            {
              maxConfidence: options.maxConfidence,
              rejected,
            },
            null,
            2
          )
        );
        return;
      }

      if (rejected.length === 0) {
        console.log(
          `No candidate memories matched --all --max-confidence ${options.maxConfidence.toFixed(2)}`
        );
        return;
      }

      for (const item of rejected) {
        console.log(
          [
            item.memory.id,
            item.memory.status,
            item.memory.type,
            item.memory.summary,
          ].join("\t")
        );
        if (item.evidence !== null) {
          console.log(["evidence", item.evidence.id, item.evidence.sourceRef].join("\t"));
        }
      }
      return;
    }

    const result = repository.rejectMemory({
      memoryId: options.memoryId!,
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
