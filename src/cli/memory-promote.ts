import { openSqlJsDatabase, saveSqlJsDatabase } from "../db/sqlite";
import type { ActivationClass } from "../db/schema/types";
import {
  MemoryRepository,
  type MemoryRecord,
  type UpdateMemoryInput,
} from "../memory";
import { scanMemoryContent } from "../security";

const VALID_ACTIVATION_CLASSES: readonly ActivationClass[] = [
  "baseline",
  "startup",
  "scoped",
  "event",
];

interface CliOptions {
  dbPath: string;
  memoryId: string | null;
  activationClass: ActivationClass | null;
  all: boolean;
  minConfidence: number;
  json: boolean;
}

interface BatchPromotionSkip {
  memoryId: string;
  summary: string;
  reason: string;
}

function parseActivationClass(value: string): ActivationClass {
  if (VALID_ACTIVATION_CLASSES.includes(value as ActivationClass)) {
    return value as ActivationClass;
  }
  throw new Error(
    `Invalid activation class: ${value}. Valid: ${VALID_ACTIVATION_CLASSES.join(", ")}`,
  );
}

function parseScore(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error(`${flag} must be a number between 0 and 1`);
  }

  return parsed;
}

function formatMemoryLine(memory: MemoryRecord): string {
  return [memory.id, memory.status, memory.type, memory.summary].join("\t");
}

function promoteCandidate(
  repository: MemoryRepository,
  memoryId: string,
  activationClass: ActivationClass | null,
): MemoryRecord {
  const updateInput: UpdateMemoryInput = {
    status: "active",
    updatedAt: new Date().toISOString(),
    lastVerifiedAt: new Date().toISOString(),
  };
  if (activationClass !== null) {
    updateInput.activationClass = activationClass;
  }

  const updated = repository.update(memoryId, updateInput);
  if (updated === null) {
    throw new Error(`Failed to promote memory: ${memoryId}`);
  }

  return updated;
}

function parseArgs(argv: string[]): CliOptions {
  let dbPath = ".harness-memory/memory.sqlite";
  let memoryId: string | null = null;
  let activationClass: ActivationClass | null = null;
  let all = false;
  let minConfidence = 0.85;
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

    if (arg === "--min-confidence" && index + 1 < argv.length) {
      minConfidence = parseScore(argv[index + 1], "--min-confidence");
      index += 1;
      continue;
    }

    if (arg === "--activation-class" && index + 1 < argv.length) {
      activationClass = parseActivationClass(argv[index + 1]);
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

  return { dbPath, memoryId, activationClass, all, minConfidence, json };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const db = await openSqlJsDatabase(options.dbPath, { requireExists: true });

  try {
    const repository = new MemoryRepository(db);

    if (options.all) {
      const candidates = repository
        .list({ status: "candidate" })
        .filter((candidate) => candidate.confidence >= options.minConfidence);
      const promoted: MemoryRecord[] = [];
      const skipped: BatchPromotionSkip[] = [];

      for (const candidate of candidates) {
        const scanResult = scanMemoryContent(candidate.summary, candidate.details);
        const blockedThreats = scanResult.threats.filter(
          (threat) => threat.severity === "block"
        );

        if (blockedThreats.length > 0) {
          skipped.push({
            memoryId: candidate.id,
            summary: candidate.summary,
            reason: "Security scan detected threats",
          });
          continue;
        }

        promoted.push(
          promoteCandidate(repository, candidate.id, options.activationClass)
        );
      }

      saveSqlJsDatabase(db, options.dbPath);

      if (options.json) {
        console.log(
          JSON.stringify(
            {
              minConfidence: options.minConfidence,
              promoted,
              skipped,
            },
            null,
            2
          )
        );
        return;
      }

      if (promoted.length === 0 && skipped.length === 0) {
        console.log(
          `No candidate memories matched --all --min-confidence ${options.minConfidence.toFixed(2)}`
        );
        return;
      }

      for (const memory of promoted) {
        console.log(formatMemoryLine(memory));
      }
      for (const skippedCandidate of skipped) {
        console.log(
          [
            "skipped",
            skippedCandidate.memoryId,
            skippedCandidate.reason,
            skippedCandidate.summary,
          ].join("\t")
        );
      }
      return;
    }

    const current = repository.getById(options.memoryId!);

    if (current === null) {
      throw new Error(`Memory not found: ${options.memoryId!}`);
    }

    if (current.status !== "candidate") {
      throw new Error(`Only candidate memories can be promoted (got ${current.status})`);
    }

    const scanResult = scanMemoryContent(current.summary, current.details);
    const blockedThreats = scanResult.threats.filter((threat) => threat.severity === "block");

    if (blockedThreats.length > 0) {
      const threatDetails = blockedThreats
        .map((threat) => `  [${threat.category}] ${threat.pattern}: ${threat.match}`)
        .join("\n");

      if (options.json) {
        console.log(
          JSON.stringify(
              {
                blocked: true,
                memoryId: options.memoryId!,
                reason: "Security scan detected threats",
                threats: blockedThreats,
              },
            null,
            2
          )
        );
      } else {
        console.error(
          `Blocked: Security scan detected threats in memory ${options.memoryId!}:\n${threatDetails}`
        );
      }
      process.exit(1);
    }

    const updated = promoteCandidate(
      repository,
      options.memoryId!,
      options.activationClass
    );

    saveSqlJsDatabase(db, options.dbPath);

    if (options.json) {
      console.log(JSON.stringify(updated, null, 2));
      return;
    }

    console.log(formatMemoryLine(updated));
  } finally {
    db.close();
  }
}

await main();
