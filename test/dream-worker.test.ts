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

  function createEvidenceEvent(input: {
    sessionId: string;
    callId: string;
    toolName: string;
    scopeRef: string;
    title: string;
    excerpt: string;
    args?: unknown;
    topicGuess: string;
    typeGuess: "workflow" | "policy" | "pitfall" | "architecture_constraint" | "decision";
    salience?: number;
    novelty?: number;
    salienceBoost?: number;
    contradictionSignal?: boolean;
    createdAt: string;
  }) {
    return dreamRepository.createEvidenceEvent({
      sessionId: input.sessionId,
      callId: input.callId,
      toolName: input.toolName,
      scopeRef: input.scopeRef,
      sourceRef: `${input.sessionId}:${input.callId}:${input.toolName}`,
      title: input.title,
      excerpt: input.excerpt,
      args: input.args ?? {},
      topicGuess: input.topicGuess,
      typeGuess: input.typeGuess,
      salience: input.salience ?? 0.6,
      novelty: input.novelty ?? 0.6,
      salienceBoost: input.salienceBoost,
      contradictionSignal: input.contradictionSignal,
      createdAt: input.createdAt,
    });
  }

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
    const event = createEvidenceEvent({
      sessionId: "session-boost",
      callId: "call-1",
      toolName: "bash",
      scopeRef: "src/main.ts",
      title: "Milestone reached",
      excerpt: "Build passed after major refactor.",
      topicGuess: "workflow:src/main.ts:verified-flow",
      typeGuess: "workflow",
      salience: 0.7,
      novelty: 0.8,
      salienceBoost: 0.2,
      createdAt: "2026-03-31T10:00:00.000Z",
    });

    expect(event.salienceBoost).toBe(0.2);
    expect(dreamRepository.getEvidenceEventById(event.id)?.salienceBoost).toBe(0.2);
  });

  test("defaults salienceBoost to 0 when not provided", () => {
    const event = createEvidenceEvent({
      sessionId: "session-no-boost",
      callId: "call-1",
      toolName: "edit",
      scopeRef: "src/main.ts",
      title: "Edit done",
      excerpt: "Updated file.",
      topicGuess: "workflow:src/main.ts:edit",
      typeGuess: "workflow",
      salience: 0.5,
      novelty: 0.6,
      createdAt: "2026-03-31T11:00:00.000Z",
    });

    expect(event.salienceBoost).toBe(0);
  });

  test("materializes tagged evidence and leaves weak singleton evidence latent", () => {
    const materializedA = createEvidenceEvent({
      sessionId: "session-tagged-a",
      callId: "call-1",
      toolName: "bash",
      scopeRef: "src/services/alpha.ts",
      title: "Build passed",
      excerpt: "Build passed after changes.",
      args: { path: "src/services/alpha.ts" },
      topicGuess: "workflow:src/services/alpha.ts:build",
      typeGuess: "workflow",
      createdAt: "2026-03-31T12:00:00.000Z",
    });
    const materializedB = createEvidenceEvent({
      sessionId: "session-tagged-b",
      callId: "call-1",
      toolName: "bash",
      scopeRef: "src/services/beta.ts",
      title: "Fix completed",
      excerpt: "Completed build verification successfully.",
      args: { path: "src/services/beta.ts" },
      topicGuess: "workflow:src/services/beta.ts:build",
      typeGuess: "workflow",
      createdAt: "2026-03-31T12:01:00.000Z",
    });
    const latentA = createEvidenceEvent({
      sessionId: "session-latent-a",
      callId: "call-1",
      toolName: "read",
      scopeRef: "notes/todo.txt",
      title: "Observation",
      excerpt: "Looked around.",
      args: [],
      topicGuess: "workflow:notes/todo.txt:observation",
      typeGuess: "workflow",
      createdAt: "2026-03-31T12:02:00.000Z",
    });
    const latentB = createEvidenceEvent({
      sessionId: "session-latent-b",
      callId: "call-1",
      toolName: "read",
      scopeRef: "notes/ideas.txt",
      title: "Observation",
      excerpt: "Looked around.",
      args: [],
      topicGuess: "workflow:notes/ideas.txt:observation",
      typeGuess: "workflow",
      createdAt: "2026-03-31T12:03:00.000Z",
    });

    const result = worker.run({
      trigger: "manual",
      createdAfter: "2026-03-31T11:59:00.000Z",
      now: "2026-03-31T12:10:00.000Z",
    });

    expect(result.suggestions).toHaveLength(2);
    expect(result.materializedEvidenceIds.sort()).toEqual([materializedA.id, materializedB.id].sort());
    expect(result.consumedEvidenceIds).toEqual(result.materializedEvidenceIds);
    expect(result.latentEvidenceIds.sort()).toEqual([latentA.id, latentB.id].sort());
    expect(result.deferredEvidenceIds).toEqual([]);
    expect(result.actionDistribution).toEqual({
      create: 2,
      reinforce: 0,
      supersede: 0,
      stale: 0,
      latent: 2,
      skip: 0,
    });
    expect(dreamRepository.listEvidenceEvents({ status: "materialized" })).toHaveLength(2);
    expect(dreamRepository.listEvidenceEvents({ status: "latent" })).toHaveLength(2);
  });

  test("materializes three untagged events as Tier 1 by event count", () => {
    const eventIds = [
      createEvidenceEvent({
        sessionId: "session-tier1",
        callId: "call-1",
        toolName: "read",
        scopeRef: "notes/repo.txt",
        title: "Observation",
        excerpt: "Looked around carefully.",
        args: [],
        topicGuess: "workflow:notes/repo.txt:tier1",
        typeGuess: "workflow",
        createdAt: "2026-03-31T12:20:00.000Z",
      }).id,
      createEvidenceEvent({
        sessionId: "session-tier1",
        callId: "call-2",
        toolName: "read",
        scopeRef: "notes/repo.txt",
        title: "Observation",
        excerpt: "Looked around carefully.",
        args: [],
        topicGuess: "workflow:notes/repo.txt:tier1",
        typeGuess: "workflow",
        createdAt: "2026-03-31T12:21:00.000Z",
      }).id,
      createEvidenceEvent({
        sessionId: "session-tier1",
        callId: "call-3",
        toolName: "read",
        scopeRef: "notes/repo.txt",
        title: "Observation",
        excerpt: "Looked around carefully.",
        args: [],
        topicGuess: "workflow:notes/repo.txt:tier1",
        typeGuess: "workflow",
        createdAt: "2026-03-31T12:22:00.000Z",
      }).id,
    ];

    const result = worker.run({
      trigger: "manual",
      createdAfter: "2026-03-31T12:00:00.000Z",
      now: "2026-03-31T12:30:00.000Z",
    });

    expect(result.suggestions).toHaveLength(1);
    expect(result.materializedEvidenceIds.sort()).toEqual(eventIds.sort());
    expect(result.latentEvidenceIds).toEqual([]);
    expect(result.actionDistribution.create).toBe(3);
  });

  test("creates a workflow candidate from repeated evidence", () => {
    createEvidenceEvent({
      sessionId: "session-1",
      callId: "call-1",
      toolName: "edit",
      scopeRef: "src/core/repo.ts",
      title: "Edit completed",
      excerpt: "Updated repository adapter and completed workflow step.",
      args: { path: "src/core/repo.ts" },
      topicGuess: "workflow:edit:src/core/repo.ts",
      typeGuess: "workflow",
      salience: 0.7,
      novelty: 0.8,
      createdAt: "2026-03-29T10:00:00.000Z",
    });
    createEvidenceEvent({
      sessionId: "session-1",
      callId: "call-2",
      toolName: "edit",
      scopeRef: "src/core/repo.ts",
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
    expect(dreamRepository.listEvidenceEvents({ status: "materialized" })).toHaveLength(2);
    expect(memoryRepository.list({ status: "candidate" })).toHaveLength(1);

    const linkedEvidence = dreamRepository.listLinkedEvidenceByMemoryIds([
      result.suggestions[0]!.memoryId,
    ]);
    expect(linkedEvidence.get(result.suggestions[0]!.memoryId)).toHaveLength(2);
  });

  test("merges time-adjacent groups across tools within the same session and scope", () => {
    createEvidenceEvent({
      sessionId: "session-merge",
      callId: "call-1",
      toolName: "read",
      scopeRef: "src/core/repo.ts",
      title: "Read completed",
      excerpt: "Checked repository architecture before changes.",
      args: { path: "src/core/repo.ts" },
      topicGuess: "workflow:src/core/repo.ts:merge",
      typeGuess: "workflow",
      createdAt: "2026-03-29T12:00:00.000Z",
    });
    createEvidenceEvent({
      sessionId: "session-merge",
      callId: "call-2",
      toolName: "edit",
      scopeRef: "src/core/repo.ts",
      title: "Edit completed",
      excerpt: "Updated repository architecture after changes.",
      args: { path: "src/core/repo.ts" },
      topicGuess: "workflow:src/core/repo.ts:merge",
      typeGuess: "workflow",
      createdAt: "2026-03-29T12:03:00.000Z",
    });

    const result = worker.run({
      trigger: "manual",
      createdAfter: "2026-03-29T11:00:00.000Z",
      now: "2026-03-29T12:30:00.000Z",
    });

    expect(result.suggestions).toHaveLength(1);
    expect(result.suggestions[0]?.evidenceEventIds).toHaveLength(2);
  });

  test("infers relevantTools from evidence tool names", () => {
    createEvidenceEvent({
      sessionId: "session-tools",
      callId: "call-1",
      toolName: "edit",
      scopeRef: "src/core/repo.ts",
      title: "Edit completed",
      excerpt: "Adjusted repository implementation details.",
      args: { path: "src/core/repo.ts" },
      topicGuess: "workflow:edit:src/core/repo.ts",
      typeGuess: "workflow",
      salience: 0.7,
      novelty: 0.8,
      createdAt: "2026-03-29T12:00:00.000Z",
    });
    createEvidenceEvent({
      sessionId: "session-tools",
      callId: "call-2",
      toolName: "bash",
      scopeRef: "src/core/repo.ts",
      title: "Build passed",
      excerpt: "Build passed after repository implementation updates.",
      args: { path: "src/core/repo.ts" },
      topicGuess: "workflow:edit:src/core/repo.ts",
      typeGuess: "workflow",
      salience: 0.75,
      novelty: 0.75,
      createdAt: "2026-03-29T12:03:00.000Z",
    });

    const result = worker.run({
      trigger: "manual",
      createdAfter: "2026-03-29T11:00:00.000Z",
      now: "2026-03-29T12:30:00.000Z",
    });

    expect(result.suggestions).toHaveLength(1);
    const candidate = memoryRepository.getById(result.suggestions[0]!.memoryId);
    expect(candidate).not.toBeNull();
    expect(candidate!.relevantTools).toEqual(["bash", "edit"]);
  });

  test("marks weak untagged singleton evidence as latent", () => {
    const event = createEvidenceEvent({
      sessionId: "session-latent-single",
      callId: "call-1",
      toolName: "read",
      scopeRef: "notes/repo.txt",
      title: "Observation",
      excerpt: "Looked around.",
      args: [],
      topicGuess: "workflow:notes/repo.txt:observation",
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
    expect(result.latentEvidenceIds).toEqual([event.id]);
    expect(result.skippedEvidenceIds).toEqual([]);
    expect(result.actionDistribution.latent).toBe(1);
    expect(dreamRepository.listEvidenceEvents({ status: "latent" })).toHaveLength(1);
    expect(memoryRepository.list({ status: "candidate" })).toHaveLength(0);
  });

  test("skips empty evidence as noise and discards it", () => {
    db.run(
      `INSERT INTO dream_evidence_events (
        id,
        session_id,
        call_id,
        tool_name,
        scope_ref,
        source_ref,
        title,
        excerpt,
        args_json,
        metadata_json,
        topic_guess,
        type_guess,
        salience,
        novelty,
        salience_boost,
        contradiction_signal,
        status,
        created_at
      ) VALUES (
        $id,
        $sessionId,
        $callId,
        $toolName,
        $scopeRef,
        $sourceRef,
        $title,
        $excerpt,
        $argsJson,
        NULL,
        $topicGuess,
        $typeGuess,
        $salience,
        $novelty,
        0,
        0,
        'pending',
        $createdAt
      )`,
      {
        $id: "ev_noise_1",
        $sessionId: "session-noise",
        $callId: "call-1",
        $toolName: "read",
        $scopeRef: "notes/empty.txt",
        $sourceRef: "session-noise:call-1:read",
        $title: "",
        $excerpt: "",
        $argsJson: "",
        $topicGuess: "workflow:notes/empty.txt:noise",
        $typeGuess: "workflow",
        $salience: 0.1,
        $novelty: 0.1,
        $createdAt: "2026-03-31T12:40:00.000Z",
      }
    );

    const result = worker.run({
      trigger: "manual",
      createdAfter: "2026-03-31T12:30:00.000Z",
      now: "2026-03-31T12:50:00.000Z",
    });

    expect(result.suggestions).toHaveLength(0);
    expect(result.skippedEvidenceIds).toEqual(["ev_noise_1"]);
    expect(result.discardedEvidenceIds).toEqual(["ev_noise_1"]);
    expect(result.actionDistribution.skip).toBe(1);
    expect(dreamRepository.listEvidenceEvents({ status: "discarded" })).toHaveLength(1);
  });

  test("discards expired latent evidence during the same run after latent classification", () => {
    const event = createEvidenceEvent({
      sessionId: "session-latent-expired",
      callId: "call-1",
      toolName: "read",
      scopeRef: "notes/old.txt",
      title: "Observation",
      excerpt: "Looked around.",
      args: [],
      topicGuess: "workflow:notes/old.txt:observation",
      typeGuess: "workflow",
      createdAt: "2026-03-01T10:00:00.000Z",
    });

    const result = worker.run({
      trigger: "manual",
      createdAfter: "2026-03-01T00:00:00.000Z",
      now: "2026-03-31T10:00:00.000Z",
    });

    expect(result.suggestions).toHaveLength(0);
    expect(result.latentEvidenceIds).toEqual([event.id]);
    expect(result.discardedEvidenceIds).toEqual([event.id]);
    expect(dreamRepository.listEvidenceEvents({ status: "discarded" })).toHaveLength(1);
  });

  test("updated candidate includes previous summary in details", () => {
    createEvidenceEvent({
      sessionId: "session-4",
      callId: "call-1",
      toolName: "edit",
      scopeRef: "src/core/repo.ts",
      title: "Edit completed",
      excerpt: "Refactored repository adapter pattern.",
      args: { path: "src/core/repo.ts" },
      topicGuess: "workflow:src/core/repo.ts:edit",
      typeGuess: "workflow",
      salience: 0.7,
      novelty: 0.8,
      createdAt: "2026-03-30T10:00:00.000Z",
    });
    createEvidenceEvent({
      sessionId: "session-4",
      callId: "call-2",
      toolName: "edit",
      scopeRef: "src/core/repo.ts",
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

    createEvidenceEvent({
      sessionId: "session-5",
      callId: "call-3",
      toolName: "edit",
      scopeRef: "src/core/repo.ts",
      title: "Edit completed",
      excerpt: "Added error handling to repository adapter.",
      args: { path: "src/core/repo.ts" },
      topicGuess: "workflow:src/core/repo.ts:edit",
      typeGuess: "workflow",
      salience: 0.7,
      novelty: 0.6,
      createdAt: "2026-03-30T11:00:00.000Z",
    });
    createEvidenceEvent({
      sessionId: "session-5",
      callId: "call-4",
      toolName: "edit",
      scopeRef: "src/core/repo.ts",
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

  test("reconciliation reinforces an at-risk memory with matching evidence", () => {
    const memory = memoryRepository.create({
      id: "mem_reinforce",
      type: "workflow",
      summary: "Repository updates should be verified after edits",
      details: "Verify repository changes with a follow-up command.",
      scopeGlob: "src/core/repo.ts",
      lifecycleTriggers: ["before_model"],
      status: "active",
      confidence: 0.6,
      importance: 0.7,
      lastVerifiedAt: "2026-03-20T09:00:00.000Z",
      createdAt: "2026-03-20T09:00:00.000Z",
      updatedAt: "2026-03-20T09:00:00.000Z",
      relevantTools: ["edit"],
    });
    const event = createEvidenceEvent({
      sessionId: "session-reinforce",
      callId: "call-1",
      toolName: "edit",
      scopeRef: "src/core/repo.ts",
      title: "Edit completed",
      excerpt: "Updated repository workflow successfully.",
      args: { path: "src/core/repo.ts" },
      topicGuess: "workflow:src/core/repo.ts:reinforce",
      typeGuess: "workflow",
      createdAt: "2026-03-31T13:00:00.000Z",
    });

    const result = worker.run({
      trigger: "manual",
      createdAfter: "2026-03-31T12:00:00.000Z",
      now: "2026-03-31T13:10:00.000Z",
    });

    const refreshed = memoryRepository.getById(memory.id);
    expect(result.suggestions).toHaveLength(0);
    expect(result.materializedEvidenceIds).toEqual([event.id]);
    expect(result.actionDistribution.reinforce).toBe(1);
    expect(refreshed?.confidence).toBe(0.65);
    expect(refreshed?.lastVerifiedAt).toBe("2026-03-31T13:00:00.000Z");

    const linkedEvidence = dreamRepository.listLinkedEvidenceByMemoryIds([memory.id]);
    expect(linkedEvidence.get(memory.id)).toHaveLength(1);
  });

  test("reconciliation stales an old memory and creates a replacement candidate on contradiction", () => {
    const oldMemory = memoryRepository.create({
      id: "mem_supersede_old",
      type: "decision",
      summary: "Use bash for repository verification",
      details: "Bash is the preferred verification path.",
      scopeGlob: "src/core/repo.ts",
      lifecycleTriggers: ["before_model"],
      status: "active",
      confidence: 0.65,
      importance: 0.8,
      lastVerifiedAt: "2026-03-15T09:00:00.000Z",
      createdAt: "2026-03-15T09:00:00.000Z",
      updatedAt: "2026-03-15T09:00:00.000Z",
    });
    const event = createEvidenceEvent({
      sessionId: "session-supersede",
      callId: "call-1",
      toolName: "edit",
      scopeRef: "src/core/repo.ts",
      title: "Decision updated",
      excerpt: "Decided to switch from bash to node after previous failures.",
      args: { path: "src/core/repo.ts" },
      topicGuess: "decision:src/core/repo.ts:verification-tool",
      typeGuess: "decision",
      contradictionSignal: true,
      createdAt: "2026-03-31T14:00:00.000Z",
    });

    const result = worker.run({
      trigger: "manual",
      createdAfter: "2026-03-31T13:00:00.000Z",
      now: "2026-03-31T14:10:00.000Z",
    });

    expect(result.suggestions).toHaveLength(1);
    expect(result.materializedEvidenceIds).toEqual([event.id]);
    expect(result.actionDistribution.supersede).toBe(1);
    expect(memoryRepository.getById(oldMemory.id)?.status).toBe("stale");

    const replacement = memoryRepository.getById(result.suggestions[0]!.memoryId);
    expect(replacement).not.toBeNull();
    expect(replacement?.status).toBe("candidate");
    expect(replacement?.summary).toContain("Decision for repo.ts");
  });

  test("reconciliation keeps contradiction evidence in supersede flow without counting it as reinforce", () => {
    memoryRepository.create({
      id: "mem_supersede_multi_old",
      type: "decision",
      summary: "Use bash for repository verification",
      details: "Bash is the preferred verification path.",
      scopeGlob: "src/core/repo.ts",
      lifecycleTriggers: ["before_model"],
      status: "active",
      confidence: 0.65,
      importance: 0.8,
      lastVerifiedAt: "2026-03-15T09:00:00.000Z",
      createdAt: "2026-03-15T09:00:00.000Z",
      updatedAt: "2026-03-15T09:00:00.000Z",
    });

    const evidenceIds = [
      createEvidenceEvent({
        sessionId: "session-supersede-multi",
        callId: "call-1",
        toolName: "edit",
        scopeRef: "src/core/repo.ts",
        title: "Decision updated",
        excerpt: "Decided to switch from bash to node after previous failures.",
        args: { path: "src/core/repo.ts" },
        topicGuess: "decision:src/core/repo.ts:verification-tool",
        typeGuess: "decision",
        contradictionSignal: true,
        createdAt: "2026-03-31T15:00:00.000Z",
      }).id,
      createEvidenceEvent({
        sessionId: "session-supersede-multi",
        callId: "call-2",
        toolName: "edit",
        scopeRef: "src/core/repo.ts",
        title: "Decision updated",
        excerpt: "Changed verification from bash to node after previous failures.",
        args: { path: "src/core/repo.ts" },
        topicGuess: "decision:src/core/repo.ts:verification-tool",
        typeGuess: "decision",
        contradictionSignal: true,
        createdAt: "2026-03-31T15:01:00.000Z",
      }).id,
      createEvidenceEvent({
        sessionId: "session-supersede-multi",
        callId: "call-3",
        toolName: "edit",
        scopeRef: "src/core/repo.ts",
        title: "Decision updated",
        excerpt: "Switched from bash to node for repository verification.",
        args: { path: "src/core/repo.ts" },
        topicGuess: "decision:src/core/repo.ts:verification-tool",
        typeGuess: "decision",
        contradictionSignal: true,
        createdAt: "2026-03-31T15:02:00.000Z",
      }).id,
    ];

    const result = worker.run({
      trigger: "manual",
      createdAfter: "2026-03-31T14:30:00.000Z",
      now: "2026-03-31T15:10:00.000Z",
    });

    expect(result.suggestions).toHaveLength(1);
    expect(result.materializedEvidenceIds.sort()).toEqual(evidenceIds.sort());
    expect(result.actionDistribution.reinforce).toBe(0);
    expect(result.actionDistribution.create).toBe(0);
    expect(result.actionDistribution.supersede).toBe(3);
    expect(memoryRepository.getById("mem_supersede_multi_old")?.status).toBe("stale");
  });
});
