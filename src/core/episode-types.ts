/**
 * Episode descriptor: the queue file `.harness-memory/queue/<episode_id>.json` written by the hook
 * that closes a turn segment (stop / precompact / next prompt / interrupt / idle sweep) and
 * inserted into `episodes` by the worker (INSERT OR IGNORE). Spec §3.4, §5.2, §5.3.
 */

import type {
  CanonicalTool,
  CloseReason,
  Enforcement,
  FailureClass,
  FiredOutcome,
  Host,
} from "./vocabulary";

export const EPISODE_SCHEMA = "episode.v1";

/** Evidence weight contributions (§5.3 / §13.2 (j)). */
export const EVIDENCE_WEIGHTS = {
  correction: 2,
  resolution: 2,
  remember: 3,
  failure: 1,
} as const;

export const EVIDENCE_WEIGHT_CAP = 10;

export interface EpisodeFlags {
  correction?: 1;
  remember?: 1;
  decision?: 1;
  failure?: 1;
  resolution?: 1;
}

export interface FiredEntry {
  memory_id: string;
  enforcement: Enforcement;
  /** Computed by the stop hook from the ledger (§9.3 B): override | heed | none. */
  outcome: FiredOutcome;
  tool?: CanonicalTool;
}

export interface FailureSignatureEntry {
  sig: string;
  class: FailureClass;
  tool: CanonicalTool;
  scope_ref: string | null;
  program_token: string | null;
  /** seq of the tool_fail line. */
  failed_seq: number;
  /** seq of the tool_ok line that resolved it, or null if unresolved within the segment. */
  resolved_seq: number | null;
}

export interface EpisodeDescriptor {
  schema: typeof EPISODE_SCHEMA;
  id: string;
  host: Host;
  session_id: string;
  session_key: string;
  turn_key: string;
  segment: number;
  started_at: string;
  closed_at: string;
  close_reason: CloseReason;
  /** 'ledger/<file>#<byte_start>-<byte_end>' | 'import:<path>' */
  ledger_ref: string;
  correction_for: string | null;
  /** Rendered last ≤12 tool lines of the corrected episode (context only; never citable). */
  context_ref: string | null;
  scope_refs: string[];
  tools: CanonicalTool[];
  failure_signatures: FailureSignatureEntry[];
  flags: EpisodeFlags;
  fired: FiredEntry[];
  evidence_weight: number;
  event_count: number;
  /** Convenience copies so eligibility can be decided without re-reading the ledger. */
  prompt_text: string | null;
  last_assistant_message: string | null;
}

/**
 * A bare correction cue ("A 말고 B", "never" inside a new instruction) weighs this much; the full
 * EVIDENCE_WEIGHTS.correction needs the episode to correct a previous turn that ran tools (design §5).
 */
export const BARE_CORRECTION_WEIGHT = 1;

export interface EvidenceWeightOptions {
  /**
   * True when the episode corrects a previous turn that had at least one tool call (`correction_for` set and the
   * corrected episode carries a tool line). Only then does the correction flag add EVIDENCE_WEIGHTS.correction;
   * otherwise the flag is a bare cue worth BARE_CORRECTION_WEIGHT (0.6.0-rc.2, design §5).
   */
  correctionReferencesPreviousTurn?: boolean;
}

export function computeEvidenceWeight(
  flags: EpisodeFlags,
  failures: readonly Pick<FailureSignatureEntry, "resolved_seq">[],
  options: EvidenceWeightOptions = {}
): number {
  let weight = 0;
  if (flags.correction === 1) weight += options.correctionReferencesPreviousTurn === true ? EVIDENCE_WEIGHTS.correction : BARE_CORRECTION_WEIGHT;
  if (flags.remember === 1) weight += EVIDENCE_WEIGHTS.remember;
  for (const failure of failures) {
    weight += failure.resolved_seq === null ? EVIDENCE_WEIGHTS.failure : EVIDENCE_WEIGHTS.resolution;
  }
  return Math.min(EVIDENCE_WEIGHT_CAP, weight);
}
