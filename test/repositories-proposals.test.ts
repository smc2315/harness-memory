import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { Database as SqlJsDatabase } from "sql.js";

import { ProposalAlreadyOpenError, ProposalRepository } from "../src/db/repositories";
import { MemoryRepository } from "../src/memory";
import { createTestDb } from "./helpers/create-test-db";
import { T0, autoMemory, humanMemory, isoPlus } from "./helpers/memory-fixtures";

describe("ProposalRepository", () => {
  let db: SqlJsDatabase;
  let proposals: ProposalRepository;
  let targetId: string;
  let candidateId: string;

  beforeEach(async () => {
    db = await createTestDb();
    proposals = new ProposalRepository(db);
    const memories = new MemoryRepository(db, { clock: () => T0 });
    targetId = memories.create(humanMemory({ summary: "Target" })).id;
    candidateId = memories.create(autoMemory({ summary: "Candidate" })).id;
  });

  afterEach(() => {
    db.close();
  });

  test("create, findOpen, support upsert and derived counts", () => {
    const created = proposals.create({
      kind: "stale",
      targetMemoryId: targetId,
      rationale: "The team moved to vitest",
      confidence: 0.7,
      createdBy: "extractor",
      now: T0,
    });

    expect(created.status).toBe("open");
    expect(created.candidateMemoryId).toBeNull();
    expect(created.expiresAt).toBe(isoPlus(T0, { days: 30 }));
    expect(created.supportCount).toBe(0);
    expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(proposals.findOpen("stale", targetId, null)?.id).toBe(created.id);
    expect(proposals.findOpen("stale", targetId, candidateId)).toBeNull();
    expect(proposals.findOpen("supersede", targetId, null)).toBeNull();

    expect(() =>
      proposals.create({ kind: "stale", targetMemoryId: targetId, rationale: "again", confidence: 0.5, createdBy: "extractor", now: T0 })
    ).toThrow(ProposalAlreadyOpenError);

    proposals.addSupport(created.id, { episodeId: "ep-1", sessionId: "s-1", confidence: 0.7, createdAt: T0, hasHumanSignal: 1 });
    proposals.addSupport(created.id, { episodeId: "ep-1", sessionId: "s-1", confidence: 0.9, createdAt: isoPlus(T0, { minutes: 1 }) });
    proposals.addSupport(created.id, { episodeId: "ep-2", sessionId: "s-1", confidence: 0.6, createdAt: T0 });
    const third = proposals.addSupport(created.id, { episodeId: "ep-3", sessionId: "s-2", confidence: 0.8, createdAt: T0, deterministic: 1 });

    expect(third.deterministic).toBe(1);
    const support = proposals.listSupport(created.id);
    expect(support).toHaveLength(3);
    expect(support.find((row) => row.episodeId === "ep-1")?.confidence).toBe(0.9);
    expect(support.find((row) => row.episodeId === "ep-1")?.hasHumanSignal).toBe(1);

    expect(proposals.getById(created.id)?.supportCount).toBe(0);
    expect(proposals.recomputeDerived(created.id)).toEqual({ supportCount: 3, supportSessions: 2 });
    const refreshed = proposals.getById(created.id);
    expect(refreshed?.supportCount).toBe(3);
    expect(refreshed?.supportSessions).toBe(2);
  });

  test("candidate-bearing proposals are distinct per candidate", () => {
    const a = proposals.create({ kind: "supersede", targetMemoryId: targetId, candidateMemoryId: candidateId, rationale: "r", confidence: 0.8, createdBy: "extractor", now: T0 });
    const b = proposals.create({ kind: "supersede", targetMemoryId: targetId, rationale: "r", confidence: 0.8, createdBy: "consolidator", now: T0 });

    expect(a.id).not.toBe(b.id);
    expect(proposals.findOpen("supersede", targetId, candidateId)?.id).toBe(a.id);
    expect(proposals.findOpen("supersede", targetId, null)?.id).toBe(b.id);
    expect(proposals.listOpen({ kind: "supersede", targetId }).map((p) => p.id)).toEqual([a.id, b.id]);
    expect(proposals.listOpen({ candidateId }).map((p) => p.id)).toEqual([a.id]);
    expect(proposals.listForMemory(candidateId).map((p) => p.id)).toEqual([a.id]);
    expect(proposals.listForMemory(targetId)).toHaveLength(2);
    expect(proposals.countOpen()).toBe(2);
  });

  test("decide records the decision once", () => {
    const created = proposals.create({ kind: "activate_policy", targetMemoryId: targetId, rationale: "r", confidence: 0.9, createdBy: "extractor", now: T0 });
    const decided = proposals.decide(created.id, { status: "accepted", decidedBy: "human", note: "looks right", now: isoPlus(T0, { days: 1 }) });

    expect(decided.status).toBe("accepted");
    expect(decided.decidedBy).toBe("human");
    expect(decided.decidedAt).toBe(isoPlus(T0, { days: 1 }));
    expect(decided.decisionNote).toBe("looks right");
    expect(proposals.findOpen("activate_policy", targetId, null)).toBeNull();
    expect(proposals.countOpen()).toBe(0);
    expect(() => proposals.decide(created.id, { status: "rejected", decidedBy: "human", now: T0 })).toThrow(/already accepted/);
    expect(proposals.listDecided({ status: "accepted" }).map((p) => p.id)).toEqual([created.id]);
    expect(proposals.listDecided({ since: isoPlus(T0, { days: 2 }) })).toEqual([]);
    expect(proposals.listForMemory(targetId, { status: "accepted" })).toHaveLength(1);
  });

  test("expire closes due proposals and a re-proposal succeeds afterwards", () => {
    const soon = proposals.create({ kind: "revalidate", targetMemoryId: targetId, rationale: "ttl", confidence: 0.5, createdBy: "consolidator", now: T0, expiresInDays: 7 });
    const later = proposals.create({ kind: "stale", targetMemoryId: targetId, rationale: "s", confidence: 0.5, createdBy: "extractor", now: T0, expiresAt: isoPlus(T0, { days: 60 }) });

    expect(proposals.countExpiringWithin(T0, 7)).toBe(1);
    expect(proposals.countExpiringWithin(T0, 60)).toBe(2);
    expect(proposals.expire(isoPlus(T0, { days: 6 }))).toEqual([]);
    expect(proposals.expire(isoPlus(T0, { days: 7 }))).toEqual([soon.id]);

    const expired = proposals.getById(soon.id);
    expect(expired?.status).toBe("expired");
    expect(expired?.decidedBy).toBe("expiry");
    expect(expired?.decidedAt).toBe(isoPlus(T0, { days: 7 }));
    expect(proposals.getById(later.id)?.status).toBe("open");

    const again = proposals.create({ kind: "revalidate", targetMemoryId: targetId, rationale: "ttl", confidence: 0.5, createdBy: "consolidator", now: isoPlus(T0, { days: 8 }) });
    expect(again.id).not.toBe(soon.id);
    expect(again.status).toBe("open");
    expect(proposals.listDecided({ kind: "revalidate", targetId }).map((p) => p.id)).toEqual([soon.id]);
  });

  test("validates enum inputs", () => {
    expect(() =>
      proposals.create({ kind: "nuke" as unknown as "stale", targetMemoryId: targetId, rationale: "r", confidence: 0.5, createdBy: "extractor", now: T0 })
    ).toThrow(/kind/);
    expect(() => proposals.addSupport("missing", { episodeId: "e", sessionId: "s", confidence: 0.5, createdAt: T0 })).toThrow(/not found/);
  });
});
