import { describe, test, expect } from "vitest";
import { rrfFusion, RRF_K, type FusionCandidate } from "../src/activation/fusion";

describe("rrfFusion", () => {
  test("returns empty array for empty input", () => {
    expect(rrfFusion([], 10)).toEqual([]);
  });

  test("returns single result set unchanged (up to limit)", () => {
    const results: FusionCandidate[] = [
      { id: "a", score: 0.9, source: "vector" },
      { id: "b", score: 0.8, source: "vector" },
      { id: "c", score: 0.7, source: "vector" },
    ];
    const fused = rrfFusion([results], 2);
    expect(fused).toHaveLength(2);
    expect(fused[0].id).toBe("a");
    expect(fused[1].id).toBe("b");
  });

  test("fuses overlapping results with higher combined score", () => {
    const dense: FusionCandidate[] = [
      { id: "a", score: 0.9, source: "vector" },
      { id: "b", score: 0.8, source: "vector" },
      { id: "c", score: 0.7, source: "vector" },
    ];
    const lexical: FusionCandidate[] = [
      { id: "b", score: 5.0, source: "lexical" },
      { id: "d", score: 4.0, source: "lexical" },
      { id: "a", score: 3.0, source: "lexical" },
    ];

    const fused = rrfFusion([dense, lexical], 10);

    // "b" appears at rank 1 in dense (1/(61+1)) and rank 0 in lexical (1/(60+1))
    // "a" appears at rank 0 in dense (1/(60+1)) and rank 2 in lexical (1/(60+3))
    // "b" should score higher because it appears at top ranks in both
    const bEntry = fused.find((f) => f.id === "b");
    const aEntry = fused.find((f) => f.id === "a");
    expect(bEntry).toBeDefined();
    expect(aEntry).toBeDefined();
    expect(bEntry!.score).toBeGreaterThan(aEntry!.score);

    // Both "a" and "b" should be marked as "hybrid" since they appear in both sets
    expect(bEntry!.source).toBe("hybrid");
    expect(aEntry!.source).toBe("hybrid");
  });

  test("fuses disjoint results into union", () => {
    const dense: FusionCandidate[] = [
      { id: "a", score: 0.9, source: "vector" },
      { id: "b", score: 0.8, source: "vector" },
    ];
    const lexical: FusionCandidate[] = [
      { id: "c", score: 5.0, source: "lexical" },
      { id: "d", score: 4.0, source: "lexical" },
    ];

    const fused = rrfFusion([dense, lexical], 10);

    expect(fused).toHaveLength(4);
    const ids = fused.map((f) => f.id);
    expect(ids).toContain("a");
    expect(ids).toContain("b");
    expect(ids).toContain("c");
    expect(ids).toContain("d");

    // Disjoint results keep their original source
    expect(fused.find((f) => f.id === "a")!.source).toBe("vector");
    expect(fused.find((f) => f.id === "c")!.source).toBe("lexical");
  });

  test("respects limit", () => {
    const dense: FusionCandidate[] = Array.from({ length: 20 }, (_, i) => ({
      id: `d${i}`,
      score: 1 - i * 0.01,
      source: "vector" as const,
    }));
    const lexical: FusionCandidate[] = Array.from({ length: 20 }, (_, i) => ({
      id: `l${i}`,
      score: 20 - i,
      source: "lexical" as const,
    }));

    const fused = rrfFusion([dense, lexical], 5);
    expect(fused).toHaveLength(5);
  });

  test("uses deterministic tie-breaking by id", () => {
    // Same rank in both sets -> same RRF score -> break by id
    const set1: FusionCandidate[] = [{ id: "b", score: 1, source: "vector" }];
    const set2: FusionCandidate[] = [{ id: "a", score: 1, source: "lexical" }];

    const fused = rrfFusion([set1, set2], 10);
    // Same score (1/(60+1) each) -> alphabetical order
    expect(fused[0].id).toBe("a");
    expect(fused[1].id).toBe("b");
  });

  test("custom k parameter affects scoring", () => {
    const dense: FusionCandidate[] = [{ id: "a", score: 0.9, source: "vector" }];
    const lexical: FusionCandidate[] = [{ id: "a", score: 5.0, source: "lexical" }];

    const fusedDefault = rrfFusion([dense, lexical], 10, RRF_K);
    const fusedSmallK = rrfFusion([dense, lexical], 10, 1);

    // Smaller k gives higher scores (more weight to top ranks)
    expect(fusedSmallK[0].score).toBeGreaterThan(fusedDefault[0].score);
  });

  test("handles three or more result sets", () => {
    const set1: FusionCandidate[] = [{ id: "a", score: 1, source: "vector" }];
    const set2: FusionCandidate[] = [{ id: "a", score: 1, source: "lexical" }];
    const set3: FusionCandidate[] = [{ id: "a", score: 1, source: "vector" }];

    const fused = rrfFusion([set1, set2, set3], 10);
    expect(fused).toHaveLength(1);
    expect(fused[0].id).toBe("a");
    expect(fused[0].source).toBe("hybrid");
    // Score should be 3 * 1/(60+1) ~= 0.0492
    expect(fused[0].score).toBeCloseTo(3 / (RRF_K + 1), 4);
  });
});
