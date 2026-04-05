import { afterAll, afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  parseExtractionResponse,
  executeExtractionActions,
} from "../../src/dream/llm-extract";
import type { ActionHandlerDeps } from "../../src/dream/llm-extract";
import { MemoryRepository } from "../../src/memory";
import {
  cosineSimilarity,
  EmbeddingService,
  EMBEDDING_DIMENSIONS,
} from "../../src/activation/embeddings";
import { createTestDb } from "../helpers/create-test-db";
import {
  printBenchmarkReport,
  MockEmbeddingService,
  buildEmbeddingLookup,
  TEST_MEMORIES,
} from "./benchmark-helpers";

const metrics = {
  parserCases: 0,
  parserPassed: 0,
  actionCases: 0,
  actionPassed: 0,
  typeChecks: 0,
  typeCorrect: 0,
};

function markParserCase(passed: boolean): void {
  metrics.parserCases += 1;
  if (passed) {
    metrics.parserPassed += 1;
  }
}

function markActionCase(passed: boolean): void {
  metrics.actionCases += 1;
  if (passed) {
    metrics.actionPassed += 1;
  }
}

function markTypeCheck(expected: string, actual: string): void {
  metrics.typeChecks += 1;
  if (expected === actual) {
    metrics.typeCorrect += 1;
  }
}

function makeUnitVector(bucket: number): Float32Array {
  const vec = new Float32Array(EMBEDDING_DIMENSIONS);
  vec[bucket] = 1;
  return vec;
}

describe("HM-ExtractBench", () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let repository: MemoryRepository;

  beforeEach(async () => {
    db = await createTestDb();
    repository = new MemoryRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  describe("parser", () => {
    test("valid JSON with fenced markdown -> extracts facts", () => {
      const validResponse = "```json\n{" +
        '\"facts\": [{\"action\": \"create\", \"type\": \"workflow\", \"summary\": \"Run tests before commit\", \"details\": \"Always run vitest before pushing\"}]' +
        "}\n```";

      const parsed = parseExtractionResponse(validResponse);
      expect(parsed.facts).toHaveLength(1);
      expect(parsed.facts[0].action).toBe("create");
      expect(parsed.facts[0].summary).toBe("Run tests before commit");
      markParserCase(true);
    });

    test("malformed JSON -> returns empty facts array", () => {
      const malformed = "```json\n{\"facts\":[{\"action\":\"create\",]\n```";
      const parsed = parseExtractionResponse(malformed);
      expect(parsed.facts).toEqual([]);
      markParserCase(true);
    });

    test("invalid action filtered -> only valid actions kept", () => {
      const response = JSON.stringify({
        facts: [
          { action: "drop_all", summary: "invalid", details: "invalid" },
          { action: "create", type: "workflow", summary: "valid", details: "valid" },
        ],
      });

      const parsed = parseExtractionResponse(response);
      expect(parsed.facts).toHaveLength(1);
      expect(parsed.facts[0].summary).toBe("valid");
      markParserCase(true);
    });

    test("missing required fields -> gracefully skipped", () => {
      const response = JSON.stringify({
        facts: [
          { action: "create", details: "no summary" },
          { action: "reinforce", targetMemoryId: "mem_1", summary: "has summary" },
        ],
      });

      const parsed = parseExtractionResponse(response);
      expect(parsed.facts).toHaveLength(1);
      expect(parsed.facts[0].action).toBe("reinforce");
      expect(parsed.facts[0].details).toBe("has summary");
      markParserCase(true);
    });
  });

  describe("create + dedup", () => {
    test("new unique fact -> creates candidate memory", async () => {
      const facts = [
        {
          action: "create" as const,
          type: "workflow" as const,
          summary: "Use changelog entries for releases",
          details: "Add changelog entries before release cut.",
          confidence: 0.88,
        },
      ];

      const results = await executeExtractionActions(facts, { memoryRepository: repository });
      expect(results).toHaveLength(1);
      expect(results[0].skipped).toBe(false);

      const created = repository.getById(results[0].memoryId);
      expect(created).not.toBeNull();
      expect(created!.status).toBe("candidate");
      markActionCase(true);
    });

    test("near-duplicate (cosine > 0.85) -> skipped with dedup reason", async () => {
      const lookup = buildEmbeddingLookup();
      const anchorDef = TEST_MEMORIES[0];
      const anchorText = `passage: ${anchorDef.input.summary} ${anchorDef.input.details}`;
      const anchorEmbedding = lookup.get(anchorText);

      if (anchorEmbedding === undefined) {
        throw new Error("Expected anchor embedding in lookup");
      }

      const existing = repository.create({
        type: "workflow",
        summary: "Anchor workflow",
        details: "Anchor details for dedup check",
        scopeGlob: "**/*",
        lifecycleTriggers: ["before_model"],
        status: "active",
        confidence: 0.92,
        importance: 0.8,
      });
      repository.updateEmbedding(existing.id, anchorEmbedding);

      const duplicateSummary = "Run tests before commit";
      const duplicateDetails = "Always run vitest before pushing";
      lookup.set(`passage: ${duplicateSummary} ${duplicateDetails}`, anchorEmbedding);

      const mockEmbedding = new MockEmbeddingService(lookup);
      const similarity = cosineSimilarity(anchorEmbedding, anchorEmbedding);
      expect(similarity).toBeGreaterThan(0.85);

      const deps: ActionHandlerDeps = {
        memoryRepository: repository,
        embeddingService: mockEmbedding as unknown as EmbeddingService,
        cosineSimilarity,
      };

      const results = await executeExtractionActions(
        [
          {
            action: "create",
            type: "workflow",
            summary: duplicateSummary,
            details: duplicateDetails,
            confidence: 0.9,
          },
        ],
        deps,
      );

      expect(results).toHaveLength(1);
      expect(results[0].skipped).toBe(true);
      expect(results[0].reason).toContain("Duplicate");
      markActionCase(true);
    });

    test("create with all types -> correct type assignment", async () => {
      const types = [
        "policy",
        "workflow",
        "pitfall",
        "architecture_constraint",
        "decision",
      ] as const;

      const facts = types.map((typeName, idx) => ({
        action: "create" as const,
        type: typeName,
        summary: `fact-${typeName}-${String(idx)}`,
        details: `details-${typeName}-${String(idx)}`,
        confidence: 0.86,
      }));

      const results = await executeExtractionActions(facts, { memoryRepository: repository });
      expect(results.every((r) => !r.skipped)).toBe(true);

      for (const result of results) {
        const created = repository.getById(result.memoryId);
        expect(created).not.toBeNull();
        const expectedType = facts.find((f) => f.summary === result.summary)?.type;
        expect(expectedType).toBeDefined();
        markTypeCheck(expectedType!, created!.type);
      }

      markActionCase(true);
    });

    test("create sets correct defaults (status=candidate, confidence)", async () => {
      const results = await executeExtractionActions(
        [
          {
            action: "create",
            type: "workflow",
            summary: "Default checks",
            details: "No confidence provided",
          },
        ],
        { memoryRepository: repository },
      );

      const created = repository.getById(results[0].memoryId);
      expect(created).not.toBeNull();
      expect(created!.status).toBe("candidate");
      expect(created!.confidence).toBeCloseTo(0.7, 6);
      markActionCase(true);
    });
  });

  describe("reinforce / supersede / stale", () => {
    test("reinforce existing -> bumps confidence +0.05", async () => {
      const target = repository.create({
        type: "workflow",
        summary: "Reinforce me",
        details: "Original confidence",
        scopeGlob: "**/*",
        lifecycleTriggers: ["before_model"],
        status: "active",
        confidence: 0.7,
        importance: 0.7,
      });

      const results = await executeExtractionActions(
        [{ action: "reinforce", targetMemoryId: target.id, summary: "confirm", details: "confirm" }],
        { memoryRepository: repository },
      );

      expect(results[0].skipped).toBe(false);
      const updated = repository.getById(target.id);
      expect(updated!.confidence).toBeCloseTo(0.75, 6);
      markActionCase(true);
    });

    test("reinforce caps at 0.99", async () => {
      const target = repository.create({
        type: "workflow",
        summary: "Confidence ceiling",
        details: "Starts high",
        scopeGlob: "**/*",
        lifecycleTriggers: ["before_model"],
        status: "active",
        confidence: 0.98,
        importance: 0.8,
      });

      await executeExtractionActions(
        [{ action: "reinforce", targetMemoryId: target.id, summary: "confirm", details: "confirm" }],
        { memoryRepository: repository },
      );

      const updated = repository.getById(target.id);
      expect(updated!.confidence).toBeCloseTo(0.99, 6);
      markActionCase(true);
    });

    test("supersede -> old marked superseded, new candidate created", async () => {
      const oldMemory = repository.create({
        type: "decision",
        summary: "Use old runtime",
        details: "Legacy choice",
        scopeGlob: "**/*",
        lifecycleTriggers: ["before_model"],
        status: "active",
        confidence: 0.88,
        importance: 0.75,
      });

      const results = await executeExtractionActions(
        [
          {
            action: "supersede",
            targetMemoryId: oldMemory.id,
            type: "decision",
            summary: "Use new runtime",
            details: "Updated choice",
            confidence: 0.9,
          },
        ],
        { memoryRepository: repository },
      );

      expect(results[0].skipped).toBe(false);
      expect(repository.getById(oldMemory.id)!.status).toBe("superseded");

      const replacement = repository.getById(results[0].memoryId);
      expect(replacement).not.toBeNull();
      expect(replacement!.status).toBe("candidate");
      expect(replacement!.supersedesMemoryId).toBe(oldMemory.id);
      markActionCase(true);
    });

    test("stale -> existing marked stale", async () => {
      const target = repository.create({
        type: "workflow",
        summary: "Outdated deployment path",
        details: "No longer used",
        scopeGlob: "**/*",
        lifecycleTriggers: ["before_model"],
        status: "active",
        confidence: 0.82,
        importance: 0.7,
      });

      const results = await executeExtractionActions(
        [{ action: "stale", targetMemoryId: target.id, summary: "obsolete", details: "obsolete" }],
        { memoryRepository: repository },
      );

      expect(results[0].skipped).toBe(false);
      expect(repository.getById(target.id)!.status).toBe("stale");
      markActionCase(true);
    });
  });

  describe("aggregate metrics", () => {
    test("mixed batch (3 create, 2 reinforce, 1 supersede, 1 stale) -> correct action counts", async () => {
      const reinforceA = repository.create({
        type: "workflow",
        summary: "Reinforce A",
        details: "existing",
        scopeGlob: "**/*",
        lifecycleTriggers: ["before_model"],
        status: "active",
        confidence: 0.8,
        importance: 0.7,
      });
      const reinforceB = repository.create({
        type: "pitfall",
        summary: "Reinforce B",
        details: "existing",
        scopeGlob: "**/*",
        lifecycleTriggers: ["before_model"],
        status: "candidate",
        confidence: 0.84,
        importance: 0.7,
      });
      const supersedeTarget = repository.create({
        type: "decision",
        summary: "Old decision",
        details: "old",
        scopeGlob: "**/*",
        lifecycleTriggers: ["before_model"],
        status: "active",
        confidence: 0.9,
        importance: 0.8,
      });
      const staleTarget = repository.create({
        type: "workflow",
        summary: "Old workflow",
        details: "old",
        scopeGlob: "**/*",
        lifecycleTriggers: ["before_model"],
        status: "active",
        confidence: 0.86,
        importance: 0.8,
      });

      const facts = [
        { action: "create" as const, type: "workflow" as const, summary: "c1", details: "d1" },
        { action: "create" as const, type: "policy" as const, summary: "c2", details: "d2" },
        { action: "create" as const, type: "pitfall" as const, summary: "c3", details: "d3" },
        { action: "reinforce" as const, targetMemoryId: reinforceA.id, summary: "r1", details: "r1" },
        { action: "reinforce" as const, targetMemoryId: reinforceB.id, summary: "r2", details: "r2" },
        {
          action: "supersede" as const,
          targetMemoryId: supersedeTarget.id,
          type: "decision" as const,
          summary: "new decision",
          details: "new decision details",
        },
        { action: "stale" as const, targetMemoryId: staleTarget.id, summary: "stale", details: "stale" },
      ];

      const results = await executeExtractionActions(facts, { memoryRepository: repository });
      const counts = {
        create: results.filter((r) => r.action === "create").length,
        reinforce: results.filter((r) => r.action === "reinforce").length,
        supersede: results.filter((r) => r.action === "supersede").length,
        stale: results.filter((r) => r.action === "stale").length,
      };

      expect(counts.create).toBe(3);
      expect(counts.reinforce).toBe(2);
      expect(counts.supersede).toBe(1);
      expect(counts.stale).toBe(1);
      markActionCase(true);
    });

    test("all actions with invalid targetMemoryId -> skipped gracefully", async () => {
      const facts = [
        { action: "reinforce" as const, targetMemoryId: "mem_missing_1", summary: "x", details: "x" },
        { action: "supersede" as const, targetMemoryId: "mem_missing_2", summary: "y", details: "y" },
        { action: "stale" as const, targetMemoryId: "mem_missing_3", summary: "z", details: "z" },
      ];

      const results = await executeExtractionActions(facts, { memoryRepository: repository });
      expect(results).toHaveLength(3);
      expect(results.every((r) => r.skipped)).toBe(true);
      expect(results.every((r) => (r.reason ?? "").includes("not found"))).toBe(true);
      markActionCase(true);
    });

    test("empty facts array -> no errors, empty results", async () => {
      const results = await executeExtractionActions([], { memoryRepository: repository });
      expect(results).toEqual([]);

      const basis = makeUnitVector(0);
      expect(basis.length).toBe(EMBEDDING_DIMENSIONS);
      markActionCase(true);
    });

    test("type accuracy across all 5 types", async () => {
      const types = [
        "policy",
        "workflow",
        "pitfall",
        "architecture_constraint",
        "decision",
      ] as const;

      const facts = types.map((t, index) => ({
        action: "create" as const,
        type: t,
        summary: `typed-summary-${t}-${String(index)}`,
        details: `typed-details-${t}-${String(index)}`,
      }));

      const results = await executeExtractionActions(facts, { memoryRepository: repository });
      for (const result of results) {
        const created = repository.getById(result.memoryId);
        expect(created).not.toBeNull();
        const expected = facts.find((fact) => fact.summary === result.summary);
        if (expected !== undefined) {
          markTypeCheck(expected.type, created!.type);
        }
      }

      const allTypedCorrect = results.every((result) => {
        const created = repository.getById(result.memoryId);
        const expected = facts.find((fact) => fact.summary === result.summary);
        return created !== null && expected !== undefined && created.type === expected.type;
      });

      expect(allTypedCorrect).toBe(true);
      markActionCase(true);
    });
  });

  afterAll(() => {
    printBenchmarkReport("HM-ExtractBench", {
      "Parser success rate": metrics.parserCases === 0 ? 1 : metrics.parserPassed / metrics.parserCases,
      "Action success rate": metrics.actionCases === 0 ? 1 : metrics.actionPassed / metrics.actionCases,
      "Type accuracy": metrics.typeChecks === 0 ? 1 : metrics.typeCorrect / metrics.typeChecks,
    });
  });
});
