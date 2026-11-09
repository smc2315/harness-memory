import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { Database as SqlJsDatabase } from "sql.js";

import { META_KEYS, MetaRepository, TransitionRepository, WriteOpsRepository } from "../src/db/repositories";
import { MemoryRepository } from "../src/memory";
import { createTestDb } from "./helpers/create-test-db";
import { T0, humanMemory, isoPlus } from "./helpers/memory-fixtures";

describe("MetaRepository", () => {
  let db: SqlJsDatabase;
  let meta: MetaRepository;

  beforeEach(async () => {
    db = await createTestDb();
    meta = new MetaRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  test("get/set/delete and getAll", () => {
    expect(meta.get("missing")).toBeNull();
    meta.set(META_KEYS.lastProbeResult, "ok");
    meta.set(META_KEYS.lastProbeResult, "not_logged_in");
    expect(meta.get(META_KEYS.lastProbeResult)).toBe("not_logged_in");
    // createTestDb may also run post-migrate (semantic_key_backfill = '1'), so only assert our keys.
    expect(meta.getAll()).toMatchObject({ db_generation: "0", last_probe_result: "not_logged_in" });
    meta.delete(META_KEYS.lastProbeResult);
    expect(meta.get(META_KEYS.lastProbeResult)).toBeNull();
    expect(meta.getAll()).not.toHaveProperty("last_probe_result");
  });

  test("generation starts at 0 (migration 018 seed) and bumps by one", () => {
    expect(meta.getGeneration()).toBe(0);
    expect(meta.bumpGeneration()).toBe(1);
    expect(meta.bumpGeneration()).toBe(2);
    expect(meta.get(META_KEYS.dbGeneration)).toBe("2");
    meta.set(META_KEYS.dbGeneration, "garbage");
    expect(meta.getGeneration()).toBe(0);
    meta.delete(META_KEYS.dbGeneration);
    expect(meta.bumpGeneration()).toBe(1);
  });
});

describe("WriteOpsRepository", () => {
  let db: SqlJsDatabase;
  let writeOps: WriteOpsRepository;

  beforeEach(async () => {
    db = await createTestDb();
    writeOps = new WriteOpsRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  test("has/insert are idempotent per id", () => {
    expect(writeOps.has("run-1")).toBe(false);
    expect(writeOps.insert("run-1", "run", 3, T0)).toBe(true);
    expect(writeOps.has("run-1")).toBe(true);
    expect(writeOps.insert("run-1", "run", 4, isoPlus(T0, { minutes: 1 }))).toBe(false);
    expect(writeOps.get("run-1")).toEqual({ id: "run-1", kind: "run", generation: 3, appliedAt: T0 });
    expect(writeOps.insert("dream:2026-11-08T00:00:00.000Z", "dream", 4, isoPlus(T0, { minutes: 2 }))).toBe(true);
    expect(writeOps.listRecent(5).map((op) => op.id)).toEqual(["dream:2026-11-08T00:00:00.000Z", "run-1"]);
    expect(writeOps.get("missing")).toBeNull();
  });
});

describe("TransitionRepository", () => {
  let db: SqlJsDatabase;
  let transitions: TransitionRepository;
  let memoryId: string;

  beforeEach(async () => {
    db = await createTestDb();
    transitions = new TransitionRepository(db);
    memoryId = new MemoryRepository(db, { clock: () => T0 }).create(humanMemory()).id;
  });

  afterEach(() => {
    db.close();
  });

  test("insert and list in chronological order", () => {
    const first = transitions.insert({ memoryId, fromStatus: "candidate", toStatus: "active", actor: "human", reason: "promote", createdAt: T0 });
    const second = transitions.insert({
      id: "tr-fixed",
      memoryId,
      fromStatus: "active",
      toStatus: "stale",
      actor: "expiry",
      proposalId: "prop-1",
      extractionRunId: "run-1",
      reason: "ttl_expired",
      createdAt: isoPlus(T0, { days: 30 }),
    });

    expect(first.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(first.proposalId).toBeNull();
    expect(second.id).toBe("tr-fixed");
    expect(second.proposalId).toBe("prop-1");
    expect(second.extractionRunId).toBe("run-1");
    expect(transitions.listForMemory(memoryId)).toEqual([first, second]);
    expect(transitions.listRecent(1)).toEqual([second]);
    expect(() => transitions.insert({ memoryId, fromStatus: "candidate", toStatus: "active", actor: "robot" as unknown as "human", reason: "x", createdAt: T0 })).toThrow(/actor/);
    expect(() => transitions.insert({ memoryId: "missing", fromStatus: "candidate", toStatus: "active", actor: "human", reason: "x", createdAt: T0 })).toThrow();
  });
});
