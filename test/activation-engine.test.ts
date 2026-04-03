import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { Database as SqlJsDatabase } from "sql.js";

import { ActivationEngine, EmbeddingService } from "../src/activation";
import { MemoryRepository } from "../src/memory";
import { createTestDb } from "./helpers/create-test-db";

function vector(...values: number[]): Float32Array {
  return new Float32Array(values);
}

class StubEmbeddingService extends EmbeddingService {
  private readonly queryEmbeddings: Map<string, Float32Array>;
  readonly requests: string[] = [];

  constructor(queryEmbeddings: Map<string, Float32Array>) {
    super();
    this.queryEmbeddings = queryEmbeddings;
    this.isReady = true;
  }

  async embedQuery(text: string): Promise<Float32Array> {
    this.requests.push(text);
    return this.queryEmbeddings.get(text) ?? vector(0, 0, 0);
  }
}

describe("ActivationEngine", () => {
  let db: SqlJsDatabase;
  let repository: MemoryRepository;
  let engine: ActivationEngine;

  beforeEach(async () => {
    db = await createTestDb();
    repository = new MemoryRepository(db);
    engine = new ActivationEngine(repository);
  });

  afterEach(() => {
    db.close();
  });

  test("activates only active memories matching trigger and scope in stable rank order", async () => {
    const highest = repository.create({
      type: "policy",
      summary: "Prefer explicit adapters",
      details: "Keep boundaries thin.",
      scopeGlob: "src/**/*.ts",
      lifecycleTriggers: ["before_model"],
      confidence: 0.9,
      importance: 0.9,
      status: "active",
      createdAt: "2026-03-28T00:00:00.000Z",
      updatedAt: "2026-03-28T00:00:00.000Z",
    });
    const second = repository.create({
      type: "workflow",
      summary: "Inspect db after migrate",
      details: "Run inspect after creating the sqlite file.",
      scopeGlob: "src/**/*.ts",
      lifecycleTriggers: ["before_model"],
      confidence: 0.8,
      importance: 0.8,
      status: "active",
      createdAt: "2026-03-28T00:10:00.000Z",
      updatedAt: "2026-03-28T00:10:00.000Z",
    });
    repository.create({
      type: "pitfall",
      summary: "Do not amend pushed commits",
      details: "Force-push risk is too high.",
      scopeGlob: "src/**/*.ts",
      lifecycleTriggers: ["before_tool"],
      status: "active",
      createdAt: "2026-03-28T00:20:00.000Z",
      updatedAt: "2026-03-28T00:20:00.000Z",
    });
    repository.create({
      type: "decision",
      summary: "Keep manual promotion in MVP",
      details: "Candidate memories stay inactive until reviewed.",
      scopeGlob: "src/**/*.ts",
      lifecycleTriggers: ["before_model"],
      status: "stale",
      createdAt: "2026-03-28T00:30:00.000Z",
      updatedAt: "2026-03-28T00:30:00.000Z",
    });

    const result = await engine.activate({
      lifecycleTrigger: "before_model",
      scopeRef: "src/memory/repository.ts",
    });

    expect(result.activated.map((memory) => memory.id)).toEqual([
      highest.id,
      second.id,
    ]);
    expect(result.activated.map((memory) => memory.rank)).toEqual([1, 2]);
    expect(result.suppressed.map((entry) => entry.kind).sort()).toEqual([
      "status_inactive",
      "trigger_mismatch",
    ]);
  });

  test("suppresses non-matching scopes with explicit reasons", async () => {
    repository.create({
      type: "workflow",
      summary: "Inspect db after migrate",
      details: "Run inspect after creating the sqlite file.",
      scopeGlob: "src/db/**/*.ts",
      lifecycleTriggers: ["before_model"],
      status: "active",
      createdAt: "2026-03-28T00:00:00.000Z",
      updatedAt: "2026-03-28T00:00:00.000Z",
    });

    const result = await engine.activate({
      lifecycleTrigger: "before_model",
      scopeRef: "src/memory/repository.ts",
    });

    expect(result.activated).toHaveLength(0);
    expect(result.suppressed).toHaveLength(1);
    expect(result.suppressed[0]?.kind).toBe("scope_mismatch");
    expect(result.suppressed[0]?.reason).toContain("does not match");
  });

  test("enforces memory count and payload budgets deterministically", async () => {
    const first = repository.create({
      type: "policy",
      summary: "A",
      details: "A detail that fits the budget.",
      scopeGlob: "src/**/*.ts",
      lifecycleTriggers: ["before_model"],
      confidence: 1,
      importance: 1,
      status: "active",
      createdAt: "2026-03-28T00:00:00.000Z",
      updatedAt: "2026-03-28T00:00:00.000Z",
    });
    const second = repository.create({
      type: "workflow",
      summary: "B",
      details: "B detail that also fits the budget.",
      scopeGlob: "src/**/*.ts",
      lifecycleTriggers: ["before_model"],
      confidence: 0.8,
      importance: 0.8,
      status: "active",
      createdAt: "2026-03-28T00:10:00.000Z",
      updatedAt: "2026-03-28T00:10:00.000Z",
    });

    const countLimited = await engine.activate({
      lifecycleTrigger: "before_model",
      scopeRef: "src/memory/repository.ts",
      maxMemories: 1,
      maxPayloadBytes: 10_000,
    });
    expect(countLimited.activated.map((memory) => memory.id)).toEqual([first.id]);
    expect(countLimited.suppressed[0]?.kind).toBe("budget_limit");

    const payloadLimited = await engine.activate({
      lifecycleTrigger: "before_model",
      scopeRef: "src/memory/repository.ts",
      maxMemories: 5,
      maxPayloadBytes: 10,
    });
    expect(payloadLimited.activated).toHaveLength(0);
    expect(payloadLimited.suppressed.map((entry) => entry.kind)).toEqual([
      "budget_limit",
      "budget_limit",
    ]);
    expect(payloadLimited.budget.usedPayloadBytes).toBe(0);
    expect(second.id).toBeTruthy();
  });

  test("suppresses memory when toolName does not match relevantTools", async () => {
    const memory = repository.create({
      type: "workflow",
      summary: "Use bash for workspace scripts",
      details: "Run scripted checks via bash tool.",
      scopeGlob: "src/**/*.ts",
      lifecycleTriggers: ["before_model"],
      status: "active",
      relevantTools: ["bash"],
    });

    const result = await engine.activate({
      lifecycleTrigger: "before_model",
      scopeRef: "src/activation/engine.ts",
      toolName: "edit",
      maxMemories: 1,
    });

    expect(result.activated).toHaveLength(0);
    expect(result.suppressed).toHaveLength(1);
    expect(result.suppressed[0]?.memory.id).toBe(memory.id);
    expect(result.suppressed[0]?.kind).toBe("tool_mismatch");
  });

  test("activates memory when toolName matches relevantTools", async () => {
    const memory = repository.create({
      type: "workflow",
      summary: "Use edit for source changes",
      details: "Prefer edit for code modifications.",
      scopeGlob: "src/**/*.ts",
      lifecycleTriggers: ["before_model"],
      status: "active",
      relevantTools: ["bash", "edit"],
    });

    const result = await engine.activate({
      lifecycleTrigger: "before_model",
      scopeRef: "src/activation/engine.ts",
      toolName: "edit",
      maxMemories: 1,
    });

    expect(result.activated.map((entry) => entry.id)).toContain(memory.id);
    expect(result.suppressed.map((entry) => entry.kind)).not.toContain("tool_mismatch");
  });

  test("activates memory when relevantTools is null (backward compat)", async () => {
    const memory = repository.create({
      type: "workflow",
      summary: "General workflow memory",
      details: "Applies regardless of tool.",
      scopeGlob: "src/**/*.ts",
      lifecycleTriggers: ["before_model"],
      status: "active",
    });

    const result = await engine.activate({
      lifecycleTrigger: "before_model",
      scopeRef: "src/activation/engine.ts",
      toolName: "bash",
      maxMemories: 1,
    });

    expect(result.activated.map((entry) => entry.id)).toContain(memory.id);
    expect(result.suppressed.map((entry) => entry.kind)).not.toContain("tool_mismatch");
  });

  test("hybrid retrieval returns results from both dense and lexical sources", async () => {
    engine = new ActivationEngine(
      repository,
      new StubEmbeddingService(new Map([["urgent rollback", vector(1, 0, 0)]])),
    );

    const denseMemory = repository.create({
      type: "workflow",
      summary: "Review migration plans",
      details: "Prefer staged rollouts for schema changes.",
      scopeGlob: "src/**/*.ts",
      activationClass: "startup",
      lifecycleTriggers: ["after_tool"],
      status: "active",
      embedding: vector(1, 0, 0),
    });
    const lexicalMemory = repository.create({
      type: "workflow",
      summary: "Urgent rollback checklist",
      details: "Use the urgent rollback runbook when releases fail.",
      scopeGlob: "src/**/*.ts",
      activationClass: "startup",
      lifecycleTriggers: ["after_tool"],
      status: "active",
    });

    const result = await engine.activate({
      lifecycleTrigger: "before_model",
      scopeRef: "src/activation/engine.ts",
      queryTokens: ["urgent", "rollback"],
      maxMemories: 3,
    });

    expect(result.activated).toHaveLength(2);
    expect(result.activated.map((memory) => memory.id)).toEqual(
      expect.arrayContaining([denseMemory.id, lexicalMemory.id]),
    );
  });

  test("lexical-only path still works when no embeddings available", async () => {
    const lexicalMemory = repository.create({
      type: "workflow",
      summary: "Urgent rollback checklist",
      details: "Use the urgent rollback runbook when releases fail.",
      scopeGlob: "src/**/*.ts",
      activationClass: "startup",
      lifecycleTriggers: ["after_tool"],
      status: "active",
    });

    const result = await engine.activate({
      lifecycleTrigger: "before_model",
      scopeRef: "src/activation/engine.ts",
      queryTokens: ["urgent", "rollback"],
      maxMemories: 1,
    });

    expect(result.activated.map((memory) => memory.id)).toEqual([lexicalMemory.id]);
  });

  test("dense-only path still works when lexical has no keyword hits", async () => {
    engine = new ActivationEngine(
      repository,
      new StubEmbeddingService(new Map([["semantic similarity", vector(1, 0, 0)]])),
    );

    const denseMemory = repository.create({
      type: "workflow",
      summary: "Schema migration planning",
      details: "Prefer staged rollouts with explicit checkpoints.",
      scopeGlob: "src/**/*.ts",
      activationClass: "startup",
      lifecycleTriggers: ["after_tool"],
      status: "active",
      embedding: vector(1, 0, 0),
    });

    const result = await engine.activate({
      lifecycleTrigger: "before_model",
      scopeRef: "src/activation/engine.ts",
      queryTokens: ["semantic", "similarity"],
      maxMemories: 1,
    });

    expect(result.activated.map((memory) => memory.id)).toEqual([denseMemory.id]);
  });

  test("summary embedding beats weak full embedding for short query", async () => {
    const embeddingService = new StubEmbeddingService(
      new Map([["rollback", vector(1, 0, 0)]]),
    );
    engine = new ActivationEngine(repository, embeddingService);

    repository.create({
      type: "workflow",
      summary: "Deployment recovery guide",
      details: "Capture timelines, approvals, and postmortem notes for incidents.",
      scopeGlob: "**/*",
      activationClass: "startup",
      lifecycleTriggers: ["after_tool"],
      status: "active",
      embedding: vector(0.7, 0.7, 0),
    });
    const rescuedMemory = repository.create({
      type: "workflow",
      summary: "Incident recovery reference",
      details: "Document every subsystem, owner handoff, and dependency before choosing a rollback path.",
      scopeGlob: "**/*",
      activationClass: "startup",
      lifecycleTriggers: ["after_tool"],
      status: "active",
      embedding: vector(0.2, 0.98, 0),
      embeddingSummary: vector(1, 0, 0),
    });

    const result = await engine.activate({
      lifecycleTrigger: "before_model",
      scopeRef: ".",
      queryTokens: ["rollback"],
      maxMemories: 2,
    });

    expect(result.activated[0]?.id).toBe(rescuedMemory.id);
  });

  test("scoped query expansion improves retrieval for domain-specific paths", async () => {
    const embeddingService = new StubEmbeddingService(
      new Map([
        ["error handling", vector(1, 0, 0)],
        ["web-app src api route: error handling", vector(0, 1, 0)],
      ]),
    );
    engine = new ActivationEngine(repository, embeddingService);

    repository.create({
      type: "workflow",
      summary: "Terminal retry strategy",
      details: "Recover failed commands with retries and exit codes.",
      scopeGlob: "**/*",
      activationClass: "startup",
      lifecycleTriggers: ["after_tool"],
      status: "active",
      embedding: vector(1, 0, 0),
    });
    const webMemory = repository.create({
      type: "workflow",
      summary: "Route exception boundary",
      details: "Handle request failures inside the API route pipeline.",
      scopeGlob: "web-app/**/*",
      activationClass: "startup",
      lifecycleTriggers: ["after_tool"],
      status: "active",
      embedding: vector(0, 1, 0),
    });

    const result = await engine.activate({
      lifecycleTrigger: "before_model",
      scopeRef: "web-app/src/api/route.ts",
      queryTokens: ["error", "handling"],
      maxMemories: 1,
    });

    expect(embeddingService.requests).toEqual(["web-app src api route: error handling"]);
    expect(result.activated.map((memory) => memory.id)).toEqual([webMemory.id]);
  });

  test("scope boost increases score for scope-matching memories", async () => {
    const embeddingService = new StubEmbeddingService(
      new Map([["error handling", vector(1, 0, 0)]]),
    );
    engine = new ActivationEngine(repository, embeddingService);

    repository.create({
      type: "workflow",
      summary: "Error handling checklist",
      details: "Use the error handling checklist for service failures.",
      scopeGlob: "src/**/*.ts",
      activationClass: "startup",
      lifecycleTriggers: ["after_tool"],
      status: "active",
      embedding: vector(1, 0, 0),
    });
    const matchingMemory = repository.create({
      type: "workflow",
      summary: "Error handling checklist",
      details: "Use the error handling checklist for service failures.",
      scopeGlob: ".",
      activationClass: "startup",
      lifecycleTriggers: ["after_tool"],
      status: "active",
      embedding: vector(1, 0, 0),
    });

    const result = await engine.activate({
      lifecycleTrigger: "before_model",
      scopeRef: ".",
      queryTokens: ["error", "handling"],
      maxMemories: 2,
    });

    expect(result.activated[0]?.id).toBe(matchingMemory.id);
    expect(result.activated[0]?.score).toBeGreaterThan(result.activated[1]?.score ?? 0);
  });

  test("first-turn queries are NOT expanded (scopeRef='.')", async () => {
    const embeddingService = new StubEmbeddingService(
      new Map([["error handling", vector(1, 0, 0)]]),
    );
    engine = new ActivationEngine(repository, embeddingService);

    repository.create({
      type: "workflow",
      summary: "Terminal recovery guide",
      details: "Capture command retries and exit code notes.",
      scopeGlob: "**/*",
      activationClass: "startup",
      lifecycleTriggers: ["after_tool"],
      status: "active",
      embedding: vector(0, 1, 0),
    });
    const broadMemory = repository.create({
      type: "workflow",
      summary: "Route recovery guide",
      details: "Capture request retries and upstream fallback notes.",
      scopeGlob: "**/*",
      activationClass: "startup",
      lifecycleTriggers: ["after_tool"],
      status: "active",
      embedding: vector(1, 0, 0),
    });

    const result = await engine.activate({
      lifecycleTrigger: "before_model",
      scopeRef: ".",
      queryTokens: ["error", "handling"],
      maxMemories: 2,
    });

    expect(embeddingService.requests).toEqual(["error handling"]);
    expect(result.activated[0]?.id).toBe(broadMemory.id);
  });
});
