/**
 * SQLite Schema Type Definitions
 *
 * This file defines TypeScript interfaces that match the SQLite schema (snake_case, one interface
 * per table, final schema = migration 022 / user_version 22). Repositories map these rows onto
 * camelCase records; nothing outside src/db and the repositories should read raw rows.
 *
 * Enumerated values live in src/core/vocabulary.ts (type-only imports here, so there is no runtime cycle).
 */

import type {
  Authority,
  CloseReason,
  Enforcement,
  EpisodeStatus,
  Host,
  KnowledgeKind,
  PatternKind,
  ProposalCreator,
  ProposalDecider,
  ProposalKind,
  ProposalStatus,
  ProvenanceRelation,
  ProviderName,
  RunStatus,
  SignatureTarget,
  SourceKind,
  TransitionActor,
} from "../../core/vocabulary";

/**
 * Memory record - core storage for project knowledge (migration 017 shape)
 */
export interface Memory {
  id: string; // UUID
  content_hash: string; // SHA256 hash for deduplication
  identity_key: string | null; // exact identity across type/scope/lifecycle; unique among live rows only
  type: 'policy' | 'workflow' | 'pitfall' | 'architecture_constraint' | 'decision';
  summary: string;
  details: string;
  scope_glob: string; // e.g., "src/**/*.ts"
  activation_class: ActivationClass; // determines activation layer
  lifecycle_triggers: string; // JSON array of trigger types
  embedding: ArrayBuffer | null;
  embedding_summary: ArrayBuffer | null;
  relevant_tools_json: string | null; // JSON array of tool names, null = all tools
  confidence: number; // 0.0-1.0
  importance: number; // 0.0-1.0
  status: 'candidate' | 'active' | 'stale' | 'superseded' | 'rejected';
  supersedes_memory_id: string | null;
  promotion_source: 'manual' | 'auto'; // how the memory was promoted
  ttl_expires_at: string | null; // ISO 8601, auto-promoted memory expiry
  validation_count: number; // revalidation count (reconfirmed evidence)
  policy_subtype: 'hard' | 'soft' | null; // for policy type memories
  created_at: string; // ISO 8601
  updated_at: string; // ISO 8601
  last_verified_at: string | null; // ISO 8601
  // v0.6 (017) -----------------------------------------------------------------------------
  semantic_key: string | null; // sha256(type|scope_glob|signature_key|normalize(summary)); unique among live rows
  trigger_signature_json: string | null; // TriggerSignature (§4.6) or NULL
  signature_key: string; // serialized canonical form of the signature ('' = none)
  knowledge_kind: KnowledgeKind | null;
  failure_classes_json: string | null; // JSON array of failure classes this memory addresses
  status_reason: string | null; // e.g. ttl_expired, expiry, cap, human
  superseded_by_memory_id: string | null;
  source_ref: string | null; // 'episode:<id>' | 'import:<file>#L<n>' | 'cli'
  revalidate_after: string | null;
  last_fired_at: string | null;
  open_proposal_id: string | null;
  authority: Authority; // NOT NULL, no default: every inserter decides
  enforcement: Enforcement; // default 'advise'
  source_kind: SourceKind; // NOT NULL, no default
  evidence_score: number;
  evidence_count: number;
  distinct_session_count: number;
  fire_count: number;
  override_count: number;
  contested: 0 | 1;
  needs_scope: 0 | 1;
  import_unconfirmed: 0 | 1;
  aliases_json: string; // JSON array of extractor-provided synonyms, default '[]'
}

/**
 * Episode row (migration 018): one closed turn segment = one extraction queue entry.
 */
export interface Episode {
  id: string;
  host: Host;
  session_id: string;
  turn_key: string;
  segment: number;
  started_at: string;
  closed_at: string;
  close_reason: CloseReason;
  ledger_ref: string; // 'ledger/<file>#<byte_start>-<byte_end>' | 'import:<path>'
  correction_for: string | null;
  context_ref: string | null;
  scope_refs_json: string;
  tools_json: string;
  failure_signatures_json: string;
  flags_json: string;
  fired_json: string;
  evidence_weight: number;
  event_count: number;
  status: EpisodeStatus;
  skip_reason: string | null;
  lease_until: string | null;
  attempt_count: number;
  next_attempt_at: string | null;
  last_error: string | null;
  extraction_run_id: string | null;
  summary: string | null; // migration 022: recall text, one line, ≤ 400 chars
  summary_kind: "extracted" | "derived" | null; // extracted = the extractor's episode_summary, derived = the worker's deterministic one
}

/**
 * Extraction run row (migration 018).
 */
export interface ExtractionRun {
  id: string; // createDeterministicId('run:' + episode_id + ':' + extractor_version)
  episode_id: string;
  provider: ProviderName;
  model: string | null;
  extractor_version: string;
  prompt_sha256: string;
  input_chars: number;
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
  status: RunStatus;
  facts_total: number;
  facts_accepted: number;
  raw_output_ref: string | null;
  error: string | null;
  outcomes_json: string; // JSON array of FactOutcome
}

/**
 * Writer idempotency ledger (migration 018).
 */
export interface WriteOp {
  id: string; // run id | 'decision:<proposal_id>:<decided_at>' | 'import:<file_sha256>' | 'dream:<started_at ISO>'
  kind: string;
  generation: number;
  applied_at: string;
}

/**
 * Key/value metadata (migration 018): db_generation, extractor_version, semantic_key_backfill, ...
 */
export interface MetaEntry {
  key: string;
  value: string;
}

/**
 * Proposal row (migration 019).
 */
export interface Proposal {
  id: string; // randomUUID()
  kind: ProposalKind;
  target_memory_id: string;
  candidate_memory_id: string | null;
  rationale: string;
  confidence: number;
  created_by: ProposalCreator;
  support_count: number; // derived from proposal_support
  support_sessions: number; // derived from proposal_support
  status: ProposalStatus;
  created_at: string;
  expires_at: string;
  decided_at: string | null;
  decided_by: ProposalDecider | null;
  decision_note: string | null;
}

/**
 * Proposal support row (migration 019): one per (proposal, episode).
 */
export interface ProposalSupport {
  proposal_id: string;
  episode_id: string;
  session_id: string;
  extraction_run_id: string | null;
  confidence: number;
  created_at: string;
  has_human_signal: 0 | 1;
  deterministic: 0 | 1;
}

/**
 * Memory provenance row (migration 019): the only source of derived confidence/evidence.
 */
export interface MemoryProvenance {
  memory_id: string;
  episode_id: string;
  event_seq: number; // e<seq> cited by the extractor; 0 for import/manual rows
  relation: ProvenanceRelation;
  confidence: number;
  excerpt: string; // <= 500 chars
  extraction_run_id: string | null;
  created_at: string;
}

/**
 * Memory transition row (migration 019): every status change leaves one.
 */
export interface MemoryTransition {
  id: string;
  memory_id: string;
  from_status: MemoryStatus;
  to_status: MemoryStatus;
  actor: TransitionActor;
  proposal_id: string | null;
  extraction_run_id: string | null;
  reason: string;
  created_at: string;
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
  // v0.6 (020) -----------------------------------------------------------------------------
  tool_pattern: string; // glob over canonical tools, default '*'
  target_kind: SignatureTarget; // default 'any'
  pattern_kind: PatternKind | null;
  arg_pattern: string | null;
  enforcement: Enforcement; // default 'advise'
  derived_at: string | null; // NULL = manual rule; otherwise rewritten from active policy memories
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
  salience_boost: number; // 0 = no boost, 0.1-0.3 for milestone moments
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
 * How a memory was promoted from candidate to active.
 */
export type PromotionSource = 'manual' | 'auto';

/**
 * Policy subtype — determines auto-promotion eligibility for policy memories.
 */
export type PolicySubtype = 'hard' | 'soft' | null;

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
 *
 * State machine:
 *   pending → retained (noise filter passed)
 *   retained → grouped (structural grouping assigned)
 *   grouped → materialized (Tier 1/2 candidate created)
 *   grouped → latent (Tier 3, no candidate, 14-day TTL)
 *   materialized ≈ consumed (backward compat: both mean "used to create candidate")
 *   latent → discarded (TTL expired or manual cleanup)
 *   any → discarded (noise, TTL, or explicit discard)
 *
 * Legacy states preserved for backward compatibility:
 *   consumed — historical rows from pre-v15; equivalent to materialized
 *   deferred — no longer written; migrated to latent in migration 015
 */
export type DreamEvidenceStatus =
  | 'pending'
  | 'retained'
  | 'grouped'
  | 'materialized'
  | 'latent'
  | 'consumed'       // legacy: equivalent to materialized
  | 'discarded';

/**
 * Signal tags attached to evidence metadata.
 * These are HINTS for dream consolidation, NOT entry criteria.
 * Regex extracts these tags; they never gate evidence.
 */
export type SignalTag =
  | 'failure_signal'
  | 'success_signal'
  | 'decision_signal'
  | 'convention_signal'
  | 'architecture_signal'
  | 'temporal_cue'
  | 'explicit_marker'
  | 'has_file_context';

/**
 * Structured metadata stored in dream_evidence_events.metadata_json.
 * Extends any existing metadata with signal tags and hints.
 */
export interface EvidenceMetadata {
  /** Signal tags derived from regex patterns (hints, not gates). */
  signalTags?: SignalTag[];
  /** SHA-256 hash of excerpt for same-session dedup. */
  excerptHash?: string;
  /** Original type guess from adapter (hint only, not used for grouping). */
  hintType?: string;
  /** Original topic guess from adapter (hint only, not used for grouping). */
  hintTopic?: string;
  /** Pass-through for any other metadata from the adapter. */
  [key: string]: unknown;
}

/**
 * Action distribution telemetry for a dream run.
 * Tracks how many evidence events resulted in each action.
 */
export interface ActionDistribution {
  create: number;
  reinforce: number;
  supersede: number;
  stale: number;
  latent: number;
  skip: number;
}

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
