/**
 * Hook I/O contract (spec §8.2, §8.6). Host adapters normalize stdin into `NormalizedHookInput`;
 * hook-core produces a `HookStdout` object that the host adapter serializes (exactly one JSON object,
 * exit code 0, logs go to files only).
 */

import type {
  CanonicalTool,
  Delivery,
  Enforcement,
  HookDecision,
  HookEvent,
  Host,
  ShellDialect,
} from "./vocabulary";

/** Raw Claude Code stdin (fields verified in docs/redesign/design-candidates/host-hook-facts.md). */
export interface ClaudeCodeHookStdin {
  session_id: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name: string;
  permission_mode?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: unknown;
  tool_use_id?: string;
  prompt?: string;
  prompt_id?: string;
  last_assistant_message?: string;
  stop_hook_active?: boolean;
  error?: string;
  is_interrupt?: boolean;
  duration_ms?: number;
  /** PreCompact: manual | auto */
  trigger?: string;
  /** SessionStart: startup | resume | clear | compact */
  source?: string;
  agent_id?: string;
  [key: string]: unknown;
}

export interface NormalizedToolCall {
  host_name: string;
  canonical: CanonicalTool;
  shell_dialect: ShellDialect | null;
  input: Record<string, unknown>;
  use_id: string | null;
  response: unknown;
  error: string | null;
  is_interrupt: boolean;
  exit_code: number | null;
}

export interface NormalizedHookInput {
  host: Host;
  event: HookEvent;
  session_id: string;
  cwd: string;
  permission_mode: string | null;
  tool: NormalizedToolCall | null;
  prompt: string | null;
  prompt_id: string | null;
  turn_id: string | null;
  last_assistant_message: string | null;
  stop_hook_active: boolean;
  trigger: string | null;
  source: string | null;
  agent_id: string | null;
  raw: unknown;
}

export interface ClaudeHookSpecificOutput {
  hookEventName: string;
  additionalContext?: string;
  permissionDecision?: "allow" | "deny" | "ask";
  permissionDecisionReason?: string;
}

/** Exactly one of these objects is printed to stdout; `{}` when there is nothing to say. */
export interface HookStdout {
  hookSpecificOutput?: ClaudeHookSpecificOutput;
  systemMessage?: string;
}

export type HookRunStatus =
  | "ok"
  | "bad_stdin"
  | "snapshot_missing"
  | "disabled"
  | "not_installed"
  | `skipped:${string}`
  | `error:${string}`;

/** One line per hook call in logs/hooks.log (§9.4 observability). */
export interface HookRunSummary {
  event: HookEvent;
  status: HookRunStatus;
  duration_ms: number;
  tool?: string;
  gen: number | null;
  activated: number;
  suppressed: number;
  decision: HookDecision;
  delivery: Delivery;
  enforcement?: Enforcement | null;
}

export const HOOK_IO_LIMITS = {
  stdin_bytes: 1024 * 1024,
  stdin_timeout_ms: 2_000,
  reason_chars: 600,
  target_chars: 4_000,
  mcp_input_chars: 2_000,
} as const;
