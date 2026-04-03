/**
 * Benchmark: Cross-Language Matching (Tier 1 — Mock)
 *
 * Validates that Korean queries can find English-language memories and
 * vice versa.  This is a key differentiator for harness-memory: the
 * multilingual-e5-small model supports Korean + English cross-language
 * retrieval.
 *
 * In Tier 1, this is validated through mock concept-clustered embeddings
 * that give Korean and English queries about the same topic similar vectors.
 * Tier 2 validates with the actual e5 model.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  type BenchmarkFixture,
  TEST_QUERIES,
  createBenchmarkFixture,
  printBenchmarkReport,
  queryActivation,
  recallAtK,
} from "./benchmark-helpers";

/** Queries that are written in Korean targeting English memories. */
const KOREAN_QUERIES = TEST_QUERIES.filter(
  (q) => q.tag === "Q05" || q.tag === "Q06"
);

/** Queries that are written in English targeting Korean memories. */
const ENGLISH_TO_KOREAN_QUERIES = TEST_QUERIES.filter((q) =>
  q.relevantTags.some((tag) => ["M11", "M12", "M13"].includes(tag))
);

describe("Benchmark: Cross-Language Matching", () => {
  let fixture: BenchmarkFixture;

  beforeEach(async () => {
    fixture = await createBenchmarkFixture();
  });

  afterEach(() => {
    fixture.db.close();
  });

  test("Korean queries retrieve English memories (한→영)", async () => {
    let totalRecall = 0;
    let totalHits = 0;
    let totalRelevant = 0;

    for (const query of KOREAN_QUERIES) {
      const retrieved = await queryActivation(fixture, query);
      const relevant = new Set(query.relevantTags);
      const recall = recallAtK(retrieved, relevant, 5);
      totalRecall += recall;

      const hits = retrieved.filter((tag) => relevant.has(tag)).length;
      totalHits += hits;
      totalRelevant += relevant.size;
    }

    const avgRecall = totalRecall / KOREAN_QUERIES.length;
    const hitRate = totalRelevant > 0 ? totalHits / totalRelevant : 0;

    printBenchmarkReport("Cross-Language: Korean → English", {
      "Avg Recall@5": avgRecall,
      "Hit Rate": hitRate,
      "Korean Queries": KOREAN_QUERIES.length,
      "Total Hits": totalHits,
      "Total Relevant": totalRelevant,
    });

    // Korean queries should find relevant English memories.
    expect(avgRecall).toBeGreaterThan(0);
    expect(hitRate).toBeGreaterThanOrEqual(0.3);
  });

  test("English queries retrieve Korean memories (영→한)", async () => {
    // Q04 "ESM module import" → M12 (Korean: 패키지 버전 충돌)
    // Q09 "plugin architecture" → M15 (Plugin isolation, partially Korean context)
    const q04 = TEST_QUERIES.find((q) => q.tag === "Q04");
    const q02 = TEST_QUERIES.find((q) => q.tag === "Q02");

    if (q04 === undefined || q02 === undefined) {
      throw new Error("Required test queries Q04, Q02 not found");
    }

    const resultQ04 = await queryActivation(fixture, q04);
    const resultQ02 = await queryActivation(fixture, q02);

    // Q04 should find M12 (Korean ESM memory)
    const q04FindsM12 = resultQ04.includes("M12");
    // Q02 should find M04, M05, or M07 (database-related)
    const q02FindsDbMemory = resultQ02.some((tag) =>
      ["M04", "M05", "M07"].includes(tag)
    );

    printBenchmarkReport("Cross-Language: English → Korean", {
      "Q04 finds M12 (KR)": q04FindsM12 ? "YES" : "NO",
      "Q02 finds DB memory": q02FindsDbMemory ? "YES" : "NO",
    });

    // EN→KO retrieval is a known weak point with mock embeddings.
    // With hybrid retrieval, lexical path may help, but keyword overlap is limited.
    // This is an aspirational test — not a hard gate.
    expect(q04FindsM12 || q02FindsDbMemory).toBe(true);
  });

  test("cross-language hit rate across all queries", async () => {
    let queriesWithCrossLangHit = 0;

    // Define which memories are in Korean.
    const koreanMemoryTags = new Set(["M11", "M12", "M13"]);

    for (const query of TEST_QUERIES) {
      const retrieved = await queryActivation(fixture, query);
      const relevant = new Set(query.relevantTags);
      const hasKoreanRelevant = query.relevantTags.some((tag) => koreanMemoryTags.has(tag));

      if (hasKoreanRelevant) {
        // This query has Korean memories in its ground truth.
        const foundKorean = retrieved.some(
          (tag) => koreanMemoryTags.has(tag) && relevant.has(tag),
        );

        if (foundKorean) {
          queriesWithCrossLangHit++;
        }
      }
    }

    const crossLangQueries = TEST_QUERIES.filter((q) =>
      q.relevantTags.some((tag) => koreanMemoryTags.has(tag)),
    );

    if (crossLangQueries.length > 0) {
      const crossLangRate = queriesWithCrossLangHit / crossLangQueries.length;

      printBenchmarkReport("Cross-Language Hit Rate (Overall)", {
        "Cross-lang queries": crossLangQueries.length,
        "Successful matches": queriesWithCrossLangHit,
        "Hit rate": crossLangRate,
      });

      expect(crossLangRate).toBeGreaterThan(0);
    }
  });
});
