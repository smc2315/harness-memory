/**
 * Tests for the conversation buffer, dream:extract prompt building,
 * and memory:add embedding-based dedup.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { Database as SqlJsDatabase } from "sql.js";

import { EmbeddingService, cosineSimilarity } from "../../src/activation/embeddings";
import type { EmbeddingService as EmbeddingServiceType } from "../../src/activation/embeddings";
import { OpenCodeAdapter } from "../../src/adapters";
import type { AdapterModelRef } from "../../src/adapters/types";
import { ActivationEngine } from "../../src/activation";
import { DreamRepository } from "../../src/dream";
import { MemoryRepository } from "../../src/memory";
import { PolicyEngine, PolicyRuleRepository } from "../../src/policy";
import { buildExtractionPrompt } from "../../src/cli/dream-extract";
import { buildExtractionUserPrompt, parseExtractionResponse, executeExtractionActions } from "../../src/dream/llm-extract";
import type { DreamEvidenceEventRecord } from "../../src/dream/types";
import { createTestDb } from "../helpers/create-test-db";
import { MockEmbeddingService } from "../benchmark/benchmark-helpers";

// ---------------------------------------------------------------------------
// ConversationBuffer integration tests via the adapter + plugin pipeline
// ---------------------------------------------------------------------------

describe("Conversation Buffer Integration", () => {
  let db: SqlJsDatabase;
  let dreamRepository: DreamRepository;
  let adapter: OpenCodeAdapter;

  beforeEach(async () => {
    db = await createTestDb();
    const memoryRepository = new MemoryRepository(db);
    const mockEmbedding = new MockEmbeddingService();
    const activationEngine = new ActivationEngine(
      memoryRepository,
      mockEmbedding as unknown as EmbeddingServiceType,
    );
    const policyRuleRepository = new PolicyRuleRepository(db);
    const policyEngine = new PolicyEngine(policyRuleRepository);
    dreamRepository = new DreamRepository(db);

    adapter = new OpenCodeAdapter({
      activationEngine,
      policyEngine,
      dreamRepository,
    });
  });

  afterEach(() => {
    db.close();
  });

  test("adapter captures tool evidence that could feed a conversation buffer", async () => {
    const sessionID = "test-session-001";

    adapter.initializeSession({
      sessionID,
      agent: "assistant",
      model: { providerID: "anthropic", modelID: "claude-sonnet-4-20250514" },
    });

    // Simulate a tool call
    adapter.beforeTool({
      sessionID,
      tool: "edit",
      callID: "call-001",
      scopeRef: "src/config.ts",
    });

    await adapter.afterTool(
      {
        sessionID,
        tool: "edit",
        callID: "call-001",
        args: { filePath: "src/config.ts" },
        scopeRef: "src/config.ts",
      },
      {
        title: "Update config",
        output: "Added repository pattern for DB access",
      },
    );

    // The adapter creates dream evidence events
    const events = dreamRepository.listEvidenceEvents({});
    expect(events.length).toBeGreaterThan(0);

    // Verify the evidence has tool information
    const editEvent = events.find((e) => e.toolName === "edit");
    expect(editEvent).toBeDefined();
    expect(editEvent!.excerpt).toContain("repository pattern");
  });

  test("multiple tool calls generate multiple evidence events", async () => {
    const sessionID = "test-session-002";

    adapter.initializeSession({
      sessionID,
      agent: "assistant",
      model: { providerID: "anthropic", modelID: "claude-sonnet-4-20250514" },
    });

    const toolCalls = [
      { tool: "read", callID: "c1", title: "Read package.json", output: "type: module" },
      { tool: "bash", callID: "c2", title: "Run tests", output: "3 passed, 0 failed" },
      { tool: "edit", callID: "c3", title: "Update tsconfig", output: "strict: true" },
    ];

    for (const tc of toolCalls) {
      adapter.beforeTool({ sessionID, tool: tc.tool, callID: tc.callID });
      await adapter.afterTool(
        { sessionID, tool: tc.tool, callID: tc.callID, args: {} },
        { title: tc.title, output: tc.output },
      );
    }

    const events = dreamRepository.listEvidenceEvents({});
    expect(events.length).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// dream:extract prompt building
// ---------------------------------------------------------------------------

describe("dream:extract Prompt Building", () => {
  test("includes conversation content in prompt", () => {
    const batches = [
      makeBatchEvent("[user] repository 패턴으로 DB 접근하자\n[tool] [edit] Created UserRepository"),
    ];

    const prompt = buildExtractionPrompt(batches, [], "test.sqlite");

    expect(prompt).toContain("repository 패턴으로 DB 접근하자");
    expect(prompt).toContain("Created UserRepository");
  });

  test("includes existing memories for dedup context", () => {
    const batches = [makeBatchEvent("[user] ESM만 사용해")];
    const existing = [
      { id: "mem_001", type: "policy", summary: "TypeScript strict mode", status: "active" },
      { id: "mem_002", type: "decision", summary: "Use Supabase for DB", status: "active" },
    ];

    const prompt = buildExtractionUserPrompt(batches, existing);

    expect(prompt).toContain("TypeScript strict mode");
    expect(prompt).toContain("Use Supabase for DB");
    expect(prompt).toContain("dedup");
  });

  test("shows (none) when no existing memories", () => {
    const batches = [makeBatchEvent("[user] hello")];
    const prompt = buildExtractionPrompt(batches, [], "test.sqlite");

    expect(prompt).toContain("(none)");
  });

  test("includes structured JSON output format", () => {
    const batches = [makeBatchEvent("[user] plan9 style")];
    const prompt = buildExtractionUserPrompt(batches, []);

    // New format uses structured JSON with action types
    expect(prompt).toContain('"action"');
    expect(prompt).toContain('"create"');
    expect(prompt).toContain('"reinforce"');
    expect(prompt).toContain('"facts"');
  });

  test("lists valid action types in output format", () => {
    const batches = [makeBatchEvent("[user] test")];
    const prompt = buildExtractionUserPrompt(batches, []);

    // Action types documented in the prompt
    expect(prompt).toContain("create");
    expect(prompt).toContain("reinforce");
    expect(prompt).toContain("supersede");
    expect(prompt).toContain("stale");
    // Memory types mentioned in what to extract
    expect(prompt).toContain("preferences");
    expect(prompt).toContain("Architecture decisions");
  });

  test("specifies what to extract and what to ignore", () => {
    const batches = [makeBatchEvent("[user] test")];
    const prompt = buildExtractionPrompt(batches, [], "test.sqlite");

    // What to extract
    expect(prompt).toContain("User preferences");
    expect(prompt).toContain("Architecture decisions");
    expect(prompt).toContain("Project constraints");

    // What to ignore
    expect(prompt).toContain("One-off commands");
    expect(prompt).toContain("Temporary information");
    expect(prompt).toContain("Discarded hypotheses");
  });

  test("joins multiple batches with separator", () => {
    const batches = [
      makeBatchEvent("[user] batch 1 content"),
      makeBatchEvent("[user] batch 2 content"),
    ];

    const prompt = buildExtractionPrompt(batches, [], "test.sqlite");

    expect(prompt).toContain("batch 1 content");
    expect(prompt).toContain("batch 2 content");
    expect(prompt).toContain("---");
  });

  test("lists valid memory types in output format", () => {
    const batches = [makeBatchEvent("[user] test")];
    const prompt = buildExtractionUserPrompt(batches, []);

    // The output example shows "policy" as a type, and instructions mention extraction categories
    expect(prompt).toContain("policy");
    expect(prompt).toContain("preferences");
    expect(prompt).toContain("Architecture");
  });
});

// ---------------------------------------------------------------------------
// memory:add embedding dedup logic
// ---------------------------------------------------------------------------

describe("Memory Add Dedup Logic", () => {
  let db: SqlJsDatabase;
  let repository: MemoryRepository;

  beforeEach(async () => {
    db = await createTestDb();
    repository = new MemoryRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  test("creates memory when no duplicates exist", () => {
    const memory = repository.create({
      type: "policy",
      summary: "TypeScript strict mode",
      details: "Always use strict TypeScript configuration",
      scopeGlob: "src/**/*.ts",
      lifecycleTriggers: ["before_model"],
      status: "candidate",
      activationClass: "scoped",
    });

    expect(memory.id).toBeDefined();
    expect(memory.status).toBe("candidate");
  });

  test("cosine similarity identifies near-duplicates", () => {
    // These represent the same concept — their embeddings should be similar.
    // We test the dedup logic with synthetic vectors.
    const vec1 = new Float32Array(384);
    const vec2 = new Float32Array(384);

    // Same direction = high similarity
    for (let i = 0; i < 30; i++) {
      vec1[i] = 1.0;
      vec2[i] = 0.98;
    }

    // Normalize
    let norm1 = 0;
    let norm2 = 0;

    for (let i = 0; i < 384; i++) {
      norm1 += vec1[i] * vec1[i];
      norm2 += vec2[i] * vec2[i];
    }

    norm1 = Math.sqrt(norm1);
    norm2 = Math.sqrt(norm2);

    for (let i = 0; i < 384; i++) {
      vec1[i] /= norm1;
      vec2[i] /= norm2;
    }

    const sim = cosineSimilarity(vec1, vec2);
    expect(sim).toBeGreaterThan(0.99); // Nearly identical vectors
  });

  test("cosine similarity distinguishes different concepts", () => {
    const vec1 = new Float32Array(384);
    const vec2 = new Float32Array(384);

    // Orthogonal directions = low similarity
    for (let i = 0; i < 30; i++) vec1[i] = 1.0;
    for (let i = 30; i < 60; i++) vec2[i] = 1.0;

    // Normalize
    let norm1 = 0;
    let norm2 = 0;

    for (let i = 0; i < 384; i++) {
      norm1 += vec1[i] * vec1[i];
      norm2 += vec2[i] * vec2[i];
    }

    norm1 = Math.sqrt(norm1);
    norm2 = Math.sqrt(norm2);

    for (let i = 0; i < 384; i++) {
      vec1[i] /= norm1;
      vec2[i] /= norm2;
    }

    const sim = cosineSimilarity(vec1, vec2);
    expect(sim).toBeLessThan(0.1); // Orthogonal vectors
  });

  test("embedding stored on memory can be retrieved for dedup", () => {
    const memory = repository.create({
      type: "policy",
      summary: "Use vitest not jest",
      details: "All tests must use vitest framework",
      scopeGlob: "**/*",
      lifecycleTriggers: ["before_model"],
      status: "active",
      activationClass: "scoped",
    });

    const embedding = new Float32Array(384);
    embedding[0] = 1.0;

    repository.updateEmbedding(memory.id, embedding);

    const retrieved = repository.getById(memory.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.embedding).not.toBeNull();
    expect(retrieved!.embedding!.length).toBe(384);
    expect(retrieved!.embedding![0]).toBeCloseTo(1.0);
  });

  test("dedup threshold: 0.85 similarity rejects duplicate", () => {
    // Simulate the dedup check logic from memory-add.ts
    const existingSummary = "Always use TypeScript strict mode";
    const newSummary = "TypeScript strict mode must be enabled";

    // With real embeddings these would be very similar.
    // Here we verify the threshold logic with controlled vectors.
    const existingVec = new Float32Array(384);
    const newVec = new Float32Array(384);

    // Very similar direction
    for (let i = 0; i < 50; i++) {
      existingVec[i] = 1.0;
      newVec[i] = 0.95 + Math.random() * 0.05;
    }

    // Normalize
    for (const vec of [existingVec, newVec]) {
      let norm = 0;

      for (let i = 0; i < 384; i++) norm += vec[i] * vec[i];

      norm = Math.sqrt(norm);

      for (let i = 0; i < 384; i++) vec[i] /= norm;
    }

    const similarity = cosineSimilarity(existingVec, newVec);
    const DEDUP_THRESHOLD = 0.85;

    expect(similarity).toBeGreaterThan(DEDUP_THRESHOLD);
    // This would be rejected as a duplicate.
  });
});

// ---------------------------------------------------------------------------
// LLM response parsing
// ---------------------------------------------------------------------------

describe("LLM Extraction Response Parsing", () => {
  test("parses valid JSON extraction response", () => {
    const response = JSON.stringify({
      facts: [
        { action: "create", type: "policy", summary: "ESM only", details: "Never use CommonJS", confidence: 0.9 },
        { action: "reinforce", targetMemoryId: "mem_001", summary: "Confirmed: strict TS", details: "Still using strict mode" },
      ],
    });

    const result = parseExtractionResponse(response);

    expect(result.facts).toHaveLength(2);
    expect(result.facts[0].action).toBe("create");
    expect(result.facts[0].type).toBe("policy");
    expect(result.facts[0].summary).toBe("ESM only");
    expect(result.facts[1].action).toBe("reinforce");
    expect(result.facts[1].targetMemoryId).toBe("mem_001");
  });

  test("handles markdown-wrapped JSON", () => {
    const response = "```json\n" + JSON.stringify({ facts: [{ action: "create", summary: "test", details: "test" }] }) + "\n```";
    const result = parseExtractionResponse(response);

    expect(result.facts).toHaveLength(1);
  });

  test("returns empty facts for invalid JSON", () => {
    const result = parseExtractionResponse("not json at all");
    expect(result.facts).toHaveLength(0);
  });

  test("returns empty facts for empty response", () => {
    const result = parseExtractionResponse('{"facts": []}');
    expect(result.facts).toHaveLength(0);
  });

  test("skips facts with invalid action type", () => {
    const response = JSON.stringify({
      facts: [
        { action: "invalid_action", summary: "test", details: "test" },
        { action: "create", summary: "valid", details: "valid" },
      ],
    });

    const result = parseExtractionResponse(response);
    expect(result.facts).toHaveLength(1);
    expect(result.facts[0].summary).toBe("valid");
  });

  test("skips facts without summary", () => {
    const response = JSON.stringify({
      facts: [
        { action: "create", details: "no summary" },
        { action: "create", summary: "", details: "empty summary" },
        { action: "create", summary: "valid", details: "has summary" },
      ],
    });

    const result = parseExtractionResponse(response);
    expect(result.facts).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Action execution
// ---------------------------------------------------------------------------

describe("Extraction Action Execution", () => {
  let db: SqlJsDatabase;
  let repository: MemoryRepository;

  beforeEach(async () => {
    db = await createTestDb();
    repository = new MemoryRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  test("create action produces candidate memory", async () => {
    const results = await executeExtractionActions(
      [{ action: "create", type: "policy", summary: "Use vitest", details: "Always use vitest for testing", confidence: 0.85 }],
      { memoryRepository: repository },
    );

    expect(results).toHaveLength(1);
    expect(results[0].skipped).toBe(false);
    expect(results[0].action).toBe("create");

    const created = repository.getById(results[0].memoryId);
    expect(created).not.toBeNull();
    expect(created!.status).toBe("candidate");
    expect(created!.summary).toBe("Use vitest");
  });

  test("reinforce action bumps confidence", async () => {
    const memory = repository.create({
      type: "policy",
      summary: "TypeScript strict mode",
      details: "Always use strict mode",
      scopeGlob: "**/*",
      lifecycleTriggers: ["before_model"],
      confidence: 0.7,
      importance: 0.8,
      status: "active",
      activationClass: "scoped",
    });

    const results = await executeExtractionActions(
      [{ action: "reinforce", targetMemoryId: memory.id, summary: "Confirmed strict mode", details: "Still using it" }],
      { memoryRepository: repository },
    );

    expect(results[0].skipped).toBe(false);
    const updated = repository.getById(memory.id);
    expect(updated!.confidence).toBeGreaterThan(0.7);
  });

  test("supersede marks old as superseded and creates new candidate", async () => {
    const oldMemory = repository.create({
      type: "decision",
      summary: "Use jest for testing",
      details: "Jest is the standard",
      scopeGlob: "**/*",
      lifecycleTriggers: ["before_model"],
      confidence: 0.8,
      importance: 0.8,
      status: "active",
      activationClass: "scoped",
    });

    const results = await executeExtractionActions(
      [{
        action: "supersede",
        targetMemoryId: oldMemory.id,
        type: "decision",
        summary: "Use vitest for testing",
        details: "Switched from jest to vitest",
      }],
      { memoryRepository: repository },
    );

    expect(results[0].skipped).toBe(false);

    const old = repository.getById(oldMemory.id);
    expect(old!.status).toBe("superseded");

    const newMem = repository.getById(results[0].memoryId);
    expect(newMem).not.toBeNull();
    expect(newMem!.status).toBe("candidate");
    expect(newMem!.summary).toBe("Use vitest for testing");
  });

  test("stale marks memory as stale", async () => {
    const memory = repository.create({
      type: "workflow",
      summary: "Deploy to Heroku",
      details: "Use Heroku for deployment",
      scopeGlob: "**/*",
      lifecycleTriggers: ["before_model"],
      confidence: 0.8,
      importance: 0.7,
      status: "active",
      activationClass: "scoped",
    });

    const results = await executeExtractionActions(
      [{ action: "stale", targetMemoryId: memory.id, summary: "No longer using Heroku", details: "Switched to Vercel" }],
      { memoryRepository: repository },
    );

    expect(results[0].skipped).toBe(false);
    const updated = repository.getById(memory.id);
    expect(updated!.status).toBe("stale");
  });

  test("reinforce without targetMemoryId is skipped", async () => {
    const results = await executeExtractionActions(
      [{ action: "reinforce", summary: "No target", details: "Missing ID" }],
      { memoryRepository: repository },
    );

    expect(results[0].skipped).toBe(true);
    expect(results[0].reason).toContain("No targetMemoryId");
  });
});

// ---------------------------------------------------------------------------
// conversation-batch evidence in dream pipeline
// ---------------------------------------------------------------------------

describe("Conversation Batch Evidence Pipeline", () => {
  let db: SqlJsDatabase;
  let dreamRepository: DreamRepository;

  beforeEach(async () => {
    db = await createTestDb();
    dreamRepository = new DreamRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  test("conversation-batch events are stored and retrievable", () => {
    dreamRepository.createEvidenceEvent({
      sessionId: "ses-001",
      callId: "conv-batch-1",
      toolName: "conversation-batch",
      scopeRef: ".",
      sourceRef: "ses-001:conv-batch-1:conversation-batch",
      title: "Conversation batch (5 entries)",
      excerpt: "[user] ESM만 사용해\n[tool] [read] package.json: type: commonjs\n[user] repository 패턴 쓰자",
      args: {},
      topicGuess: "conversation-batch:.:pending-extraction",
      typeGuess: "workflow",
      salience: 0.5,
      novelty: 0.8,
      contradictionSignal: false,
    });

    const events = dreamRepository.listEvidenceEvents({});
    const batch = events.find((e) => e.toolName === "conversation-batch");

    expect(batch).toBeDefined();
    expect(batch!.excerpt).toContain("ESM만 사용해");
    expect(batch!.excerpt).toContain("repository 패턴");
    expect(batch!.status).toBe("pending");
  });

  test("conversation-batch events can be filtered by status for processing", () => {
    // Create 2 pending batches and 1 consumed
    dreamRepository.createEvidenceEvent({
      sessionId: "ses-001",
      callId: "cb-1",
      toolName: "conversation-batch",
      scopeRef: ".",
      sourceRef: "ses-001:cb-1:conversation-batch",
      title: "Batch 1",
      excerpt: "[user] First batch",
      args: {},
      topicGuess: "conversation-batch:.:pending-extraction",
      typeGuess: "workflow",
      salience: 0.5,
      novelty: 0.8,
    });

    dreamRepository.createEvidenceEvent({
      sessionId: "ses-001",
      callId: "cb-2",
      toolName: "conversation-batch",
      scopeRef: ".",
      sourceRef: "ses-001:cb-2:conversation-batch",
      title: "Batch 2",
      excerpt: "[user] Second batch",
      args: {},
      topicGuess: "conversation-batch:.:pending-extraction",
      typeGuess: "workflow",
      salience: 0.5,
      novelty: 0.8,
    });

    const allEvents = dreamRepository.listEvidenceEvents({});
    const pendingBatches = allEvents.filter(
      (e) => e.toolName === "conversation-batch" && e.status === "pending",
    );

    expect(pendingBatches.length).toBe(2);

    // Mark first as consumed — need a dream run for the FK constraint
    const dreamRun = dreamRepository.createDreamRun({
      trigger: "manual",
      windowStart: new Date().toISOString(),
      windowEnd: new Date().toISOString(),
      evidenceCount: 1,
      summary: "test extraction run",
    });

    dreamRepository.markEvidenceEventsConsumed(
      [pendingBatches[0].id],
      dreamRun.id,
    );

    const afterConsume = dreamRepository.listEvidenceEvents({});
    const stillPending = afterConsume.filter(
      (e) => e.toolName === "conversation-batch" && e.status === "pending",
    );

    expect(stillPending.length).toBe(1);
    expect(stillPending[0].excerpt).toContain("Second batch");
  });

  test("conversation-batch excerpt preserves role annotations", () => {
    const excerpt = [
      "[user] 배포는 Vercel로 하자",
      "[tool] [bash] vercel deploy: Success",
      "[user] ESM only, CommonJS 쓰지마",
      "[tool] [edit] Updated tsconfig: module: esnext",
      "[user] repository 패턴 사용해",
    ].join("\n");

    dreamRepository.createEvidenceEvent({
      sessionId: "ses-001",
      callId: "cb-roles",
      toolName: "conversation-batch",
      scopeRef: ".",
      sourceRef: "ses-001:cb-roles:conversation-batch",
      title: "Conversation batch (5 entries)",
      excerpt,
      args: {},
      topicGuess: "conversation-batch:.:pending-extraction",
      typeGuess: "workflow",
      salience: 0.5,
      novelty: 0.8,
    });

    const events = dreamRepository.listEvidenceEvents({});
    const batch = events.find((e) => e.callId === "cb-roles");

    expect(batch).toBeDefined();

    // Count role annotations
    const userLines = batch!.excerpt.split("\n").filter((l) => l.startsWith("[user]"));
    const toolLines = batch!.excerpt.split("\n").filter((l) => l.startsWith("[tool]"));

    expect(userLines.length).toBe(3);
    expect(toolLines.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeBatchEvent(excerpt: string): DreamEvidenceEventRecord {
  return {
    id: `evt-${Math.random().toString(36).slice(2, 8)}`,
    sessionId: "test-session",
    callId: "conv-batch-test",
    toolName: "conversation-batch",
    scopeRef: ".",
    sourceRef: "test-session:conv-batch-test:conversation-batch",
    title: "Conversation batch (test)",
    excerpt,
    argsJson: "{}",
    metadataJson: "null",
    topicGuess: "conversation-batch:.:pending-extraction",
    typeGuess: "workflow",
    salience: 0.5,
    novelty: 0.8,
    contradictionSignal: false,
    status: "pending",
    retryCount: 0,
    nextReviewAt: null,
    lastReviewedAt: null,
    dreamRunId: null,
    consumedAt: null,
    discardedAt: null,
    createdAt: new Date().toISOString(),
  };
}
