import type {
  Tier2MemoryFixture,
  Tier2QueryFixture,
  Tier2GroundTruthLabel,
  ProjectDomain,
  QueryCategory,
} from "../fixtures/tier2.types";
import { TIER2_MINIMUMS } from "../fixtures/tier2.types";

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  stats: {
    totalMemories: number;
    memoriesByDomain: Record<ProjectDomain, number>;
    koreanMemories: number;
    totalQueries: number;
    queriesByCategory: Record<QueryCategory, number>;
    totalLabels: number;
    avgRelevantPerQuery: number;
    avgForbiddenPerQuery: number;
    hardNegativeGroups: number;
  };
}

/**
 * Validates the Tier 2 dataset for completeness, consistency, and minimum requirements.
 *
 * Checks:
 * - Total memory count >= TIER2_MINIMUMS.totalMemories
 * - Memories per domain >= TIER2_MINIMUMS.memoriesPerDomain
 * - Korean memories >= TIER2_MINIMUMS.koreanMemories
 * - Total queries >= TIER2_MINIMUMS.totalQueries
 * - Queries per category meet minimums
 * - Every query has exactly one label
 * - All memory IDs in labels exist in the memories array
 * - All query IDs in labels exist in the queries array
 * - No duplicate memory IDs
 * - No duplicate query IDs
 * - Memory IDs follow "{domain}-{nn}" pattern
 * - Query IDs follow "q-{category}-{nn}" pattern
 * - forbiddenMemoryIds don't overlap with relevantMemoryIds
 * - Negative queries have empty relevantMemoryIds
 * - At least 3 hard negative groups span 2+ domains
 */
export function validateDataset(
  memories: readonly Tier2MemoryFixture[],
  queries: readonly Tier2QueryFixture[],
  labels: readonly Tier2GroundTruthLabel[],
): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // =========================================================================
  // 1. Check memory counts
  // =========================================================================

  if (memories.length < TIER2_MINIMUMS.totalMemories) {
    errors.push(
      `Total memories (${memories.length}) < minimum (${TIER2_MINIMUMS.totalMemories})`,
    );
  }

  const memoriesByDomain: Record<ProjectDomain, number> = {
    "web-app": 0,
    "cli-tool": 0,
    "ai-ml": 0,
  };

  let koreanMemories = 0;

  for (const memory of memories) {
    memoriesByDomain[memory.domain]++;
    if (memory.language === "ko") {
      koreanMemories++;
    }
  }

  for (const domain of ["web-app", "cli-tool", "ai-ml"] as const) {
    if (memoriesByDomain[domain] < TIER2_MINIMUMS.memoriesPerDomain) {
      errors.push(
        `Memories in domain '${domain}' (${memoriesByDomain[domain]}) < minimum (${TIER2_MINIMUMS.memoriesPerDomain})`,
      );
    }
  }

  if (koreanMemories < TIER2_MINIMUMS.koreanMemories) {
    errors.push(
      `Korean memories (${koreanMemories}) < minimum (${TIER2_MINIMUMS.koreanMemories})`,
    );
  }

  // =========================================================================
  // 2. Check query counts
  // =========================================================================

  if (queries.length < TIER2_MINIMUMS.totalQueries) {
    errors.push(
      `Total queries (${queries.length}) < minimum (${TIER2_MINIMUMS.totalQueries})`,
    );
  }

  const queriesByCategory: Record<QueryCategory, number> = {
    "first-turn": 0,
    scoped: 0,
    "cross-language": 0,
    negative: 0,
    ambiguous: 0,
  };

  for (const query of queries) {
    queriesByCategory[query.category]++;
  }

  const categoryMinimums: Record<QueryCategory, number> = {
    "first-turn": TIER2_MINIMUMS.firstTurnQueries,
    scoped: TIER2_MINIMUMS.scopedQueries,
    "cross-language": TIER2_MINIMUMS.crossLanguageQueries,
    negative: TIER2_MINIMUMS.negativeQueries,
    ambiguous: TIER2_MINIMUMS.ambiguousQueries,
  };

  for (const category of [
    "first-turn",
    "scoped",
    "cross-language",
    "negative",
    "ambiguous",
  ] as const) {
    if (queriesByCategory[category] < categoryMinimums[category]) {
      errors.push(
        `Queries in category '${category}' (${queriesByCategory[category]}) < minimum (${categoryMinimums[category]})`,
      );
    }
  }

  // =========================================================================
  // 3. Check for duplicate IDs
  // =========================================================================

  const memoryIds = new Set<string>();
  const duplicateMemoryIds: string[] = [];

  for (const memory of memories) {
    if (memoryIds.has(memory.id)) {
      duplicateMemoryIds.push(memory.id);
    }
    memoryIds.add(memory.id);
  }

  if (duplicateMemoryIds.length > 0) {
    errors.push(`Duplicate memory IDs: ${duplicateMemoryIds.join(", ")}`);
  }

  const queryIds = new Set<string>();
  const duplicateQueryIds: string[] = [];

  for (const query of queries) {
    if (queryIds.has(query.id)) {
      duplicateQueryIds.push(query.id);
    }
    queryIds.add(query.id);
  }

  if (duplicateQueryIds.length > 0) {
    errors.push(`Duplicate query IDs: ${duplicateQueryIds.join(", ")}`);
  }

  // =========================================================================
  // 4. Check ID format patterns
  // =========================================================================

  const memoryIdPattern = /^(web-app|cli-tool|ai-ml)-\d{2}$/;
  const invalidMemoryIds: string[] = [];

  for (const memory of memories) {
    if (!memoryIdPattern.test(memory.id)) {
      invalidMemoryIds.push(memory.id);
    }
  }

  if (invalidMemoryIds.length > 0) {
    errors.push(
      `Memory IDs don't follow "{domain}-{nn}" pattern: ${invalidMemoryIds.join(", ")}`,
    );
  }

  const queryIdPattern = /^q-(first-turn|scoped|cross-language|negative|ambiguous)-\d{2}$/;
  const invalidQueryIds: string[] = [];

  for (const query of queries) {
    if (!queryIdPattern.test(query.id)) {
      invalidQueryIds.push(query.id);
    }
  }

  if (invalidQueryIds.length > 0) {
    errors.push(
      `Query IDs don't follow "q-{category}-{nn}" pattern: ${invalidQueryIds.join(", ")}`,
    );
  }

  // =========================================================================
  // 5. Check labels
  // =========================================================================

  if (labels.length !== queries.length) {
    errors.push(
      `Label count (${labels.length}) != query count (${queries.length})`,
    );
  }

  const labelsByQueryId = new Map<string, Tier2GroundTruthLabel>();
  const queriesWithoutLabels: string[] = [];

  for (const label of labels) {
    labelsByQueryId.set(label.queryId, label);
  }

  for (const query of queries) {
    if (!labelsByQueryId.has(query.id)) {
      queriesWithoutLabels.push(query.id);
    }
  }

  if (queriesWithoutLabels.length > 0) {
    errors.push(`Queries without labels: ${queriesWithoutLabels.join(", ")}`);
  }

  // =========================================================================
  // 6. Check label referential integrity
  // =========================================================================

  const invalidMemoryReferences: string[] = [];
  const invalidQueryReferences: string[] = [];

  for (const label of labels) {
    // Check query ID exists
    if (!queryIds.has(label.queryId)) {
      invalidQueryReferences.push(label.queryId);
    }

    // Check all relevant memory IDs exist
    for (const memoryId of label.relevantMemoryIds) {
      if (!memoryIds.has(memoryId)) {
        invalidMemoryReferences.push(`${label.queryId} -> ${memoryId}`);
      }
    }

    // Check all forbidden memory IDs exist
    for (const memoryId of label.forbiddenMemoryIds) {
      if (!memoryIds.has(memoryId)) {
        invalidMemoryReferences.push(`${label.queryId} -> ${memoryId} (forbidden)`);
      }
    }
  }

  if (invalidMemoryReferences.length > 0) {
    errors.push(
      `Invalid memory references in labels: ${invalidMemoryReferences.join(", ")}`,
    );
  }

  if (invalidQueryReferences.length > 0) {
    errors.push(
      `Invalid query references in labels: ${invalidQueryReferences.join(", ")}`,
    );
  }

  // =========================================================================
  // 7. Check label constraints
  // =========================================================================

  const overlappingIds: string[] = [];
  const negativeQueriesWithRelevant: string[] = [];

  for (const label of labels) {
    // Check no overlap between relevant and forbidden
    const relevantSet = new Set(label.relevantMemoryIds);
    for (const forbiddenId of label.forbiddenMemoryIds) {
      if (relevantSet.has(forbiddenId)) {
        overlappingIds.push(`${label.queryId}: ${forbiddenId}`);
      }
    }

    // Check negative queries have empty relevantMemoryIds
    const query = Array.from(queries).find((q) => q.id === label.queryId);
    if (query && query.category === "negative") {
      if (label.relevantMemoryIds.length > 0) {
        negativeQueriesWithRelevant.push(label.queryId);
      }
    }
  }

  if (overlappingIds.length > 0) {
    errors.push(
      `Overlapping relevant/forbidden memory IDs: ${overlappingIds.join(", ")}`,
    );
  }

  if (negativeQueriesWithRelevant.length > 0) {
    errors.push(
      `Negative queries with relevant memories: ${negativeQueriesWithRelevant.join(", ")}`,
    );
  }

  // =========================================================================
  // 8. Check hard negative groups
  // =========================================================================

  const hardNegativeGroups = new Map<string, Set<ProjectDomain>>();

  for (const memory of memories) {
    if (memory.hardNegativeGroup) {
      if (!hardNegativeGroups.has(memory.hardNegativeGroup)) {
        hardNegativeGroups.set(memory.hardNegativeGroup, new Set());
      }
      hardNegativeGroups.get(memory.hardNegativeGroup)!.add(memory.domain);
    }
  }

  const multiDomainGroups = Array.from(hardNegativeGroups.entries()).filter(
    ([, domains]) => domains.size >= 2,
  );

  if (multiDomainGroups.length < 3) {
    errors.push(
      `Hard negative groups spanning 2+ domains (${multiDomainGroups.length}) < minimum (3)`,
    );
  }

  // =========================================================================
  // 9. Calculate statistics
  // =========================================================================

  let totalRelevant = 0;
  let totalForbidden = 0;

  for (const label of labels) {
    totalRelevant += label.relevantMemoryIds.length;
    totalForbidden += label.forbiddenMemoryIds.length;
  }

  const avgRelevantPerQuery = labels.length > 0 ? totalRelevant / labels.length : 0;
  const avgForbiddenPerQuery = labels.length > 0 ? totalForbidden / labels.length : 0;

  const stats = {
    totalMemories: memories.length,
    memoriesByDomain,
    koreanMemories,
    totalQueries: queries.length,
    queriesByCategory,
    totalLabels: labels.length,
    avgRelevantPerQuery,
    avgForbiddenPerQuery,
    hardNegativeGroups: multiDomainGroups.length,
  };

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    stats,
  };
}
