import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { TIER2_GROUND_TRUTH } from "./fixtures/tier2.ground-truth";
import { TIER2_MEMORIES } from "./fixtures/tier2.memories";
import { TIER2_QUERIES } from "./fixtures/tier2.queries";
import type {
  Tier2GroundTruthLabel,
  Tier2MemoryFixture,
  Tier2QueryFixture,
} from "./fixtures/tier2.types";
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

const CROSS_LANGUAGE_QUERIES = TIER2_QUERIES.filter(
  (query) => query.category === "cross-language",
);
const LABELS_BY_QUERY_ID = new Map<string, Tier2GroundTruthLabel>(
  TIER2_GROUND_TRUTH.map((label) => [label.queryId, label]),
);
const MEMORIES_BY_ID = new Map<string, Tier2MemoryFixture>(
  TIER2_MEMORIES.map((memory) => [memory.id, memory]),
);

interface DirectionSummary {
  name: string;
  queries: readonly Tier2QueryFixture[];
  runs: Tier2QueryRunResult[];
  hitCount: number;
  hitRate: number;
  recallAt5: number;
  precisionAt5: number;
  mrr: number;
  hitInterval: ReturnType<typeof wilsonInterval>;
  recallInterval: ReturnType<typeof bootstrapMeanInterval>;
  mrrInterval: ReturnType<typeof bootstrapMeanInterval>;
}

function computeDirectionSummary(
  name: string,
  queries: readonly Tier2QueryFixture[],
  runs: readonly Tier2QueryRunResult[],
): DirectionSummary {
  const runsByQueryId = new Map(runs.map((run) => [run.queryId, run]));
  const orderedRuns = queries
    .map((query) => runsByQueryId.get(query.id))
    .filter((run): run is Tier2QueryRunResult => run !== undefined);
  const aggregate = computeAggregateMetrics(orderedRuns, LABELS_BY_QUERY_ID);
  const hitCount = orderedRuns.filter((run) => {
    const label = LABELS_BY_QUERY_ID.get(run.queryId);

    if (label === undefined) {
      return false;
    }

    return run.activatedFixtureIds.some((memoryId) => label.relevantMemoryIds.includes(memoryId));
  }).length;

  return {
    name,
    queries,
    runs: orderedRuns,
    hitCount,
    hitRate: orderedRuns.length > 0 ? hitCount / orderedRuns.length : 0,
    recallAt5: aggregate.mean.recallAt5,
    precisionAt5: aggregate.mean.precisionAt5,
    mrr: aggregate.mean.mrr,
    hitInterval: wilsonInterval(hitCount, orderedRuns.length),
    recallInterval: bootstrapMeanInterval(
      aggregate.perQuery.map((metrics) => metrics.recallAt5),
    ),
    mrrInterval: bootstrapMeanInterval(aggregate.perQuery.map((metrics) => metrics.mrr)),
  };
}

describe("Tier 2: Cross-Language Retrieval", () => {
  let fixture: Tier2SeededFixture;
  let runs: Tier2QueryRunResult[];
  let koreanToEnglish: DirectionSummary;
  let englishToKorean: DirectionSummary;

  beforeAll(async () => {
    const runtime = await createTier2EmbeddingRuntime();
    fixture = await createTier2SeededFixture(runtime, TIER2_MEMORIES);
    runs = await runAllTier2Queries(fixture, CROSS_LANGUAGE_QUERIES);

    const koreanQueries = CROSS_LANGUAGE_QUERIES.filter((query) => query.language === "ko");
    const englishQueries = CROSS_LANGUAGE_QUERIES.filter((query) => query.language === "en");

    koreanToEnglish = computeDirectionSummary("Korean -> English", koreanQueries, runs);
    englishToKorean = computeDirectionSummary("English -> Korean", englishQueries, runs);
  });

  afterAll(() => {
    closeTier2Fixture(fixture);
  });

  test("Korean queries retrieve English memories", () => {
    const details = koreanToEnglish.runs.map((run) => {
      const label = LABELS_BY_QUERY_ID.get(run.queryId);
      const relevantLanguages = (label?.relevantMemoryIds ?? []).map((memoryId) => {
        const memory = MEMORIES_BY_ID.get(memoryId);
        return memory?.language ?? "unknown";
      });

      return {
        queryId: run.queryId,
        activatedTop5: run.activatedFixtureIds.slice(0, 5),
        relevantLanguages,
      };
    });

    console.log("\nTier 2 Korean -> English cross-language results:");
    console.log(JSON.stringify(details, null, 2));
    printSimpleReport("Tier 2 Korean -> English", {
      Queries: koreanToEnglish.runs.length,
      "Hit rate": koreanToEnglish.hitRate,
      "Recall@5": koreanToEnglish.recallAt5,
      "Precision@5": koreanToEnglish.precisionAt5,
      MRR: koreanToEnglish.mrr,
    });

    expect(koreanToEnglish.hitRate).toBeGreaterThan(0.2);
    expect(koreanToEnglish.recallAt5).toBeGreaterThan(0);
  });

  test("English queries retrieve Korean memories", () => {
    const details = englishToKorean.runs.map((run) => {
      const label = LABELS_BY_QUERY_ID.get(run.queryId);
      const relevantLanguages = (label?.relevantMemoryIds ?? []).map((memoryId) => {
        const memory = MEMORIES_BY_ID.get(memoryId);
        return memory?.language ?? "unknown";
      });

      return {
        queryId: run.queryId,
        activatedTop5: run.activatedFixtureIds.slice(0, 5),
        relevantLanguages,
      };
    });

    console.log("\nTier 2 English -> Korean cross-language results:");
    console.log(JSON.stringify(details, null, 2));
    printSimpleReport("Tier 2 English -> Korean", {
      Queries: englishToKorean.runs.length,
      "Hit rate": englishToKorean.hitRate,
      "Recall@5": englishToKorean.recallAt5,
      "Precision@5": englishToKorean.precisionAt5,
      MRR: englishToKorean.mrr,
    });

    expect(englishToKorean.hitRate).toBeGreaterThan(0);
    expect(englishToKorean.mrr).toBeGreaterThan(0);
  });

  test("prints cross-language metrics with confidence intervals", () => {
    printTier2Report("Tier 1 vs Tier 2 Cross-Language", [
      {
        metric: "KO->EN Hit rate",
        tier1: TIER1_CLAIMS.crossLangHitRate,
        tier2: koreanToEnglish.hitRate,
        deltaPercent: computeDeltaPercent(TIER1_CLAIMS.crossLangHitRate, koreanToEnglish.hitRate),
        optimistic: isTier1Optimistic(TIER1_CLAIMS.crossLangHitRate, koreanToEnglish.hitRate),
      },
      {
        metric: "KO->EN Recall@5",
        tier1: TIER1_CLAIMS.crossLangRecall,
        tier2: koreanToEnglish.recallAt5,
        deltaPercent: computeDeltaPercent(TIER1_CLAIMS.crossLangRecall, koreanToEnglish.recallAt5),
        optimistic: isTier1Optimistic(TIER1_CLAIMS.crossLangRecall, koreanToEnglish.recallAt5),
      },
      {
        metric: "EN->KO Hit rate",
        tier1: TIER1_CLAIMS.crossLangHitRate,
        tier2: englishToKorean.hitRate,
        deltaPercent: computeDeltaPercent(TIER1_CLAIMS.crossLangHitRate, englishToKorean.hitRate),
        optimistic: isTier1Optimistic(TIER1_CLAIMS.crossLangHitRate, englishToKorean.hitRate),
      },
      {
        metric: "EN->KO Recall@5",
        tier1: TIER1_CLAIMS.crossLangRecall,
        tier2: englishToKorean.recallAt5,
        deltaPercent: computeDeltaPercent(TIER1_CLAIMS.crossLangRecall, englishToKorean.recallAt5),
        optimistic: isTier1Optimistic(TIER1_CLAIMS.crossLangRecall, englishToKorean.recallAt5),
      },
    ]);

    printSimpleReport("Tier 2 Cross-Language Confidence Intervals", {
      "KO->EN hit lower": koreanToEnglish.hitInterval.lower,
      "KO->EN hit upper": koreanToEnglish.hitInterval.upper,
      "KO->EN recall lower": koreanToEnglish.recallInterval.lower,
      "KO->EN recall upper": koreanToEnglish.recallInterval.upper,
      "KO->EN MRR lower": koreanToEnglish.mrrInterval.lower,
      "KO->EN MRR upper": koreanToEnglish.mrrInterval.upper,
      "EN->KO hit lower": englishToKorean.hitInterval.lower,
      "EN->KO hit upper": englishToKorean.hitInterval.upper,
      "EN->KO recall lower": englishToKorean.recallInterval.lower,
      "EN->KO recall upper": englishToKorean.recallInterval.upper,
      "EN->KO MRR lower": englishToKorean.mrrInterval.lower,
      "EN->KO MRR upper": englishToKorean.mrrInterval.upper,
    });

    expect(koreanToEnglish.hitInterval.lower).toBeLessThanOrEqual(koreanToEnglish.hitInterval.upper);
    expect(englishToKorean.hitInterval.lower).toBeLessThanOrEqual(englishToKorean.hitInterval.upper);
  });
});
