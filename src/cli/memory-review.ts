import { openSqlJsDatabase } from "../db/sqlite";
import type { MemoryType } from "../db/schema/types";
import { DreamRepository } from "../dream";
import { MemoryRepository } from "../memory";
import { getCandidateAgeDays } from "../promotion/auto-promoter";

const VALID_MEMORY_TYPES: readonly MemoryType[] = [
  "policy",
  "workflow",
  "pitfall",
  "architecture_constraint",
  "decision",
];
const VALID_SORT_OPTIONS = ["confidence", "created"] as const;

interface CliOptions {
  dbPath: string;
  limit?: number;
  type?: MemoryType;
  sort: (typeof VALID_SORT_OPTIONS)[number];
  json: boolean;
}

interface CandidateReviewEntry {
  id: string;
  type: string;
  scopeGlob: string;
  summary: string;
  confidence: number;
  importance: number;
  createdAt: string;
  ageDays: number;
  lastVerifiedAt: string | null;
  evidenceCount: number;
  recentEvidence: {
    id: string;
    title: string;
    toolName: string;
    topicGuess: string;
    createdAt: string;
    excerpt: string;
  }[];
}

function parseMemoryType(value: string): MemoryType {
  if (VALID_MEMORY_TYPES.includes(value as MemoryType)) {
    return value as MemoryType;
  }

  throw new Error(`Invalid memory type: ${value}. Valid: ${VALID_MEMORY_TYPES.join(", ")}`);
}

function parseSort(value: string): CliOptions["sort"] {
  if (VALID_SORT_OPTIONS.includes(value as CliOptions["sort"])) {
    return value as CliOptions["sort"];
  }

  throw new Error(`Invalid sort option: ${value}. Valid: ${VALID_SORT_OPTIONS.join(", ")}`);
}

function compareByCreatedDesc(
  left: Pick<CandidateReviewEntry, "createdAt" | "id">,
  right: Pick<CandidateReviewEntry, "createdAt" | "id">,
): number {
  const createdAtDelta = Date.parse(right.createdAt) - Date.parse(left.createdAt);
  if (!Number.isNaN(createdAtDelta) && createdAtDelta !== 0) {
    return createdAtDelta;
  }

  return left.id.localeCompare(right.id);
}

function compareByConfidenceDesc(left: CandidateReviewEntry, right: CandidateReviewEntry): number {
  const confidenceDelta = right.confidence - left.confidence;
  if (confidenceDelta !== 0) {
    return confidenceDelta;
  }

  return compareByCreatedDesc(left, right);
}

function parseArgs(argv: string[]): CliOptions {
  let dbPath = ".harness-memory/memory.sqlite";
  let limit: number | undefined;
  let type: MemoryType | undefined;
  let sort: CliOptions["sort"] = "created";
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

    if (arg === "--type" && index + 1 < argv.length) {
      type = parseMemoryType(argv[index + 1]);
      index += 1;
      continue;
    }

    if (arg === "--sort" && index + 1 < argv.length) {
      sort = parseSort(argv[index + 1]);
      index += 1;
      continue;
    }

    if (arg === "--json") {
      json = true;
    }
  }

  return { dbPath, limit, type, sort, json };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const db = await openSqlJsDatabase(options.dbPath, { requireExists: true });

  try {
    const memoryRepository = new MemoryRepository(db);
    const dreamRepository = new DreamRepository(db);
    const candidates = memoryRepository.list({
      status: "candidate",
      type: options.type,
      limit: options.limit,
    });
    const linkedEvidenceByMemoryId = dreamRepository.listLinkedEvidenceByMemoryIds(
      candidates.map((memory) => memory.id)
    );

    const entries: CandidateReviewEntry[] = candidates.map((memory) => {
      const linkedEvidence = linkedEvidenceByMemoryId.get(memory.id) ?? [];
      const recentEvidence = linkedEvidence
        .slice(-5)
        .map((event) => ({
          id: event.id,
          title: event.title,
          toolName: event.toolName,
          topicGuess: event.topicGuess,
          createdAt: event.createdAt,
          excerpt: event.excerpt,
        }));

      return {
        id: memory.id,
        type: memory.type,
        scopeGlob: memory.scopeGlob,
        summary: memory.summary,
        confidence: memory.confidence,
        importance: memory.importance,
        createdAt: memory.createdAt,
        ageDays: getCandidateAgeDays(memory.createdAt),
        lastVerifiedAt: memory.lastVerifiedAt,
        evidenceCount: linkedEvidence.length,
        recentEvidence,
      };
    });
    const sortedEntries = [...entries].sort(
      options.sort === "confidence" ? compareByConfidenceDesc : compareByCreatedDesc
    );

    if (options.json) {
      console.log(JSON.stringify(sortedEntries, null, 2));
      return;
    }

    for (const entry of sortedEntries) {
      console.log(
        [
          entry.id,
          entry.type,
          entry.scopeGlob,
          `confidence=${entry.confidence.toFixed(2)}`,
          `importance=${entry.importance.toFixed(2)}`,
          `evidence=${entry.evidenceCount}`,
          entry.summary,
        ].join("\t")
      );
      for (const evidence of entry.recentEvidence) {
        console.log(
          [
            "  evidence",
            evidence.id,
            evidence.toolName,
            evidence.topicGuess,
            evidence.excerpt,
          ].join("\t")
        );
      }
    }
  } finally {
    db.close();
  }
}

await main();
