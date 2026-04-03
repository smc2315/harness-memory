import { describe, test, expect } from "vitest";
import { TIER2_MEMORIES } from "./fixtures/tier2.memories";
import { TIER2_QUERIES } from "./fixtures/tier2.queries";
import { TIER2_GROUND_TRUTH } from "./fixtures/tier2.ground-truth";
import { TIER2_MINIMUMS } from "./fixtures/tier2.types";
import { validateDataset } from "./helpers/dataset-validation";

describe("Tier 2 Dataset Integrity", () => {
  const result = validateDataset(TIER2_MEMORIES, TIER2_QUERIES, TIER2_GROUND_TRUTH);

  test("dataset validation passes without errors", () => {
    if (result.errors.length > 0) {
      console.error("Validation errors:", result.errors);
    }
    expect(result.valid).toBe(true);
  });

  test("has required memory count", () => {
    expect(result.stats.totalMemories).toBeGreaterThanOrEqual(
      TIER2_MINIMUMS.totalMemories,
    );
  });

  test("has required memories per domain", () => {
    for (const domain of ["web-app", "cli-tool", "ai-ml"] as const) {
      expect(result.stats.memoriesByDomain[domain]).toBeGreaterThanOrEqual(
        TIER2_MINIMUMS.memoriesPerDomain,
      );
    }
  });

  test("has required Korean memories", () => {
    expect(result.stats.koreanMemories).toBeGreaterThanOrEqual(
      TIER2_MINIMUMS.koreanMemories,
    );
  });

  test("has required query count", () => {
    expect(result.stats.totalQueries).toBeGreaterThanOrEqual(
      TIER2_MINIMUMS.totalQueries,
    );
  });

  test("has labels for every query", () => {
    expect(result.stats.totalLabels).toBe(result.stats.totalQueries);
  });

  test("has hard negative groups spanning multiple domains", () => {
    expect(result.stats.hardNegativeGroups).toBeGreaterThanOrEqual(3);
  });

  test("prints dataset statistics", () => {
    console.log("\n=== Tier 2 Dataset Statistics ===");
    console.log(JSON.stringify(result.stats, null, 2));
    if (result.warnings.length > 0) {
      console.log("Warnings:", result.warnings);
    }
  });
});
