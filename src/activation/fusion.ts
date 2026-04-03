/**
 * Reciprocal Rank Fusion (RRF) for hybrid retrieval.
 *
 * Combines ranked result lists from multiple retrieval sources
 * (dense vector, lexical/BM25) into a single fused ranking.
 *
 * RRF score for document d = sum over each result set S:
 *   1 / (k + rank_in_S(d))
 *
 * where k is a constant (default 60) that dampens the influence
 * of high ranks and prevents division by zero.
 */

/** Standard RRF constant. Higher k = more uniform weighting across ranks. */
export const RRF_K = 60;

export type RetrievalSource = "vector" | "lexical" | "hybrid";

export interface FusionCandidate {
  id: string;
  score: number;
  source: RetrievalSource;
}

/**
 * Fuse multiple ranked result lists using Reciprocal Rank Fusion.
 *
 * Each input list is assumed to be sorted by relevance (best first).
 * The output is a fused ranking sorted by RRF score (highest first).
 *
 * Candidates appearing in multiple lists get contributions from each.
 * Candidates in only one list get only that contribution.
 *
 * @param resultSets - One or more ranked result lists
 * @param limit - Maximum results to return
 * @param k - RRF constant (default 60)
 * @returns Fused candidates sorted by RRF score
 */
export function rrfFusion(
  resultSets: readonly (readonly FusionCandidate[])[],
  limit: number,
  k: number = RRF_K,
): FusionCandidate[] {
  if (resultSets.length === 0) {
    return [];
  }

  // Single result set - no fusion needed
  if (resultSets.length === 1) {
    return resultSets[0].slice(0, limit).map((c) => ({
      ...c,
      source: c.source,
    }));
  }

  const scores = new Map<string, { score: number; sources: Set<RetrievalSource> }>();

  for (const resultSet of resultSets) {
    for (let rank = 0; rank < resultSet.length; rank++) {
      const candidate = resultSet[rank];
      const entry = scores.get(candidate.id) ?? { score: 0, sources: new Set<RetrievalSource>() };
      entry.score += 1 / (k + rank + 1);
      entry.sources.add(candidate.source);
      scores.set(candidate.id, entry);
    }
  }

  return [...scores.entries()]
    .map(([id, { score, sources }]) => ({
      id,
      score,
      source: (sources.size > 1 ? "hybrid" : [...sources][0]!) as RetrievalSource,
    }))
    .sort((a, b) => {
      const scoreDelta = b.score - a.score;
      if (scoreDelta !== 0) return scoreDelta;
      return a.id.localeCompare(b.id); // deterministic tie-breaking
    })
    .slice(0, limit);
}
