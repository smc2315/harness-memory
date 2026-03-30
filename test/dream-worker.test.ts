import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { Database as SqlJsDatabase } from "sql.js";

import { DreamRepository, DreamWorker } from "../src/dream";
import { MemoryRepository } from "../src/memory";
import { createTestDb } from "./helpers/create-test-db";

describe("DreamWorker", () => {
  let db: SqlJsDatabase;
  let dreamRepository: DreamRepository;
  let memoryRepository: MemoryRepository;
  let worker: DreamWorker;

  beforeEach(async () => {
    db = await createTestDb();
    dreamRepository = new DreamRepository(db);
    memoryRepository = new MemoryRepository(db);
    worker = new DreamWorker(dreamRepository, memoryRepository);
  });

  afterEach(() => {
    db.close();
  });

  test("creates a workflow candidate from repeated evidence", () => {
    dreamRepository.createEvidenceEvent({
      sessionId: "session-1",
      callId: "call-1",
      toolName: "edit",
      scopeRef: "src/core/repo.ts",
      sourceRef: "session-1:call-1:edit",
      title: "Edit completed",
      excerpt: "Updated repository adapter and completed workflow step.",
      args: { path: "src/core/repo.ts" },
      topicGuess: "workflow:edit:src/core/repo.ts",
      typeGuess: "workflow",
      salience: 0.7,
      novelty: 0.8,
      createdAt: "2026-03-29T10:00:00.000Z",
    });
    dreamRepository.createEvidenceEvent({
      sessionId: "session-1",
      callId: "call-2",
      toolName: "edit",
      scopeRef: "src/core/repo.ts",
      sourceRef: "session-1:call-2:edit",
      title: "Edit completed",
      excerpt: "Updated repository adapter and completed workflow step again.",
      args: { path: "src/core/repo.ts" },
      topicGuess: "workflow:edit:src/core/repo.ts",
      typeGuess: "workflow",
      salience: 0.75,
      novelty: 0.75,
      createdAt: "2026-03-29T10:05:00.000Z",
    });

    const result = worker.run({
      trigger: "manual",
      createdAfter: "2026-03-29T09:00:00.000Z",
      now: "2026-03-29T10:30:00.000Z",
    });

    expect(result.suggestions).toHaveLength(1);
    expect(result.suggestions[0]?.type).toBe("workflow");
    expect(result.suggestions[0]?.action).toBe("created");
    expect(result.run.status).toBe("completed");
    expect(dreamRepository.listEvidenceEvents({ status: "consumed" })).toHaveLength(2);
    expect(memoryRepository.list({ status: "candidate" })).toHaveLength(1);
    const linkedEvidence = dreamRepository.listLinkedEvidenceByMemoryIds([
      result.suggestions[0]!.memoryId,
    ]);
    expect(linkedEvidence.get(result.suggestions[0]!.memoryId)).toHaveLength(2);
  });

  test("defers weak single evidence instead of reprocessing it forever", () => {
    const event = dreamRepository.createEvidenceEvent({
      sessionId: "session-2",
      callId: "call-1",
      toolName: "read",
      scopeRef: "src/core/repo.ts",
      sourceRef: "session-2:call-1:read",
      title: "Read completed",
      excerpt: "Read repository file.",
      args: { path: "src/core/repo.ts" },
      topicGuess: "workflow:read:src/core/repo.ts",
      typeGuess: "workflow",
      salience: 0.45,
      novelty: 0.45,
      createdAt: "2026-03-29T11:00:00.000Z",
    });

    const result = worker.run({
      trigger: "manual",
      createdAfter: "2026-03-29T10:00:00.000Z",
      now: "2026-03-29T11:10:00.000Z",
    });

    expect(result.suggestions).toHaveLength(0);
    expect(result.skippedEvidenceIds).toEqual([event.id]);
    expect(result.deferredEvidenceIds).toEqual([event.id]);
    expect(dreamRepository.listEvidenceEvents({ status: "deferred" })).toHaveLength(1);
    expect(memoryRepository.list({ status: "candidate" })).toHaveLength(0);
  });

  test("discards repeatedly deferred weak evidence after retry budget is exhausted", () => {
    const event = dreamRepository.createEvidenceEvent({
      sessionId: "session-3",
      callId: "call-1",
      toolName: "read",
      scopeRef: "src/core/repo.ts",
      sourceRef: "session-3:call-1:read",
      title: "Read completed",
      excerpt: "Read repository file.",
      args: { path: "src/core/repo.ts" },
      topicGuess: "workflow:read:src/core/repo.ts",
      typeGuess: "workflow",
      salience: 0.45,
      novelty: 0.45,
      createdAt: "2026-03-29T11:00:00.000Z",
    });

    worker.run({
      trigger: "manual",
      createdAfter: "2026-03-29T10:00:00.000Z",
      now: "2026-03-29T11:10:00.000Z",
    });
    worker.run({
      trigger: "manual",
      createdAfter: "2026-03-29T10:00:00.000Z",
      now: "2026-03-29T17:20:00.000Z",
    });
    const result = worker.run({
      trigger: "manual",
      createdAfter: "2026-03-29T10:00:00.000Z",
      now: "2026-03-30T05:30:00.000Z",
    });

    expect(result.discardedEvidenceIds).toEqual([event.id]);
    expect(dreamRepository.listEvidenceEvents({ status: "discarded" })).toHaveLength(1);
  });
});
