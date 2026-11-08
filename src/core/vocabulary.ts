/**
 * Canonical vocabularies shared by every process (hook, worker, CLI, plugin).
 *
 * Conventions
 * - File formats (ledger lines, queue descriptors, snapshots, config) use snake_case keys.
 * - Database records exposed by repositories use camelCase (see src/memory/repository.ts).
 * - Every enumerated value lives here exactly once. Modules import the `*` arrays for runtime
 *   validation and the derived union types for typing. SQL CHECK constraints in
 *   src/db/migrations/017–021 mirror these lists; change both together.
 */

import type {
  ActivationClass,
  LifecycleTrigger,
  MemoryStatus,
  MemoryType,
} from "../db/schema/types";

export type { ActivationClass, LifecycleTrigger, MemoryStatus, MemoryType };

export const MEMORY_TYPES: readonly MemoryType[] = [
  "policy",
  "workflow",
  "pitfall",
  "architecture_constraint",
  "decision",
];

export const MEMORY_STATUSES: readonly MemoryStatus[] = [
  "candidate",
  "active",
  "stale",
  "superseded",
  "rejected",
];

/** Statuses that count as "live" for uniqueness (identity_key / semantic_key partial indexes). */
export const LIVE_STATUSES: readonly MemoryStatus[] = ["candidate", "active", "stale"];

export const LIFECYCLE_TRIGGERS: readonly LifecycleTrigger[] = [
  "session_start",
  "before_model",
  "before_tool",
  "after_tool",
];

export const ACTIVATION_CLASSES: readonly ActivationClass[] = ["baseline", "startup", "scoped", "event"];

export const HOSTS = ["claude-code", "codex", "opencode", "import"] as const;
export type Host = (typeof HOSTS)[number];

export const HOOK_EVENTS = [
  "session-start",
  "prompt",
  "pre-tool",
  "post-tool",
  "post-tool-failure",
  "stop",
  "stop-failure",
  "precompact",
  "session-end",
  "interrupt",
] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

export const AUTHORITIES = ["human", "auto"] as const;
export type Authority = (typeof AUTHORITIES)[number];

export const ENFORCEMENTS = ["advise", "confirm", "soft_deny", "deny"] as const;
export type Enforcement = (typeof ENFORCEMENTS)[number];

export const ENFORCEMENT_RANK: Readonly<Record<Enforcement, number>> = {
  advise: 0,
  confirm: 1,
  soft_deny: 2,
  deny: 3,
};

export function maxEnforcement(values: readonly Enforcement[]): Enforcement | null {
  let best: Enforcement | null = null;
  for (const value of values) {
    if (best === null || ENFORCEMENT_RANK[value] > ENFORCEMENT_RANK[best]) {
      best = value;
    }
  }
  return best;
}

export const KNOWLEDGE_KINDS = [
  "correction",
  "failure_resolution",
  "convention",
  "decision",
  "import",
  "manual",
] as const;
export type KnowledgeKind = (typeof KNOWLEDGE_KINDS)[number];

/** Subset the extractor may emit (import/manual are set by the CLI). */
export const EXTRACTED_KNOWLEDGE_KINDS = [
  "correction",
  "failure_resolution",
  "convention",
  "decision",
] as const;
export type ExtractedKnowledgeKind = (typeof EXTRACTED_KNOWLEDGE_KINDS)[number];

export const SOURCE_KINDS = ["manual", "import", "extraction", "legacy"] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

export const CLOSE_REASONS = ["stop", "precompact", "session_end", "idle", "interrupted", "import"] as const;
export type CloseReason = (typeof CLOSE_REASONS)[number];

export const EPISODE_STATUSES = ["queued", "leased", "extracted", "skipped", "failed", "dead"] as const;
export type EpisodeStatus = (typeof EPISODE_STATUSES)[number];

export const RUN_STATUSES = [
  "started",
  "ok",
  "invalid_output",
  "suspect",
  "timeout",
  "provider_error",
  "no_provider",
  "nested_refusal",
  "not_logged_in",
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const PROVIDERS = ["claude", "codex", "opencode", "replay"] as const;
export type ProviderName = (typeof PROVIDERS)[number];

export const PROBE_RESULTS = [
  "ok",
  "missing",
  "nested_refusal",
  "probe_timeout",
  "not_logged_in",
  "invalid_output",
  "provider_error",
] as const;
export type ProbeResult = (typeof PROBE_RESULTS)[number];

export const PROPOSAL_KINDS = [
  "supersede",
  "stale",
  "activate_policy",
  "activate_global",
  "fix_scope",
  "fix_signature",
  "revalidate",
  "merge",
] as const;
export type ProposalKind = (typeof PROPOSAL_KINDS)[number];

export const PROPOSAL_STATUSES = ["open", "accepted", "rejected", "expired"] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

export const PROPOSAL_DECIDERS = ["human", "auto_rule", "expiry"] as const;
export type ProposalDecider = (typeof PROPOSAL_DECIDERS)[number];

export const PROPOSAL_CREATORS = ["extractor", "consolidator", "migration", "import"] as const;
export type ProposalCreator = (typeof PROPOSAL_CREATORS)[number];

export const PROVENANCE_RELATIONS = ["origin", "reinforce", "contradict", "import"] as const;
export type ProvenanceRelation = (typeof PROVENANCE_RELATIONS)[number];

/** Relations that count toward evidence_count / evidence_score (contradict does not). */
export const EVIDENCE_RELATIONS: readonly ProvenanceRelation[] = ["origin", "reinforce", "import"];

export const TRANSITION_ACTORS = ["human", "auto_rule", "expiry", "import", "migration"] as const;
export type TransitionActor = (typeof TRANSITION_ACTORS)[number];

export const DELIVERIES = ["before", "before_downgraded", "with_result", "none"] as const;
export type Delivery = (typeof DELIVERIES)[number];

export const FIRED_OUTCOMES = ["override", "heed", "none"] as const;
export type FiredOutcome = (typeof FIRED_OUTCOMES)[number];

export const HOOK_DECISIONS = ["allow", "ask", "deny", "none"] as const;
export type HookDecision = (typeof HOOK_DECISIONS)[number];

/**
 * Canonical tool vocabulary (§8.5). `mcp` is a family whose concrete tools are `mcp:<server>/<tool>`.
 * Hosts map their own names onto this (Claude Code `Bash|PowerShell` → `bash`, `Edit|MultiEdit|NotebookEdit`
 * → `edit`, `WebFetch` → `fetch`, `WebSearch` → `other`, `Task|Agent` → `task`, `mcp__s__t` → `mcp:s/t`).
 */
export const CANONICAL_TOOL_FAMILIES = [
  "bash",
  "edit",
  "write",
  "read",
  "grep",
  "glob",
  "fetch",
  "task",
  "mcp",
  "other",
] as const;
export type CanonicalToolFamily = (typeof CANONICAL_TOOL_FAMILIES)[number];
export type CanonicalTool = Exclude<CanonicalToolFamily, "mcp"> | `mcp:${string}`;

/** Families whose tools are registered on PreToolUse (V11 reachability). read/grep/glob/task/other never reach the hook. */
export const PRE_TOOL_HOOKED_FAMILIES: readonly CanonicalToolFamily[] = ["bash", "edit", "write", "fetch", "mcp"];

export function toolFamily(tool: string): CanonicalToolFamily {
  if (tool === "mcp" || tool.startsWith("mcp:")) {
    return "mcp";
  }
  return (CANONICAL_TOOL_FAMILIES as readonly string[]).includes(tool)
    ? (tool as CanonicalToolFamily)
    : "other";
}

export function isCanonicalTool(value: string): value is CanonicalTool {
  if (value.startsWith("mcp:")) {
    return value.length > 4;
  }
  return value !== "mcp" && (CANONICAL_TOOL_FAMILIES as readonly string[]).includes(value);
}

export const SIGNATURE_TARGETS = ["command", "path", "url", "any"] as const;
export type SignatureTarget = (typeof SIGNATURE_TARGETS)[number];

export const PATTERN_KINDS = ["cmd", "glob", "regex", "substring"] as const;
export type PatternKind = (typeof PATTERN_KINDS)[number];

/** Stored form of memories.trigger_signature_json (§4.6). `tool` is a glob over canonical tools. */
export interface TriggerSignature {
  tool: string;
  target: SignatureTarget;
  pattern_kind: PatternKind;
  pattern: string;
  negate?: boolean;
}

export const AUTONOMY_LEVELS = ["off", "shadow", "standard"] as const;
export type AutonomyLevel = (typeof AUTONOMY_LEVELS)[number];

export const SHELL_DIALECTS = ["bash", "powershell", "cmd", "unknown"] as const;
export type ShellDialect = (typeof SHELL_DIALECTS)[number];

export const FIXED_FAILURE_CLASSES = ["enoent", "eacces", "timeout", "interrupt", "other"] as const;
export type FailureClass = (typeof FIXED_FAILURE_CLASSES)[number] | `exit_${number}`;

export function isFailureClass(value: string): value is FailureClass {
  return (FIXED_FAILURE_CLASSES as readonly string[]).includes(value) || /^exit_\d+$/.test(value);
}

/** Global scope spellings accepted on input; GLOBAL_SCOPE is the canonical one for new rows. */
export const GLOBAL_SCOPE = "**/*";
export const GLOBAL_SCOPE_SPELLINGS: readonly string[] = ["**/*", "**", "*", "."];

export function isGlobalScope(scopeGlob: string): boolean {
  return GLOBAL_SCOPE_SPELLINGS.includes(scopeGlob.trim());
}

export const STATUS_REASONS = [
  "human",
  "auto_rule",
  "ttl_expired",
  "expiry",
  "cap",
  "migration",
  "import",
  "import_sync",
  "revalidate_expired",
  /** Active from birth because the user asked to remember it (A′ remember-as-human; src/promotion/remember.ts). */
  "remember",
] as const;
export type StatusReason = (typeof STATUS_REASONS)[number];
