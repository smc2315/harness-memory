import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { Database as SqlJsDatabase } from "sql.js";

import { ActivationEngine, type ActivationResult } from "../src/activation";
import {
  DreamRepository,
  DreamWorker,
  type CreateDreamEvidenceEventInput,
} from "../src/dream";
import { MemoryRepository } from "../src/memory";
import { generateSessionSummary } from "../src/retrieval/summary-generator";
import { SummaryRepository } from "../src/retrieval/summary-repository";
import { createTestDb } from "./helpers/create-test-db";

describe("end-to-end pipeline smoke", () => {
  let db: SqlJsDatabase;
  let dreamRepository: DreamRepository;
  let memoryRepository: MemoryRepository;
  let worker: DreamWorker;
  let engine: ActivationEngine;

  function createEvidenceEvent(
    input: Omit<CreateDreamEvidenceEventInput, "sourceRef" | "salience" | "novelty"> & {
      sourceRef?: string;
      salience?: number;
      novelty?: number;
    },
  ) {
    return dreamRepository.createEvidenceEvent({
      ...input,
      sourceRef: input.sourceRef ?? `${input.sessionId}:${input.callId}:${input.toolName}`,
      salience: input.salience ?? 0.7,
      novelty: input.novelty ?? 0.6,
    });
  }

  function insertNoiseEvidenceEvent(id: string, createdAt: string) {
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
        $id: id,
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
        $createdAt: createdAt,
      },
    );
  }

  function expectValidActivationResult(result: ActivationResult) {
    expect(result.budget.usedMemories).toBe(result.activated.length);
    expect(result.budget.usedMemories).toBeLessThanOrEqual(result.budget.maxMemories);
    expect(result.budget.usedPayloadBytes).toBeLessThanOrEqual(result.budget.maxPayloadBytes);
  }

  beforeEach(async () => {
    db = await createTestDb();
    dreamRepository = new DreamRepository(db);
    memoryRepository = new MemoryRepository(db);
    worker = new DreamWorker(dreamRepository, memoryRepository);
    engine = new ActivationEngine(memoryRepository);
  });

  afterEach(() => {
    db.close();
  });

  test("full pipeline: evidence -> dream -> candidate -> activation", async () => {
    const evidence = [
      createEvidenceEvent({
        sessionId: "session-auth",
        callId: "call-1",
        toolName: "bash",
        scopeRef: "src/auth/index.ts",
        title: "Build failed",
        excerpt: "Build failed in auth module after token changes.",
        args: { path: "src/auth/index.ts" },
        topicGuess: "workflow:src/auth/index.ts:auth-fix",
        typeGuess: "workflow",
        createdAt: "2026-04-01T10:00:00.000Z",
      }),
      createEvidenceEvent({
        sessionId: "session-auth",
        callId: "call-2",
        toolName: "edit",
        scopeRef: "src/auth/index.ts",
        title: "Fixed auth module",
        excerpt: "Fixed auth module and updated token validation.",
        args: { path: "src/auth/index.ts" },
        topicGuess: "workflow:src/auth/index.ts:auth-fix",
        typeGuess: "workflow",
        createdAt: "2026-04-01T10:02:00.000Z",
      }),
      createEvidenceEvent({
        sessionId: "session-auth",
        callId: "call-3",
        toolName: "bash",
        scopeRef: "src/auth/index.ts",
        title: "Tests passing",
        excerpt: "Auth tests passing after the fix completed.",
        args: { path: "src/auth/index.ts" },
        topicGuess: "workflow:src/auth/index.ts:auth-fix",
        typeGuess: "workflow",
        createdAt: "2026-04-01T10:04:00.000Z",
      }),
    ];

    const dreamResult = worker.run({
      trigger: "manual",
      createdAfter: "2026-04-01T09:55:00.000Z",
      now: "2026-04-01T10:10:00.000Z",
    });

    expect(dreamResult.suggestions.length).toBeGreaterThanOrEqual(1);
    expect(dreamResult.suggestions[0]?.evidenceEventIds).toEqual(evidence.map((event) => event.id));
    expect(dreamResult.materializedEvidenceIds).toEqual(evidence.map((event) => event.id).sort());
    expect(dreamResult.materializedEvidenceIds).not.toHaveLength(0);
    expect(dreamResult.actionDistribution.create).toBeGreaterThan(0);

    const candidateId = dreamResult.suggestions[0]!.memoryId;
    const candidate = memoryRepository.getById(candidateId);
    expect(candidate?.status).toBe("candidate");

    const promoted = memoryRepository.update(candidateId, {
      status: "active",
      updatedAt: "2026-04-01T10:11:00.000Z",
    });
    expect(promoted?.status).toBe("active");

    const activationResult = await engine.activate({
      lifecycleTrigger: "before_model",
      scopeRef: "src/auth/index.ts",
      queryTokens: ["auth", "fix"],
      maxMemories: 1,
      maxPayloadBytes: 4_096,
    });

    expect(activationResult.activated.map((memory) => memory.id)).toContain(candidateId);
    expectValidActivationResult(activationResult);
  });

  test("noise filter blocks empty evidence", () => {
    insertNoiseEvidenceEvent("ev_noise_pipeline", "2026-04-01T11:00:00.000Z");

    const result = worker.run({
      trigger: "manual",
      createdAfter: "2026-04-01T10:50:00.000Z",
      now: "2026-04-01T11:05:00.000Z",
    });

    expect(result.skippedEvidenceIds).toContain("ev_noise_pipeline");
    expect(result.materializedEvidenceIds).not.toContain("ev_noise_pipeline");
    expect(result.suggestions).toHaveLength(0);
  });

  test("single tagless evidence becomes latent, not candidate", () => {
    const event = createEvidenceEvent({
      sessionId: "session-latent",
      callId: "call-1",
      toolName: "read",
      scopeRef: "notes/repo.txt",
      title: "Observation",
      excerpt: "Looked around carefully.",
      args: [],
      topicGuess: "workflow:notes/repo.txt:observation",
      typeGuess: "workflow",
      createdAt: "2026-04-01T12:00:00.000Z",
      salience: 0.45,
      novelty: 0.45,
    });

    const result = worker.run({
      trigger: "manual",
      createdAfter: "2026-04-01T11:50:00.000Z",
      now: "2026-04-01T12:05:00.000Z",
    });

    expect(result.latentEvidenceIds).toEqual([event.id]);
    expect(result.suggestions).toHaveLength(0);
    expect(memoryRepository.list({ status: "candidate" })).toHaveLength(0);
  });

  test("reconciler reinforces existing memory", () => {
    const memory = memoryRepository.create({
      id: "mem_auth_reinforce",
      type: "workflow",
      summary: "Verify auth changes after edits",
      details: "Run follow-up verification for auth module changes.",
      scopeGlob: "src/auth/index.ts",
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
      scopeRef: "src/auth/index.ts",
      title: "Auth fix completed",
      excerpt: "Fixed auth module and verified the updated workflow.",
      args: { path: "src/auth/index.ts" },
      topicGuess: "workflow:src/auth/index.ts:verification",
      typeGuess: "workflow",
      createdAt: "2026-04-01T13:00:00.000Z",
    });

    const result = worker.run({
      trigger: "manual",
      createdAfter: "2026-04-01T12:50:00.000Z",
      now: "2026-04-01T13:05:00.000Z",
    });

    const refreshed = memoryRepository.getById(memory.id);
    const linkedEvidence = dreamRepository.listLinkedEvidenceByMemoryIds([memory.id]);

    expect(result.suggestions).toHaveLength(0);
    expect(result.actionDistribution.reinforce).toBeGreaterThan(0);
    expect(refreshed?.confidence).toBeGreaterThan(memory.confidence);
    expect(memoryRepository.list({ status: "active" })).toHaveLength(1);
    expect(linkedEvidence.get(memory.id)?.map((entry) => entry.id)).toEqual([event.id]);
  });

  test("session summary generation + retrieval", async () => {
    const summaryRepository = new SummaryRepository(db);
    const sessionMemory = memoryRepository.create({
      id: "mem_session_summary_startup",
      type: "workflow",
      summary: "Startup auth checklist",
      details: "Use the latest auth session context when a new task starts.",
      scopeGlob: "src/auth/index.ts",
      activationClass: "startup",
      lifecycleTriggers: ["before_model"],
      status: "active",
      confidence: 0.7,
      importance: 0.7,
      createdAt: "2026-04-01T13:30:00.000Z",
      updatedAt: "2026-04-01T13:30:00.000Z",
    });
    const events = [
      createEvidenceEvent({
        sessionId: "session-summary",
        callId: "call-1",
        toolName: "read",
        scopeRef: "src/auth/index.ts",
        title: "Reviewed auth flow",
        excerpt: "Reviewed auth flow before making changes.",
        args: { path: "src/auth/index.ts" },
        topicGuess: "workflow:src/auth/index.ts:session-summary",
        typeGuess: "workflow",
        createdAt: "2026-04-01T14:00:00.000Z",
      }),
      createEvidenceEvent({
        sessionId: "session-summary",
        callId: "call-2",
        toolName: "edit",
        scopeRef: "src/auth/index.ts",
        title: "Patched token parsing",
        excerpt: "Updated token parsing and auth validation paths.",
        args: { path: "src/auth/index.ts" },
        topicGuess: "workflow:src/auth/index.ts:session-summary",
        typeGuess: "workflow",
        createdAt: "2026-04-01T14:01:00.000Z",
      }),
      createEvidenceEvent({
        sessionId: "session-summary",
        callId: "call-3",
        toolName: "bash",
        scopeRef: "src/auth/index.ts",
        title: "Tests passed",
        excerpt: "Auth tests passed after the parser update.",
        args: { path: "src/auth/index.ts" },
        topicGuess: "workflow:src/auth/index.ts:session-summary",
        typeGuess: "workflow",
        createdAt: "2026-04-01T14:02:00.000Z",
      }),
      createEvidenceEvent({
        sessionId: "session-summary",
        callId: "call-4",
        toolName: "edit",
        scopeRef: "src/auth/index.ts",
        title: "Decision updated",
        excerpt: "Decided to keep auth helpers inside the auth module.",
        args: { path: "src/auth/index.ts" },
        topicGuess: "decision:src/auth/index.ts:module-boundary",
        typeGuess: "decision",
        createdAt: "2026-04-01T14:03:00.000Z",
      }),
      createEvidenceEvent({
        sessionId: "session-summary",
        callId: "call-5",
        toolName: "bash",
        scopeRef: "src/auth/index.ts",
        title: "Policy confirmed",
        excerpt: "Auth changes should always be validated before merge.",
        args: { path: "src/auth/index.ts" },
        topicGuess: "policy:src/auth/index.ts:validation",
        typeGuess: "policy",
        createdAt: "2026-04-01T14:04:00.000Z",
      }),
    ];

    const generated = generateSessionSummary({
      sessionId: "session-summary",
      events,
    });
    const stored = summaryRepository.upsertSessionSummary({
      sessionId: "session-summary",
      ...generated,
    });

    expect(stored.summaryShort).toContain("[Session] 5 events");
    expect(stored.summaryMedium).toContain("Session session-summary overview");
    expect(stored.toolNames).toEqual(["bash", "edit", "read"]);
    expect(stored.eventCount).toBe(5);
    expect(stored.sourceEventIds).toEqual(expect.arrayContaining(events.map((event) => event.id)));
    expect(stored.typeDistribution.workflow).toBe(3);
    expect(stored.typeDistribution.decision).toBe(1);
    expect(stored.typeDistribution.policy).toBe(1);

    engine.setSummaryRepository(summaryRepository);

    const activationResult = await engine.activate({
      lifecycleTrigger: "before_model",
      scopeRef: "src/auth/index.ts",
      activationMode: "startup",
      maxMemories: 2,
    });

    expect(activationResult.activated.map((memory) => memory.id)).toContain(sessionMemory.id);
    expectValidActivationResult(activationResult);
  });

  test("activation modes all return valid results", async () => {
    memoryRepository.create({
      id: "mem_modes_baseline",
      type: "policy",
      summary: "Auth work keeps strict verification",
      details: "Always verify auth behavior before finishing a task.",
      scopeGlob: "src/auth/**/*",
      activationClass: "baseline",
      lifecycleTriggers: ["before_model"],
      status: "active",
      confidence: 0.9,
      importance: 0.9,
      createdAt: "2026-03-25T09:00:00.000Z",
      updatedAt: "2026-03-25T09:00:00.000Z",
    });
    memoryRepository.create({
      id: "mem_modes_startup",
      type: "workflow",
      summary: "Auth startup checklist",
      details: "Start auth tasks by reading the login and token flow checklist.",
      scopeGlob: "src/auth/index.ts",
      activationClass: "startup",
      lifecycleTriggers: ["before_model"],
      status: "active",
      confidence: 0.75,
      importance: 0.8,
      createdAt: "2026-03-26T09:00:00.000Z",
      updatedAt: "2026-03-26T09:00:00.000Z",
    });
    memoryRepository.create({
      id: "mem_modes_scoped",
      type: "decision",
      summary: "Auth modules stay under src/auth",
      details: "Keep auth-specific helpers and decisions inside src/auth.",
      scopeGlob: "src/auth/**/*",
      activationClass: "scoped",
      lifecycleTriggers: ["before_model"],
      status: "active",
      confidence: 0.7,
      importance: 0.75,
      createdAt: "2026-03-27T09:00:00.000Z",
      updatedAt: "2026-03-27T09:00:00.000Z",
    });

    const request = {
      lifecycleTrigger: "before_model" as const,
      scopeRef: "src/auth/index.ts",
      queryTokens: ["auth", "checklist"],
      maxMemories: 3,
      maxPayloadBytes: 8_192,
    };

    const startupResult = await engine.activate({
      ...request,
      activationMode: "startup",
    });
    const defaultResult = await engine.activate({
      ...request,
      activationMode: "default",
    });
    const temporalResult = await engine.activate({
      ...request,
      activationMode: "temporal",
    });
    const crossSessionResult = await engine.activate({
      ...request,
      activationMode: "cross_session",
    });

    expectValidActivationResult(startupResult);
    expectValidActivationResult(defaultResult);
    expectValidActivationResult(temporalResult);
    expectValidActivationResult(crossSessionResult);
    expect(defaultResult.activated.length).toBeGreaterThan(0);
  });
});
