import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { ActivationEngine } from "../../src/activation";
import { EMBEDDING_DIMENSIONS } from "../../src/activation/embeddings";
import { MemoryRepository } from "../../src/memory";
import {
  CONCEPTS,
  MockEmbeddingService,
  printBenchmarkReport,
} from "./benchmark-helpers";
import { createTestDb } from "../helpers/create-test-db";

interface TimelineMemoryDef {
  tag: string;
  type: "policy" | "workflow" | "pitfall" | "architecture_constraint" | "decision";
  summary: string;
  details: string;
  concepts: number[];
  createdAt: string;
  status?: "active" | "superseded";
}

const TIMELINE_MEMORIES: TimelineMemoryDef[] = [
  {
    tag: "T01",
    type: "decision",
    summary: "[Session 1/6] Chose Express.js for HTTP server",
    details: "Session 1: Evaluated Express vs Fastify. Chose Express for ecosystem.",
    concepts: [CONCEPTS.TYPESCRIPT, CONCEPTS.PLUGIN],
    createdAt: "2026-01-01T00:00:00Z",
    status: "superseded",
  },
  {
    tag: "T02",
    type: "decision",
    summary: "[Session 2/6] Switched from Express to Fastify",
    details: "Session 2: Express too slow for our use case. Migrated to Fastify.",
    concepts: [CONCEPTS.TYPESCRIPT, CONCEPTS.PLUGIN],
    createdAt: "2026-01-15T00:00:00Z",
  },
  {
    tag: "T03",
    type: "workflow",
    summary: "[Session 3/6] Added CI pipeline with GitHub Actions",
    details: "Session 3: Set up CI with lint, test, build stages.",
    concepts: [CONCEPTS.GIT, CONCEPTS.TESTING],
    createdAt: "2026-02-01T00:00:00Z",
  },
  {
    tag: "T04",
    type: "pitfall",
    summary: "[Session 3/6] CI fails on Windows due to path separators",
    details: "Session 3: Windows uses backslash. Normalize paths with path.posix.",
    concepts: [CONCEPTS.ERRORS, CONCEPTS.TESTING],
    createdAt: "2026-02-01T12:00:00Z",
  },
  {
    tag: "T05",
    type: "architecture_constraint",
    summary: "[Session 4/6] Database moved from PostgreSQL to SQLite",
    details: "Session 4: Removed Postgres dependency. Using sql.js for portability.",
    concepts: [CONCEPTS.DATABASE],
    createdAt: "2026-03-01T00:00:00Z",
  },
  {
    tag: "T06",
    type: "workflow",
    summary: "[Session 5/6] Adopted conventional commits",
    details: "Session 5: All commits must follow conventional commit format.",
    concepts: [CONCEPTS.GIT],
    createdAt: "2026-03-15T00:00:00Z",
  },
  {
    tag: "T07",
    type: "policy",
    summary: "[Session 6/6] No direct database access outside repository layer",
    details: "Session 6: All DB access must go through MemoryRepository.",
    concepts: [CONCEPTS.DATABASE, CONCEPTS.TYPESCRIPT],
    createdAt: "2026-04-01T00:00:00Z",
  },
  {
    tag: "T08",
    type: "decision",
    summary: "[Session 6/6] Using vitest instead of jest",
    details: "Session 6: Switched to vitest for better ESM support.",
    concepts: [CONCEPTS.TESTING, CONCEPTS.ESM],
    createdAt: "2026-04-01T12:00:00Z",
  },
];

const TIMELINE_QUERIES = [
  { text: "what HTTP framework", concepts: [CONCEPTS.TYPESCRIPT, CONCEPTS.PLUGIN] },
  { text: "CI pipeline", concepts: [CONCEPTS.GIT, CONCEPTS.TESTING] },
  { text: "database choice", concepts: [CONCEPTS.DATABASE] },
  { text: "what changed about HTTP framework", concepts: [CONCEPTS.TYPESCRIPT, CONCEPTS.PLUGIN] },
  { text: "testing framework", concepts: [CONCEPTS.TESTING, CONCEPTS.ESM] },
  { text: "CI issues", concepts: [CONCEPTS.TESTING, CONCEPTS.ERRORS] },
  { text: "current database", concepts: [CONCEPTS.DATABASE, CONCEPTS.TYPESCRIPT] },
  { text: "current testing", concepts: [CONCEPTS.TESTING, CONCEPTS.ESM] },
  { text: "commit conventions", concepts: [CONCEPTS.GIT] },
] as const;

const DIMS_PER_CONCEPT = Math.floor(EMBEDDING_DIMENSIONS / 10);

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

  for (const conceptId of concepts) {
    const basis = makeBasisVector(conceptId);
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

function tokenizeQuery(text: string): string[] {
  return text.split(/[\s\p{P}]+/u).filter((token) => token.length > 2);
}

describe("HM-TimelineBench", () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let repository: MemoryRepository;
  let engine: ActivationEngine;
  let idToTag: Map<string, string>;

  beforeEach(async () => {
    db = await createTestDb();
    repository = new MemoryRepository(db);
    idToTag = new Map<string, string>();

    const lookup = new Map<string, Float32Array>();

    for (let i = 0; i < TIMELINE_MEMORIES.length; i++) {
      const memory = TIMELINE_MEMORIES[i];
      lookup.set(
        `passage: ${memory.summary} ${memory.details}`,
        blendAndNoise(memory.concepts, i + 1),
      );
    }

    for (let i = 0; i < TIMELINE_QUERIES.length; i++) {
      const query = TIMELINE_QUERIES[i];
      lookup.set(`query: ${query.text}`, blendAndNoise(query.concepts, 100 + i));
    }

    const mockEmbedding = new MockEmbeddingService(lookup);
    engine = new ActivationEngine(repository, mockEmbedding as never);

    for (const memory of TIMELINE_MEMORIES) {
      const created = repository.create({
        type: memory.type,
        summary: memory.summary,
        details: memory.details,
        scopeGlob: "**/*",
        lifecycleTriggers: ["before_model"],
        status: memory.status ?? "active",
        confidence: 0.9,
        importance: 0.85,
        activationClass: "scoped",
        createdAt: memory.createdAt,
        updatedAt: memory.createdAt,
      });

      idToTag.set(created.id, memory.tag);

      const embedding = await mockEmbedding.embedPassage(
        `${memory.summary} ${memory.details}`,
      );
      repository.updateEmbedding(created.id, embedding);
    }
  });

  afterEach(() => {
    db.close();
  });

  async function runQuery(text: string): Promise<string[]> {
    const result = await engine.activate({
      lifecycleTrigger: "before_model",
      scopeRef: ".",
      queryTokens: tokenizeQuery(text),
      maxMemories: 10,
      maxPayloadBytes: 8192,
    });

    return result.activated.map((memory) => idToTag.get(memory.id) ?? memory.id);
  }

  /** Temporal query: includes superseded memories for evolution context */
  async function runTemporalQuery(text: string): Promise<string[]> {
    const result = await engine.activate({
      lifecycleTrigger: "before_model",
      scopeRef: ".",
      queryTokens: tokenizeQuery(text),
      maxMemories: 10,
      maxPayloadBytes: 8192,
      includeSuperseded: true,
    });

    return result.activated.map((memory) => idToTag.get(memory.id) ?? memory.id);
  }

  describe("session ordering", () => {
    test("query 'what HTTP framework' returns latest Fastify decision", async () => {
      const activated = await runQuery("what HTTP framework");

      expect(activated).toContain("T02");
      expect(activated).not.toContain("T01");
    });

    test("query 'CI pipeline' includes both setup and pitfall memories", async () => {
      const activated = await runQuery("CI pipeline");

      expect(activated).toContain("T03");
      expect(activated).toContain("T04");
    });

    test("query 'database choice' includes decision and policy", async () => {
      const activated = await runQuery("database choice");

      expect(activated).toContain("T05");
      expect(activated).toContain("T07");
    });

    test("superseded T01 never appears in activated results", async () => {
      for (const query of TIMELINE_QUERIES) {
        const activated = await runQuery(query.text);
        expect(activated).not.toContain("T01");
      }
    });
  });

  describe("change detection", () => {
    test("query 'what changed about HTTP framework' surfaces T02", async () => {
      const activated = await runQuery("what changed about HTTP framework");

      expect(activated).toContain("T02");
      expect(activated).not.toContain("T01");
    });

    test("query 'testing framework' returns vitest decision", async () => {
      const activated = await runQuery("testing framework");

      expect(activated).toContain("T08");
    });

    test("query 'CI issues' activates both related same-session memories", async () => {
      const activated = await runQuery("CI issues");

      expect(activated).toContain("T03");
      expect(activated).toContain("T04");
    });

    test("stale and superseded memories are excluded from all timeline queries", async () => {
      for (const query of TIMELINE_QUERIES) {
        const activated = await runQuery(query.text);
        expect(activated).not.toContain("T01");
      }
    });
  });

  describe("latest-state retrieval", () => {
    test("query 'current database' returns current storage state", async () => {
      const activated = await runQuery("current database");

      expect(activated).toContain("T05");
      expect(activated).toContain("T07");
      expect(activated).not.toContain("T01");
    });

    test("query 'current testing' returns latest testing stack", async () => {
      const activated = await runQuery("current testing");

      expect(activated).toContain("T08");
      expect(activated).toContain("T03");
    });

    test("query 'commit conventions' returns conventional commits memory", async () => {
      const activated = await runQuery("commit conventions");

      expect(activated).toContain("T06");
    });

    test("latest-state accuracy across core timeline queries is >= 0.75", async () => {
      const checks = [
        {
          query: "current database",
          expected: ["T05", "T07"],
          forbidden: ["T01"],
        },
        {
          query: "current testing",
          expected: ["T08", "T03"],
          forbidden: ["T01"],
        },
        {
          query: "what changed about HTTP framework",
          expected: ["T02"],
          forbidden: ["T01"],
        },
        {
          query: "commit conventions",
          expected: ["T06"],
          forbidden: ["T01"],
        },
      ] as const;

      let passed = 0;

      for (const check of checks) {
        const activated = await runQuery(check.query);
        const hasAllExpected = check.expected.every((tag) => activated.includes(tag));
        const hasForbidden = check.forbidden.some((tag) => activated.includes(tag));

        if (hasAllExpected && !hasForbidden) {
          passed += 1;
        }
      }

      const accuracy = passed / checks.length;

      printBenchmarkReport("HM-TimelineBench", {
        "Latest-state accuracy": accuracy,
        "Passed checks": passed,
        "Total checks": checks.length,
      });

      expect(accuracy).toBeGreaterThanOrEqual(0.75);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // Temporal REASONING tests — these probe capabilities the system
  // currently LACKS. Tests will FAIL to show real gaps.
  // When the system gains temporal capabilities (Phase 2:
  // hierarchical retrieval), these tests will start passing.
  // ─────────────────────────────────────────────────────────────

  describe("temporal reasoning (with includeSuperseded mode)", () => {
    test("ordering: 'what was the sequence of framework changes' returns both T01 and T02", async () => {
      // With includeSuperseded=true, temporal queries can show evolution
      const activated = await runTemporalQuery("what was the sequence of HTTP framework changes from beginning to end");

      const t02Idx = activated.indexOf("T02");
      expect(t02Idx).toBeGreaterThanOrEqual(0);

      // Now T01 (superseded) should be included for temporal context
      expect(activated).toContain("T01");
    });

    test("change-point: database switch query finds T05 and adjacent session context", async () => {
      const activated = await runTemporalQuery("when exactly did we switch from PostgreSQL to SQLite and in which session");

      expect(activated).toContain("T05");
    });

    test("progression: testing evolution query finds multiple related memories", async () => {
      const activated = await runTemporalQuery("how did testing practices evolve over time across all sessions");

      const testingMemories = ["T03", "T04", "T08"].filter((tag) => activated.includes(tag));
      expect(testingMemories.length).toBeGreaterThanOrEqual(2);
    });

    test("latest-state with superseded context: 'what framework and why did we change' needs both old and new", async () => {
      // With temporal mode, both old and new decisions should appear
      const activated = await runTemporalQuery("what HTTP framework do we use now and why did we change from the previous one");

      expect(activated).toContain("T02"); // Current: Fastify
      expect(activated).toContain("T01"); // Previous: Express — now included via includeSuperseded
    });
  });
});
