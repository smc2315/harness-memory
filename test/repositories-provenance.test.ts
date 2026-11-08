import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { Database as SqlJsDatabase } from "sql.js";

import { ProvenanceRepository, deriveAutoConfidence, recomputeDerived } from "../src/db/repositories";
import { MemoryNotFoundError, MemoryRepository } from "../src/memory";
import { createTestDb } from "./helpers/create-test-db";
import { T0, autoMemory, humanMemory, insertEpisode, isoPlus } from "./helpers/memory-fixtures";

describe("ProvenanceRepository / recomputeDerived (R1)", () => {
  let db: SqlJsDatabase;
  let provenance: ProvenanceRepository;
  let memories: MemoryRepository;

  beforeEach(async () => {
    db = await createTestDb();
    provenance = new ProvenanceRepository(db);
    memories = new MemoryRepository(db, { clock: () => T0 });
  });

  afterEach(() => {
    db.close();
  });

  test("insert is INSERT OR IGNORE and truncates the excerpt", () => {
    const memory = memories.create(autoMemory());
    const inserted = provenance.insert({
      memoryId: memory.id,
      episodeId: "ep-1",
      eventSeq: 3,
      relation: "origin",
      confidence: 0.8,
      excerpt: "x".repeat(700),
      extractionRunId: "run-1",
      createdAt: T0,
    });

    expect(inserted).toBe(true);
    expect(provenance.insert({ memoryId: memory.id, episodeId: "ep-1", eventSeq: 3, relation: "origin", confidence: 0.9, createdAt: T0 })).toBe(false);

    const rows = provenance.listForMemory(memory.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].excerpt.length).toBe(500);
    expect(rows[0].confidence).toBe(0.8);
    expect(rows[0].extractionRunId).toBe("run-1");
    expect(provenance.listForEpisode("ep-1")).toEqual(rows);
    expect(() => provenance.insert({ memoryId: memory.id, episodeId: "e", eventSeq: 0, relation: "guess" as unknown as "origin", confidence: 1, createdAt: T0 })).toThrow(/relation/);
  });

  test("aggregate counts distinct evidence episodes, sums their weights and ignores contradict", () => {
    const memory = memories.create(autoMemory());
    const correction = insertEpisode(db, { session_id: "s-1", evidence_weight: 2 });
    const failure = insertEpisode(db, { session_id: "s-2", evidence_weight: 1 });
    const other = insertEpisode(db, { session_id: "s-3", evidence_weight: 5 });

    expect(provenance.aggregate(memory.id)).toEqual({ evidenceCount: 0, evidenceScore: 0, distinctSessionCount: 0, maxConfidence: null });

    provenance.insert({ memoryId: memory.id, episodeId: correction.id, eventSeq: 1, relation: "origin", confidence: 0.8, createdAt: T0 });
    provenance.insert({ memoryId: memory.id, episodeId: correction.id, eventSeq: 4, relation: "origin", confidence: 0.7, createdAt: T0 });
    expect(provenance.aggregate(memory.id)).toEqual({ evidenceCount: 1, evidenceScore: 2, distinctSessionCount: 1, maxConfidence: 0.8 });

    provenance.insert({ memoryId: memory.id, episodeId: failure.id, eventSeq: 2, relation: "reinforce", confidence: 0.6, createdAt: T0 });
    expect(provenance.aggregate(memory.id)).toEqual({ evidenceCount: 2, evidenceScore: 3, distinctSessionCount: 2, maxConfidence: 0.8 });

    provenance.insert({ memoryId: memory.id, episodeId: other.id, eventSeq: 1, relation: "contradict", confidence: 0.95, createdAt: T0 });
    expect(provenance.aggregate(memory.id)).toEqual({ evidenceCount: 2, evidenceScore: 3, distinctSessionCount: 2, maxConfidence: 0.8 });

    provenance.insert({ memoryId: memory.id, episodeId: other.id, eventSeq: 0, relation: "import", confidence: 0.5, createdAt: T0 });
    expect(provenance.aggregate(memory.id)).toEqual({ evidenceCount: 3, evidenceScore: 4, distinctSessionCount: 3, maxConfidence: 0.8 });

    provenance.insert({ memoryId: memory.id, episodeId: "import:CLAUDE.md", eventSeq: 0, relation: "import", confidence: 0.9, createdAt: T0 });
    expect(provenance.aggregate(memory.id)).toEqual({ evidenceCount: 4, evidenceScore: 5, distinctSessionCount: 4, maxConfidence: 0.9 });
  });

  test("recomputeDerived writes counters and raises auto confidence by 0.05 per extra episode, capped at 0.99", () => {
    const memory = memories.create(autoMemory({ confidence: 0.5 }));
    const a = insertEpisode(db, { session_id: "s-1", evidence_weight: 2 });
    const b = insertEpisode(db, { session_id: "s-2", evidence_weight: 1 });

    provenance.insert({ memoryId: memory.id, episodeId: a.id, eventSeq: 1, relation: "origin", confidence: 0.8, createdAt: T0 });
    const first = recomputeDerived(db, memory.id);
    expect(first).toMatchObject({ memoryId: memory.id, authority: "auto", evidenceCount: 1, evidenceScore: 2, distinctSessionCount: 1, maxConfidence: 0.8, confidence: 0.8, confidenceChanged: true });
    let row = memories.getById(memory.id)!;
    expect(row.evidenceCount).toBe(1);
    expect(row.evidenceScore).toBe(2);
    expect(row.confidence).toBeCloseTo(0.8);

    provenance.insert({ memoryId: memory.id, episodeId: b.id, eventSeq: 2, relation: "reinforce", confidence: 0.6, createdAt: isoPlus(T0, { hours: 1 }) });
    const second = recomputeDerived(db, memory.id);
    expect(second.evidenceCount).toBe(2);
    expect(second.evidenceScore).toBe(3);
    expect(second.distinctSessionCount).toBe(2);
    expect(second.confidence).toBeCloseTo(0.85);
    row = memories.getById(memory.id)!;
    expect(row.confidence).toBeCloseTo(0.85);
    expect(row.importance).toBe(0.5);

    const capped = memories.create(autoMemory({ summary: "Capped" }));
    for (let index = 0; index < 6; index += 1) {
      provenance.insert({ memoryId: capped.id, episodeId: `ep-cap-${String(index)}`, eventSeq: 1, relation: "reinforce", confidence: 0.97, createdAt: T0 });
    }
    expect(recomputeDerived(db, capped.id).confidence).toBe(0.99);
    expect(deriveAutoConfidence(0.97, 6)).toBe(0.99);
    expect(deriveAutoConfidence(0.7, 1)).toBeCloseTo(0.7);
    expect(deriveAutoConfidence(0.7, 0)).toBeCloseTo(0.7);
  });

  test("human rows keep their confidence; a row without evidence keeps its confidence; missing rows throw", () => {
    const human = memories.create(humanMemory({ confidence: 0.9 }));
    const episode = insertEpisode(db, { evidence_weight: 2 });
    provenance.insert({ memoryId: human.id, episodeId: episode.id, eventSeq: 1, relation: "reinforce", confidence: 0.3, createdAt: T0 });

    const result = recomputeDerived(db, human.id);
    expect(result.authority).toBe("human");
    expect(result.evidenceCount).toBe(1);
    expect(result.evidenceScore).toBe(2);
    expect(result.confidence).toBe(0.9);
    expect(result.confidenceChanged).toBe(false);
    expect(memories.getById(human.id)?.confidence).toBe(0.9);
    expect(memories.getById(human.id)?.evidenceCount).toBe(1);

    const bare = memories.create(autoMemory({ confidence: 0.65 }));
    expect(recomputeDerived(db, bare.id).confidence).toBe(0.65);
    expect(() => recomputeDerived(db, "missing")).toThrow(MemoryNotFoundError);
  });
});
