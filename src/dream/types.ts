import type {
  DreamEvidenceStatus,
  DreamEvidenceTypeGuess,
  DreamRunStatus,
  DreamTrigger,
  LifecycleTrigger,
  MemoryType,
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
  deferredEvidenceIds: string[];
  discardedEvidenceIds: string[];
  suggestions: DreamCandidateSuggestion[];
  skippedEvidenceIds: string[];
}

export interface ListDreamRunsInput {
  limit?: number;
  trigger?: DreamTrigger | readonly DreamTrigger[];
  status?: DreamRunStatus | readonly DreamRunStatus[];
}
