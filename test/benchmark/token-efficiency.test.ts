/**
 * Benchmark: Token Efficiency (Tier 1 — Mock)
 *
 * Measures the byte-level payload efficiency of selective memory injection
 * compared to a hypothetical "dump everything" approach (like CLAUDE.md).
 *
 * Key metric: token_efficiency_ratio = selective_payload / full_dump_payload
 * Lower ratio = better efficiency (we inject less noise).
 *
 * Also validates that the budget enforcement system correctly limits payload
 * size and memory count.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  type BenchmarkFixture,
  TEST_MEMORIES,
  TEST_QUERIES,
  createBenchmarkFixture,
  printBenchmarkReport,
  queryActivation,
} from "./benchmark-helpers";

/** Estimate the byte size of a memory's payload using the SAME format as the engine. */
function estimateMemoryPayloadBytes(
  input: { id?: string; summary: string; details: string; type: string; scopeGlob: string; lifecycleTriggers?: readonly string[]; status?: string },
): number {
  const payload = JSON.stringify({
    id: input.id ?? "mem_placeholder",
    type: input.type,
    summary: input.summary,
    details: input.details,
    scopeGlob: input.scopeGlob,
    lifecycleTriggers: input.lifecycleTriggers ?? ["before_model"],
    status: input.status ?? "active",
  });

  return Buffer.byteLength(payload, "utf8");
}

describe("Benchmark: Token Efficiency", () => {
  let fixture: BenchmarkFixture;

  beforeEach(async () => {
    fixture = await createBenchmarkFixture();
  });

  afterEach(() => {
    fixture.db.close();
  });

  test("selective injection uses significantly less payload than full dump", async () => {
    // Calculate full dump size (all active memories).
    const activeMemories = TEST_MEMORIES.filter(
      (m) => m.input.status === "active",
    );
    const fullDumpBytes = activeMemories.reduce(
      (sum, m) => sum + estimateMemoryPayloadBytes(m.input),
      0,
    );

    // Calculate selective injection size across all queries.
    let totalSelectiveBytes = 0;
    let queryCount = 0;

    for (const query of TEST_QUERIES) {
      const result = await fixture.engine.activate({
        lifecycleTrigger: "before_model",
        scopeRef: "src/activation/engine.ts",
        queryTokens: query.text.split(/[\s\p{P}]+/u).filter((t) => t.length > 2),
        maxMemories: 10,
        maxPayloadBytes: 8192,
      });

      totalSelectiveBytes += result.budget.usedPayloadBytes;
      queryCount++;
    }

    const avgSelectiveBytes = totalSelectiveBytes / queryCount;
    const efficiencyRatio = avgSelectiveBytes / fullDumpBytes;
    const savingsPercent = (1 - efficiencyRatio) * 100;

    printBenchmarkReport("Token Efficiency: Selective vs Full Dump", {
      "Full dump (all active)": `${fullDumpBytes} bytes`,
      "Avg selective injection": `${Math.round(avgSelectiveBytes)} bytes`,
      "Efficiency ratio": efficiencyRatio,
      "Token savings": `${savingsPercent.toFixed(1)}%`,
      "Active memories": activeMemories.length,
      "Queries evaluated": queryCount,
    });

    // Selective injection should use less than 90% of the full dump.
    // With 17 active memories and 10-memory budget, we expect 10-30% savings.
    expect(efficiencyRatio).toBeLessThan(0.90);
    expect(savingsPercent).toBeGreaterThan(10);
  });

  test("budget enforcement: memory count limit", async () => {
    const result = await fixture.engine.activate({
      lifecycleTrigger: "before_model",
      scopeRef: "src/activation/engine.ts",
      queryTokens: ["typescript", "database", "testing", "plugin"],
      maxMemories: 3,
      maxPayloadBytes: 8192,
    });

    expect(result.activated.length).toBeLessThanOrEqual(3);
    expect(result.budget.usedMemories).toBeLessThanOrEqual(3);
    expect(result.budget.maxMemories).toBe(3);
  });

  test("budget enforcement: payload size limit", async () => {
    const result = await fixture.engine.activate({
      lifecycleTrigger: "before_model",
      scopeRef: "src/activation/engine.ts",
      queryTokens: ["typescript", "database", "testing", "plugin"],
      maxMemories: 20,
      maxPayloadBytes: 512, // Very tight budget
    });

    expect(result.budget.usedPayloadBytes).toBeLessThanOrEqual(512);
    // With 512 byte budget, only 1-2 memories should fit.
    expect(result.activated.length).toBeLessThanOrEqual(4);
  });

  test("CLAUDE.md equivalent comparison", async () => {
    // Simulate a CLAUDE.md approach: a single system prompt containing ALL memories
    // with full metadata (matching engine payload format for fair comparison).
    const allActive = TEST_MEMORIES.filter((m) => m.input.status === "active");
    const claudeMdBytes = allActive.reduce(
      (sum, m) => sum + estimateMemoryPayloadBytes(m.input),
      0,
    );

    // Our selective approach for a typical query
    const typicalQuery = TEST_QUERIES[0]; // TypeScript query
    const result = await fixture.engine.activate({
      lifecycleTrigger: "before_model",
      scopeRef: "src/activation/engine.ts",
      queryTokens: typicalQuery.text.split(/[\s\p{P}]+/u).filter((t) => t.length > 2),
      maxMemories: 10,
      maxPayloadBytes: 8192,
    });

    const selectiveBytes = result.budget.usedPayloadBytes;

    printBenchmarkReport("CLAUDE.md vs Selective Injection", {
      "CLAUDE.md equivalent": `${claudeMdBytes} bytes (all ${allActive.length} memories)`,
      "Selective injection": `${selectiveBytes} bytes (${result.activated.length} memories)`,
      "Ratio": selectiveBytes / claudeMdBytes,
      "Savings": `${((1 - selectiveBytes / claudeMdBytes) * 100).toFixed(1)}%`,
    });

    // With 10-memory cap vs 17 total active, we should use less payload.
    expect(selectiveBytes).toBeLessThan(claudeMdBytes);
  });
});
