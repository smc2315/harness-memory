import type {
  ActionDistribution,
  DreamEvidenceStatus,
  DreamEvidenceTypeGuess,
  DreamRunStatus,
  DreamTrigger,
  LifecycleTrigger,
  MemoryType,
  SignalTag,
} from "../db/schema/types";
import type { MemoryRecord } from "../memory";

export interface DreamEvidenceLinkRecord {
  evidenceEventId: string;
  memoryId: string;
  dreamRunId: string;
  createdAt: string;
}

export interface DreamEvidenceEventRecord {
  id: string;
  sessionId: string;
  callId: string;
  toolName: string;
  scopeRef: string;
  sourceRef: string;
  title: string;
  excerpt: string;
  argsJson: string;
  metadataJson: string | null;
  topicGuess: string;
  typeGuess: DreamEvidenceTypeGuess;
  salience: number;
  novelty: number;
  salienceBoost: number;
  contradictionSignal: boolean;
  status: DreamEvidenceStatus;
  retryCount: number;
  nextReviewAt: string | null;
  lastReviewedAt: string | null;
  dreamRunId: string | null;
  createdAt: string;
  consumedAt: string | null;
  discardedAt: string | null;
}

export interface CreateDreamEvidenceEventInput {
  id?: string;
  sessionId: string;
  callId: string;
  toolName: string;
  scopeRef: string;
  sourceRef: string;
  title: string;
  excerpt: string;
  args: unknown;
  metadata?: unknown;
  topicGuess: string;
  typeGuess: DreamEvidenceTypeGuess;
  salience: number;
  novelty: number;
  salienceBoost?: number;
  contradictionSignal?: boolean;
  createdAt?: string;
}

export interface ListDreamEvidenceEventsInput {
  sessionId?: string;
  status?: DreamEvidenceStatus | readonly DreamEvidenceStatus[];
  limit?: number;
  createdAfter?: string;
}

export interface DreamRunRecord {
  id: string;
  trigger: DreamTrigger;
  status: DreamRunStatus;
  windowStart: string;
  windowEnd: string;
  evidenceCount: number;
  candidateCount: number;
  summary: string;
  createdAt: string;
  completedAt: string | null;
}

export interface CreateDreamRunInput {
  id?: string;
  trigger: DreamTrigger;
  windowStart: string;
  windowEnd: string;
  evidenceCount?: number;
  candidateCount?: number;
  summary?: string;
  createdAt?: string;
}

export interface CompleteDreamRunInput {
  status: Extract<DreamRunStatus, "completed" | "failed">;
  summary: string;
  candidateCount: number;
  completedAt?: string;
}

export interface DreamCandidateSuggestion {
  memoryId: string;
  type: Extract<MemoryType, "policy" | "workflow" | "pitfall" | "architecture_constraint" | "decision">;
  action: "created" | "updated";
  scopeGlob: string;
  lifecycleTriggers: LifecycleTrigger[];
  summary: string;
  confidence: number;
  importance: number;
  evidenceEventIds: string[];
  memory: MemoryRecord;
  previousSummary: string | null;
}

export interface DreamRunRequest {
  trigger: DreamTrigger;
  createdAfter?: string;
  limit?: number;
  now?: string;
}

export interface DreamRunResult {
  run: DreamRunRecord;
  processedEvidenceCount: number;
  consumedEvidenceIds: string[];
  materializedEvidenceIds: string[];
  latentEvidenceIds: string[];
  deferredEvidenceIds: string[];
  discardedEvidenceIds: string[];
  suggestions: DreamCandidateSuggestion[];
  skippedEvidenceIds: string[];
  actionDistribution: ActionDistribution;
}

export interface ListDreamRunsInput {
  limit?: number;
  trigger?: DreamTrigger | readonly DreamTrigger[];
  status?: DreamRunStatus | readonly DreamRunStatus[];
}

// ---------------------------------------------------------------------------
// LLM-based extraction types (dream:extract pipeline)
// ---------------------------------------------------------------------------

/**
 * Actions the LLM can propose for memory lifecycle management.
 *
 * - `create`    — new fact not covered by any existing memory → candidate
 * - `reinforce` — existing memory confirmed again → bump confidence
 * - `supersede` — existing memory replaced by updated fact → supersede old, create new
 * - `stale`     — existing memory no longer valid → mark stale
 */
export type DreamExtractionAction = "create" | "reinforce" | "supersede" | "stale";

/** A single memory extraction proposed by the LLM. */
export interface DreamExtractedFact {
  action: DreamExtractionAction;
  /** Memory type for new memories. */
  type?: "policy" | "workflow" | "pitfall" | "architecture_constraint" | "decision";
  /** One-line summary. */
  summary: string;
  /** Detailed explanation. */
  details: string;
  /** For reinforce/supersede/stale: the ID of the existing memory. */
  targetMemoryId?: string;
  /** LLM's confidence in this extraction (0.0–1.0). */
  confidence?: number;
}

/** The structured response expected from the LLM extraction call. */
export interface DreamExtractionResult {
  facts: DreamExtractedFact[];
}

/** Options for the LLM extraction process. */
export interface DreamExtractionOptions {
  /** Path to the SQLite database. */
  dbPath: string;
  /** Maximum number of batches to process per run. */
  maxBatches?: number;
  /** Minimum evidence count before extraction is allowed. */
  minEvidenceCount?: number;
  /** Minimum hours since the last extraction run. */
  minHoursSinceLastExtract?: number;
  /** Whether to skip scheduler gates (for testing). */
  skipGates?: boolean;
  /** Dry run — build prompt but don't call LLM. */
  dryRun?: boolean;
}
