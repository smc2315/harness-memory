import type { Database as SqlJsDatabase } from "sql.js";

import { ActivationEngine } from "../../../src/activation";
import { EmbeddingService } from "../../../src/activation/embeddings";
import { MemoryRepository } from "../../../src/memory";
import { createTestDb } from "../../helpers/create-test-db";
import type { Tier2MemoryFixture } from "../fixtures/tier2.types";
import type { Tier2EmbeddingRuntime } from "./embedding-runtime";

export interface Tier2SeededFixture {
  db: SqlJsDatabase;
  repository: MemoryRepository;
  engine: ActivationEngine;
  embeddingService: EmbeddingService;
  memoryIdMap: ReadonlyMap<string, string>;
  reverseIdMap: ReadonlyMap<string, string>;
  seedTimeMs: number;
}

export async function createTier2SeededFixture(
  runtime: Tier2EmbeddingRuntime,
  memories: readonly Tier2MemoryFixture[],
): Promise<Tier2SeededFixture> {
  const db = await createTestDb();
  const repository = new MemoryRepository(db);
  const engine = new ActivationEngine(repository, runtime.service);
  const memoryIdMap = new Map<string, string>();
  const reverseIdMap = new Map<string, string>();
  const start = Date.now();

  for (const fixture of memories) {
    const memory = repository.create({
      type: fixture.type,
      summary: fixture.summary,
      details: fixture.details,
      scopeGlob: fixture.scopeGlob,
      lifecycleTriggers: fixture.lifecycleTriggers,
      activationClass: fixture.activationClass,
      confidence: fixture.confidence,
      importance: fixture.importance,
      status: "active",
    });

    const passageText = `${fixture.summary} ${fixture.details}`;
    const embedding = await runtime.service.embedPassage(passageText);
    repository.updateEmbedding(memory.id, embedding);

    const summaryEmbedding = await runtime.service.embedPassage(fixture.summary);
    repository.updateEmbeddingSummary(memory.id, summaryEmbedding);

    memoryIdMap.set(fixture.id, memory.id);
    reverseIdMap.set(memory.id, fixture.id);
  }

  return {
    db,
    repository,
    engine,
    embeddingService: runtime.service,
    memoryIdMap,
    reverseIdMap,
    seedTimeMs: Date.now() - start,
  };
}

export function closeTier2Fixture(fixture: Tier2SeededFixture): void {
  fixture.db.close();
}
