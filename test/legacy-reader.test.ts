/**
 * dream/legacy-reader: archived v0.5 dream tables (migration 021) for `memory:history`.
 * The real v9 fixture carries 75 legacy evidence events but no links, so a link is added by the test.
 */

import { describe, expect, test } from "vitest";

import { countLegacyLinkedMemories, hasLegacyTables, readLegacyHistory } from "../src/dream/legacy-reader";
import { selectAll } from "../src/db/sql";
import { LEGACY_FIXTURES, TEST_NOW, createTestDb, createTestDbFromFixture } from "./helpers/create-test-db";

describe("readLegacyHistory", () => {
  test("v9 fixture: a linked memory returns its evidence events and dream runs", async () => {
    const db = await createTestDbFromFixture(LEGACY_FIXTURES.v9);
    expect(hasLegacyTables(db)).toBe(true);
    const memoryId = String(selectAll(db, "SELECT id FROM memories ORDER BY created_at ASC LIMIT 1")[0]!.id);
    const events = selectAll(db, "SELECT id FROM legacy_dream_evidence_events ORDER BY created_at ASC LIMIT 2").map((row) => String(row.id));
    expect(events).toHaveLength(2);
    db.run(
      `INSERT INTO legacy_dream_runs (id, trigger, status, window_start, window_end, evidence_count, candidate_count, summary, created_at, completed_at)
       VALUES ('run-legacy', 'manual', 'completed', ?, ?, 2, 1, 'legacy run', ?, ?)`,
      [TEST_NOW, TEST_NOW, TEST_NOW, TEST_NOW]
    );
    for (const eventId of events) {
      db.run("INSERT INTO legacy_dream_memory_evidence_links (evidence_event_id, memory_id, dream_run_id, created_at) VALUES (?, ?, 'run-legacy', ?)", [eventId, memoryId, TEST_NOW]);
    }

    const history = readLegacyHistory(db, memoryId);
    expect(history.available).toBe(true);
    expect(history.memoryId).toBe(memoryId);
    expect(history.links.map((link) => link.evidenceEventId)).toEqual(events);
    expect(history.links.every((link) => link.event !== null && link.event.id === link.evidenceEventId && link.event.excerpt.length > 0)).toBe(true);
    expect(history.runs).toEqual([expect.objectContaining({ id: "run-legacy", trigger: "manual", status: "completed", evidenceCount: 2, summary: "legacy run" })]);
    expect(countLegacyLinkedMemories(db)).toBe(1);
    db.close();
  });

  test("a memory without links yields empty lists but available=true", async () => {
    const db = await createTestDbFromFixture(LEGACY_FIXTURES.v10);
    const history = readLegacyHistory(db, "no-such-memory");
    expect(history).toEqual({ memoryId: "no-such-memory", available: true, links: [], runs: [] });
    db.close();
  });

  test("a database without the archived tables reports available=false", async () => {
    const db = await createTestDb();
    db.run("DROP TABLE legacy_dream_memory_evidence_links");
    expect(hasLegacyTables(db)).toBe(false);
    expect(readLegacyHistory(db, "x")).toEqual({ memoryId: "x", available: false, links: [], runs: [] });
    expect(countLegacyLinkedMemories(db)).toBe(0);
    db.close();
  });
});
