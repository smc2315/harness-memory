import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  type BenchmarkFixture,
  TEST_MEMORIES as MEMORIES,
  TEST_QUERIES as QUERIES,
  createBenchmarkFixture,
  queryActivation,
} from "./benchmark-helpers";

/**
 * Canary benchmark: 10 fixed query→memory pairs.
 *
 * Purpose: Detect retrieval quality regressions immediately.
 * Any change to activation/retrieval/scoring that drops MRR by >10%
 * from baseline will fail this test.
 */

interface CanaryPair {
  queryTag: string;
  expectedMemoryTag: string;
  description: string;
}

interface CanaryResult {
  queryTag: string;
  expectedMemoryTag: string;
  description: string;
  rank: number | null;
  rr: number;
}

// 10 fixed pairs covering lexical hits, semantic similarity, mixed concepts,
// Korean/English query variants, and scoped/broad retrieval behavior.
const CANARY_PAIRS: CanaryPair[] = [
  { queryTag: "Q01", expectedMemoryTag: "M01", description: "strict TS config policy" },
  { queryTag: "Q01", expectedMemoryTag: "M02", description: "no-any TS rule" },
  { queryTag: "Q02", expectedMemoryTag: "M01", description: "DB security query still surfaces baseline TS" },
  { queryTag: "Q03", expectedMemoryTag: "M03", description: "tests before commit workflow" },
  { queryTag: "Q04", expectedMemoryTag: "M08", description: "ESM import extension pitfall" },
  { queryTag: "Q05", expectedMemoryTag: "M02", description: "Korean TS query retrieves no-any policy" },
  { queryTag: "Q06", expectedMemoryTag: "M20", description: "vector retrieval budget constraint" },
  { queryTag: "Q06", expectedMemoryTag: "M13", description: "vector DB decision memory" },
  { queryTag: "Q07", expectedMemoryTag: "M09", description: "error handling policy" },
  { queryTag: "Q10", expectedMemoryTag: "M10", description: "git branch naming workflow" },
];

const BASELINE_MRR = 0.3953968254;
const REGRESSION_TOLERANCE = 0.9;

function printCanaryTable(results: CanaryResult[], currentMRR: number): void {
  const title = "Canary Pair Results";
  const rows = results.map((result, index) => ({
    pair: `${String(index + 1).padStart(2, "0")}`,
    query: result.queryTag,
    expected: result.expectedMemoryTag,
    rank: result.rank === null ? "-" : String(result.rank),
    rr: result.rr.toFixed(4),
    note: result.description,
  }));

  const widths = {
    pair: Math.max("Pair".length, ...rows.map((r) => r.pair.length)),
    query: Math.max("Query".length, ...rows.map((r) => r.query.length)),
    expected: Math.max("Expected".length, ...rows.map((r) => r.expected.length)),
    rank: Math.max("Rank".length, ...rows.map((r) => r.rank.length)),
    rr: Math.max("RR".length, ...rows.map((r) => r.rr.length)),
    note: Math.max("Description".length, ...rows.map((r) => r.note.length)),
  };

  const header = [
    "Pair".padEnd(widths.pair),
    "Query".padEnd(widths.query),
    "Expected".padEnd(widths.expected),
    "Rank".padEnd(widths.rank),
    "RR".padEnd(widths.rr),
    "Description".padEnd(widths.note),
  ].join(" | ");

  const divider = "-".repeat(header.length);
  console.log(`\n${title}`);
  console.log(header);
  console.log(divider);

  for (const row of rows) {
    console.log(
      [
        row.pair.padEnd(widths.pair),
        row.query.padEnd(widths.query),
        row.expected.padEnd(widths.expected),
        row.rank.padEnd(widths.rank),
        row.rr.padEnd(widths.rr),
        row.note.padEnd(widths.note),
      ].join(" | "),
    );
  }

  console.log(divider);
  console.log(`MRR: ${currentMRR.toFixed(4)}`);
  console.log(`Baseline MRR: ${BASELINE_MRR.toFixed(4)}`);
  console.log(`Threshold (baseline * ${REGRESSION_TOLERANCE}): ${(BASELINE_MRR * REGRESSION_TOLERANCE).toFixed(4)}\n`);
}

async function runCanaryBenchmark(fixture: BenchmarkFixture): Promise<{
  results: CanaryResult[];
  currentMRR: number;
}> {
  let totalRR = 0;
  const results: CanaryResult[] = [];

  for (const pair of CANARY_PAIRS) {
    const query = QUERIES.find((item) => item.tag === pair.queryTag);

    if (query === undefined) {
      throw new Error(`Query ${pair.queryTag} was not found in QUERIES`);
    }

    const expectedMemory = MEMORIES.find((item) => item.tag === pair.expectedMemoryTag);

    if (expectedMemory === undefined) {
      throw new Error(`Memory ${pair.expectedMemoryTag} was not found in MEMORIES`);
    }

    const activated = await queryActivation(fixture, query);
    const rankIndex = activated.findIndex((tag) => tag === expectedMemory.tag);
    const rank = rankIndex === -1 ? null : rankIndex + 1;
    const rr = rank === null ? 0 : 1 / rank;

    totalRR += rr;
    results.push({
      queryTag: pair.queryTag,
      expectedMemoryTag: pair.expectedMemoryTag,
      description: pair.description,
      rank,
      rr,
    });
  }

  return {
    results,
    currentMRR: totalRR / CANARY_PAIRS.length,
  };
}

describe("Benchmark: Canary Set", () => {
  let fixture: BenchmarkFixture;

  beforeAll(async () => {
    fixture = await createBenchmarkFixture();
  });

  afterAll(() => {
    fixture.db.close();
  });

  test("canary MRR does not regress from baseline", async () => {
    const { results, currentMRR } = await runCanaryBenchmark(fixture);

    printCanaryTable(results, currentMRR);

    expect(currentMRR).toBeGreaterThanOrEqual(BASELINE_MRR * REGRESSION_TOLERANCE);
  });

  test("prints individual canary pair results", async () => {
    const { results, currentMRR } = await runCanaryBenchmark(fixture);
    const missing = results.filter((result) => result.rank === null);

    console.log("\nCanary Debug Breakdown");
    for (const result of results) {
      console.log(
        `${result.queryTag} -> ${result.expectedMemoryTag}: rank=${result.rank === null ? "-" : result.rank}, rr=${result.rr.toFixed(4)} (${result.description})`,
      );
    }
    console.log(`Current canary MRR: ${currentMRR.toFixed(6)}\n`);

    expect(results).toHaveLength(CANARY_PAIRS.length);
    expect(missing).toHaveLength(0);
  });
});
