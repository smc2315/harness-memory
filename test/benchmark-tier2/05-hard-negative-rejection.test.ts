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
import { runAllTier2Queries, type Tier2QueryRunResult } from "./helpers/query-runner";
import { printSimpleReport } from "./helpers/reporting";
import { wilsonInterval } from "./helpers/statistics";

const HARD_NEGATIVE_QUERIES = TIER2_QUERIES.filter((query) => query.category === "scoped");
const LABELS_BY_QUERY_ID = new Map<string, Tier2GroundTruthLabel>(
  TIER2_GROUND_TRUTH.map((label) => [label.queryId, label]),
);

interface HardNegativeSummary {
  queryId: string;
  relevantRanks: number[];
  forbiddenRanks: number[];
  leakedForbidden: string[];
  activatedFixtureIds: string[];
}

describe("Tier 2: Hard Negative Rejection", () => {
  let fixture: Tier2SeededFixture;
  let summaries: HardNegativeSummary[];
  let totalForbiddenCandidates = 0;
  let totalForbiddenLeaks = 0;

  beforeAll(async () => {
    const runtime = await createTier2EmbeddingRuntime();
    fixture = await createTier2SeededFixture(runtime, TIER2_MEMORIES);
    const runs = await runAllTier2Queries(fixture, HARD_NEGATIVE_QUERIES);
    const runsByQueryId = new Map(runs.map((run) => [run.queryId, run]));

    summaries = HARD_NEGATIVE_QUERIES.map((query) => {
      const label = LABELS_BY_QUERY_ID.get(query.id);
      const run = runsByQueryId.get(query.id);

      if (label === undefined || run === undefined) {
        throw new Error(`Missing hard-negative data for ${query.id}`);
      }

      totalForbiddenCandidates += label.forbiddenMemoryIds.length;
      const relevantRanks = label.relevantMemoryIds
        .map((memoryId) => run.activatedFixtureIds.indexOf(memoryId))
        .filter((index) => index >= 0)
        .map((index) => index + 1);
      const forbiddenRanks = label.forbiddenMemoryIds
        .map((memoryId) => run.activatedFixtureIds.indexOf(memoryId))
        .filter((index) => index >= 0)
        .map((index) => index + 1);
      const leakedForbidden = run.activatedFixtureIds.filter((memoryId) =>
        label.forbiddenMemoryIds.includes(memoryId),
      );

      totalForbiddenLeaks += leakedForbidden.length;

      return {
        queryId: query.id,
        relevantRanks,
        forbiddenRanks,
        leakedForbidden,
        activatedFixtureIds: run.activatedFixtureIds,
      };
    });
  });

  afterAll(() => {
    closeTier2Fixture(fixture);
  });

  test("prefers correct-domain memory over topical hard negative", () => {
    const preferredCount = summaries.filter((summary) => {
      const firstRelevant = summary.relevantRanks[0] ?? Number.POSITIVE_INFINITY;
      const firstForbidden = summary.forbiddenRanks[0] ?? Number.POSITIVE_INFINITY;

      return summary.relevantRanks.length > 0 && firstRelevant < firstForbidden;
    }).length;
    const preferenceRate = preferredCount / Math.max(summaries.length, 1);

    console.log("\nTier 2 hard-negative preference results:");
    console.log(JSON.stringify(summaries, null, 2));
    printSimpleReport("Tier 2 Hard-Negative Preference", {
      Queries: summaries.length,
      "Correct over forbidden": preferredCount,
      "Preference rate": preferenceRate,
    });

    expect(preferenceRate).toBeGreaterThan(0.3);
  });

  test("reports hard-negative loss rate", () => {
    const lossRate =
      totalForbiddenCandidates > 0 ? totalForbiddenLeaks / totalForbiddenCandidates : 0;
    const keepOutCount = totalForbiddenCandidates - totalForbiddenLeaks;
    const keepOutInterval = wilsonInterval(keepOutCount, totalForbiddenCandidates);

    printSimpleReport("Tier 2 Hard-Negative Loss", {
      "Forbidden candidates": totalForbiddenCandidates,
      "Forbidden leaks": totalForbiddenLeaks,
      "Loss rate": lossRate,
      "Keep-out lower": keepOutInterval.lower,
      "Keep-out upper": keepOutInterval.upper,
    });

    expect(lossRate).toBeLessThan(0.5);
  });
});
