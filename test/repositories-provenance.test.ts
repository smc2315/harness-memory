import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { Database as SqlJsDatabase } from "sql.js";

import { ProvenanceRepository, deriveAutoConfidence, recomputeDerived } from "../src/db/repositories";
import { SESSION_BLOCK_HOURS } from "../src/db/repositories/provenance";
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

  test("distinct_session_count counts (session_id, 4-hour block of started_at) pairs (0.6.0-rc.2 §4); import rows without an episode count once", () => {
    expect(SESSION_BLOCK_HOURS).toBe(4);
    const memory = memories.create(autoMemory());
    // T0 sits on a block boundary (unix(T0) is a multiple of 4 h), so +1 h / +3 h 59 min share its block and +4 h / +5 h do not.
    const first = insertEpisode(db, { session_id: "s-long", started_at: T0, evidence_weight: 1 });
    const oneHourLater = insertEpisode(db, { session_id: "s-long", started_at: isoPlus(T0, { hours: 1 }), evidence_weight: 1 });
    provenance.insert({ memoryId: memory.id, episodeId: first.id, eventSeq: 1, relation: "origin", confidence: 0.8, createdAt: T0 });
    provenance.insert({ memoryId: memory.id, episodeId: oneHourLater.id, eventSeq: 1, relation: "reinforce", confidence: 0.8, createdAt: isoPlus(T0, { hours: 1 }) });
    expect(provenance.aggregate(memory.id)).toMatchObject({ evidenceCount: 2, evidenceScore: 2, distinctSessionCount: 1 });

    const lastMinuteOfBlock = insertEpisode(db, { session_id: "s-long", started_at: isoPlus(T0, { hours: 3, minutes: 59 }), evidence_weight: 1 });
    provenance.insert({ memoryId: memory.id, episodeId: lastMinuteOfBlock.id, eventSeq: 1, relation: "reinforce", confidence: 0.8, createdAt: isoPlus(T0, { hours: 4 }) });
    expect(provenance.aggregate(memory.id).distinctSessionCount).toBe(1);

    // The same resumed session five hours later is another block: reinforcement the A′ ladder can see.
    const fiveHoursLater = insertEpisode(db, { session_id: "s-long", started_at: isoPlus(T0, { hours: 5 }), evidence_weight: 1 });
    provenance.insert({ memoryId: memory.id, episodeId: fiveHoursLater.id, eventSeq: 1, relation: "reinforce", confidence: 0.8, createdAt: isoPlus(T0, { hours: 5 }) });
    expect(provenance.aggregate(memory.id)).toMatchObject({ evidenceCount: 4, distinctSessionCount: 2 });

    // Another session in the very same block is still another session.
    const otherSession = insertEpisode(db, { session_id: "s-other", started_at: isoPlus(T0, { minutes: 30 }), evidence_weight: 1 });
    provenance.insert({ memoryId: memory.id, episodeId: otherSession.id, eventSeq: 1, relation: "reinforce", confidence: 0.8, createdAt: isoPlus(T0, { hours: 6 }) });
    expect(provenance.aggregate(memory.id).distinctSessionCount).toBe(3);

    // An import bullet has no episodes row: it counts once, by its episode id, as before.
    provenance.insert({ memoryId: memory.id, episodeId: "import:CLAUDE.md", eventSeq: 0, relation: "import", confidence: 0.9, createdAt: isoPlus(T0, { hours: 7 }) });
    provenance.insert({ memoryId: memory.id, episodeId: "import:CLAUDE.md", eventSeq: 0, relation: "import", confidence: 0.9, createdAt: isoPlus(T0, { hours: 8 }) });
    expect(provenance.aggregate(memory.id)).toMatchObject({ evidenceCount: 6, evidenceScore: 6, distinctSessionCount: 4 });

    // A contradict row never counts, whatever its block.
    const contradicting = insertEpisode(db, { session_id: "s-contra", started_at: isoPlus(T0, { days: 1 }), evidence_weight: 2 });
    provenance.insert({ memoryId: memory.id, episodeId: contradicting.id, eventSeq: 1, relation: "contradict", confidence: 0.9, createdAt: isoPlus(T0, { days: 1 }) });
    expect(provenance.aggregate(memory.id).distinctSessionCount).toBe(4);

    expect(recomputeDerived(db, memory.id).distinctSessionCount).toBe(4);
    expect(memories.getById(memory.id)?.distinctSessionCount).toBe(4);
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

  test("hasDecisionOrigin is true only for an origin provenance to a decision-flagged episode (0.6.0-rc.3 §1.1)", () => {
    const decision = insertEpisode(db, { session_id: "s-decide", flags: { decision: 1 }, evidence_weight: 0 });
    const born = memories.create(autoMemory({ summary: "Born from a decision" }));

    // (d) No provenance at all.
    expect(provenance.hasDecisionOrigin(born.id)).toBe(false);

    // (b) The decision episode attached as reinforce or contradict does not count: origin only.
    const reinforced = memories.create(autoMemory({ summary: "Reinforced by a decision" }));
    provenance.insert({ memoryId: reinforced.id, episodeId: decision.id, eventSeq: 1, relation: "reinforce", confidence: 0.8, createdAt: T0 });
    expect(provenance.hasDecisionOrigin(reinforced.id)).toBe(false);
    const contradicted = memories.create(autoMemory({ summary: "Contradicted by a decision" }));
    provenance.insert({ memoryId: contradicted.id, episodeId: decision.id, eventSeq: 1, relation: "contradict", confidence: 0.8, createdAt: T0 });
    expect(provenance.hasDecisionOrigin(contradicted.id)).toBe(false);

    // (a) An origin row pointing at the decision episode; the marker is found wherever it sits in flags_json.
    provenance.insert({ memoryId: born.id, episodeId: decision.id, eventSeq: 2, relation: "origin", confidence: 0.8, createdAt: T0 });
    expect(provenance.hasDecisionOrigin(born.id)).toBe(true);
    const alsoRemembered = memories.create(autoMemory({ summary: "Remembered decision" }));
    const remembered = insertEpisode(db, { session_id: "s-remember", flags: { remember: 1, decision: 1 }, evidence_weight: 3 });
    provenance.insert({ memoryId: alsoRemembered.id, episodeId: remembered.id, eventSeq: 1, relation: "origin", confidence: 0.8, createdAt: T0 });
    expect(provenance.hasDecisionOrigin(alsoRemembered.id)).toBe(true);

    // (c) An origin episode without the marker: no flags, or the correction flag alone.
    const plain = memories.create(autoMemory({ summary: "Plain origin" }));
    const plainEpisode = insertEpisode(db, { session_id: "s-plain", flags: {} });
    provenance.insert({ memoryId: plain.id, episodeId: plainEpisode.id, eventSeq: 1, relation: "origin", confidence: 0.8, createdAt: T0 });
    expect(provenance.hasDecisionOrigin(plain.id)).toBe(false);
    const corrected = memories.create(autoMemory({ summary: "Correction origin" }));
    const correction = insertEpisode(db, { session_id: "s-correct", flags: { correction: 1 }, evidence_weight: 2 });
    provenance.insert({ memoryId: corrected.id, episodeId: correction.id, eventSeq: 1, relation: "origin", confidence: 0.8, createdAt: T0 });
    expect(provenance.hasDecisionOrigin(corrected.id)).toBe(false);

    // (e) An origin row whose episode is unknown (import bullet): there is no flags_json to read the marker from.
    const imported = memories.create(autoMemory({ summary: "Imported origin" }));
    provenance.insert({ memoryId: imported.id, episodeId: "import:CLAUDE.md", eventSeq: 0, relation: "origin", confidence: 0.9, createdAt: T0 });
    expect(provenance.hasDecisionOrigin(imported.id)).toBe(false);
  });
});
