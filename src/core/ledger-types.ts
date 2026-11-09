/**
 * Ledger file format (`.harness-memory/ledger/<host>-<session_key>.jsonl`) and per-session state.
 *
 * One JSON object per line, appended with a single `appendFileSync` (≤ 32 KB), never rewritten
 * during a session. Hooks are the only writers; the worker only reads byte ranges referenced by
 * episode descriptors. Keys are snake_case because this is a file format (spec §5.1).
 */

import type {
  CanonicalTool,
  Delivery,
  Enforcement,
  FailureClass,
  HookDecision,
  Host,
  ShellDialect,
} from "./vocabulary";

export const LEDGER_LIMITS = {
  /** Hard cap on one serialized line. Longer lines are truncated field by field before writing. */
  line_bytes: 32 * 1024,
  prompt_text: 4_000,
  assistant_text: 2_000,
  output_head: 2_000,
  output_tail: 1_000,
  error_text: 1_500,
  input_digest: 500,
  target_digest: 120,
  /** Bytes read from the end of the ledger by pre-tool/post-tool hooks (firedKeys, lastScopeRef, pending failures). */
  tail_read_bytes: 256 * 1024,
  /** Bytes read by stop/precompact when closing a turn segment. */
  turn_read_bytes: 4 * 1024 * 1024,
} as const;

export type LedgerLineKind = "prompt" | "fired" | "tool_ok" | "tool_fail" | "assistant" | "marker";

export interface LedgerLineBase {
  kind: LedgerLineKind;
  /** ISO 8601 UTC. */
  ts: string;
  /** Monotonic within a process: hooks use Date.now()-based sequence; episodes renumber as e<seq>. */
  seq: number;
  turn_key: string;
  /** Present when the event came from a subagent; such lines are excluded from episodes by default. */
  agent_id?: string;
}

export interface PromptLine extends LedgerLineBase {
  kind: "prompt";
  text: string;
  correction: 0 | 1;
  remember: 0 | 1;
  prompt_id?: string;
}

export interface FiredLine extends LedgerLineBase {
  kind: "fired";
  memory_ids: string[];
  rule_codes: string[];
  tool: CanonicalTool;
  target_digest: string;
  delivery: Delivery;
  decision: HookDecision;
  enforcement: Enforcement | null;
  /** signature_key of each fired memory with a signature; used by the stop hook to compute override/heed. */
  signature_keys?: string[];
}

export interface ToolOkLine extends LedgerLineBase {
  kind: "tool_ok";
  tool_use_id: string | null;
  tool: CanonicalTool;
  host_tool: string;
  shell_dialect: ShellDialect | null;
  input_digest: string;
  scope_refs: string[];
  /** First canonical program token of a command (`pm test` style) or null for non-command tools. */
  program_token: string | null;
  output_head: string;
  output_tail: string;
  /** failure_sig of an earlier tool_fail line in this session that this success resolves, else null. */
  resolution_of: string | null;
}

export interface ToolFailLine extends LedgerLineBase {
  kind: "tool_fail";
  tool_use_id: string | null;
  tool: CanonicalTool;
  host_tool: string;
  shell_dialect: ShellDialect | null;
  input_digest: string;
  scope_refs: string[];
  program_token: string | null;
  output_head: string;
  output_tail: string;
  error: string;
  is_interrupt: boolean;
  exit_code: number | null;
  failure_class: FailureClass;
  /** `<tool>|<class>|<scope_ref | program token>` (§5.1). */
  failure_sig: string;
}

export interface AssistantLine extends LedgerLineBase {
  kind: "assistant";
  text: string;
  stop_hook_active?: boolean;
}

export type MarkerKind =
  | "session_start"
  | "precompact"
  | "session_end"
  | "stop_failure"
  | "interrupt"
  | "idle_close";

export interface MarkerLine extends LedgerLineBase {
  kind: "marker";
  marker: MarkerKind;
  detail?: string;
}

export type LedgerLine = PromptLine | FiredLine | ToolOkLine | ToolFailLine | AssistantLine | MarkerLine;

/**
 * `.harness-memory/state/<host>-<session_key>.json`, written tmp+rename only by the host-serialized
 * hooks `prompt`, `stop`, `precompact` (and `session-end`). Parallel hooks never write it (§5.2, §9.1).
 */
export interface SessionState {
  schema: "state.v1";
  host: Host;
  session_id: string;
  session_key: string;
  /** Null before the first prompt of the session. */
  turn_key: string | null;
  /** Byte offset in the ledger where the open segment starts; the prompt line is inside the segment. */
  turn_start_offset: number;
  segment: number;
  /** Set by the prompt hook when the prompt corrects the previous episode. */
  correction_for?: string;
  /** Id of the most recently closed episode (becomes correction_for on a correcting prompt). */
  last_episode_id?: string;
  /** Ledger byte range of that episode; the stop hook renders its tool lines into `context_ref` (§5.2). */
  last_episode_range?: { start: number; end: number };
  /** Daily systemMessage throttle (ISO date of the last digest). */
  last_digest_date?: string;
  updated_at: string;
}

/** `.harness-memory/state/<host>-<session_key>.notify.json`: worker → next prompt hook (§7.4). */
export interface NotifyFile {
  schema: "notify.v1";
  messages: string[];
  created_at: string;
}
