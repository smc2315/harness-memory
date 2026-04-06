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
  // Aspirational temporal REASONING tests — these probe deep
  // capabilities the system currently LACKS.
  //
  // test.fails() means: "this test is EXPECTED to fail."
  // - CI passes because the failure is expected.
  // - When the feature is implemented and the test starts PASSING,
  //   CI will FAIL — that's the signal to remove test.fails().
  //
  // Required features:
  // - P0: Evidence retention + reconciliation
  // - P1: Hierarchical retrieval + session summaries + 4-mode activation
  // ─────────────────────────────────────────────────────────────

  describe("aspirational temporal reasoning (P0/P1 required)", () => {
    // ── Ordering (2 tests) ──
    // System must return memories in chronological session order,
    // not just by relevance score.

    test.fails("ordering: T01 (Express) appears before T02 (Fastify) in temporal results", async () => {
      // Requires: session-ordered retrieval where rank reflects chronology
      const activated = await runTemporalQuery("show the full history of HTTP framework decisions in order");

      expect(activated).toContain("T01"); // Express (session 1)
      expect(activated).toContain("T02"); // Fastify (session 2)

      const t01Idx = activated.indexOf("T01");
      const t02Idx = activated.indexOf("T02");
      // Chronological: Express (Jan) must appear before Fastify (Jan 15)
      expect(t01Idx).toBeLessThan(t02Idx);
    });

    test.fails("ordering: CI setup (T03) appears before CI pitfall fix (T04) in same session", async () => {
      // Requires: intra-session temporal ordering
      const activated = await runTemporalQuery("what happened with CI pipeline in chronological order");

      expect(activated).toContain("T03"); // CI setup (session 3, morning)
      expect(activated).toContain("T04"); // CI pitfall (session 3, afternoon)

      const t03Idx = activated.indexOf("T03");
      const t04Idx = activated.indexOf("T04");
      // T03 was created before T04 in the same session
      expect(t03Idx).toBeLessThan(t04Idx);
    });

    // ── Progression (2 tests) ──
    // System must synthesize how a topic evolved across sessions.

    test.fails("progression: testing evolution returns T03, T04, AND T08 in chronological sequence", async () => {
      // Requires: cross-session topic tracking + temporal ordering
      const activated = await runTemporalQuery("how did our testing practices evolve from the beginning to now");

      // All three testing-related memories must appear
      expect(activated).toContain("T03"); // CI setup (session 3)
      expect(activated).toContain("T04"); // CI pitfall (session 3)
      expect(activated).toContain("T08"); // vitest switch (session 6)

      // And they must be in chronological order
      const t03Idx = activated.indexOf("T03");
      const t04Idx = activated.indexOf("T04");
      const t08Idx = activated.indexOf("T08");
      expect(t03Idx).toBeLessThan(t04Idx);
      expect(t04Idx).toBeLessThan(t08Idx);
    });

    test.fails("progression: database architecture evolution returns T05 then T07", async () => {
      // Requires: cross-session topic tracking for database decisions
      const activated = await runTemporalQuery("how did database architecture evolve over time across sessions");

      expect(activated).toContain("T05"); // SQLite switch (session 4)
      expect(activated).toContain("T07"); // Repository policy (session 6)

      const t05Idx = activated.indexOf("T05");
      const t07Idx = activated.indexOf("T07");
      // Session 4 decision before session 6 policy
      expect(t05Idx).toBeLessThan(t07Idx);
    });

    // ── Cross-session comparison (2 tests) ──
    // System must retrieve memories from different sessions AND
    // return them in chronological session order. Current system
    // retrieves by relevance, not session-ordered.

    test.fails("cross-session: session 3 vs session 6 testing comparison returns all 3 in session order", async () => {
      // Requires: session-level pre-filtering + chronological ordering
      const activated = await runTemporalQuery("compare how testing was done in session 3 versus session 6");

      // Session 3: CI setup + pitfall, Session 6: vitest decision
      expect(activated).toContain("T03");
      expect(activated).toContain("T04");
      expect(activated).toContain("T08");

      // Must be in session order: session 3 items before session 6 items
      const t03Idx = activated.indexOf("T03");
      const t04Idx = activated.indexOf("T04");
      const t08Idx = activated.indexOf("T08");
      expect(t03Idx).toBeLessThan(t08Idx); // session 3 before session 6
      expect(t04Idx).toBeLessThan(t08Idx); // session 3 before session 6
    });

    test.fails("cross-session: DB decision (session 4) before repo policy (session 6) in chronological order", async () => {
      // Requires: session-aware retrieval with chronological ordering
      const activated = await runTemporalQuery("what was the database decision in session 4 and how did the repository policy in session 6 build on it");

      expect(activated).toContain("T05"); // DB switch (session 4)
      expect(activated).toContain("T07"); // Repo policy (session 6)

      // Session 4 must appear before session 6
      const t05Idx = activated.indexOf("T05");
      const t07Idx = activated.indexOf("T07");
      expect(t05Idx).toBeLessThan(t07Idx);
    });
  });
});
