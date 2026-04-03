import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { TIER2_GROUND_TRUTH } from "./fixtures/tier2.ground-truth";
import { TIER2_MEMORIES } from "./fixtures/tier2.memories";
import { TIER2_QUERIES } from "./fixtures/tier2.queries";
import type { Tier2GroundTruthLabel } from "./fixtures/tier2.types";
import { createTier2EmbeddingRuntime } from "./helpers/embedding-runtime";
import {
  closeTier2Fixture,
  createTier2SeededFixture,
  type Tier2SeededFixture,
} from "./helpers/fixture-seeder";
import { computeAggregateMetrics } from "./helpers/metrics";
import { runAllTier2Queries, type Tier2QueryRunResult } from "./helpers/query-runner";
import {
  computeDeltaPercent,
  isTier1Optimistic,
  printSimpleReport,
  printTier2Report,
} from "./helpers/reporting";
import { bootstrapMeanInterval, wilsonInterval } from "./helpers/statistics";

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

const FIRST_TURN_QUERIES = TIER2_QUERIES.filter((query) => query.category === "first-turn");
const LABELS_BY_QUERY_ID = new Map<string, Tier2GroundTruthLabel>(
  TIER2_GROUND_TRUTH.map((label) => [label.queryId, label]),
);

function hasHit(run: Tier2QueryRunResult, label: Tier2GroundTruthLabel): boolean {
  return run.activatedFixtureIds.some((memoryId) => label.relevantMemoryIds.includes(memoryId));
}

describe("Tier 2: First-Turn Hit Rate", () => {
  let fixture: Tier2SeededFixture;
  let runs: Tier2QueryRunResult[];
  let hitRate = 0;
  let hitCount = 0;
  let averageUsedPayloadBytes = 0;
  let averageUsedMemories = 0;
  let aggregate = computeAggregateMetrics([], LABELS_BY_QUERY_ID);
  let hitRateInterval = wilsonInterval(0, 0);
  let recallInterval = bootstrapMeanInterval([]);

  beforeAll(async () => {
    const runtime = await createTier2EmbeddingRuntime();
    fixture = await createTier2SeededFixture(runtime, TIER2_MEMORIES);
    runs = await runAllTier2Queries(fixture, FIRST_TURN_QUERIES);
    aggregate = computeAggregateMetrics(runs, LABELS_BY_QUERY_ID);
    hitCount = runs.filter((run) => {
      const label = LABELS_BY_QUERY_ID.get(run.queryId);

      if (label === undefined) {
        return false;
      }

      return hasHit(run, label);
    }).length;
    hitRate = runs.length > 0 ? hitCount / runs.length : 0;
    averageUsedPayloadBytes =
      runs.reduce((sum, run) => sum + run.usedPayloadBytes, 0) / Math.max(runs.length, 1);
    averageUsedMemories =
      runs.reduce((sum, run) => sum + run.usedMemories, 0) / Math.max(runs.length, 1);
    hitRateInterval = wilsonInterval(hitCount, runs.length);
    recallInterval = bootstrapMeanInterval(
      aggregate.perQuery.map((metrics) => metrics.recallAt5),
    );
  });

  afterAll(() => {
    closeTier2Fixture(fixture);
  });

  test("measures first-turn hit rate with real embeddings", () => {
    const perQuery = runs.map((run) => {
      const label = LABELS_BY_QUERY_ID.get(run.queryId);

      if (label === undefined) {
        throw new Error(`Missing ground truth for ${run.queryId}`);
      }

      const queryMetrics = aggregate.perQuery.find((metrics) => metrics.queryId === run.queryId);

      return {
        queryId: run.queryId,
        hit: hasHit(run, label),
        recallAt5: queryMetrics?.recallAt5 ?? 0,
        activatedTop5: run.activatedFixtureIds.slice(0, 5),
        relevant: label.relevantMemoryIds,
      };
    });

    console.log("\nTier 2 first-turn per-query results:");
    console.log(JSON.stringify(perQuery, null, 2));
    printSimpleReport("Tier 2 First-Turn Metrics", {
      Queries: runs.length,
      Hits: hitCount,
      "Hit rate": hitRate,
      "Mean recall@5": aggregate.mean.recallAt5,
      "Mean precision@5": aggregate.mean.precisionAt5,
      MRR: aggregate.mean.mrr,
      "Avg used memories": averageUsedMemories,
      "Avg payload bytes": averageUsedPayloadBytes,
      "Seed ms": fixture.seedTimeMs,
    });

    expect(hitRate).toBeGreaterThan(0.3);
    expect(aggregate.mean.recallAt5).toBeGreaterThan(0.05);
  });

  test("compares with Tier 1 mock baseline", () => {
    printTier2Report("Tier 1 vs Tier 2 First-Turn", [
      {
        metric: "Hit rate",
        tier1: TIER1_CLAIMS.firstTurnHitRate,
        tier2: hitRate,
        deltaPercent: computeDeltaPercent(TIER1_CLAIMS.firstTurnHitRate, hitRate),
        optimistic: isTier1Optimistic(TIER1_CLAIMS.firstTurnHitRate, hitRate),
      },
      {
        metric: "Recall@5",
        tier1: TIER1_CLAIMS.firstTurnAvgRecall,
        tier2: aggregate.mean.recallAt5,
        deltaPercent: computeDeltaPercent(TIER1_CLAIMS.firstTurnAvgRecall, aggregate.mean.recallAt5),
        optimistic: isTier1Optimistic(TIER1_CLAIMS.firstTurnAvgRecall, aggregate.mean.recallAt5),
      },
      {
        metric: "Precision@5",
        tier1: TIER1_CLAIMS.precisionAt5,
        tier2: aggregate.mean.precisionAt5,
        deltaPercent: computeDeltaPercent(TIER1_CLAIMS.precisionAt5, aggregate.mean.precisionAt5),
        optimistic: isTier1Optimistic(TIER1_CLAIMS.precisionAt5, aggregate.mean.precisionAt5),
      },
      {
        metric: "MRR",
        tier1: TIER1_CLAIMS.mrr,
        tier2: aggregate.mean.mrr,
        deltaPercent: computeDeltaPercent(TIER1_CLAIMS.mrr, aggregate.mean.mrr),
        optimistic: isTier1Optimistic(TIER1_CLAIMS.mrr, aggregate.mean.mrr),
      },
    ]);

    expect(Number.isFinite(aggregate.mean.mrr)).toBe(true);
  });

  test("prints confidence interval for hit rate", () => {
    printSimpleReport("Tier 2 First-Turn Confidence Intervals", {
      "Hit rate lower": hitRateInterval.lower,
      "Hit rate point": hitRateInterval.point,
      "Hit rate upper": hitRateInterval.upper,
      "Recall lower": recallInterval.lower,
      "Recall point": recallInterval.point,
      "Recall upper": recallInterval.upper,
    });

    expect(hitRateInterval.lower).toBeLessThanOrEqual(hitRateInterval.point);
    expect(hitRateInterval.point).toBeLessThanOrEqual(hitRateInterval.upper);
  });
});
