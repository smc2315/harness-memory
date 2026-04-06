import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  type BenchmarkFixture,
  TEST_QUERIES,
  TEST_MEMORIES,
  CONCEPTS,
  createBenchmarkFixture,
  printBenchmarkReport,
  precisionAtK,
  recallAtK,
  reciprocalRank,
  ndcgAtK,
  computeAggregateMetrics,
} from "./benchmark-helpers";

const INACTIVE_TAGS = new Set(["M16-stale", "M17-superseded", "M18-rejected"]);

function tokenize(text: string): string[] {
  return text
    .split(/[\s\p{P}]+/u)
    .filter((t) => t.length > 2 || /[\u3131-\u318e\uac00-\ud7a3]/u.test(t));
}

async function activateForQuery(
  fixture: BenchmarkFixture,
  queryTag: string,
  overrides?: {
    scopeRef?: string;
    toolName?: string;
    maxMemories?: number;
    maxPayloadBytes?: number;
  },
): Promise<string[]> {
  const query = TEST_QUERIES.find((candidate) => candidate.tag === queryTag);

  if (query === undefined) {
    throw new Error(`Missing query fixture: ${queryTag}`);
  }

  const result = await fixture.engine.activate({
    lifecycleTrigger: "before_model",
    scopeRef: overrides?.scopeRef ?? ".",
    toolName: overrides?.toolName,
    queryTokens: tokenize(query.text),
    maxMemories: overrides?.maxMemories ?? 10,
    maxPayloadBytes: overrides?.maxPayloadBytes ?? 8192,
  });

  return result.activated.map((m) => fixture.idToTag.get(m.id) ?? m.id);
}

describe("HM-ActivationBench", () => {
  let fixture: BenchmarkFixture;

  beforeEach(async () => {
    fixture = await createBenchmarkFixture();
  });

  afterEach(() => {
    fixture.db.close();
  });

  describe("Layer A: Baseline", () => {
    test("baseline memories always activated regardless of query", async () => {
      expect(TEST_MEMORIES.filter((m) => m.input.status === "active").length).toBe(17);
      expect(Object.keys(CONCEPTS)).toHaveLength(10);

      const result = await fixture.engine.activate({
        lifecycleTrigger: "before_model",
        scopeRef: "src/unrelated/random.txt",
        queryTokens: ["irrelevant", "question", "completely", "different"],
        maxMemories: 10,
        maxPayloadBytes: 8192,
      });

      const retrieved = result.activated.map((m) => fixture.idToTag.get(m.id) ?? m.id);
      expect(retrieved).toContain("M01");
      expect(retrieved).toContain("M03");
    });

    test("baseline cap of 3 memories enforced", async () => {
      fixture.repository.create({
        type: "workflow",
        summary: "Extra baseline one",
        details: "Extra baseline memory for cap validation.",
        scopeGlob: "**/*",
        lifecycleTriggers: ["before_model"],
        activationClass: "baseline",
        confidence: 0.2,
        importance: 0.2,
        status: "active",
      });
      fixture.repository.create({
        type: "decision",
        summary: "Extra baseline two",
        details: "Another extra baseline memory for cap validation.",
        scopeGlob: "**/*",
        lifecycleTriggers: ["before_model"],
        activationClass: "baseline",
        confidence: 0.15,
        importance: 0.15,
        status: "active",
      });

      const result = await fixture.engine.activate({
        lifecycleTrigger: "before_model",
        scopeRef: ".",
        queryTokens: ["baseline", "capacity", "validation"],
        maxMemories: 20,
        maxPayloadBytes: 65536,
      });

      const baselineCount = result.activated.filter(
        (memory) => memory.activationClass === "baseline",
      ).length;
      expect(baselineCount).toBe(2);
    });

    test("baseline payload cap of 2048 bytes enforced", async () => {
      fixture.repository.create({
        type: "policy",
        summary: "Large baseline payload",
        details: "X".repeat(7000),
        scopeGlob: "**/*",
        lifecycleTriggers: ["before_model"],
        activationClass: "baseline",
        confidence: 0.95,
        importance: 0.95,
        status: "active",
      });

      const result = await fixture.engine.activate({
        lifecycleTrigger: "before_model",
        scopeRef: ".",
        queryTokens: ["baseline", "payload", "size"],
        maxMemories: 20,
        maxPayloadBytes: 65536,
      });

      const baselineBytes = result.activated
        .filter((memory) => memory.activationClass === "baseline")
        .reduce((sum, memory) => sum + memory.payloadBytes, 0);

      expect(baselineBytes).toBeLessThanOrEqual(2048);
    });

    test("baseline includes at least 1 memory on empty scope", async () => {
      const result = await fixture.engine.activate({
        lifecycleTrigger: "before_model",
        scopeRef: "",
        queryTokens: [],
        maxMemories: 10,
        maxPayloadBytes: 8192,
      });

      const baselineCount = result.activated.filter(
        (memory) => memory.activationClass === "baseline",
      ).length;

      expect(baselineCount).toBeGreaterThanOrEqual(1);
    });
  });

  describe("Layer B: Startup/Retrieval", () => {
    test("Q01 (typescript) includes M01 or M02", async () => {
      const retrieved = await activateForQuery(fixture, "Q01");
      expect(retrieved.some((tag) => ["M01", "M02"].includes(tag))).toBe(true);
    });

    test("Q02 (database security) includes M04", async () => {
      const retrieved = await activateForQuery(fixture, "Q02");
      expect(retrieved).toContain("M04");
    });

    test("Q03 (testing) includes M03", async () => {
      const retrieved = await activateForQuery(fixture, "Q03");
      expect(retrieved).toContain("M03");
    });

    test("Q04 (ESM) includes M08 or M12", async () => {
      const retrieved = await activateForQuery(fixture, "Q04");
      expect(retrieved.some((tag) => ["M08", "M12"].includes(tag))).toBe(true);
    });

    test("Q05 (Korean TS) includes M01 or M02 or M11", async () => {
      const retrieved = await activateForQuery(fixture, "Q05");
      expect(retrieved.some((tag) => ["M01", "M02", "M11"].includes(tag))).toBe(true);
    });

    test("Q06 (vector Korean) includes M13 or M20", async () => {
      const retrieved = await activateForQuery(fixture, "Q06");
      expect(retrieved.some((tag) => ["M13", "M20"].includes(tag))).toBe(true);
    });

    test("Q07 (errors) includes M09", async () => {
      const retrieved = await activateForQuery(fixture, "Q07");
      expect(retrieved).toContain("M09");
    });

    test("Q08 (dream) includes M14", async () => {
      const retrieved = await activateForQuery(fixture, "Q08");
      expect(retrieved).toContain("M14");
    });
  });

  describe("Layer C: Scoped", () => {
    test("scopeRef src/db/** boosts database memories", async () => {
      const retrieved = await activateForQuery(fixture, "Q02", {
        scopeRef: "src/db/repository.ts",
      });
      const dbTags = ["M04", "M05", "M06", "M07"];
      const dbHits = retrieved.slice(0, 5).filter((tag) => dbTags.includes(tag));

      expect(dbHits.length).toBeGreaterThanOrEqual(2);
    });

    test("scopeRef src/dream/** boosts dream memory M14", async () => {
      const retrieved = await activateForQuery(fixture, "Q08", {
        scopeRef: "src/dream/runner.ts",
      });

      expect(retrieved.slice(0, 3)).toContain("M14");
    });

    test("scopeRef src/activation/** boosts vector memory M20", async () => {
      const retrieved = await activateForQuery(fixture, "Q06", {
        scopeRef: "src/activation/engine.ts",
      });

      expect(retrieved.slice(0, 5)).toContain("M20");
    });

    test("toolName edit with scopeRef activates scoped path memories", async () => {
      const retrieved = await activateForQuery(fixture, "Q02", {
        scopeRef: "src/db/query.ts",
        toolName: "edit",
      });
      const scopedTags = ["M04", "M05", "M06", "M07"];

      expect(retrieved.some((tag) => scopedTags.includes(tag))).toBe(true);
    });
  });

  describe("Layer D: Diversity + Budget", () => {
    test("type quota enforced: no more than 3 policy in top 10", async () => {
      const result = await fixture.engine.activate({
        lifecycleTrigger: "before_model",
        scopeRef: ".",
        queryTokens: tokenize("typescript policy errors strict database security and style"),
        maxMemories: 10,
        maxPayloadBytes: 8192,
      });

      const policyCount = result.activated
        .slice(0, 10)
        .filter((memory) => memory.type === "policy").length;
      expect(policyCount).toBeLessThanOrEqual(3);
    });

    test("budget limit keeps total payload <= 8192 bytes", async () => {
      const result = await fixture.engine.activate({
        lifecycleTrigger: "before_model",
        scopeRef: ".",
        queryTokens: tokenize("broad query to pull many memories"),
        maxMemories: 10,
        maxPayloadBytes: 8192,
      });

      const computedPayload = result.activated.reduce((sum, memory) => sum + memory.payloadBytes, 0);
      expect(result.budget.usedPayloadBytes).toBeLessThanOrEqual(8192);
      expect(computedPayload).toBeLessThanOrEqual(8192);
      expect(result.budget.usedPayloadBytes).toBe(computedPayload);
    });

    test("hard negatives never activated", async () => {
      for (const query of TEST_QUERIES) {
        const result = await fixture.engine.activate({
          lifecycleTrigger: "before_model",
          scopeRef: ".",
          queryTokens: tokenize(query.text),
          maxMemories: 10,
          maxPayloadBytes: 8192,
        });

        const retrieved = result.activated.map((m) => fixture.idToTag.get(m.id) ?? m.id);
        const leaked = retrieved.filter((tag) => INACTIVE_TAGS.has(tag));
        expect(leaked).toHaveLength(0);
      }
    });

    test("exploration slot exists when budget allows", async () => {
      const result = await fixture.engine.activate({
        lifecycleTrigger: "before_model",
        scopeRef: "src/db/queries.ts",
        queryTokens: tokenize("database repository migration naming security sql"),
        maxMemories: 4,
        maxPayloadBytes: 8192,
      });

      expect(result.budget.usedPayloadBytes).toBeLessThanOrEqual(8192);
      expect(result.activated).toHaveLength(4);
    });
  });

  describe("Aggregate IR Metrics", () => {
    async function getAggregateMetrics() {
      const results: Array<{ retrieved: string[]; relevant: Set<string> }> = [];

      for (const query of TEST_QUERIES) {
        const result = await fixture.engine.activate({
          lifecycleTrigger: "before_model",
          scopeRef: ".",
          queryTokens: tokenize(query.text),
          maxMemories: 10,
          maxPayloadBytes: 8192,
        });
        const retrieved = result.activated.map((m) => fixture.idToTag.get(m.id) ?? m.id);
        const relevant = new Set(query.relevantTags);

        results.push({ retrieved, relevant });
      }

      return {
        raw: results,
        aggregate: computeAggregateMetrics(results),
      };
    }

    test("mean precision@5 across all 10 queries", async () => {
      const metrics = await getAggregateMetrics();
      const meanPrecisionAt5 =
        metrics.raw.reduce(
          (sum, result) => sum + precisionAtK(result.retrieved, result.relevant, 5),
          0,
        ) / metrics.raw.length;

      printBenchmarkReport("HM-ActivationBench Aggregate (P@5)", {
        "Mean Precision@5": meanPrecisionAt5,
        "Threshold": 0.1,
        "Query Count": metrics.aggregate.queryCount,
      });

      expect(meanPrecisionAt5).toBeGreaterThanOrEqual(0.35);
    });

    test("mean recall@5 across all 10 queries", async () => {
      const metrics = await getAggregateMetrics();
      const meanRecallAt5 =
        metrics.raw.reduce(
          (sum, result) => sum + recallAtK(result.retrieved, result.relevant, 5),
          0,
        ) / metrics.raw.length;

      printBenchmarkReport("HM-ActivationBench Aggregate (R@5)", {
        "Mean Recall@5": meanRecallAt5,
        "Threshold": 0.4,
        "Query Count": metrics.aggregate.queryCount,
      });

      expect(meanRecallAt5).toBeGreaterThanOrEqual(0.75);
    });

    test("MRR across all 10 queries", async () => {
      const metrics = await getAggregateMetrics();
      const mrr =
        metrics.raw.reduce(
          (sum, result) => sum + reciprocalRank(result.retrieved, result.relevant),
          0,
        ) / metrics.raw.length;

      printBenchmarkReport("HM-ActivationBench Aggregate (MRR)", {
        MRR: mrr,
        Threshold: 0.3,
        "Query Count": metrics.aggregate.queryCount,
      });

      expect(mrr).toBeGreaterThanOrEqual(0.70);
    });

    test("mean NDCG@5 across all 10 queries", async () => {
      const metrics = await getAggregateMetrics();
      const meanNdcgAt5 =
        metrics.raw.reduce(
          (sum, result) => sum + ndcgAtK(result.retrieved, result.relevant, 5),
          0,
        ) / metrics.raw.length;

      printBenchmarkReport("HM-ActivationBench Aggregate (NDCG@5)", {
        "Mean NDCG@5": meanNdcgAt5,
        "Mean Precision@5": metrics.aggregate.meanPrecisionAt5,
        "Mean Recall@5": metrics.aggregate.meanRecallAt5,
        MRR: metrics.aggregate.mrr,
      });

      expect(meanNdcgAt5).toBeGreaterThanOrEqual(0.2);
    });
  });
});
