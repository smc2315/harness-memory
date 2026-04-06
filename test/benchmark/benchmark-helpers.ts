/**
 * Benchmark test infrastructure.
 *
 * Provides:
 * - A realistic 20-memory test dataset with known relevance ground truth
 * - A mock embedding service with concept-clustered vectors
 * - IR metric calculators (Precision@K, Recall@K, MRR, NDCG@K)
 * - Helpers to seed and query the activation engine
 */

import type { Database as SqlJsDatabase } from "sql.js";

import { ActivationEngine } from "../../src/activation";
import {
  EmbeddingService,
  EMBEDDING_DIMENSIONS,
  cosineSimilarity,
} from "../../src/activation/embeddings";
import type { ActivationRequest } from "../../src/activation/types";
import type { ActivationClass, LifecycleTrigger, MemoryStatus, MemoryType } from "../../src/db/schema/types";
import { MemoryRepository, type CreateMemoryInput } from "../../src/memory";
import { createTestDb } from "../helpers/create-test-db";

// ---------------------------------------------------------------------------
// Concept-clustered mock embeddings
// ---------------------------------------------------------------------------

/**
 * Semantic concept IDs — each concept occupies a distinct region of the
 * embedding space so that cosine similarity faithfully reflects relatedness.
 */
export const CONCEPTS = {
  TYPESCRIPT: 0,
  DATABASE: 1,
  TESTING: 2,
  ESM: 3,
  VECTOR: 4,
  ERRORS: 5,
  DREAM: 6,
  PLUGIN: 7,
  GIT: 8,
  KOREAN_RULES: 9,
} as const;

const DIMS_PER_CONCEPT = Math.floor(EMBEDDING_DIMENSIONS / 10); // 38

/**
 * Create a unit-length basis vector for a concept.
 * Each concept "lives" in its own 38-dim subspace of the 384-dim space.
 */
function basisVector(conceptId: number): Float32Array {
  const vec = new Float32Array(EMBEDDING_DIMENSIONS);
  const start = conceptId * DIMS_PER_CONCEPT;

  for (let i = start; i < start + DIMS_PER_CONCEPT; i++) {
    vec[i] = 1.0;
  }

  // Normalize
  const norm = Math.sqrt(DIMS_PER_CONCEPT);

  for (let i = 0; i < vec.length; i++) {
    vec[i] /= norm;
  }

  return vec;
}

/**
 * Blend multiple concept basis vectors with optional weights.
 * Returns a unit-length vector that sits "between" the concepts.
 */
function blendConcepts(
  conceptIds: number[],
  weights?: number[]
): Float32Array {
  const effectiveWeights = weights ?? conceptIds.map(() => 1.0 / conceptIds.length);
  const result = new Float32Array(EMBEDDING_DIMENSIONS);

  for (let c = 0; c < conceptIds.length; c++) {
    const basis = basisVector(conceptIds[c]);

    for (let i = 0; i < EMBEDDING_DIMENSIONS; i++) {
      result[i] += basis[i] * effectiveWeights[c];
    }
  }

  // Normalize to unit length
  let norm = 0;

  for (let i = 0; i < EMBEDDING_DIMENSIONS; i++) {
    norm += result[i] * result[i];
  }

  norm = Math.sqrt(norm);

  if (norm > 0) {
    for (let i = 0; i < EMBEDDING_DIMENSIONS; i++) {
      result[i] /= norm;
    }
  }

  return result;
}

/**
 * Add small noise to a vector (for deduplication avoidance).
 * Returns a new normalized vector.
 */
function addNoise(vec: Float32Array, seed: number, magnitude: number = 0.05): Float32Array {
  const noisy = new Float32Array(vec.length);

  for (let i = 0; i < vec.length; i++) {
    // Deterministic pseudo-random noise based on seed
    const hash = Math.sin(seed * 9301 + i * 49297 + 233280) * 0.5 + 0.5;
    noisy[i] = vec[i] + (hash - 0.5) * magnitude;
  }

  // Re-normalize
  let norm = 0;

  for (let i = 0; i < noisy.length; i++) {
    norm += noisy[i] * noisy[i];
  }

  norm = Math.sqrt(norm);

  for (let i = 0; i < noisy.length; i++) {
    noisy[i] /= norm;
  }

  return noisy;
}

// ---------------------------------------------------------------------------
// Test dataset — 20 memories with concept assignments
// ---------------------------------------------------------------------------

export interface TestMemoryDef {
  /** Short identifier for test readability. */
  tag: string;
  input: CreateMemoryInput;
  /** Primary concept(s) — determines embedding direction. */
  concepts: number[];
  /** Optional concept weights (defaults to equal). */
  conceptWeights?: number[];
}

const ts = (offsetMinutes: number) =>
  new Date(Date.UTC(2026, 2, 28, 0, offsetMinutes, 0)).toISOString();

export const TEST_MEMORIES: TestMemoryDef[] = [
  // ---- Active memories (17) ----
  {
    tag: "M01",
    input: {
      type: "policy",
      summary: "TypeScript strict mode",
      details: "Always use strict TypeScript configuration with noImplicitAny and strictNullChecks enabled.",
      scopeGlob: "src/**/*.ts",
      lifecycleTriggers: ["before_model"],
      confidence: 0.95,
      importance: 0.9,
      status: "active",
      activationClass: "baseline",
      createdAt: ts(0),
      updatedAt: ts(0),
    },
    concepts: [CONCEPTS.TYPESCRIPT],
  },
  {
    tag: "M02",
    input: {
      type: "policy",
      summary: "No any types",
      details: "Never use `any` type annotation. Prefer `unknown` for untyped values and narrow with type guards.",
      scopeGlob: "src/**/*.ts",
      lifecycleTriggers: ["before_model"],
      confidence: 0.9,
      importance: 0.85,
      status: "active",
      activationClass: "scoped",
      createdAt: ts(1),
      updatedAt: ts(1),
    },
    concepts: [CONCEPTS.TYPESCRIPT],
  },
  {
    tag: "M03",
    input: {
      type: "workflow",
      summary: "Run tests before commit",
      details: "Always run npm test before creating a git commit. Verify all test suites pass.",
      scopeGlob: "**/*",
      lifecycleTriggers: ["before_model"],
      confidence: 0.85,
      importance: 0.8,
      status: "active",
      activationClass: "baseline",
      createdAt: ts(2),
      updatedAt: ts(2),
    },
    concepts: [CONCEPTS.TESTING, CONCEPTS.GIT],
    conceptWeights: [0.7, 0.3],
  },
  {
    tag: "M04",
    input: {
      type: "pitfall",
      summary: "SQL injection in raw queries",
      details: "Use parameterized queries with $-prefixed placeholders. Never concatenate user input into SQL strings.",
      scopeGlob: "src/db/**/*.ts",
      lifecycleTriggers: ["before_model", "before_tool"],
      confidence: 0.95,
      importance: 0.95,
      status: "active",
      activationClass: "scoped",
      createdAt: ts(3),
      updatedAt: ts(3),
    },
    concepts: [CONCEPTS.DATABASE, CONCEPTS.ERRORS],
    conceptWeights: [0.8, 0.2],
  },
  {
    tag: "M05",
    input: {
      type: "architecture_constraint",
      summary: "Repository pattern",
      details: "All database access must go through repository classes. No direct SQL in business logic or adapters.",
      scopeGlob: "src/**/*.ts",
      lifecycleTriggers: ["before_model"],
      confidence: 0.9,
      importance: 0.9,
      status: "active",
      activationClass: "scoped",
      createdAt: ts(4),
      updatedAt: ts(4),
    },
    concepts: [CONCEPTS.DATABASE, CONCEPTS.PLUGIN],
    conceptWeights: [0.7, 0.3],
  },
  {
    tag: "M06",
    input: {
      type: "workflow",
      summary: "Migration naming convention",
      details: "Name migration files as NNN_description.sql where NNN is a zero-padded sequence number.",
      scopeGlob: "src/db/migrations/**/*.sql",
      lifecycleTriggers: ["before_model"],
      confidence: 0.8,
      importance: 0.7,
      status: "active",
      activationClass: "scoped",
      createdAt: ts(5),
      updatedAt: ts(5),
    },
    concepts: [CONCEPTS.DATABASE],
  },
  {
    tag: "M07",
    input: {
      type: "decision",
      summary: "Use sql.js over better-sqlite3",
      details: "sql.js was chosen for WASM portability and zero native dependencies. Do not switch to better-sqlite3.",
      scopeGlob: "src/db/**/*.ts",
      lifecycleTriggers: ["before_model"],
      confidence: 0.95,
      importance: 0.85,
      status: "active",
      activationClass: "scoped",
      createdAt: ts(6),
      updatedAt: ts(6),
    },
    concepts: [CONCEPTS.DATABASE],
  },
  {
    tag: "M08",
    input: {
      type: "pitfall",
      summary: "ESM import extensions",
      details: "Always use .js file extension in ESM import paths. TypeScript outputs .js files, not .ts.",
      scopeGlob: "src/**/*.ts",
      lifecycleTriggers: ["before_model"],
      confidence: 0.85,
      importance: 0.8,
      status: "active",
      activationClass: "scoped",
      createdAt: ts(7),
      updatedAt: ts(7),
    },
    concepts: [CONCEPTS.ESM, CONCEPTS.TYPESCRIPT],
    conceptWeights: [0.7, 0.3],
  },
  {
    tag: "M09",
    input: {
      type: "policy",
      summary: "Error handling pattern",
      details: "Never use empty catch blocks. Always log the error or rethrow. Use typed error classes where possible.",
      scopeGlob: "src/**/*.ts",
      lifecycleTriggers: ["before_model"],
      confidence: 0.9,
      importance: 0.85,
      status: "active",
      activationClass: "scoped",
      createdAt: ts(8),
      updatedAt: ts(8),
    },
    concepts: [CONCEPTS.ERRORS],
  },
  {
    tag: "M10",
    input: {
      type: "workflow",
      summary: "Git branch naming",
      details: "Use feature/, fix/, chore/ prefixes for branch names. Include ticket number if applicable.",
      scopeGlob: "**/*",
      lifecycleTriggers: ["before_model"],
      confidence: 0.8,
      importance: 0.7,
      status: "active",
      activationClass: "startup",
      createdAt: ts(9),
      updatedAt: ts(9),
    },
    concepts: [CONCEPTS.GIT],
  },
  {
    tag: "M11",
    input: {
      type: "policy",
      summary: "한국어 주석 금지",
      details: "코드 주석은 반드시 영어로 작성해야 합니다. 한국어 변수명이나 주석을 사용하지 마세요.",
      scopeGlob: "src/**/*.ts",
      lifecycleTriggers: ["before_model"],
      confidence: 0.85,
      importance: 0.8,
      status: "active",
      activationClass: "scoped",
      createdAt: ts(10),
      updatedAt: ts(10),
    },
    concepts: [CONCEPTS.KOREAN_RULES, CONCEPTS.TYPESCRIPT],
    conceptWeights: [0.6, 0.4],
  },
  {
    tag: "M12",
    input: {
      type: "pitfall",
      summary: "패키지 버전 충돌",
      details: "@xenova/transformers는 ESM only 패키지입니다. CommonJS 프로젝트에서는 dynamic import를 사용하세요.",
      scopeGlob: "src/**/*.ts",
      lifecycleTriggers: ["before_model"],
      confidence: 0.9,
      importance: 0.85,
      status: "active",
      activationClass: "scoped",
      createdAt: ts(11),
      updatedAt: ts(11),
    },
    concepts: [CONCEPTS.ESM, CONCEPTS.VECTOR],
    conceptWeights: [0.6, 0.4],
  },
  {
    tag: "M13",
    input: {
      type: "decision",
      summary: "벡터 DB 선택",
      details: "SQLite BLOB 저장 방식을 선택했습니다. 별도의 벡터 데이터베이스(Pinecone, Qdrant 등)를 사용하지 않습니다.",
      scopeGlob: "src/activation/**/*.ts",
      lifecycleTriggers: ["before_model"],
      confidence: 0.95,
      importance: 0.9,
      status: "active",
      activationClass: "scoped",
      createdAt: ts(12),
      updatedAt: ts(12),
    },
    concepts: [CONCEPTS.VECTOR, CONCEPTS.DATABASE],
    conceptWeights: [0.7, 0.3],
  },
  {
    tag: "M14",
    input: {
      type: "workflow",
      summary: "Dream consolidation flow",
      details: "Evidence events flow through: evidence capture → dream:run → candidate creation → manual review → promote/reject.",
      scopeGlob: "src/dream/**/*.ts",
      lifecycleTriggers: ["before_model"],
      confidence: 0.85,
      importance: 0.8,
      status: "active",
      activationClass: "scoped",
      createdAt: ts(13),
      updatedAt: ts(13),
    },
    concepts: [CONCEPTS.DREAM],
  },
  {
    tag: "M15",
    input: {
      type: "architecture_constraint",
      summary: "Plugin isolation",
      details: "Plugins must not directly access the database. All DB operations go through the adapter layer.",
      scopeGlob: "src/plugin/**/*.ts",
      lifecycleTriggers: ["before_model"],
      confidence: 0.9,
      importance: 0.9,
      status: "active",
      activationClass: "scoped",
      createdAt: ts(14),
      updatedAt: ts(14),
    },
    concepts: [CONCEPTS.PLUGIN, CONCEPTS.DATABASE],
    conceptWeights: [0.7, 0.3],
  },
  {
    tag: "M19",
    input: {
      type: "workflow",
      summary: "API versioning",
      details: "Use semver for package.json versioning. Document all breaking changes in CHANGELOG.md.",
      scopeGlob: "**/*",
      lifecycleTriggers: ["before_model"],
      confidence: 0.8,
      importance: 0.75,
      status: "active",
      activationClass: "scoped",
      createdAt: ts(18),
      updatedAt: ts(18),
    },
    concepts: [CONCEPTS.GIT],
  },
  {
    tag: "M20",
    input: {
      type: "architecture_constraint",
      summary: "Activation budget limits",
      details: "Maximum 10 memories and 8KB payload per activation call. These limits are enforced in the activation engine.",
      scopeGlob: "src/activation/**/*.ts",
      lifecycleTriggers: ["before_model"],
      confidence: 0.95,
      importance: 0.9,
      status: "active",
      activationClass: "scoped",
      createdAt: ts(19),
      updatedAt: ts(19),
    },
    concepts: [CONCEPTS.VECTOR],
  },
  // ---- Inactive memories (3) — should NEVER appear in results ----
  {
    tag: "M16-stale",
    input: {
      type: "policy",
      summary: "Stale memory check",
      details: "Review stale memories weekly and either supersede or reactivate them.",
      scopeGlob: "**/*",
      lifecycleTriggers: ["before_model"],
      confidence: 0.7,
      importance: 0.7,
      status: "stale",
      activationClass: "scoped",
      createdAt: ts(15),
      updatedAt: ts(15),
    },
    concepts: [CONCEPTS.DREAM],
  },
  {
    tag: "M17-superseded",
    input: {
      type: "decision",
      summary: "Manual promotion only",
      details: "Auto-promote was disabled because it was too noisy. Manual review required.",
      scopeGlob: "**/*",
      lifecycleTriggers: ["before_model"],
      confidence: 0.75,
      importance: 0.7,
      status: "superseded",
      activationClass: "scoped",
      createdAt: ts(16),
      updatedAt: ts(16),
    },
    concepts: [CONCEPTS.DREAM],
  },
  {
    tag: "M18-rejected",
    input: {
      type: "pitfall",
      summary: "Too many warnings",
      details: "Warning fatigue made users ignore all policy warnings. Keep warnings under 3 per activation.",
      scopeGlob: "**/*",
      lifecycleTriggers: ["before_model"],
      confidence: 0.6,
      importance: 0.6,
      status: "rejected",
      activationClass: "scoped",
      createdAt: ts(17),
      updatedAt: ts(17),
    },
    concepts: [CONCEPTS.ERRORS],
  },
];

// ---------------------------------------------------------------------------
// Queries with ground-truth relevance
// ---------------------------------------------------------------------------

export interface TestQuery {
  tag: string;
  text: string;
  /** Tags of memories that ARE relevant to this query. */
  relevantTags: string[];
  /** Concept(s) the query maps to. */
  concepts: number[];
  conceptWeights?: number[];
}

export const TEST_QUERIES: TestQuery[] = [
  {
    tag: "Q01",
    text: "typescript strict type checking configuration",
    relevantTags: ["M01", "M02"],
    concepts: [CONCEPTS.TYPESCRIPT],
  },
  {
    tag: "Q02",
    text: "database query security and parameterized statements",
    relevantTags: ["M04", "M05", "M07"],
    concepts: [CONCEPTS.DATABASE, CONCEPTS.ERRORS],
    conceptWeights: [0.7, 0.3],
  },
  {
    tag: "Q03",
    text: "how to run tests before committing code",
    relevantTags: ["M03"],
    concepts: [CONCEPTS.TESTING, CONCEPTS.GIT],
    conceptWeights: [0.7, 0.3],
  },
  {
    tag: "Q04",
    text: "ESM module import file extension requirements",
    relevantTags: ["M08", "M12"],
    concepts: [CONCEPTS.ESM],
  },
  {
    tag: "Q05",
    text: "타입스크립트 엄격 모드 설정",
    relevantTags: ["M01", "M02", "M11"],
    concepts: [CONCEPTS.TYPESCRIPT, CONCEPTS.KOREAN_RULES],
    conceptWeights: [0.7, 0.3],
  },
  {
    tag: "Q06",
    text: "벡터 검색 구현 방법",
    relevantTags: ["M13", "M20"],
    concepts: [CONCEPTS.VECTOR],
  },
  {
    tag: "Q07",
    text: "error handling best practices and typed exceptions",
    relevantTags: ["M09", "M04"],
    concepts: [CONCEPTS.ERRORS],
  },
  {
    tag: "Q08",
    text: "dream evidence consolidation pipeline",
    relevantTags: ["M14"],
    concepts: [CONCEPTS.DREAM],
  },
  {
    tag: "Q09",
    text: "plugin architecture and adapter isolation pattern",
    relevantTags: ["M15", "M05"],
    concepts: [CONCEPTS.PLUGIN, CONCEPTS.DATABASE],
    conceptWeights: [0.7, 0.3],
  },
  {
    tag: "Q10",
    text: "git workflow and branch naming conventions",
    relevantTags: ["M10", "M03"],
    concepts: [CONCEPTS.GIT, CONCEPTS.TESTING],
    conceptWeights: [0.7, 0.3],
  },
];

// ---------------------------------------------------------------------------
// Mock Embedding Service
// ---------------------------------------------------------------------------

/** Maps a text key to a pre-computed embedding vector. */
type EmbeddingLookup = Map<string, Float32Array>;

/**
 * Build the complete lookup table for all memories and queries.
 *
 * Memory passages are keyed by `"passage: <summary> <details>"`.
 * Query texts are keyed by `"query: <text>"`.
 */
export function buildEmbeddingLookup(): EmbeddingLookup {
  const lookup = new Map<string, Float32Array>();

  for (let i = 0; i < TEST_MEMORIES.length; i++) {
    const mem = TEST_MEMORIES[i];
    const passageText = `passage: ${mem.input.summary} ${mem.input.details}`;
    const vec = addNoise(
      blendConcepts(mem.concepts, mem.conceptWeights),
      i,
      0.03,
    );
    lookup.set(passageText, vec);
  }

  for (let i = 0; i < TEST_QUERIES.length; i++) {
    const query = TEST_QUERIES[i];
    const queryText = `query: ${query.text}`;
    const vec = addNoise(
      blendConcepts(query.concepts, query.conceptWeights),
      100 + i,
      0.03,
    );
    lookup.set(queryText, vec);
  }

  return lookup;
}

/**
 * A mock EmbeddingService that returns pre-computed concept vectors.
 *
 * It implements the same public interface as the real EmbeddingService
 * so it can be cast and injected into ActivationEngine.
 */
export class MockEmbeddingService {
  private lookup: EmbeddingLookup;
  isReady = true;

  constructor(lookup?: EmbeddingLookup) {
    this.lookup = lookup ?? buildEmbeddingLookup();
  }

  async warmup(): Promise<void> {
    /* no-op */
  }

  async embed(text: string): Promise<Float32Array> {
    const cached = this.lookup.get(text);

    if (cached !== undefined) {
      return cached;
    }

    // Fallback: generate a random vector for unknown text (seeded by text hash).
    let seed = 0;

    for (let i = 0; i < text.length; i++) {
      seed = ((seed << 5) - seed + text.charCodeAt(i)) | 0;
    }

    return addNoise(new Float32Array(EMBEDDING_DIMENSIONS), Math.abs(seed), 1.0);
  }

  async embedQuery(text: string): Promise<Float32Array> {
    return this.embed(`query: ${text}`);
  }

  async embedPassage(text: string): Promise<Float32Array> {
    return this.embed(`passage: ${text}`);
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    const results: Float32Array[] = [];

    for (const text of texts) {
      results.push(await this.embedPassage(text));
    }

    return results;
  }
}

// ---------------------------------------------------------------------------
// Benchmark scaffold: seed DB, build engine, run activation
// ---------------------------------------------------------------------------

export interface BenchmarkFixture {
  db: SqlJsDatabase;
  repository: MemoryRepository;
  engine: ActivationEngine;
  mockEmbedding: MockEmbeddingService;
  /** Map from memory tag (M01, M02, …) to database memory ID. */
  tagToId: Map<string, string>;
  /** Map from database memory ID to memory tag. */
  idToTag: Map<string, string>;
}

/**
 * Create a fully-seeded benchmark fixture:
 * 1. In-memory SQLite DB with all migrations
 * 2. 20 memories inserted
 * 3. Mock passage embeddings stored for each memory
 * 4. ActivationEngine wired to MockEmbeddingService
 */
export async function createBenchmarkFixture(): Promise<BenchmarkFixture> {
  const db = await createTestDb();
  const repository = new MemoryRepository(db);
  const mockEmbedding = new MockEmbeddingService();
  const engine = new ActivationEngine(
    repository,
    mockEmbedding as unknown as EmbeddingService,
  );

  const tagToId = new Map<string, string>();
  const idToTag = new Map<string, string>();

  for (const def of TEST_MEMORIES) {
    const memory = repository.create(def.input);
    tagToId.set(def.tag, memory.id);
    idToTag.set(memory.id, def.tag);

    // Store mock passage embedding
    const passageText = `${def.input.summary} ${def.input.details}`;
    const embedding = await mockEmbedding.embedPassage(passageText);
    repository.updateEmbedding(memory.id, embedding);
  }

  return { db, repository, engine, mockEmbedding, tagToId, idToTag };
}

/**
 * Run an activation query against the benchmark fixture.
 * Returns the tags of activated memories (in rank order).
 */
export async function queryActivation(
  fixture: BenchmarkFixture,
  query: TestQuery,
  overrides?: Partial<ActivationRequest>,
): Promise<string[]> {
  const result = await fixture.engine.activate({
    lifecycleTrigger: "before_model",
    scopeRef: "src/activation/engine.ts",
    queryTokens: query.text.split(/[\s\p{P}]+/u).filter((t) => t.length > 2),
    maxMemories: overrides?.maxMemories ?? 10,
    maxPayloadBytes: overrides?.maxPayloadBytes ?? 8192,
    ...overrides,
  });

  return result.activated.map((m) => fixture.idToTag.get(m.id) ?? m.id);
}

// ---------------------------------------------------------------------------
// IR Metrics
// ---------------------------------------------------------------------------

/**
 * Precision@K — fraction of the top-K results that are relevant.
 */
export function precisionAtK(retrieved: string[], relevant: Set<string>, k: number): number {
  const topK = retrieved.slice(0, k);

  if (topK.length === 0) {
    return 0;
  }

  const hits = topK.filter((id) => relevant.has(id)).length;
  return hits / topK.length;
}

/**
 * Recall@K — fraction of relevant items that appear in the top-K results.
 */
export function recallAtK(retrieved: string[], relevant: Set<string>, k: number): number {
  if (relevant.size === 0) {
    return 1;
  }

  const topK = retrieved.slice(0, k);
  const hits = topK.filter((id) => relevant.has(id)).length;
  return hits / relevant.size;
}

/**
 * Mean Reciprocal Rank — 1 / rank of the first relevant result.
 */
export function reciprocalRank(retrieved: string[], relevant: Set<string>): number {
  for (let i = 0; i < retrieved.length; i++) {
    if (relevant.has(retrieved[i])) {
      return 1 / (i + 1);
    }
  }

  return 0;
}

/**
 * NDCG@K — Normalized Discounted Cumulative Gain.
 */
export function ndcgAtK(retrieved: string[], relevant: Set<string>, k: number): number {
  const topK = retrieved.slice(0, k);

  // DCG
  let dcg = 0;

  for (let i = 0; i < topK.length; i++) {
    const rel = relevant.has(topK[i]) ? 1 : 0;
    dcg += rel / Math.log2(i + 2); // i+2 because log2(1) = 0
  }

  // Ideal DCG (all relevant items first)
  const idealK = Math.min(relevant.size, k);
  let idcg = 0;

  for (let i = 0; i < idealK; i++) {
    idcg += 1 / Math.log2(i + 2);
  }

  if (idcg === 0) {
    return 0;
  }

  return dcg / idcg;
}

/**
 * Compute average metrics across all queries.
 */
export interface AggregateMetrics {
  meanPrecisionAt5: number;
  meanRecallAt5: number;
  mrr: number;
  meanNdcgAt5: number;
  queryCount: number;
}

export function computeAggregateMetrics(
  results: Array<{ retrieved: string[]; relevant: Set<string> }>,
): AggregateMetrics {
  let totalP = 0;
  let totalR = 0;
  let totalRR = 0;
  let totalNDCG = 0;

  for (const { retrieved, relevant } of results) {
    totalP += precisionAtK(retrieved, relevant, 5);
    totalR += recallAtK(retrieved, relevant, 5);
    totalRR += reciprocalRank(retrieved, relevant);
    totalNDCG += ndcgAtK(retrieved, relevant, 5);
  }

  const n = results.length;

  return {
    meanPrecisionAt5: totalP / n,
    meanRecallAt5: totalR / n,
    mrr: totalRR / n,
    meanNdcgAt5: totalNDCG / n,
    queryCount: n,
  };
}

/**
 * Print a formatted benchmark report to console.
 */
export function printBenchmarkReport(
  title: string,
  metrics: Record<string, number | string>,
): void {
  const maxKeyLen = Math.max(...Object.keys(metrics).map((k) => k.length));
  const lines = Object.entries(metrics).map(
    ([key, value]) =>
      `│ ${key.padEnd(maxKeyLen)}  ${typeof value === "number" ? value.toFixed(4) : value}`,
  );

  const width = Math.max(title.length + 4, ...lines.map((l) => l.length + 2));
  const border = "─".repeat(width);

  console.log(`\n┌${border}┐`);
  console.log(`│ ${title.padEnd(width - 2)} │`);
  console.log(`├${border}┤`);

  for (const line of lines) {
    console.log(`${line.padEnd(width + 1)}│`);
  }

  console.log(`└${border}┘\n`);
}

// ---------------------------------------------------------------------------
// 3-run median helpers — run a benchmark function N times, report median ± variance
// ---------------------------------------------------------------------------

export interface MedianResult<T> {
  /** The median value from N runs. */
  median: T;
  /** All individual run results (sorted by the sort key). */
  runs: T[];
  /** Standard deviation of the sort key across runs (0 for deterministic). */
  stdev: number;
  /** Number of runs executed. */
  runCount: number;
}

/**
 * Run an async benchmark function N times and return the median result.
 *
 * The `sortKey` function extracts a numeric value from each result for
 * sorting and variance calculation. The median result (by sort key) is
 * returned along with stdev across runs.
 *
 * Typical usage:
 * ```typescript
 * const { median, stdev, runCount } = await runNMedian(3, async () => {
 *   const result = await engine.activate({ ... });
 *   return result.activated.length;
 * }, (count) => count);
 * ```
 */
export async function runNMedian<T>(
  n: number,
  fn: () => Promise<T>,
  sortKey: (result: T) => number,
): Promise<MedianResult<T>> {
  const results: T[] = [];

  for (let i = 0; i < n; i++) {
    const result = await fn();
    results.push(result);
  }

  // Sort by the numeric key
  const sorted = [...results].sort((a, b) => sortKey(a) - sortKey(b));

  // Median: middle element (for even N, take lower-middle)
  const medianIndex = Math.floor(sorted.length / 2);
  const median = sorted[medianIndex];

  // Standard deviation
  const values = sorted.map(sortKey);
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
  const stdev = Math.sqrt(variance);

  return {
    median,
    runs: sorted,
    stdev,
    runCount: n,
  };
}

/**
 * Format a median ± stdev string for benchmark reporting.
 */
export function formatMedianResult(value: number, stdev: number): string {
  if (stdev === 0) {
    return value.toFixed(4);
  }

  return `${value.toFixed(4)} ± ${stdev.toFixed(4)}`;
}
