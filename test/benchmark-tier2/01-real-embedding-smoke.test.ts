import { beforeAll, describe, expect, test } from "vitest";

import {
  EMBEDDING_DIMENSIONS,
  cosineSimilarity,
} from "../../src/activation/embeddings";
import { TIER2_MEMORIES } from "./fixtures/tier2.memories";
import { TIER2_QUERIES } from "./fixtures/tier2.queries";
import { createTier2EmbeddingRuntime, type Tier2EmbeddingRuntime } from "./helpers/embedding-runtime";
import { printSimpleReport } from "./helpers/reporting";

describe("Tier 2: Real Embedding Smoke", () => {
  let runtime: Tier2EmbeddingRuntime;

  beforeAll(async () => {
    runtime = await createTier2EmbeddingRuntime();
  });

  test("warms multilingual-e5-small successfully", () => {
    printSimpleReport("Tier 2 Embedding Warmup", {
      "Model ready": runtime.service.isReady ? "yes" : "no",
      "Warmup ms": runtime.warmupMs,
    });

    expect(runtime.service.isReady).toBe(true);
    expect(runtime.warmupMs).toBeGreaterThanOrEqual(0);
  });

  test("embeds passages and queries at 384 dimensions", async () => {
    const passageEmbedding = await runtime.service.embedPassage(
      "TypeScript strict mode keeps implicit any out of the codebase.",
    );
    const queryEmbedding = await runtime.service.embedQuery(
      "How should I configure strict type checking?",
    );

    printSimpleReport("Tier 2 Embedding Dimensions", {
      "Expected dims": EMBEDDING_DIMENSIONS,
      "Passage dims": passageEmbedding.length,
      "Query dims": queryEmbedding.length,
    });

    expect(passageEmbedding.length).toBe(EMBEDDING_DIMENSIONS);
    expect(queryEmbedding.length).toBe(EMBEDDING_DIMENSIONS);
    expect([...passageEmbedding].every(Number.isFinite)).toBe(true);
    expect([...queryEmbedding].every(Number.isFinite)).toBe(true);
  });

  test("related pairs score higher than unrelated pairs", async () => {
    const queryEmbedding = await runtime.service.embedQuery("strict type checking");
    const relatedEmbedding = await runtime.service.embedPassage(
      "TypeScript strict mode enables strong compile-time checks.",
    );
    const unrelatedEmbedding = await runtime.service.embedPassage(
      "Database migration files must run before production deploys.",
    );
    const relatedScore = cosineSimilarity(queryEmbedding, relatedEmbedding);
    const unrelatedScore = cosineSimilarity(queryEmbedding, unrelatedEmbedding);

    printSimpleReport("Tier 2 Similarity Smoke", {
      "Related score": relatedScore,
      "Unrelated score": unrelatedScore,
      Gap: relatedScore - unrelatedScore,
    });

    expect(relatedScore).toBeGreaterThan(unrelatedScore);
  });

  test("Korean and English queries produce valid embeddings", async () => {
    const koreanQuery = TIER2_QUERIES.find((query) => query.id === "q-cross-language-01");
    const englishQuery = TIER2_QUERIES.find((query) => query.id === "q-first-turn-01");

    if (koreanQuery === undefined || englishQuery === undefined) {
      throw new Error("Expected Tier 2 smoke queries were not found");
    }

    const koreanEmbedding = await runtime.service.embedQuery(koreanQuery.text);
    const englishEmbedding = await runtime.service.embedQuery(englishQuery.text);
    const crossSimilarity = cosineSimilarity(koreanEmbedding, englishEmbedding);

    printSimpleReport("Tier 2 Multilingual Query Smoke", {
      "Korean dims": koreanEmbedding.length,
      "English dims": englishEmbedding.length,
      "Cross similarity": crossSimilarity,
    });

    expect(koreanEmbedding.length).toBe(EMBEDDING_DIMENSIONS);
    expect(englishEmbedding.length).toBe(EMBEDDING_DIMENSIONS);
    expect(Number.isFinite(crossSimilarity)).toBe(true);
  });

  test("prints similarity distribution sample", async () => {
    const sampleQueries = TIER2_QUERIES.filter((query) =>
      ["q-first-turn-01", "q-cross-language-01", "q-first-turn-09"].includes(query.id),
    );
    const sampleMemories = TIER2_MEMORIES.filter((memory) =>
      ["web-app-01", "cli-tool-01", "ai-ml-16"].includes(memory.id),
    );
    const rows: Array<Record<string, string | number>> = [];

    for (const query of sampleQueries) {
      const queryEmbedding = await runtime.service.embedQuery(query.text);
      const scores: Record<string, string | number> = {
        queryId: query.id,
      };

      for (const memory of sampleMemories) {
        const memoryEmbedding = await runtime.service.embedPassage(
          `${memory.summary} ${memory.details}`,
        );
        scores[memory.id] = cosineSimilarity(queryEmbedding, memoryEmbedding);
      }

      rows.push(scores);
    }

    console.log("\nTier 2 similarity sample:");
    console.log(JSON.stringify(rows, null, 2));

    expect(rows).toHaveLength(sampleQueries.length);
  });
});
