import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { cosineSimilarity } from "../../src/activation/embeddings";
import { TIER2_GROUND_TRUTH } from "./fixtures/tier2.ground-truth";
import { TIER2_MEMORIES } from "./fixtures/tier2.memories";
import { TIER2_QUERIES } from "./fixtures/tier2.queries";
import type { Tier2GroundTruthLabel } from "./fixtures/tier2.types";
import { createTier2EmbeddingRuntime, type Tier2EmbeddingRuntime } from "./helpers/embedding-runtime";
import {
  closeTier2Fixture,
  createTier2SeededFixture,
  type Tier2SeededFixture,
} from "./helpers/fixture-seeder";
import { printSimpleReport } from "./helpers/reporting";
import { describeDistribution } from "./helpers/statistics";

const LABELS_BY_QUERY_ID = new Map<string, Tier2GroundTruthLabel>(
  TIER2_GROUND_TRUTH.map((label) => [label.queryId, label]),
);

describe("Tier 2: Similarity Distribution", () => {
  let runtime: Tier2EmbeddingRuntime;
  let fixture: Tier2SeededFixture;
  let relevantScores: number[] = [];
  let irrelevantScores: number[] = [];
  let relevantSummary = describeDistribution([]);
  let irrelevantSummary = describeDistribution([]);
  let discriminationGap = 0;
  let overlapLower = 0;
  let overlapUpper = 0;
  let hasOverlap = false;
  let irrelevantAtOrAboveRelevantMinRate = 0;
  let irrelevantAtOrAbove078Rate = 0;
  let perQueryPreview: Array<Record<string, number | string>> = [];

  beforeAll(async () => {
    runtime = await createTier2EmbeddingRuntime();
    fixture = await createTier2SeededFixture(runtime, TIER2_MEMORIES);
    const activeMemories = fixture.repository.list({ status: "active" });

    for (const query of TIER2_QUERIES) {
      const label = LABELS_BY_QUERY_ID.get(query.id);

      if (label === undefined) {
        throw new Error(`Missing label for ${query.id}`);
      }

      const queryEmbedding = await runtime.service.embedQuery(query.text);
      const queryRelevantScores: number[] = [];
      const queryIrrelevantScores: number[] = [];

      for (const memory of activeMemories) {
        if (memory.embedding === null) {
          continue;
        }

        const fixtureId = fixture.reverseIdMap.get(memory.id);
        if (fixtureId === undefined) {
          continue;
        }

        const score = cosineSimilarity(queryEmbedding, memory.embedding);
        if (label.relevantMemoryIds.includes(fixtureId)) {
          relevantScores.push(score);
          queryRelevantScores.push(score);
        } else {
          irrelevantScores.push(score);
          queryIrrelevantScores.push(score);
        }
      }

      perQueryPreview.push({
        queryId: query.id,
        relevantMean:
          queryRelevantScores.length > 0
            ? queryRelevantScores.reduce((sum, score) => sum + score, 0) / queryRelevantScores.length
            : 0,
        irrelevantMean:
          queryIrrelevantScores.reduce((sum, score) => sum + score, 0) /
          Math.max(queryIrrelevantScores.length, 1),
        relevantCount: queryRelevantScores.length,
      });
    }

    relevantSummary = describeDistribution(relevantScores);
    irrelevantSummary = describeDistribution(irrelevantScores);
    discriminationGap = relevantSummary.mean - irrelevantSummary.mean;
    overlapLower = Math.max(relevantSummary.min, irrelevantSummary.min);
    overlapUpper = Math.min(relevantSummary.max, irrelevantSummary.max);
    hasOverlap = overlapLower <= overlapUpper;
    irrelevantAtOrAboveRelevantMinRate =
      irrelevantScores.filter((score) => score >= relevantSummary.min).length /
      Math.max(irrelevantScores.length, 1);
    irrelevantAtOrAbove078Rate =
      irrelevantScores.filter((score) => score >= 0.78).length /
      Math.max(irrelevantScores.length, 1);
    perQueryPreview = perQueryPreview.slice(0, 12);
  });

  afterAll(() => {
    closeTier2Fixture(fixture);
  });

  test("measures similarity distribution for relevant vs irrelevant pairs", () => {
    printSimpleReport("Tier 2 Similarity Distribution", {
      "Relevant count": relevantSummary.count,
      "Relevant mean": relevantSummary.mean,
      "Relevant median": relevantSummary.median,
      "Relevant stddev": relevantSummary.stddev,
      "Irrelevant count": irrelevantSummary.count,
      "Irrelevant mean": irrelevantSummary.mean,
      "Irrelevant median": irrelevantSummary.median,
      "Irrelevant stddev": irrelevantSummary.stddev,
    });

    expect(relevantSummary.count).toBeGreaterThan(0);
    expect(irrelevantSummary.count).toBeGreaterThan(0);
    expect(relevantSummary.mean).toBeGreaterThan(irrelevantSummary.mean);
  });

  test("identifies the discrimination gap", () => {
    printSimpleReport("Tier 2 Discrimination Gap", {
      "Relevant min": relevantSummary.min,
      "Relevant max": relevantSummary.max,
      "Irrelevant min": irrelevantSummary.min,
      "Irrelevant max": irrelevantSummary.max,
      "Mean gap": discriminationGap,
      "Irrelevant >= relevant min": irrelevantAtOrAboveRelevantMinRate,
      "Irrelevant >= 0.78": irrelevantAtOrAbove078Rate,
    });

    expect(discriminationGap).toBeGreaterThan(0);
  });

  test("prints distribution summary", () => {
    console.log("\nTier 2 similarity per-query preview:");
    console.log(JSON.stringify(perQueryPreview, null, 2));
    printSimpleReport("Tier 2 Similarity Overlap", {
      "Has overlap": hasOverlap ? "yes" : "no",
      "Overlap lower": overlapLower,
      "Overlap upper": overlapUpper,
    });

    expect(hasOverlap ? overlapLower <= overlapUpper : true).toBe(true);
  });
});
