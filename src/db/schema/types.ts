/**
 * SQLite Schema Type Definitions
 * 
 * This file defines TypeScript interfaces that match the SQLite schema.
 * Used for type-safe database operations and validation.
 */

/**
 * Memory record - core storage for project knowledge
 */
export interface Memory {
  id: string; // UUID
  content_hash: string; // SHA256 hash for deduplication
  identity_key: string | null; // exact identity across type/scope/lifecycle
  type: 'policy' | 'workflow' | 'pitfall' | 'architecture_constraint' | 'decision';
  summary: string;
  details: string;
  scope_glob: string; // e.g., "src/**/*.ts"
  activation_class: ActivationClass; // determines activation layer
  lifecycle_triggers: string; // JSON array of trigger types
  confidence: number; // 0.0-1.0
  importance: number; // 0.0-1.0
  status: 'candidate' | 'active' | 'stale' | 'superseded' | 'rejected';
  supersedes_memory_id: string | null;
  created_at: string; // ISO 8601
  updated_at: string; // ISO 8601
  last_verified_at: string | null; // ISO 8601
}

/**
 * Evidence record - supporting evidence for memories
 */
export interface Evidence {
  id: string; // UUID
  memory_id: string; // Foreign key to memories
  source_kind: 'session' | 'task' | 'file' | 'manual_note';
  source_ref: string; // e.g., file path, session ID
  excerpt: string; // Relevant excerpt from source
  created_at: string; // ISO 8601
}

/**
 * Policy rule - enforceable rules linked to memories
 */
export interface PolicyRule {
  id: string; // UUID
  memory_id: string | null; // Optional foreign key to memories
  rule_code: string; // Unique rule identifier
  severity: 'info' | 'warning';
  trigger_kind: 'session_start' | 'before_model' | 'before_tool' | 'after_tool';
  scope_glob: string; // e.g., "src/**/*.ts"
  message: string; // Rule message/description
  created_at: string; // ISO 8601
  updated_at: string; // ISO 8601
}

/**
 * Activation log - audit trail of memory activations
 */
export interface ActivationLog {
  id: string; // UUID
  session_id: string;
  lifecycle_trigger: 'session_start' | 'before_model' | 'before_tool' | 'after_tool';
  scope_ref: string; // e.g., file path
  activated_memory_ids: string; // JSON array of memory IDs
  suppressed_memory_ids: string; // JSON array of memory IDs
  reason: string; // Reason for activation/suppression
  created_at: string; // ISO 8601
}

/**
 * Dream evidence event - append-only signal for later consolidation
 */
export interface DreamEvidenceEvent {
  id: string;
  session_id: string;
  call_id: string;
  tool_name: string;
  scope_ref: string;
  source_ref: string;
  title: string;
  excerpt: string;
  args_json: string;
  metadata_json: string | null;
  topic_guess: string;
  type_guess: DreamEvidenceTypeGuess;
  salience: number;
  novelty: number;
  contradiction_signal: 0 | 1;
  status: DreamEvidenceStatus;
  retry_count: number;
  next_review_at: string | null;
  last_reviewed_at: string | null;
  dream_run_id: string | null;
  created_at: string;
  consumed_at: string | null;
  discarded_at: string | null;
}

/**
 * Dream run - consolidation batch over recent evidence
 */
export interface DreamRun {
  id: string;
  trigger: DreamTrigger;
  status: DreamRunStatus;
  window_start: string;
  window_end: string;
  evidence_count: number;
  candidate_count: number;
  summary: string;
  created_at: string;
  completed_at: string | null;
}

/**
 * Schema version metadata
 */
export interface SchemaVersion {
  version: number;
  applied_at: string; // ISO 8601
}

/**
 * Lifecycle trigger types
 */
export type LifecycleTrigger = 'session_start' | 'before_model' | 'before_tool' | 'after_tool';

/**
 * Memory type enumeration
 */
export type MemoryType = 'policy' | 'workflow' | 'pitfall' | 'architecture_constraint' | 'decision';

/**
 * Memory status enumeration
 */
export type MemoryStatus = 'candidate' | 'active' | 'stale' | 'superseded' | 'rejected';

/**
 * Activation class - determines which activation layer handles the memory
 */
export type ActivationClass = 'baseline' | 'startup' | 'scoped' | 'event';

/**
 * Evidence source kind enumeration
 */
export type EvidenceSourceKind = 'session' | 'task' | 'file' | 'manual_note';

/**
 * Policy severity enumeration
 */
export type PolicySeverity = 'info' | 'warning';

/**
 * Dream consolidation trigger types
 */
export type DreamTrigger = 'manual' | 'precompact' | 'task_end' | 'session_end' | 'idle';

/**
 * Dream evidence classifications
 */
export type DreamEvidenceTypeGuess = 'policy' | 'workflow' | 'pitfall' | 'architecture_constraint' | 'decision';

/**
 * Dream evidence event lifecycle
 */
export type DreamEvidenceStatus = 'pending' | 'deferred' | 'consumed' | 'discarded';

/**
 * Dream run lifecycle
 */
export type DreamRunStatus = 'started' | 'completed' | 'failed';

/**
 * Activation budget constraints
 */
export const ACTIVATION_BUDGET = {
  MAX_MEMORIES: 10,
  MAX_PAYLOAD_BYTES: 8192, // 8KB
} as const;

/**
 * Default values for memory creation
 */
export const MEMORY_DEFAULTS = {
  STATUS: 'candidate' as const,
  ACTIVATION_CLASS: 'scoped' as const,
  CONFIDENCE: 0.5,
  IMPORTANCE: 0.5,
} as const;
