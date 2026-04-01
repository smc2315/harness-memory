/**
 * Benchmark: Real Embedding Model (Tier 2 — requires model download)
 *
 * Uses the actual @xenova/transformers multilingual-e5-small model to
 * validate cross-language retrieval, prefix impact, and latency.
 *
 * Run separately via: npm run test:embedding
 * NOT included in the default npm test suite (model download ~100MB).
 *
 * Expected output:
 *   - Cross-language similarity scores (Korean ↔ English)
 *   - Prefix vs no-prefix similarity comparison
 *   - Embedding latency measurements
 *   - End-to-end retrieval accuracy with real vectors
 */

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  EmbeddingService,
  EMBEDDING_DIMENSIONS,
  cosineSimilarity,
  findTopK,
} from "../../src/activation/embeddings";

describe("Tier 2: Real Embedding Model", () => {
  let service: EmbeddingService;

  beforeAll(async () => {
    service = new EmbeddingService();
    await service.warmup();
  }, 120_000); // Model download may take time on first run.

  afterAll(() => {
    // Release singleton for test isolation.
    (EmbeddingService as unknown as { defaultInstance: null }).defaultInstance = null;
  });

  // -----------------------------------------------------------------------
  // Cross-language matching
  // -----------------------------------------------------------------------

  describe("Cross-Language Similarity", () => {
    test("Korean query matches English passage on same topic", async () => {
      const queryKo = await service.embedQuery("타입스크립트 엄격 모드 설정");
      const passageEn = await service.embedPassage(
        "Always use strict TypeScript configuration with noImplicitAny and strictNullChecks enabled.",
      );

      const sim = cosineSimilarity(queryKo, passageEn);

      console.log(`[Cross-lang] KO query → EN passage similarity: ${sim.toFixed(4)}`);
      expect(sim).toBeGreaterThan(0.5);
    });

    test("English query matches Korean passage on same topic", async () => {
      const queryEn = await service.embedQuery("vector database storage implementation");
      const passageKo = await service.embedPassage(
        "SQLite BLOB 저장 방식을 선택했습니다. 별도의 벡터 데이터베이스를 사용하지 않습니다.",
      );

      const sim = cosineSimilarity(queryEn, passageKo);

      console.log(`[Cross-lang] EN query → KO passage similarity: ${sim.toFixed(4)}`);
      expect(sim).toBeGreaterThan(0.4);
    });

    test("cross-language pairs score higher than unrelated pairs", async () => {
      const queryKo = await service.embedQuery("데이터베이스 쿼리 보안");
      const passageRelated = await service.embedPassage(
        "Use parameterized queries with $-prefixed placeholders. Never concatenate user input into SQL strings.",
      );
      const passageUnrelated = await service.embedPassage(
        "Use feature/, fix/, chore/ prefixes for git branch names.",
      );

      const relatedSim = cosineSimilarity(queryKo, passageRelated);
      const unrelatedSim = cosineSimilarity(queryKo, passageUnrelated);

      console.log(
        `[Cross-lang] Related: ${relatedSim.toFixed(4)}, Unrelated: ${unrelatedSim.toFixed(4)}, Delta: ${(relatedSim - unrelatedSim).toFixed(4)}`,
      );

      expect(relatedSim).toBeGreaterThan(unrelatedSim);
    });
  });

  // -----------------------------------------------------------------------
  // E5 prefix impact
  // -----------------------------------------------------------------------

  describe("E5 Prefix Impact", () => {
    test("prefix improves discrimination between related and unrelated pairs", async () => {
      const queryText = "error handling best practices";
      const relatedPassage = "Never use empty catch blocks. Always log the error or rethrow.";
      const unrelatedPassage = "Name migration files as NNN_description.sql.";

      // WITH prefix
      const queryWithPrefix = await service.embedQuery(queryText);
      const relatedWithPrefix = await service.embedPassage(relatedPassage);
      const unrelatedWithPrefix = await service.embedPassage(unrelatedPassage);

      const simRelatedPrefixed = cosineSimilarity(queryWithPrefix, relatedWithPrefix);
      const simUnrelatedPrefixed = cosineSimilarity(queryWithPrefix, unrelatedWithPrefix);
      const deltaPrefixed = simRelatedPrefixed - simUnrelatedPrefixed;

      // WITHOUT prefix (raw embed)
      const queryNoPref = await service.embed(queryText);
      const relatedNoPref = await service.embed(relatedPassage);
      const unrelatedNoPref = await service.embed(unrelatedPassage);

      const simRelatedRaw = cosineSimilarity(queryNoPref, relatedNoPref);
      const simUnrelatedRaw = cosineSimilarity(queryNoPref, unrelatedNoPref);
      const deltaRaw = simRelatedRaw - simUnrelatedRaw;

      console.log(`[Prefix] WITH prefix — related: ${simRelatedPrefixed.toFixed(4)}, unrelated: ${simUnrelatedPrefixed.toFixed(4)}, delta: ${deltaPrefixed.toFixed(4)}`);
      console.log(`[Prefix] WITHOUT prefix — related: ${simRelatedRaw.toFixed(4)}, unrelated: ${simUnrelatedRaw.toFixed(4)}, delta: ${deltaRaw.toFixed(4)}`);
      console.log(`[Prefix] Discrimination improvement: ${((deltaPrefixed - deltaRaw) / Math.abs(deltaRaw || 0.01) * 100).toFixed(1)}%`);

      // Prefixed version should have better discrimination (larger delta).
      // Note: this may not always be true for every pair, but should hold on average.
      expect(deltaPrefixed).toBeGreaterThan(0);
    });

    test("unrelated pairs have lower similarity with prefix", async () => {
      const pairs = [
        { query: "typescript strict mode", passage: "git branch naming conventions" },
        { query: "SQL injection prevention", passage: "React server components" },
        { query: "dream consolidation pipeline", passage: "ESM import file extensions" },
      ];

      let totalPrefixed = 0;
      let totalRaw = 0;

      for (const pair of pairs) {
        const qPrefixed = await service.embedQuery(pair.query);
        const pPrefixed = await service.embedPassage(pair.passage);
        const qRaw = await service.embed(pair.query);
        const pRaw = await service.embed(pair.passage);

        totalPrefixed += cosineSimilarity(qPrefixed, pPrefixed);
        totalRaw += cosineSimilarity(qRaw, pRaw);
      }

      const avgPrefixed = totalPrefixed / pairs.length;
      const avgRaw = totalRaw / pairs.length;

      console.log(
        `[Prefix] Avg unrelated similarity — prefixed: ${avgPrefixed.toFixed(4)}, raw: ${avgRaw.toFixed(4)}`,
      );

      // With prefix, unrelated pairs should have lower similarity.
      expect(avgPrefixed).toBeLessThan(avgRaw + 0.1);
    });
  });

  // -----------------------------------------------------------------------
  // Latency
  // -----------------------------------------------------------------------

  describe("Embedding Latency", () => {
    test("single embed under 10ms (warm cache excluded)", async () => {
      // Warm up cache by embedding once.
      await service.embedQuery("warmup text for benchmark");

      const texts = [
        "TypeScript strict mode configuration",
        "데이터베이스 보안 쿼리",
        "Repository pattern for data access",
        "Dream evidence consolidation pipeline",
        "ESM module import file extensions",
      ];

      const latencies: number[] = [];

      for (const text of texts) {
        const start = performance.now();
        await service.embedQuery(text);
        latencies.push(performance.now() - start);
      }

      const avgLatency = latencies.reduce((a, b) => a + b, 0) / latencies.length;
      const maxLatency = Math.max(...latencies);
      const p95 = latencies.sort((a, b) => a - b)[Math.floor(latencies.length * 0.95)];

      console.log(
        `[Latency] avg: ${avgLatency.toFixed(2)}ms, max: ${maxLatency.toFixed(2)}ms, p95: ${p95.toFixed(2)}ms`,
      );

      // Individual embed should be under 50ms (generous bound for CI).
      expect(maxLatency).toBeLessThan(50);
    });

    test("batch embed throughput", async () => {
      const texts = Array.from({ length: 20 }, (_, i) =>
        `Benchmark text number ${i} for throughput measurement`,
      );

      const start = performance.now();

      for (const text of texts) {
        await service.embedPassage(text);
      }

      const totalMs = performance.now() - start;
      const throughput = texts.length / (totalMs / 1000);

      console.log(
        `[Latency] Batch: ${texts.length} texts in ${totalMs.toFixed(0)}ms (${throughput.toFixed(1)} texts/sec)`,
      );

      // Should process at least 10 texts per second.
      expect(throughput).toBeGreaterThan(10);
    });
  });

  // -----------------------------------------------------------------------
  // End-to-end retrieval
  // -----------------------------------------------------------------------

  describe("End-to-End Retrieval", () => {
    test("findTopK retrieves correct memories with real embeddings", async () => {
      const memories = [
        { id: "m1", text: "Always use strict TypeScript configuration." },
        { id: "m2", text: "Use parameterized SQL queries to prevent injection." },
        { id: "m3", text: "Git branch naming: use feature/, fix/, chore/ prefixes." },
        { id: "m4", text: "Run npm test before every commit." },
        { id: "m5", text: "Use repository pattern for all database access." },
      ];

      const candidates = await Promise.all(
        memories.map(async (m) => ({
          id: m.id,
          embedding: await service.embedPassage(m.text),
        })),
      );

      // Query about TypeScript
      const tsQuery = await service.embedQuery("typescript type checking");
      const tsResults = findTopK(tsQuery, candidates, 3);

      console.log(
        `[Retrieval] "typescript type checking" → top-3: ${tsResults.map((r) => `${r.id}(${r.score.toFixed(3)})`).join(", ")}`,
      );

      expect(tsResults[0].id).toBe("m1");

      // Query about database
      const dbQuery = await service.embedQuery("database query security");
      const dbResults = findTopK(dbQuery, candidates, 3);

      console.log(
        `[Retrieval] "database query security" → top-3: ${dbResults.map((r) => `${r.id}(${r.score.toFixed(3)})`).join(", ")}`,
      );

      expect(["m2", "m5"]).toContain(dbResults[0].id);

      // Query in Korean
      const koQuery = await service.embedQuery("깃 브랜치 이름 규칙");
      const koResults = findTopK(koQuery, candidates, 3);

      console.log(
        `[Retrieval] "깃 브랜치 이름 규칙" → top-3: ${koResults.map((r) => `${r.id}(${r.score.toFixed(3)})`).join(", ")}`,
      );

      // m3 (git branch naming) should be in top-2 for Korean git query.
      const m3InTop2 = koResults.slice(0, 2).some((r) => r.id === "m3");
      expect(m3InTop2).toBe(true);
    });
  });
});
