import { openSqlJsDatabase } from "../db/sqlite";
import { DreamRepository } from "../dream";
import { MemoryRepository } from "../memory";

interface CliOptions {
  dbPath: string;
  limit?: number;
  json: boolean;
}

interface CandidateReviewEntry {
  id: string;
  type: string;
  scopeGlob: string;
  summary: string;
  confidence: number;
  importance: number;
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
    const memoryRepository = new MemoryRepository(db);
    const dreamRepository = new DreamRepository(db);
    const candidates = memoryRepository.list({ status: "candidate", limit: options.limit });
    const linkedEvidenceByMemoryId = dreamRepository.listLinkedEvidenceByMemoryIds(
      candidates.map((memory) => memory.id)
    );

    const entries: CandidateReviewEntry[] = candidates.map((memory) => {
      const matchingEvidence = (linkedEvidenceByMemoryId.get(memory.id) ?? [])
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
        lastVerifiedAt: memory.lastVerifiedAt,
        evidenceCount: matchingEvidence.length,
        recentEvidence: matchingEvidence,
      };
    });

    if (options.json) {
      console.log(JSON.stringify(entries, null, 2));
      return;
    }

    for (const entry of entries) {
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
