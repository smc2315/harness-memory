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

  test("creates evidence event with explicit salienceBoost", () => {
    const event = dreamRepository.createEvidenceEvent({
      sessionId: "session-boost",
      callId: "call-1",
      toolName: "bash",
      scopeRef: "src/main.ts",
      sourceRef: "session-boost:call-1:bash",
      title: "Milestone reached",
      excerpt: "Build passed after major refactor.",
      args: {},
      topicGuess: "workflow:src/main.ts:verified-flow",
      typeGuess: "workflow",
      salience: 0.7,
      novelty: 0.8,
      salienceBoost: 0.2,
      createdAt: "2026-03-31T10:00:00.000Z",
    });
    expect(event.salienceBoost).toBe(0.2);

    const fetched = dreamRepository.getEvidenceEventById(event.id);
    expect(fetched?.salienceBoost).toBe(0.2);
  });

  test("defaults salienceBoost to 0 when not provided", () => {
    const event = dreamRepository.createEvidenceEvent({
      sessionId: "session-no-boost",
      callId: "call-1",
      toolName: "edit",
      scopeRef: "src/main.ts",
      sourceRef: "session-no-boost:call-1:edit",
      title: "Edit done",
      excerpt: "Updated file.",
      args: {},
      topicGuess: "workflow:src/main.ts:edit",
      typeGuess: "workflow",
      salience: 0.5,
      novelty: 0.6,
      createdAt: "2026-03-31T11:00:00.000Z",
    });
    expect(event.salienceBoost).toBe(0);
  });

  test("boosted evidence contributes to higher aggregate score", () => {
    const boostedAlpha = dreamRepository.createEvidenceEvent({
      sessionId: "session-boosted-threshold",
      callId: "call-1",
      toolName: "bash",
      scopeRef: "src/services/alpha.ts",
      sourceRef: "session-boosted-threshold:call-1:bash",
      title: "Build passed",
      excerpt: "Build passed after changes.",
      args: { path: "src/services/alpha.ts" },
      topicGuess: "workflow:src/services/alpha.ts:build",
      typeGuess: "workflow",
      salience: 0.65,
      novelty: 0.7,
      salienceBoost: 0.2,
      createdAt: "2026-03-31T12:00:00.000Z",
    });
    const boostedBeta = dreamRepository.createEvidenceEvent({
      sessionId: "session-boosted-threshold",
      callId: "call-2",
      toolName: "bash",
      scopeRef: "src/services/beta.ts",
      sourceRef: "session-boosted-threshold:call-2:bash",
      title: "Build passed",
      excerpt: "Build passed after changes.",
      args: { path: "src/services/beta.ts" },
      topicGuess: "workflow:src/services/beta.ts:build",
      typeGuess: "workflow",
      salience: 0.65,
      novelty: 0.7,
      salienceBoost: 0.2,
      createdAt: "2026-03-31T12:01:00.000Z",
    });
    const plainGamma = dreamRepository.createEvidenceEvent({
      sessionId: "session-unboosted-threshold",
      callId: "call-1",
      toolName: "read",
      scopeRef: "src/services/gamma.ts",
      sourceRef: "session-unboosted-threshold:call-1:read",
      title: "Read completed",
      excerpt: "Read file.",
      args: { path: "src/services/gamma.ts" },
      topicGuess: "workflow:src/services/gamma.ts:read",
      typeGuess: "workflow",
      salience: 0.5,
      novelty: 0.5,
      createdAt: "2026-03-31T12:02:00.000Z",
    });
    const plainDelta = dreamRepository.createEvidenceEvent({
      sessionId: "session-unboosted-threshold",
      callId: "call-2",
      toolName: "read",
      scopeRef: "src/services/delta.ts",
      sourceRef: "session-unboosted-threshold:call-2:read",
      title: "Read completed",
      excerpt: "Read file.",
      args: { path: "src/services/delta.ts" },
      topicGuess: "workflow:src/services/delta.ts:read",
      typeGuess: "workflow",
      salience: 0.5,
      novelty: 0.5,
      createdAt: "2026-03-31T12:03:00.000Z",
    });

    const result = worker.run({
      trigger: "manual",
      createdAfter: "2026-03-31T11:59:00.000Z",
      now: "2026-03-31T12:10:00.000Z",
    });

    expect(result.suggestions).toHaveLength(2);
    expect(result.deferredEvidenceIds).toHaveLength(2);
    expect(result.consumedEvidenceIds.sort()).toEqual([boostedAlpha.id, boostedBeta.id].sort());
    expect(result.deferredEvidenceIds.sort()).toEqual([plainGamma.id, plainDelta.id].sort());
    const deferredEvents = dreamRepository.listEvidenceEvents({ status: "deferred" });
    expect(deferredEvents).toHaveLength(2);
    expect(deferredEvents.every((event) => event.salienceBoost === 0)).toBe(true);
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

  test("infers relevantTools from evidence tool names", () => {
    dreamRepository.createEvidenceEvent({
      sessionId: "session-tools",
      callId: "call-1",
      toolName: "edit",
      scopeRef: "src/core/repo.ts",
      sourceRef: "session-tools:call-1:edit",
      title: "Edit completed",
      excerpt: "Adjusted repository implementation details.",
      args: { path: "src/core/repo.ts" },
      topicGuess: "workflow:edit:src/core/repo.ts",
      typeGuess: "workflow",
      salience: 0.7,
      novelty: 0.8,
      createdAt: "2026-03-29T12:00:00.000Z",
    });
    dreamRepository.createEvidenceEvent({
      sessionId: "session-tools",
      callId: "call-2",
      toolName: "edit",
      scopeRef: "src/core/repo.ts",
      sourceRef: "session-tools:call-2:edit",
      title: "Edit completed",
      excerpt: "Finished repository implementation updates.",
      args: { path: "src/core/repo.ts" },
      topicGuess: "workflow:edit:src/core/repo.ts",
      typeGuess: "workflow",
      salience: 0.75,
      novelty: 0.75,
      createdAt: "2026-03-29T12:05:00.000Z",
    });

    const result = worker.run({
      trigger: "manual",
      createdAfter: "2026-03-29T11:00:00.000Z",
      now: "2026-03-29T12:30:00.000Z",
    });

    expect(result.suggestions).toHaveLength(1);
    const candidate = memoryRepository.getById(result.suggestions[0]!.memoryId);
    expect(candidate).not.toBeNull();
    expect(candidate!.relevantTools).toEqual(["edit"]);
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

  test("updated candidate includes previous summary in details", () => {
    dreamRepository.createEvidenceEvent({
      sessionId: "session-4",
      callId: "call-1",
      toolName: "edit",
      scopeRef: "src/core/repo.ts",
      sourceRef: "session-4:call-1:edit",
      title: "Edit completed",
      excerpt: "Refactored repository adapter pattern.",
      args: { path: "src/core/repo.ts" },
      topicGuess: "workflow:src/core/repo.ts:edit",
      typeGuess: "workflow",
      salience: 0.7,
      novelty: 0.8,
      createdAt: "2026-03-30T10:00:00.000Z",
    });
    dreamRepository.createEvidenceEvent({
      sessionId: "session-4",
      callId: "call-2",
      toolName: "edit",
      scopeRef: "src/core/repo.ts",
      sourceRef: "session-4:call-2:edit",
      title: "Edit completed",
      excerpt: "Completed adapter refactor successfully.",
      args: { path: "src/core/repo.ts" },
      topicGuess: "workflow:src/core/repo.ts:edit",
      typeGuess: "workflow",
      salience: 0.75,
      novelty: 0.75,
      createdAt: "2026-03-30T10:05:00.000Z",
    });

    const firstResult = worker.run({
      trigger: "manual",
      createdAfter: "2026-03-30T09:00:00.000Z",
      now: "2026-03-30T10:30:00.000Z",
    });
    expect(firstResult.suggestions).toHaveLength(1);
    expect(firstResult.suggestions[0]?.action).toBe("created");
    expect(firstResult.suggestions[0]?.previousSummary).toBeNull();

    const firstCandidate = memoryRepository.getById(firstResult.suggestions[0]!.memoryId);
    expect(firstCandidate).not.toBeNull();
    expect(firstCandidate!.details).toContain("Dream consolidation candidate built from recent evidence:");

    dreamRepository.createEvidenceEvent({
      sessionId: "session-5",
      callId: "call-3",
      toolName: "edit",
      scopeRef: "src/core/repo.ts",
      sourceRef: "session-5:call-3:edit",
      title: "Edit completed",
      excerpt: "Added error handling to repository adapter.",
      args: { path: "src/core/repo.ts" },
      topicGuess: "workflow:src/core/repo.ts:edit",
      typeGuess: "workflow",
      salience: 0.7,
      novelty: 0.6,
      createdAt: "2026-03-30T11:00:00.000Z",
    });
    dreamRepository.createEvidenceEvent({
      sessionId: "session-5",
      callId: "call-4",
      toolName: "edit",
      scopeRef: "src/core/repo.ts",
      sourceRef: "session-5:call-4:edit",
      title: "Edit completed",
      excerpt: "Error handling verified and working.",
      args: { path: "src/core/repo.ts" },
      topicGuess: "workflow:src/core/repo.ts:edit",
      typeGuess: "workflow",
      salience: 0.65,
      novelty: 0.55,
      createdAt: "2026-03-30T11:05:00.000Z",
    });

    const secondResult = worker.run({
      trigger: "manual",
      createdAfter: "2026-03-30T10:30:01.000Z",
      now: "2026-03-30T11:30:00.000Z",
    });
    expect(secondResult.suggestions).toHaveLength(1);
    expect(secondResult.suggestions[0]?.action).toBe("updated");
    expect(secondResult.suggestions[0]?.previousSummary).not.toBeNull();

    const updatedCandidate = memoryRepository.getById(secondResult.suggestions[0]!.memoryId);
    expect(updatedCandidate).not.toBeNull();
    expect(updatedCandidate!.details).toContain("Previous understanding:");
    expect(updatedCandidate!.details).toContain("New evidence:");
  });

  test("newly created candidate has no previous summary", () => {
    dreamRepository.createEvidenceEvent({
      sessionId: "session-6",
      callId: "call-1",
      toolName: "bash",
      scopeRef: "src/api/handler.ts",
      sourceRef: "session-6:call-1:bash",
      title: "Test passed",
      excerpt: "All API handler tests passed successfully.",
      args: {},
      topicGuess: "workflow:src/api/handler.ts:verified-flow",
      typeGuess: "workflow",
      salience: 0.8,
      novelty: 0.9,
      createdAt: "2026-03-30T12:00:00.000Z",
    });
    dreamRepository.createEvidenceEvent({
      sessionId: "session-6",
      callId: "call-2",
      toolName: "bash",
      scopeRef: "src/api/handler.ts",
      sourceRef: "session-6:call-2:bash",
      title: "Build passed",
      excerpt: "Build completed without errors.",
      args: {},
      topicGuess: "workflow:src/api/handler.ts:verified-flow",
      typeGuess: "workflow",
      salience: 0.75,
      novelty: 0.85,
      createdAt: "2026-03-30T12:05:00.000Z",
    });

    const result = worker.run({
      trigger: "manual",
      createdAfter: "2026-03-30T11:00:00.000Z",
      now: "2026-03-30T12:30:00.000Z",
    });

    expect(result.suggestions).toHaveLength(1);
    expect(result.suggestions[0]?.action).toBe("created");
    expect(result.suggestions[0]?.previousSummary).toBeNull();
  });
});
