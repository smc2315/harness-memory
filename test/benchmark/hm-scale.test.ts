import { afterAll, afterEach, describe, expect, test } from "vitest";

import { ActivationEngine } from "../../src/activation";
import { EMBEDDING_DIMENSIONS } from "../../src/activation/embeddings";
import { MemoryRepository, type CreateMemoryInput } from "../../src/memory";
import {
  CONCEPTS,
  MockEmbeddingService,
  TEST_MEMORIES,
  TEST_QUERIES,
  precisionAtK,
  printBenchmarkReport,
  recallAtK,
} from "./benchmark-helpers";
import { createTestDb } from "../helpers/create-test-db";

type DistractorDef = {
  tag: string;
  input: CreateMemoryInput;
  concepts: number[];
};

type PoolMetrics = {
  poolSize: number;
  meanRecallAt5: number;
  meanPrecisionAt5: number;
  inactiveLeaks: number;
  meanLatencyMs: number;
};

const DIMS_PER_CONCEPT = Math.floor(EMBEDDING_DIMENSIONS / 10);
const INACTIVE_TAGS = new Set(["M16-stale", "M17-superseded", "M18-rejected"]);
const comparativeRecalls: Record<number, number> = {};

function makeBasisVector(conceptId: number): Float32Array {
  const vec = new Float32Array(EMBEDDING_DIMENSIONS);
  const start = conceptId * DIMS_PER_CONCEPT;

  for (let i = start; i < start + DIMS_PER_CONCEPT; i++) {
    vec[i] = 1.0;
  }

  const norm = Math.sqrt(DIMS_PER_CONCEPT);
  for (let i = 0; i < vec.length; i++) {
    vec[i] /= norm;
  }

  return vec;
}

function blendAndNoise(concepts: readonly number[], seed: number): Float32Array {
  const result = new Float32Array(EMBEDDING_DIMENSIONS);

  for (let c = 0; c < concepts.length; c++) {
    const basis = makeBasisVector(concepts[c]);
    for (let i = 0; i < EMBEDDING_DIMENSIONS; i++) {
      result[i] += basis[i] / concepts.length;
    }
  }

  for (let i = 0; i < result.length; i++) {
    const hash = Math.sin(seed * 9301 + i * 49297 + 233280) * 0.5 + 0.5;
    result[i] += (hash - 0.5) * 0.05;
  }

  let norm = 0;
  for (let i = 0; i < result.length; i++) {
    norm += result[i] * result[i];
  }
  norm = Math.sqrt(norm);

  if (norm > 0) {
    for (let i = 0; i < result.length; i++) {
      result[i] /= norm;
    }
  }

  return result;
}

function blendWithWeightsAndNoise(
  concepts: readonly number[],
  seed: number,
  weights?: readonly number[],
): Float32Array {
  const effectiveWeights = weights ?? concepts.map(() => 1 / concepts.length);
  const result = new Float32Array(EMBEDDING_DIMENSIONS);

  for (let c = 0; c < concepts.length; c++) {
    const basis = makeBasisVector(concepts[c]);
    for (let i = 0; i < EMBEDDING_DIMENSIONS; i++) {
      result[i] += basis[i] * effectiveWeights[c];
    }
  }

  for (let i = 0; i < result.length; i++) {
    const hash = Math.sin(seed * 9301 + i * 49297 + 233280) * 0.5 + 0.5;
    result[i] += (hash - 0.5) * 0.04;
  }

  let norm = 0;
  for (let i = 0; i < result.length; i++) {
    norm += result[i] * result[i];
  }
  norm = Math.sqrt(norm);

  if (norm > 0) {
    for (let i = 0; i < result.length; i++) {
      result[i] /= norm;
    }
  }

  return result;
}

function tokenizeQuery(text: string): string[] {
  return text.split(/[\s\p{P}]+/u).filter((token) => token.length > 2);
}

function distractorTimestamp(index: number): string {
  return new Date(Date.UTC(2026, 3, 1, 0, index, 0)).toISOString();
}

function generateDistractors(count: number, startIndex: number): DistractorDef[] {
  const distractors: DistractorDef[] = [];
  const conceptKeys = Object.values(CONCEPTS) as number[];
  const memoryTypes = [
    "workflow",
    "pitfall",
    "policy",
    "decision",
    "architecture_constraint",
  ] as const;

  // Near-miss distractors: use same concepts as real memories but with different content
  // These are much harder to distinguish from relevant memories
  const NEAR_MISS_TEMPLATES = [
    { concepts: [CONCEPTS.TYPESCRIPT], summary: "TypeScript compiler flags for production builds", details: "Use --declaration and --sourceMap for library builds. Not related to strict mode." },
    { concepts: [CONCEPTS.TYPESCRIPT], summary: "TypeScript namespace patterns for legacy code", details: "Avoid namespaces in new code. Use ES modules instead." },
    { concepts: [CONCEPTS.DATABASE], summary: "Database connection pooling configuration", details: "Set max connections to 10 for development. Use PgBouncer in production." },
    { concepts: [CONCEPTS.DATABASE], summary: "Database schema versioning with timestamps", details: "Use UTC timestamps for all migration tracking columns." },
    { concepts: [CONCEPTS.TESTING], summary: "Test coverage thresholds for CI gates", details: "Require 80% line coverage. Exclude generated files from reports." },
    { concepts: [CONCEPTS.TESTING], summary: "Test data factory patterns for integration tests", details: "Use builder pattern for test fixtures. Reset DB between suites." },
    { concepts: [CONCEPTS.ERRORS], summary: "Error boundary patterns for async operations", details: "Wrap all async handlers in try-catch with typed error narrowing." },
    { concepts: [CONCEPTS.ERRORS], summary: "Error logging format standardization", details: "Use structured JSON logging with error code, message, and stack trace." },
    { concepts: [CONCEPTS.GIT], summary: "Git hook configuration for pre-push validation", details: "Run type-check and lint on pre-push. Skip on WIP branches." },
    { concepts: [CONCEPTS.VECTOR], summary: "Vector index rebuild frequency policy", details: "Rebuild HNSW index weekly or after 1000 new embeddings." },
  ];

  for (let i = 0; i < count; i++) {
    const idx = startIndex + i;
    const ts = distractorTimestamp(idx);

    // First 10 distractors per batch use near-miss templates (harder)
    const nearMissIdx = i % NEAR_MISS_TEMPLATES.length;
    const isNearMiss = i < NEAR_MISS_TEMPLATES.length * 3; // ~30 near-misses per pool
    const template = NEAR_MISS_TEMPLATES[nearMissIdx];

    if (isNearMiss) {
      distractors.push({
        tag: `D${String(idx).padStart(4, "0")}`,
        input: {
          type: memoryTypes[idx % memoryTypes.length],
          summary: `${template.summary} (variant ${Math.floor(i / NEAR_MISS_TEMPLATES.length)})`,
          details: template.details,
          scopeGlob: "**/*",
          lifecycleTriggers: ["before_model"],
          status: "active",
          confidence: 0.6 + (idx % 20) * 0.015,
          importance: 0.5 + (idx % 15) * 0.02,
          activationClass: "scoped",
          createdAt: ts,
          updatedAt: ts,
        },
        concepts: template.concepts,
      });
    } else {
      const c1 = conceptKeys[idx % conceptKeys.length];
      const c2 = conceptKeys[(idx + 3) % conceptKeys.length];
      distractors.push({
        tag: `D${String(idx).padStart(4, "0")}`,
        input: {
          type: memoryTypes[idx % memoryTypes.length],
          summary: `Distractor ${idx}: general knowledge about ${c1} and ${c2}`,
          details: `This is distractor memory ${idx} covering mixed topics.`,
          scopeGlob: "**/*",
          lifecycleTriggers: ["before_model"],
          status: "active",
          confidence: 0.5 + (idx % 30) * 0.01,
          importance: 0.4 + (idx % 20) * 0.01,
          activationClass: "scoped",
          createdAt: ts,
          updatedAt: ts,
        },
        concepts: [c1, c2],
      });
    }
  }

  return distractors;
}

async function evaluatePool(poolSize: number): Promise<PoolMetrics> {
  const baseCount = TEST_MEMORIES.length;
  const distractorCount = poolSize - baseCount;

  if (distractorCount < 0) {
    throw new Error(`Pool size ${poolSize} cannot be smaller than base count ${baseCount}`);
  }

  const db = await createTestDb();
  const repository = new MemoryRepository(db);
  const distractors = generateDistractors(distractorCount, 1);

  const lookup = new Map<string, Float32Array>();

  for (let i = 0; i < TEST_MEMORIES.length; i++) {
    const memory = TEST_MEMORIES[i];
    lookup.set(
      `passage: ${memory.input.summary} ${memory.input.details}`,
      blendWithWeightsAndNoise(memory.concepts, i + 1, memory.conceptWeights),
    );
  }

  for (let i = 0; i < distractors.length; i++) {
    const distractor = distractors[i];
    lookup.set(
      `passage: ${distractor.input.summary} ${distractor.input.details}`,
      blendAndNoise(distractor.concepts, 5000 + i),
    );
  }

  for (let i = 0; i < TEST_QUERIES.length; i++) {
    const query = TEST_QUERIES[i];
    lookup.set(
      `query: ${query.text}`,
      blendWithWeightsAndNoise(query.concepts, 1000 + i, query.conceptWeights),
    );
  }

  const mockEmbedding = new MockEmbeddingService(lookup);
  const engine = new ActivationEngine(repository, mockEmbedding as never);
  const idToTag = new Map<string, string>();

  try {
    for (const memory of TEST_MEMORIES) {
      const created = repository.create(memory.input);
      idToTag.set(created.id, memory.tag);
      const embedding = await mockEmbedding.embedPassage(
        `${memory.input.summary} ${memory.input.details}`,
      );
      repository.updateEmbedding(created.id, embedding);
    }

    for (const distractor of distractors) {
      const created = repository.create(distractor.input);
      idToTag.set(created.id, distractor.tag);
      const embedding = await mockEmbedding.embedPassage(
        `${distractor.input.summary} ${distractor.input.details}`,
      );
      repository.updateEmbedding(created.id, embedding);
    }

    let totalRecall = 0;
    let totalPrecision = 0;
    let inactiveLeaks = 0;
    let totalLatencyMs = 0;

    for (const query of TEST_QUERIES) {
      const start = Date.now();
      const result = await engine.activate({
        lifecycleTrigger: "before_model",
        scopeRef: ".",
        queryTokens: tokenizeQuery(query.text),
        maxMemories: 10,
        maxPayloadBytes: 8192,
      });
      const elapsed = Date.now() - start;

      totalLatencyMs += elapsed;

      const retrieved = result.activated.map(
        (memory) => idToTag.get(memory.id) ?? memory.id,
      );
      const relevant = new Set(query.relevantTags);

      totalRecall += recallAtK(retrieved, relevant, 5);
      totalPrecision += precisionAtK(retrieved, relevant, 5);

      for (const tag of retrieved) {
        if (INACTIVE_TAGS.has(tag)) {
          inactiveLeaks += 1;
        }
      }
    }

    const meanRecallAt5 = totalRecall / TEST_QUERIES.length;
    const meanPrecisionAt5 = totalPrecision / TEST_QUERIES.length;
    const meanLatencyMs = totalLatencyMs / TEST_QUERIES.length;

    comparativeRecalls[poolSize] = meanRecallAt5;

    return {
      poolSize,
      meanRecallAt5,
      meanPrecisionAt5,
      inactiveLeaks,
      meanLatencyMs,
    };
  } finally {
    db.close();
  }
}

afterAll(() => {
  const r50 = comparativeRecalls[50];
  const r150 = comparativeRecalls[150];
  const r500 = comparativeRecalls[500];

  if (r50 !== undefined && r150 !== undefined && r500 !== undefined) {
    printBenchmarkReport("HM-ScaleBench", {
      "Pool-50 recall@5": r50,
      "Pool-150 recall@5": r150,
      "Pool-500 recall@5": r500,
      "Recall degradation 50->500": r50 - r500,
    });
  }
});

describe("HM-ScaleBench", () => {
  afterEach(() => {
    // no-op: pool fixtures are created/closed inside evaluatePool
  });

  describe("pool-50 (20 base + 30 distractors)", () => {
    test("aggregate recall@5 across all 10 queries", async () => {
      const metrics = await evaluatePool(50);

      printBenchmarkReport("HM-ScaleBench / Pool-50", {
        "Recall@5": metrics.meanRecallAt5,
        "Precision@5": metrics.meanPrecisionAt5,
        "Inactive leaks": metrics.inactiveLeaks,
        "Mean latency (ms)": metrics.meanLatencyMs,
      });

      expect(metrics.meanRecallAt5).toBeGreaterThanOrEqual(0.25);
    });

    test("aggregate precision@5", async () => {
      const metrics = await evaluatePool(50);

      expect(metrics.meanPrecisionAt5).toBeGreaterThanOrEqual(0.1);
    });

    test("no inactive memory leaks", async () => {
      const metrics = await evaluatePool(50);

      expect(metrics.inactiveLeaks).toBe(0);
    });

    test("activation latency is recorded (non-gating)", async () => {
      const metrics = await evaluatePool(50);

      expect(metrics.meanLatencyMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe("pool-150 (20 base + 130 distractors)", () => {
    test("aggregate recall@5 across all 10 queries", async () => {
      const metrics = await evaluatePool(150);

      expect(metrics.meanRecallAt5).toBeGreaterThanOrEqual(0.2);
    });

    test("aggregate precision@5", async () => {
      const metrics = await evaluatePool(150);

      expect(metrics.meanPrecisionAt5).toBeGreaterThanOrEqual(0.08);
    });

    test("no inactive memory leaks and latency is recorded", async () => {
      const metrics = await evaluatePool(150);

      expect(metrics.inactiveLeaks).toBe(0);
      expect(metrics.meanLatencyMs).toBeGreaterThanOrEqual(0);
    });

    test("recall@5 compared with pool-50 reports scale trend", async () => {
      const pool50 = await evaluatePool(50);
      const pool150 = await evaluatePool(150);

      const delta = pool150.meanRecallAt5 - pool50.meanRecallAt5;
      printBenchmarkReport("HM-ScaleBench / 50->150", {
        "Pool-50 recall@5": pool50.meanRecallAt5,
        "Pool-150 recall@5": pool150.meanRecallAt5,
        "Delta (150-50)": delta,
      });

      expect(pool150.meanRecallAt5).toBeLessThanOrEqual(pool50.meanRecallAt5 + 0.2);
    });
  });

  describe("pool-500 (20 base + 480 distractors)", () => {
    test("aggregate recall@5 across all 10 queries", async () => {
      const metrics = await evaluatePool(500);

      expect(metrics.meanRecallAt5).toBeGreaterThanOrEqual(0.15);
    });

    test("aggregate precision@5", async () => {
      const metrics = await evaluatePool(500);

      expect(metrics.meanPrecisionAt5).toBeGreaterThanOrEqual(0.06);
    });

    test("no inactive memory leaks and latency is recorded", async () => {
      const metrics = await evaluatePool(500);

      expect(metrics.inactiveLeaks).toBe(0);
      expect(metrics.meanLatencyMs).toBeGreaterThanOrEqual(0);
    });

    test("recall@5 compared with pool-150 and degradation curve", async () => {
      const pool150 = await evaluatePool(150);
      const pool500 = await evaluatePool(500);
      const pool50 = await evaluatePool(50);

      const d50to150 = pool50.meanRecallAt5 - pool150.meanRecallAt5;
      const d150to500 = pool150.meanRecallAt5 - pool500.meanRecallAt5;
      const d50to500 = pool50.meanRecallAt5 - pool500.meanRecallAt5;

      printBenchmarkReport("HM-ScaleBench / Degradation Curve", {
        "Pool-50 recall@5": pool50.meanRecallAt5,
        "Pool-150 recall@5": pool150.meanRecallAt5,
        "Pool-500 recall@5": pool500.meanRecallAt5,
        "Degradation 50->150": d50to150,
        "Degradation 150->500": d150to500,
        "Degradation 50->500": d50to500,
      });

      // Aspirational: pool-500 should still maintain at least 0.55 recall
      // Current: 0.47 — needs better retrieval to scale
      expect(pool500.meanRecallAt5).toBeGreaterThanOrEqual(0.55);
    });
  });
});
