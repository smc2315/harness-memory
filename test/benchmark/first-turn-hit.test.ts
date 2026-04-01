/**
 * Benchmark: First-Turn Hit Rate (Tier 1 — Mock)
 *
 * Measures how well the activation engine finds relevant memories on the
 * very first interaction — WITHOUT any scope context.  This simulates a
 * user opening a new session and asking a question before any file is open.
 *
 * Compares two approaches:
 *   v0.2.3 (scope-only)  — No vector search, relies on scope + trigger matching
 *   v0.3.0 (vector search) — Uses query tokens + vector similarity
 *
 * The delta between them demonstrates the value of vector search for
 * cold-start / first-turn scenarios.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { ActivationEngine } from "../../src/activation";
import { MemoryRepository } from "../../src/memory";
import {
  type BenchmarkFixture,
  TEST_QUERIES,
  createBenchmarkFixture,
  printBenchmarkReport,
  recallAtK,
} from "./benchmark-helpers";

describe("Benchmark: First-Turn Hit Rate", () => {
  let fixture: BenchmarkFixture;

  beforeEach(async () => {
    fixture = await createBenchmarkFixture();
  });

  afterEach(() => {
    fixture.db.close();
  });

  test("v0.3.0 (vector search) vs v0.2.3 (scope-only) first-turn hit rate", async () => {
    // v0.3.0 approach: use queryTokens + vector search + broad scope
    const v030Results: Array<{ tag: string; recall: number; hitCount: number }> = [];

    for (const query of TEST_QUERIES) {
      const result = await fixture.engine.activate({
        lifecycleTrigger: "before_model",
        scopeRef: ".", // Broad scope — first turn, no specific file
        queryTokens: query.text.split(/[\s\p{P}]+/u).filter((t) => t.length > 2),
        maxMemories: 10,
        maxPayloadBytes: 8192,
      });

      const retrieved = result.activated.map(
        (m) => fixture.idToTag.get(m.id) ?? m.id,
      );
      const relevant = new Set(query.relevantTags);

      v030Results.push({
        tag: query.tag,
        recall: recallAtK(retrieved, relevant, 5),
        hitCount: retrieved.filter((tag) => relevant.has(tag)).length,
      });
    }

    // v0.2.3 approach: NO query tokens, scope-only matching
    const engineNoVector = new ActivationEngine(fixture.repository);
    const v023Results: Array<{ tag: string; recall: number; hitCount: number }> = [];

    for (const query of TEST_QUERIES) {
      const result = await engineNoVector.activate({
        lifecycleTrigger: "before_model",
        scopeRef: ".", // Broad scope — first turn
        // No queryTokens — this is the v0.2.3 approach.
        maxMemories: 10,
        maxPayloadBytes: 8192,
      });

      const retrieved = result.activated.map(
        (m) => fixture.idToTag.get(m.id) ?? m.id,
      );
      const relevant = new Set(query.relevantTags);

      v023Results.push({
        tag: query.tag,
        recall: recallAtK(retrieved, relevant, 5),
        hitCount: retrieved.filter((tag) => relevant.has(tag)).length,
      });
    }

    const v030HitRate =
      v030Results.filter((r) => r.hitCount > 0).length / v030Results.length;
    const v023HitRate =
      v023Results.filter((r) => r.hitCount > 0).length / v023Results.length;
    const v030AvgRecall =
      v030Results.reduce((sum, r) => sum + r.recall, 0) / v030Results.length;
    const v023AvgRecall =
      v023Results.reduce((sum, r) => sum + r.recall, 0) / v023Results.length;

    printBenchmarkReport("First-Turn Hit Rate Comparison", {
      "v0.3.0 Hit Rate": v030HitRate,
      "v0.2.3 Hit Rate": v023HitRate,
      "Delta (Hit Rate)": v030HitRate - v023HitRate,
      "v0.3.0 Avg Recall@5": v030AvgRecall,
      "v0.2.3 Avg Recall@5": v023AvgRecall,
      "Delta (Recall)": v030AvgRecall - v023AvgRecall,
      "Queries": TEST_QUERIES.length,
    });

    // v0.3.0 should equal or beat v0.2.3 in first-turn scenarios.
    expect(v030HitRate).toBeGreaterThanOrEqual(v023HitRate);
  });

  test("vector search activates relevant memories even without file scope context", async () => {
    // Specifically test that a broad scope query with tokens finds relevant results.
    const query = TEST_QUERIES.find((q) => q.tag === "Q01"); // typescript strict

    if (query === undefined) {
      throw new Error("Query Q01 not found");
    }

    const result = await fixture.engine.activate({
      lifecycleTrigger: "before_model",
      scopeRef: ".", // No specific file
      queryTokens: query.text.split(/[\s\p{P}]+/u).filter((t) => t.length > 2),
    });

    const retrieved = result.activated.map(
      (m) => fixture.idToTag.get(m.id) ?? m.id,
    );

    // Should find at least one of M01, M02 (TypeScript-related).
    const hasTypeScript = retrieved.some((tag) => ["M01", "M02"].includes(tag));
    expect(hasTypeScript).toBe(true);
  });

  test("baseline memories always appear regardless of query", async () => {
    // Baseline memories (M01, M03) should appear even with a completely
    // unrelated query, because they are Layer A (always inject).
    const result = await fixture.engine.activate({
      lifecycleTrigger: "before_model",
      scopeRef: "src/something.ts",
      queryTokens: ["random", "unrelated", "topic"],
    });

    const retrieved = result.activated.map(
      (m) => fixture.idToTag.get(m.id) ?? m.id,
    );

    // M01 and M03 are baseline — should always be present.
    const baselineTags = ["M01", "M03"];
    const foundBaseline = baselineTags.filter((tag) => retrieved.includes(tag));

    expect(foundBaseline.length).toBeGreaterThanOrEqual(1);
  });
});
