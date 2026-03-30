import { openSqlJsDatabase } from "../db/sqlite";
import { DreamRepository } from "../dream";
import { MemoryRepository } from "../memory";

interface CliOptions {
  dbPath: string;
  memoryId: string;
  json: boolean;
}

interface HistoryOutputEntry {
  relation: string;
  id: string;
  status: string;
  type: string;
  summary: string;
  replacesMemoryId: string | null;
  replacedByMemoryIds: string[];
  createdAt: string;
  updatedAt: string;
  lastVerifiedAt: string | null;
  evidence: {
    id: string;
    sourceKind: string;
    sourceRef: string;
    excerpt: string;
    createdAt: string;
  }[];
  dreamEvidence: {
    id: string;
    status: string;
    toolName: string;
    topicGuess: string;
    excerpt: string;
    createdAt: string;
  }[];
}

function parseArgs(argv: string[]): CliOptions {
  let dbPath = "memory.sqlite";
  let memoryId = "";
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

    if (arg === "--json") {
      json = true;
    }
  }

  if (memoryId.length === 0) {
    throw new Error("Missing required --memory <id> argument");
  }

  return {
    dbPath,
    memoryId,
    json,
  };
}

function buildReplacementIndex(
  entries: readonly {
    memory: {
      id: string;
      supersedesMemoryId: string | null;
    };
  }[]
): Map<string, string[]> {
  const replacementIndex = new Map<string, string[]>();

  for (const entry of entries) {
    if (entry.memory.supersedesMemoryId === null) {
      continue;
    }

    const replacements = replacementIndex.get(entry.memory.supersedesMemoryId) ?? [];
    replacements.push(entry.memory.id);
    replacements.sort((left, right) => left.localeCompare(right));
    replacementIndex.set(entry.memory.supersedesMemoryId, replacements);
  }

  return replacementIndex;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const db = await openSqlJsDatabase(options.dbPath, { requireExists: true });

  try {
    const repository = new MemoryRepository(db);
    const dreamRepository = new DreamRepository(db);
    const lineage = repository.getLineage(options.memoryId);
    const history = repository.getHistory(options.memoryId);
    const replacementIndex = buildReplacementIndex(history);
    const dreamEvidenceByMemoryId = dreamRepository.listLinkedEvidenceByMemoryIds(
      history.map((entry) => entry.memory.id)
    );
    const entries: HistoryOutputEntry[] = history.map((entry) => ({
      relation: entry.relation,
      id: entry.memory.id,
      status: entry.memory.status,
      type: entry.memory.type,
      summary: entry.memory.summary,
      replacesMemoryId: entry.memory.supersedesMemoryId,
      replacedByMemoryIds: replacementIndex.get(entry.memory.id) ?? [],
      createdAt: entry.memory.createdAt,
      updatedAt: entry.memory.updatedAt,
      lastVerifiedAt: entry.memory.lastVerifiedAt,
      evidence: entry.evidence.map((evidence) => ({
        id: evidence.id,
        sourceKind: evidence.sourceKind,
        sourceRef: evidence.sourceRef,
        excerpt: evidence.excerpt,
        createdAt: evidence.createdAt,
      })),
      dreamEvidence: (dreamEvidenceByMemoryId.get(entry.memory.id) ?? []).map((evidence) => ({
        id: evidence.id,
        status: evidence.status,
        toolName: evidence.toolName,
        topicGuess: evidence.topicGuess,
        excerpt: evidence.excerpt,
        createdAt: evidence.createdAt,
      })),
    }));
    const output = {
      memoryId: options.memoryId,
      rootId: lineage.root.id,
      focusId: lineage.focus.id,
      entries,
    };

    if (options.json) {
      console.log(JSON.stringify(output, null, 2));
      return;
    }

    console.log(`root\t${output.rootId}`);
    console.log(`focus\t${output.focusId}`);
    console.log("history");
    for (const entry of output.entries) {
      console.log(
        [
          entry.relation,
          entry.status,
          entry.type,
          entry.id,
          `replaces=${entry.replacesMemoryId ?? "-"}`,
          `replaced_by=${entry.replacedByMemoryIds.join(",") || "-"}`,
          entry.summary,
        ].join("\t")
      );
    }

    console.log("evidence");
    for (const entry of output.entries) {
      for (const evidence of entry.evidence) {
        console.log(
          [
            entry.id,
            evidence.id,
            evidence.sourceKind,
            evidence.sourceRef,
            evidence.excerpt,
          ].join("\t")
        );
      }
    }

    console.log("dream_evidence");
    for (const entry of output.entries) {
      for (const evidence of entry.dreamEvidence) {
        console.log(
          [
            entry.id,
            evidence.id,
            evidence.status,
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
