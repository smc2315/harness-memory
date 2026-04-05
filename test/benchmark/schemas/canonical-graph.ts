/**
 * Canonical Memory Graph — shared annotation layer for HM benchmarks.
 *
 * All benchmark data derives from this common schema. This ensures
 * annotation is done once and reused across Extract, Promotion,
 * Activation, Timeline, Safety, Product, and Scale benchmarks.
 */

// -- Enums / Literal Unions --

export type EventType =
  | "workflow_observed" // Recurring pattern in user behavior
  | "decision_made" // Explicit architectural/design decision
  | "pitfall_encountered" // Bug, error, or antipattern found
  | "policy_stated" // Rule or convention declared
  | "convention_established" // Implicit or explicit standard
  | "tool_usage" // Significant tool interaction pattern
  | "conflict_detected" // Contradicting information found
  | "correction_applied"; // User explicitly corrects previous info

export type SalienceLevel = "high" | "medium" | "low";

export type MemoryTypeGold =
  | "policy"
  | "workflow"
  | "pitfall"
  | "architecture_constraint"
  | "decision";

export type PolicySubtypeGold = "hard" | "soft" | null;

export type ActivationClassGold = "baseline" | "startup" | "scoped" | "event";

export type PromotionTarget = "auto" | "manual_review" | "never_auto";

export type ReviewStateGold = "reviewed" | "unreviewed" | "needs_recheck";

export type TTLClass = "permanent" | "refresh_on_reuse" | "time_limited" | "session_scoped";

export type RiskFlag =
  | "prompt_injection"
  | "credential_leak"
  | "stale_info"
  | "contradicts_existing"
  | "security_sensitive";

export type Language = "en" | "ko" | "mixed";

// -- Event Span Schema --

export interface EventSpan {
  /** Unique identifier for this event */
  event_id: string;
  /** Project this event belongs to */
  project_id: string;
  /** Session where this event occurred */
  session_id: string;
  /** Turn IDs that constitute this event (user + assistant turns) */
  turn_ids: string[];
  /** Tool call IDs associated with this event */
  tool_call_ids: string[];
  /** Type of event observed */
  event_type: EventType;
  /** Human-readable summary of what happened */
  summary: string;
  /** Scope context for this event */
  scope: {
    paths: string[];
    modules: string[];
    branch: string | null;
  };
  /** Tools involved in this event */
  relevant_tools: string[];
  /** Language of the conversation */
  language: Language;
  /** How important is this event for memory extraction */
  salience: SalienceLevel;
  /** Risk flags detected in this event */
  risk_flags: RiskFlag[];
  /** Monotonically increasing order within project */
  time_order: number;
}

// -- Gold Memory Schema --

export interface GoldMemory {
  /** Unique identifier */
  memory_id: string;
  /** Memory type classification */
  memory_type: MemoryTypeGold;
  /** For policy type: hard (must follow) vs soft (prefer) */
  policy_subtype: PolicySubtypeGold;
  /** One-line summary (< 80 chars) */
  summary_short: string;
  /** Medium summary (1-2 sentences) */
  summary_medium: string;
  /** Full details with context and rationale */
  details: string;
  /** File/path scope glob */
  scope_glob: string;
  /** Tools this memory is relevant to */
  relevant_tools: string[];
  /** How this memory should be activated */
  activation_class: ActivationClassGold;
  /** Whether this can be auto-promoted */
  promotion_target: PromotionTarget;
  /** Event IDs that provide evidence for this memory */
  required_evidence_ids: string[];
  /** Gold standard review state */
  review_state_gold: ReviewStateGold;
  /** How this memory's TTL should be managed */
  ttl_class: TTLClass;
  /** Unique canonical key for dedup and tracking (e.g., "workflow.debug.verbose-first") */
  canonical_key: string;
}

// -- Project-Level Container --

export interface CanonicalProject {
  /** Project identifier */
  project_id: string;
  /** Project name */
  name: string;
  /** Tech stack tags */
  tech_stack: string[];
  /** Primary language */
  language: Language;
  /** Total session count */
  session_count: number;
  /** All event spans in this project */
  events: EventSpan[];
  /** All gold memories derived from events */
  memories: GoldMemory[];
  /** Memory update/contradiction episodes */
  updates: MemoryUpdateEpisode[];
  /** Safety/risk cases */
  risks: RiskCase[];
}

// -- Update/Contradiction Episodes --

export interface MemoryUpdateEpisode {
  /** Episode identifier */
  episode_id: string;
  /** The original memory being updated */
  original_memory_id: string;
  /** The event that triggers the update */
  trigger_event_id: string;
  /** What kind of update */
  update_type: "reinforce" | "supersede" | "stale" | "contradiction" | "correction";
  /** New memory ID (for supersede) */
  new_memory_id: string | null;
  /** Explanation of the update */
  reason: string;
}

// -- Risk Cases --

export interface RiskCase {
  /** Case identifier */
  case_id: string;
  /** What kind of risk */
  risk_type:
    | "prompt_injection"
    | "credential_leak"
    | "malicious_instruction"
    | "stale_promotion"
    | "false_positive_block";
  /** The problematic content */
  content: { summary: string; details: string };
  /** Expected system behavior */
  expected_action: "block" | "warn" | "allow";
  /** Why this is a risk (or why it's a false positive) */
  rationale: string;
}

// -- Benchmark Query Types --

export interface ActivationQuery {
  /** Query identifier */
  query_id: string;
  /** Category of query */
  category:
    | "startup"
    | "scoped"
    | "before_tool"
    | "first_turn"
    | "hard_negative"
    | "temporal_precursor"
    | "cross_session_precursor";
  /** The user's turn context */
  turn_context: {
    user_prompt: string;
    path: string;
    tool: string | null;
    branch: string | null;
  };
  /** Memory IDs that MUST be in activated set */
  must_include_ids: string[];
  /** Memory IDs that SHOULD be in activated set if budget allows */
  nice_to_have_ids: string[];
  /** Memory IDs that MUST NOT be in activated set */
  must_exclude_ids: string[];
  /** Preferred disclosure tier per memory */
  preferred_disclosure: Record<string, "full" | "summary" | "hint">;
}

export interface TimelineQuery {
  /** Query identifier */
  question_id: string;
  /** Question type */
  question_type:
    | "event_ordering"
    | "change_point"
    | "latest_state"
    | "multi_session_synthesis"
    | "hard_negative_temporal";
  /** The question text */
  question: string;
  /** Expected answer */
  gold_answer: string;
  /** Session IDs that support the answer */
  supporting_session_ids: string[];
  /** Event IDs needed for the answer, in required order */
  required_event_ids: string[];
  /** The latest/current state (for latest_state questions) */
  required_latest_state: string | null;
}
