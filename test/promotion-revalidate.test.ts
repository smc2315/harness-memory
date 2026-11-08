import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { Database as SqlJsDatabase } from "sql.js";

import { MemoryRepository } from "../src/memory";
import {
  baseTtlDays,
  computeRevalidation,
  extendTtlOnFire,
  revalidateMemory,
  trustMultiplier,
  ttlDays,
} from "../src/promotion";
import { createTestDb } from "./helpers/create-test-db";
import { T0, autoMemory, humanMemory, isoPlus } from "./helpers/memory-fixtures";

describe("TTL math", () => {
  test("ttlDays doubles from 7 and caps at 90", () => {
    expect(ttlDays(0)).toBe(7);
    expect(ttlDays(1)).toBe(14);
    expect(ttlDays(2)).toBe(28);
    expect(ttlDays(3)).toBe(56);
    expect(ttlDays(4)).toBe(90);
    expect(ttlDays(10)).toBe(90);
    expect(ttlDays(-3)).toBe(7);
  });

  test("baseTtlDays is 30 for correction / failure_resolution and 7 otherwise", () => {
    expect(baseTtlDays("correction")).toBe(30);
    expect(baseTtlDays("failure_resolution")).toBe(30);
    expect(baseTtlDays("convention")).toBe(7);
    expect(baseTtlDays("decision")).toBe(7);
    expect(baseTtlDays("import")).toBe(7);
    expect(baseTtlDays(null)).toBe(7);
    expect(baseTtlDays(undefined)).toBe(7);
  });

  test("trustMultiplier follows §6.4", () => {
    expect(trustMultiplier("human", 0)).toBe(1);
    expect(trustMultiplier("human", 5)).toBe(1);
    expect(trustMultiplier("auto", 0)).toBe(0.65);
    expect(trustMultiplier("auto", 1)).toBe(0.8);
    expect(trustMultiplier("auto", 2)).toBe(0.95);
    expect(trustMultiplier("auto", 7)).toBe(0.95);
  });

  test("computeRevalidation never shrinks the TTL (D4)", () => {
    const fresh = computeRevalidation({ evidenceCount: 1, knowledgeKind: "correction", ttlExpiresAt: null, revalidateAfter: null }, T0);
    expect(fresh.validationCount).toBe(0);
    expect(fresh.days).toBe(30);
    expect(fresh.ttlExpiresAt).toBe(isoPlus(T0, { days: 30 }));
    expect(fresh.revalidateAfter).toBe(isoPlus(T0, { days: 15 }));

    const convention = computeRevalidation({ evidenceCount: 3, knowledgeKind: "convention", ttlExpiresAt: null, revalidateAfter: null }, T0);
    expect(convention.validationCount).toBe(2);
    expect(convention.days).toBe(28);

    const far = isoPlus(T0, { days: 80 });
    const kept = computeRevalidation({ evidenceCount: 2, knowledgeKind: "convention", ttlExpiresAt: far, revalidateAfter: isoPlus(T0, { days: 70 }) }, T0);
    expect(kept.ttlExpiresAt).toBe(far);
    expect(kept.revalidateAfter).toBe(isoPlus(T0, { days: 70 }));
  });
});

describe("revalidateMemory / extendTtlOnFire", () => {
  let db: SqlJsDatabase;
  let memories: MemoryRepository;

  beforeEach(async () => {
    db = await createTestDb();
    memories = new MemoryRepository(db, { clock: () => T0 });
  });

  afterEach(() => {
    db.close();
  });

  test("revalidates an auto active row from its evidence count and never shrinks an existing TTL", () => {
    const memory = memories.create(autoMemory({ status: "active", knowledgeKind: "convention", ttlExpiresAt: isoPlus(T0, { days: 7 }), revalidateAfter: isoPlus(T0, { days: 3 }) }));
    memories.updateDerived(memory.id, { evidenceScore: 4, evidenceCount: 3, distinctSessionCount: 2 });
    const now = isoPlus(T0, { days: 2 });
    const closedAt = isoPlus(T0, { days: 2, hours: -1 });

    const result = revalidateMemory(db, memory.id, { now, closedAt });

    expect(result.applied).toBe(true);
    expect(result.skipped).toBeNull();
    expect(result.memory?.validationCount).toBe(2);
    expect(result.memory?.ttlExpiresAt).toBe(isoPlus(now, { days: 28 }));
    expect(result.memory?.revalidateAfter).toBe(isoPlus(now, { days: 14 }));
    expect(result.memory?.lastVerifiedAt).toBe(closedAt);
    expect(result.memory?.updatedAt).toBe(now);
    expect(result.memory?.status).toBe("active");

    const later = isoPlus(now, { days: 1 });
    const again = revalidateMemory(db, memory.id, { now: later, closedAt: later });
    expect(again.memory?.ttlExpiresAt).toBe(isoPlus(later, { days: 28 }));

    const farTtl = isoPlus(T0, { days: 85 });
    memories.setTtl(memory.id, { ttlExpiresAt: farTtl, revalidateAfter: isoPlus(T0, { days: 60 }) });
    const kept = revalidateMemory(db, memory.id, { now: later, closedAt: later });
    expect(kept.memory?.ttlExpiresAt).toBe(farTtl);
    expect(kept.memory?.revalidateAfter).toBe(isoPlus(T0, { days: 60 }));
  });

  test("correction-derived rows get at least 30 days and stale(ttl_expired) rows are revalidated too", () => {
    const correction = memories.create(autoMemory({ status: "active", knowledgeKind: "correction" }));
    memories.updateDerived(correction.id, { evidenceScore: 2, evidenceCount: 1, distinctSessionCount: 1 });
    const result = revalidateMemory(db, correction.id, { now: T0, closedAt: T0 });
    expect(result.memory?.validationCount).toBe(0);
    expect(result.memory?.ttlExpiresAt).toBe(isoPlus(T0, { days: 30 }));

    const stale = memories.create(autoMemory({ status: "stale", summary: "Stale auto", statusReason: "ttl_expired", ttlExpiresAt: isoPlus(T0, { days: -1 }) }));
    const revived = revalidateMemory(db, stale.id, { now: T0, closedAt: T0 });
    expect(revived.applied).toBe(true);
    expect(revived.memory?.ttlExpiresAt).toBe(isoPlus(T0, { days: 30 }));
    expect(revived.memory?.status).toBe("stale");
  });

  test("skips human rows, candidates and missing rows without writing", () => {
    const human = memories.create(humanMemory());
    const candidate = memories.create(autoMemory());

    expect(revalidateMemory(db, human.id, { now: T0, closedAt: T0 })).toMatchObject({ applied: false, skipped: "human" });
    expect(memories.getById(human.id)).toEqual(human);
    expect(revalidateMemory(db, candidate.id, { now: T0, closedAt: T0 })).toMatchObject({ applied: false, skipped: "status" });
    expect(memories.getById(candidate.id)).toEqual(candidate);
    expect(revalidateMemory(db, "missing", { now: T0, closedAt: T0 })).toEqual({ applied: false, skipped: "not_found", memory: null });
  });

  test("extendTtlOnFire pushes the TTL to last_fired_at + 14 d but never back", () => {
    const memory = memories.create(autoMemory({ status: "active", ttlExpiresAt: isoPlus(T0, { days: 3 }), revalidateAfter: isoPlus(T0, { days: 1 }) }));

    const extended = extendTtlOnFire(db, memory.id, { lastFiredAt: T0 });
    expect(extended.applied).toBe(true);
    expect(extended.memory?.ttlExpiresAt).toBe(isoPlus(T0, { days: 14 }));
    expect(extended.memory?.revalidateAfter).toBe(isoPlus(T0, { days: 7 }));

    const unchanged = extendTtlOnFire(db, memory.id, { lastFiredAt: isoPlus(T0, { days: -5 }) });
    expect(unchanged.applied).toBe(false);
    expect(unchanged.skipped).toBeNull();
    expect(unchanged.memory?.ttlExpiresAt).toBe(isoPlus(T0, { days: 14 }));

    const noTtl = memories.create(autoMemory({ status: "active", summary: "No TTL yet" }));
    expect(extendTtlOnFire(db, noTtl.id, { lastFiredAt: T0 }).memory?.ttlExpiresAt).toBe(isoPlus(T0, { days: 14 }));

    const human = memories.create(humanMemory());
    expect(extendTtlOnFire(db, human.id, { lastFiredAt: T0 })).toMatchObject({ applied: false, skipped: "human" });
    const candidate = memories.create(autoMemory());
    expect(extendTtlOnFire(db, candidate.id, { lastFiredAt: T0 })).toMatchObject({ applied: false, skipped: "status" });
    expect(extendTtlOnFire(db, "missing", { lastFiredAt: T0 }).skipped).toBe("not_found");
  });
});
