/**
 * Tier 2 benchmark fixture types.
 *
 * These types define the shape of the memory corpus, query set, and
 * ground truth labels used for real-model benchmarking. The key difference
 * from Tier 1: NO concept assignments. Ground truth is independently
 * labeled based on memory content, not embedding construction.
 */

import type {
  ActivationClass,
  LifecycleTrigger,
  MemoryType,
} from "../../../src/db/schema/types";

// ---------------------------------------------------------------------------
// Domain & language metadata
// ---------------------------------------------------------------------------

/**
 * Project domain that a memory belongs to. Used for scope discrimination
 * testing — memories from one domain should not bleed into another's queries
 * when scope_glob differs.
 */
export type ProjectDomain = "web-app" | "cli-tool" | "ai-ml";

/** Language of the memory content. */
export type ContentLanguage = "en" | "ko";

// ---------------------------------------------------------------------------
// Memory fixture
// ---------------------------------------------------------------------------

export interface Tier2MemoryFixture {
  /** Stable identifier for test readability (e.g., "web-01", "cli-15"). */
  id: string;

  /** Project domain this memory belongs to. */
  domain: ProjectDomain;

  /** Language of summary and details. */
  language: ContentLanguage;

  /** Memory type (policy, workflow, pitfall, etc.). */
  type: MemoryType;

  /** One-line summary. */
  summary: string;

  /** Full details. */
  details: string;

  /** Scope glob — should be domain-specific (e.g., "src/web/**" for web-app). */
  scopeGlob: string;

  /** Lifecycle triggers. */
  lifecycleTriggers: LifecycleTrigger[];

  /** Activation class. */
  activationClass: ActivationClass;

  /** Confidence (0-1). */
  confidence: number;

  /** Importance (0-1). */
  importance: number;

  /**
   * Hard-negative group ID. Memories with the same group but different
   * domains are "topical near-neighbors" that the engine should distinguish.
   * Example: group "typescript-config" appears in both web-app and cli-tool.
   */
  hardNegativeGroup?: string;
}

// ---------------------------------------------------------------------------
// Query fixture
// ---------------------------------------------------------------------------

export type QueryCategory =
  | "first-turn"       // scopeRef=".", broad query, no file context
  | "scoped"           // scopeRef targets a specific domain's path
  | "cross-language"   // query language ≠ memory language
  | "negative"         // no relevant memories exist
  | "ambiguous";       // multiple domains could match

export interface Tier2QueryFixture {
  /** Stable identifier (e.g., "q01", "q-cross-ko-01"). */
  id: string;

  /** Query text as a developer would type it. */
  text: string;

  /** Language of the query. */
  language: ContentLanguage;

  /** Category for analysis grouping. */
  category: QueryCategory;

  /** Scope ref to use in activation request. */
  scopeRef: string;

  /** Lifecycle trigger to use. */
  lifecycleTrigger: LifecycleTrigger;

  /**
   * Target domain (if scoped). Used for scope discrimination analysis.
   * Null for first-turn and negative queries.
   */
  targetDomain: ProjectDomain | null;
}

// ---------------------------------------------------------------------------
// Ground truth labels
// ---------------------------------------------------------------------------

export interface Tier2GroundTruthLabel {
  /** Query ID this label applies to. */
  queryId: string;

  /** Memory IDs that ARE relevant to this query (1-5). */
  relevantMemoryIds: string[];

  /**
   * Memory IDs that MUST NOT appear in results. Used for scope
   * discrimination and hard-negative testing. These are memories from
   * wrong domains that are topically similar.
   */
  forbiddenMemoryIds: string[];

  /** Human-readable explanation of the labeling decision. */
  rationale: string;
}

// ---------------------------------------------------------------------------
// Dataset minimums (for validation)
// ---------------------------------------------------------------------------

export const TIER2_MINIMUMS = {
  totalMemories: 60,
  memoriesPerDomain: 18,
  koreanMemories: 10,
  totalQueries: 30,
  firstTurnQueries: 10,
  crossLanguageQueries: 6,
  scopedQueries: 8,
  negativeQueries: 3,
  ambiguousQueries: 3,
} as const;
