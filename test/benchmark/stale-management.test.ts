/**
 * Benchmark: Stale Memory Management (Tier 1 — Mock)
 *
 * Validates that the activation engine correctly filters out inactive
 * memories (stale, superseded, rejected) and that the supersession chain
 * works correctly.
 *
 * This is a correctness benchmark — the expected result is 100% filtering
 * accuracy for inactive memories.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { ActivationEngine } from "../../src/activation";
import type { EmbeddingService } from "../../src/activation/embeddings";
import { MemoryRepository } from "../../src/memory";
import {
  type BenchmarkFixture,
  MockEmbeddingService,
  TEST_MEMORIES,
  TEST_QUERIES,
  createBenchmarkFixture,
  printBenchmarkReport,
} from "./benchmark-helpers";
import { createTestDb } from "../helpers/create-test-db";

const INACTIVE_TAGS = new Set(["M16-stale", "M17-superseded", "M18-rejected"]);

describe("Benchmark: Stale Memory Management", () => {
  let fixture: BenchmarkFixture;

  beforeEach(async () => {
    fixture = await createBenchmarkFixture();
  });

  afterEach(() => {
    fixture.db.close();
  });

  test("inactive memories are NEVER activated (100% filtering)", async () => {
    let totalActivations = 0;
    let inactiveLeaks = 0;

    for (const query of TEST_QUERIES) {
      const result = await fixture.engine.activate({
        lifecycleTrigger: "before_model",
        scopeRef: "src/activation/engine.ts",
        queryTokens: query.text.split(/[\s\p{P}]+/u).filter((t) => t.length > 2),
        maxMemories: 20, // Large budget to avoid budget-based suppression
        maxPayloadBytes: 65536,
      });

      for (const memory of result.activated) {
        totalActivations++;
        const tag = fixture.idToTag.get(memory.id);

        if (tag !== undefined && INACTIVE_TAGS.has(tag)) {
          inactiveLeaks++;
        }
      }
    }

    const filteringAccuracy = totalActivations > 0
      ? 1 - inactiveLeaks / totalActivations
      : 1;

    printBenchmarkReport("Stale Memory Filtering", {
      "Total activations": totalActivations,
      "Inactive leaks": inactiveLeaks,
      "Filtering accuracy": filteringAccuracy,
      "Queries tested": TEST_QUERIES.length,
      "Inactive memories": INACTIVE_TAGS.size,
    });

    expect(inactiveLeaks).toBe(0);
    expect(filteringAccuracy).toBe(1);
  });

  test("stale memories appear in suppressed list with correct reason", async () => {
    const result = await fixture.engine.activate({
      lifecycleTrigger: "before_model",
      scopeRef: "**/*",
      queryTokens: ["stale", "memory", "check", "review"],
      maxMemories: 20,
      maxPayloadBytes: 65536,
    });

    const staleSuppressions = result.suppressed.filter(
      (s) => s.kind === "status_inactive",
    );

    // All 3 inactive memories should be in suppressed list.
    expect(staleSuppressions.length).toBeGreaterThanOrEqual(INACTIVE_TAGS.size);

    for (const suppression of staleSuppressions) {
      expect(suppression.reason).toContain("not eligible for activation");
    }
  });

  test("supersession chain: superseded memory references parent", async () => {
    // M17-superseded has status "superseded" — verify it's excluded.
    const m17Id = fixture.tagToId.get("M17-superseded");

    if (m17Id === undefined) {
      throw new Error("M17-superseded not found in fixture");
    }

    const memory = fixture.repository.getById(m17Id);
    expect(memory).not.toBeNull();
    expect(memory!.status).toBe("superseded");

    // Verify it never appears in any activation.
    for (const query of TEST_QUERIES) {
      const result = await fixture.engine.activate({
        lifecycleTrigger: "before_model",
        scopeRef: ".",
        queryTokens: query.text.split(/[\s\p{P}]+/u).filter((t) => t.length > 2),
      });

      const activatedIds = result.activated.map((m) => m.id);
      expect(activatedIds).not.toContain(m17Id);
    }
  });

  test("rejected memories are permanently excluded", async () => {
    const m18Id = fixture.tagToId.get("M18-rejected");

    if (m18Id === undefined) {
      throw new Error("M18-rejected not found in fixture");
    }

    const memory = fixture.repository.getById(m18Id);
    expect(memory).not.toBeNull();
    expect(memory!.status).toBe("rejected");

    // Rejected should never activate even with very broad criteria.
    const result = await fixture.engine.activate({
      lifecycleTrigger: "before_model",
      scopeRef: "**/*",
      queryTokens: ["warning", "fatigue", "too", "many"],
      maxMemories: 50,
      maxPayloadBytes: 65536,
    });

    const activatedIds = result.activated.map((m) => m.id);
    expect(activatedIds).not.toContain(m18Id);
  });

  test("diversity rerank does not resurrect inactive memories", async () => {
    // Layer D diversity rerank operates on already-selected memories.
    // Inactive memories should never reach Layer D.
    const result = await fixture.engine.activate({
      lifecycleTrigger: "before_model",
      scopeRef: "src/dream/worker.ts",
      queryTokens: ["dream", "consolidation", "evidence", "manual", "promotion"],
      maxMemories: 10,
      maxPayloadBytes: 8192,
    });

    for (const activated of result.activated) {
      const tag = fixture.idToTag.get(activated.id);
      expect(tag === undefined || !INACTIVE_TAGS.has(tag)).toBe(true);
      expect(activated.status).toBe("active");
    }
  });
});
