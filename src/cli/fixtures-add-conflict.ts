import { ActivationEngine } from "../activation";
import { openSqlJsDatabase, saveSqlJsDatabase } from "../db/sqlite";
import { MemoryRepository } from "../memory";
import { readBundledMigrationSql } from "../runtime/package-paths";

interface CliOptions {
  dbPath: string;
  json: boolean;
}

interface FixtureMemoryInput {
  id: string;
  type: "policy";
  summary: string;
  details: string;
  scopeGlob: string;
  lifecycleTriggers: ["before_model"];
  confidence: number;
  importance: number;
  status: "active" | "stale";
  supersedesMemoryId: string | null;
  createdAt: string;
  updatedAt: string;
  lastVerifiedAt?: string | null;
}

function parseArgs(argv: string[]): CliOptions {
  let dbPath = ".harness-memory/memory.sqlite";
  let json = false;

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
  }

  return { dbPath, json };
}

function ensureSchema(db: Parameters<typeof saveSqlJsDatabase>[0]): void {
  db.exec(readBundledMigrationSql());
  db.run("PRAGMA user_version = 1;");
}

function upsertFixtureMemory(repository: MemoryRepository, input: FixtureMemoryInput) {
  const existing = repository.getById(input.id);

  if (existing === null) {
    return repository.create(input);
  }

  const updated = repository.update(input.id, {
    type: input.type,
    summary: input.summary,
    details: input.details,
    scopeGlob: input.scopeGlob,
    lifecycleTriggers: input.lifecycleTriggers,
    confidence: input.confidence,
    importance: input.importance,
    status: input.status,
    supersedesMemoryId: input.supersedesMemoryId,
    updatedAt: input.updatedAt,
    lastVerifiedAt: input.lastVerifiedAt ?? null,
  });

  if (updated === null) {
    throw new Error(`Failed to update fixture memory ${input.id}`);
  }

  return updated;
}

function ensureEvidence(
  repository: MemoryRepository,
  input: {
    memoryId: string;
    sourceKind: "task";
    sourceRef: string;
    excerpt: string;
    createdAt: string;
  }
) {
  const existing = repository
    .listEvidence(input.memoryId)
    .find(
      (evidence) =>
        evidence.sourceKind === input.sourceKind &&
        evidence.sourceRef === input.sourceRef &&
        evidence.excerpt === input.excerpt
    );

  if (existing !== undefined) {
    return existing;
  }

  return repository.createEvidence(input);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const db = await openSqlJsDatabase(options.dbPath);

  try {
    ensureSchema(db);

    const repository = new MemoryRepository(db);
    const root = upsertFixtureMemory(repository, {
      id: "mem_policy_001",
      type: "policy",
      summary: "Prefer direct SQL inspection before edits",
      details: "Inspect the current database state before changing memory wiring.",
      scopeGlob: "src/**/*.ts",
      lifecycleTriggers: ["before_model"],
      confidence: 0.82,
      importance: 0.74,
      status: "stale",
      supersedesMemoryId: null,
      createdAt: "2026-03-29T00:00:00.000Z",
      updatedAt: "2026-03-29T00:10:00.000Z",
      lastVerifiedAt: "2026-03-29T00:10:00.000Z",
    });
    const firstConflict = upsertFixtureMemory(repository, {
      id: "mem_policy_002",
      type: "policy",
      summary: "Prefer repository helpers over direct SQL inspection",
      details: "Use repository APIs first so replacement history stays explicit.",
      scopeGlob: "src/**/*.ts",
      lifecycleTriggers: ["before_model"],
      confidence: 0.93,
      importance: 0.88,
      status: "active",
      supersedesMemoryId: root.id,
      createdAt: "2026-03-29T00:20:00.000Z",
      updatedAt: "2026-03-29T00:20:00.000Z",
      lastVerifiedAt: "2026-03-29T00:20:00.000Z",
    });
    const secondConflict = upsertFixtureMemory(repository, {
      id: "mem_policy_003",
      type: "policy",
      summary: "Prefer ad hoc SQL for conflict triage",
      details: "Use targeted SQL queries during conflict triage even when helpers exist.",
      scopeGlob: "src/**/*.ts",
      lifecycleTriggers: ["before_model"],
      confidence: 0.91,
      importance: 0.86,
      status: "active",
      supersedesMemoryId: root.id,
      createdAt: "2026-03-29T00:30:00.000Z",
      updatedAt: "2026-03-29T00:30:00.000Z",
      lastVerifiedAt: "2026-03-29T00:30:00.000Z",
    });

    ensureEvidence(repository, {
      memoryId: firstConflict.id,
      sourceKind: "task",
      sourceRef: "fixtures:add-conflict",
      excerpt: "Conflict fixture branch A",
      createdAt: "2026-03-29T00:21:00.000Z",
    });
    ensureEvidence(repository, {
      memoryId: secondConflict.id,
      sourceKind: "task",
      sourceRef: "fixtures:add-conflict",
      excerpt: "Conflict fixture branch B",
      createdAt: "2026-03-29T00:31:00.000Z",
    });

    saveSqlJsDatabase(db, options.dbPath);

    const engine = new ActivationEngine(repository);
    const activation = await engine.activate({
      lifecycleTrigger: "before_model",
      scopeRef: "src/core/repo.ts",
    });
    const output = {
      dbPath: options.dbPath,
      historyMemoryId: root.id,
      created: [root, firstConflict, secondConflict].map((memory) => ({
        id: memory.id,
        status: memory.status,
        supersedesMemoryId: memory.supersedesMemoryId,
        summary: memory.summary,
      })),
      conflicts: activation.conflicts.map((conflict) => ({
        marker: "CONFLICT",
        kind: conflict.kind,
        reason: conflict.reason,
        rootId: conflict.root.id,
        memoryIds: conflict.memories.map((memory) => memory.id),
      })),
    };

    if (options.json) {
      console.log(JSON.stringify(output, null, 2));
      return;
    }

    console.log(`history\t${output.historyMemoryId}`);
    console.log("created");
    for (const memory of output.created) {
      console.log(
        [
          memory.id,
          memory.status,
          `replaces=${memory.supersedesMemoryId ?? "-"}`,
          memory.summary,
        ].join("\t")
      );
    }
    console.log("conflicts");
    for (const conflict of output.conflicts) {
      console.log(
        [
          conflict.marker,
          conflict.kind,
          conflict.rootId,
          conflict.memoryIds.join(",") || "-",
          conflict.reason,
        ].join("\t")
      );
    }
  } finally {
    db.close();
  }
}

await main();
