import { afterAll, beforeAll, describe, expect, test } from "vitest";

import type { MemoryRecord } from "../../src/memory";
import { TIER2_MEMORIES } from "./fixtures/tier2.memories";
import { TIER2_QUERIES } from "./fixtures/tier2.queries";
import { createTier2EmbeddingRuntime } from "./helpers/embedding-runtime";
import {
  closeTier2Fixture,
  createTier2SeededFixture,
  type Tier2SeededFixture,
} from "./helpers/fixture-seeder";
import { runAllTier2Queries, type Tier2QueryRunResult } from "./helpers/query-runner";
import {
  computeDeltaPercent,
  isTier1Optimistic,
  printSimpleReport,
  printTier2Report,
} from "./helpers/reporting";

const TIER1_CLAIMS = {
  firstTurnHitRate: 0.90,
  firstTurnAvgRecall: 0.37,
  crossLangRecall: 0.67,
  crossLangHitRate: 0.80,
  tokenSavingsPercent: 41.1,
  precisionAt5: 0.18,
  recallAt5: 0.47,
  mrr: 0.51,
};

function estimateMemoryPayloadBytes(memory: MemoryRecord): number {
  return Buffer.byteLength(
    JSON.stringify({
      id: memory.id,
      type: memory.type,
      summary: memory.summary,
      details: memory.details,
      scopeGlob: memory.scopeGlob,
      lifecycleTriggers: memory.lifecycleTriggers,
      status: memory.status,
    }),
    "utf8",
  );
}

describe("Tier 2: Token Efficiency", () => {
  let fixture: Tier2SeededFixture;
  let runs: Tier2QueryRunResult[];
  let fullDumpBytes = 0;
  let averageSelectiveBytes = 0;
  let minSelectiveBytes = 0;
  let maxSelectiveBytes = 0;
  let averageUsedMemories = 0;
  let actualSavingsPercent = 0;
  let capOnlySavingsPercent = 0;
  let rankingIntelligenceSavingsPercent = 0;

  beforeAll(async () => {
    const runtime = await createTier2EmbeddingRuntime();
    fixture = await createTier2SeededFixture(runtime, TIER2_MEMORIES);
    runs = await runAllTier2Queries(fixture, TIER2_QUERIES);

    const activeMemories = fixture.repository.list({ status: "active" });
    fullDumpBytes = activeMemories.reduce(
      (sum, memory) => sum + estimateMemoryPayloadBytes(memory),
      0,
    );

    const usedPayloads = runs.map((run) => run.usedPayloadBytes);
    averageSelectiveBytes =
      usedPayloads.reduce((sum, value) => sum + value, 0) / Math.max(usedPayloads.length, 1);
    minSelectiveBytes = Math.min(...usedPayloads);
    maxSelectiveBytes = Math.max(...usedPayloads);
    averageUsedMemories =
      runs.reduce((sum, run) => sum + run.usedMemories, 0) / Math.max(runs.length, 1);
    actualSavingsPercent = fullDumpBytes > 0 ? (1 - averageSelectiveBytes / fullDumpBytes) * 100 : 0;
    capOnlySavingsPercent =
      activeMemories.length > 0 ? (1 - 10 / activeMemories.length) * 100 : 0;
    rankingIntelligenceSavingsPercent = actualSavingsPercent - capOnlySavingsPercent;
  });

  afterAll(() => {
    closeTier2Fixture(fixture);
  });

  test("measures actual payload vs full dump", () => {
    printSimpleReport("Tier 2 Token Efficiency", {
      Queries: runs.length,
      "Full dump bytes": fullDumpBytes,
      "Avg selective bytes": averageSelectiveBytes,
      "Min selective bytes": minSelectiveBytes,
      "Max selective bytes": maxSelectiveBytes,
      "Avg used memories": averageUsedMemories,
      "Token savings %": actualSavingsPercent,
    });

    expect(actualSavingsPercent).toBeGreaterThan(60);
  });

  test("separates cap-only savings from ranking-intelligence savings", () => {
    printSimpleReport("Tier 2 Cap vs Ranking Savings", {
      "Cap-only savings %": capOnlySavingsPercent,
      "Actual savings %": actualSavingsPercent,
      "Ranking intelligence %": rankingIntelligenceSavingsPercent,
      "Avg used memories": averageUsedMemories,
    });

    expect(capOnlySavingsPercent).toBeGreaterThan(80);
    expect(Number.isFinite(rankingIntelligenceSavingsPercent)).toBe(true);
  });

  test("compares with Tier 1 claims", () => {
    printTier2Report("Tier 1 vs Tier 2 Token Efficiency", [
      {
        metric: "Token savings %",
        tier1: TIER1_CLAIMS.tokenSavingsPercent,
        tier2: actualSavingsPercent,
        deltaPercent: computeDeltaPercent(TIER1_CLAIMS.tokenSavingsPercent, actualSavingsPercent),
        optimistic: isTier1Optimistic(TIER1_CLAIMS.tokenSavingsPercent, actualSavingsPercent),
      },
      {
        metric: "Cap-only savings %",
        tier1: "10/17 cap context",
        tier2: capOnlySavingsPercent,
      },
      {
        metric: "Ranking intelligence %",
        tier1: "N/A",
        tier2: rankingIntelligenceSavingsPercent,
      },
    ]);

    expect(actualSavingsPercent).toBeGreaterThan(0);
  });
});
