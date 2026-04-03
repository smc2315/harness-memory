import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { TIER2_GROUND_TRUTH } from "./fixtures/tier2.ground-truth";
import { TIER2_MEMORIES } from "./fixtures/tier2.memories";
import { TIER2_QUERIES } from "./fixtures/tier2.queries";
import type {
  ProjectDomain,
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
import { runAllTier2Queries, type Tier2QueryRunResult } from "./helpers/query-runner";
import { printSimpleReport } from "./helpers/reporting";
import { wilsonInterval } from "./helpers/statistics";

const SCOPED_QUERIES = TIER2_QUERIES.filter((query) => query.category === "scoped");
const LABELS_BY_QUERY_ID = new Map<string, Tier2GroundTruthLabel>(
  TIER2_GROUND_TRUTH.map((label) => [label.queryId, label]),
);
const MEMORIES_BY_ID = new Map<string, Tier2MemoryFixture>(
  TIER2_MEMORIES.map((memory) => [memory.id, memory]),
);

interface ScopedSummary {
  queryId: string;
  targetDomain: ProjectDomain;
  activatedFixtureIds: string[];
  activatedDomains: ProjectDomain[];
  correctCount: number;
  totalCount: number;
  forbiddenHits: string[];
}

function summarizeScopedRun(
  query: Tier2QueryFixture,
  run: Tier2QueryRunResult,
): ScopedSummary {
  if (query.targetDomain === null) {
    throw new Error(`Expected scoped query target domain for ${query.id}`);
  }

  const label = LABELS_BY_QUERY_ID.get(query.id);
  if (label === undefined) {
    throw new Error(`Missing label for ${query.id}`);
  }

  const activatedDomains = run.activatedFixtureIds.map((memoryId) => {
    const memory = MEMORIES_BY_ID.get(memoryId);

    if (memory === undefined) {
      throw new Error(`Missing memory fixture ${memoryId}`);
    }

    return memory.domain;
  });
  const forbiddenHits = run.activatedFixtureIds.filter((memoryId) =>
    label.forbiddenMemoryIds.includes(memoryId),
  );

  return {
    queryId: query.id,
    targetDomain: query.targetDomain,
    activatedFixtureIds: run.activatedFixtureIds,
    activatedDomains,
    correctCount: activatedDomains.filter((domain) => domain === query.targetDomain).length,
    totalCount: activatedDomains.length,
    forbiddenHits,
  };
}

describe("Tier 2: Scope Discrimination", () => {
  let fixture: Tier2SeededFixture;
  let summaries: ScopedSummary[];

  beforeAll(async () => {
    const runtime = await createTier2EmbeddingRuntime();
    fixture = await createTier2SeededFixture(runtime, TIER2_MEMORIES);
    const runs = await runAllTier2Queries(fixture, SCOPED_QUERIES);
    const runsByQueryId = new Map(runs.map((run) => [run.queryId, run]));

    summaries = SCOPED_QUERIES.map((query) => {
      const run = runsByQueryId.get(query.id);

      if (run === undefined) {
        throw new Error(`Missing run for ${query.id}`);
      }

      return summarizeScopedRun(query, run);
    });
  });

  afterAll(() => {
    closeTier2Fixture(fixture);
  });

  test("scoped web-app queries do not retrieve cli-tool memories", () => {
    const webSummaries = summaries.filter((summary) => summary.targetDomain === "web-app");
    const targetCount = webSummaries.reduce(
      (sum, summary) =>
        sum + summary.activatedDomains.filter((domain) => domain === "web-app").length,
      0,
    );
    const contrastedCount = webSummaries.reduce(
      (sum, summary) =>
        sum + summary.activatedDomains.filter((domain) => domain === "cli-tool").length,
      0,
    );
    const forbiddenLeakCount = webSummaries.reduce(
      (sum, summary) => sum + summary.forbiddenHits.length,
      0,
    );

    console.log("\nTier 2 scoped web-app results:");
    console.log(JSON.stringify(webSummaries, null, 2));
    printSimpleReport("Tier 2 Web Scope Discrimination", {
      Queries: webSummaries.length,
      "Web-app activations": targetCount,
      "Cli-tool activations": contrastedCount,
      "Forbidden hits": forbiddenLeakCount,
    });

    expect(targetCount).toBeGreaterThan(contrastedCount);
    expect(forbiddenLeakCount).toBe(0);
  });

  test("scoped cli-tool queries do not retrieve web-app memories", () => {
    const cliSummaries = summaries.filter((summary) => summary.targetDomain === "cli-tool");
    const targetCount = cliSummaries.reduce(
      (sum, summary) =>
        sum + summary.activatedDomains.filter((domain) => domain === "cli-tool").length,
      0,
    );
    const contrastedCount = cliSummaries.reduce(
      (sum, summary) =>
        sum + summary.activatedDomains.filter((domain) => domain === "web-app").length,
      0,
    );
    const forbiddenLeakCount = cliSummaries.reduce(
      (sum, summary) => sum + summary.forbiddenHits.length,
      0,
    );

    console.log("\nTier 2 scoped cli-tool results:");
    console.log(JSON.stringify(cliSummaries, null, 2));
    printSimpleReport("Tier 2 CLI Scope Discrimination", {
      Queries: cliSummaries.length,
      "Cli-tool activations": targetCount,
      "Web-app activations": contrastedCount,
      "Forbidden hits": forbiddenLeakCount,
    });

    expect(targetCount).toBeGreaterThanOrEqual(contrastedCount);
    expect(forbiddenLeakCount).toBe(0);
  });

  test("reports domain purity rate", () => {
    const correctCount = summaries.reduce((sum, summary) => sum + summary.correctCount, 0);
    const totalCount = summaries.reduce((sum, summary) => sum + summary.totalCount, 0);
    const forbiddenTotal = summaries.reduce((sum, summary) => sum + summary.forbiddenHits.length, 0);
    const purity = totalCount > 0 ? correctCount / totalCount : 0;
    const purityInterval = wilsonInterval(correctCount, totalCount);

    printSimpleReport("Tier 2 Domain Purity", {
      "Activated memories": totalCount,
      "Correct-domain memories": correctCount,
      "Domain purity": purity,
      "Purity lower": purityInterval.lower,
      "Purity upper": purityInterval.upper,
      "Forbidden hits": forbiddenTotal,
    });

    expect(purity).toBeGreaterThan(0.5);
  });
});
