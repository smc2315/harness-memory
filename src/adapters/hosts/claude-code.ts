/**
 * Claude Code host adapter (spec §8.2, §8.5, §8.6, §7.2): stdin JSON → `NormalizedHookInput`, and the
 * host-neutral `HookResult` → the one JSON object Claude Code reads. Tool names are canonicalized
 * through `src/activation/tool-vocabulary.ts`; `PostToolUseFailure.error`'s first line `Exit code N`
 * yields `exit_code`. `permissionDecision` is only ever `ask` or `deny` (never `allow`), and the
 * silent events (Stop, StopFailure, PreCompact, SessionEnd) produce no stdout at all.
 */

import type { ClaudeCodeHookStdin, ClaudeHookSpecificOutput, HookStdout, NormalizedHookInput, NormalizedToolCall } from "../../core/hook-types";
import { HOOK_EVENTS, type HookEvent } from "../../core/vocabulary";
import { canonicalizeHostTool } from "../../activation/tool-vocabulary";
import { parseExitCode } from "../../dream/ledger";
import type { HookResult } from "../hook-core";

export const CLAUDE_CODE_EVENT_NAMES: Readonly<Record<HookEvent, string>> = {
  "session-start": "SessionStart",
  prompt: "UserPromptSubmit",
  "pre-tool": "PreToolUse",
  "post-tool": "PostToolUse",
  "post-tool-failure": "PostToolUseFailure",
  stop: "Stop",
  "stop-failure": "StopFailure",
  precompact: "PreCompact",
  "session-end": "SessionEnd",
  interrupt: "Interrupt",
};

/** Events whose stdout Claude Code would interpret (Stop continuation, PreCompact instructions): we print nothing. */
export const SILENT_EVENTS: ReadonlySet<HookEvent> = new Set(["stop", "stop-failure", "precompact", "session-end", "interrupt"]);

export function isHookEvent(value: unknown): value is HookEvent {
  return typeof value === "string" && (HOOK_EVENTS as readonly string[]).includes(value);
}

export function hookEventFromClaudeName(name: string | undefined): HookEvent | null {
  if (name === undefined) return null;
  for (const [event, claudeName] of Object.entries(CLAUDE_CODE_EVENT_NAMES) as Array<[HookEvent, string]>) {
    if (claudeName === name) return event;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** JSON parse + the one field every event carries (`session_id`); anything else → null (`bad_stdin`). */
export function parseClaudeCodeStdin(raw: string): ClaudeCodeHookStdin | null {
  if (raw.trim().length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || typeof parsed.session_id !== "string" || parsed.session_id.length === 0) return null;
  if (typeof parsed.hook_event_name !== "string") parsed.hook_event_name = "";
  return parsed as unknown as ClaudeCodeHookStdin;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function normalizeClaudeCodeTool(stdin: ClaudeCodeHookStdin): NormalizedToolCall | null {
  if (typeof stdin.tool_name !== "string" || stdin.tool_name.length === 0) return null;
  const { canonical, shellDialect } = canonicalizeHostTool("claude-code", stdin.tool_name);
  const error = optionalString(stdin.error);
  return {
    host_name: stdin.tool_name,
    canonical,
    shell_dialect: shellDialect,
    input: isRecord(stdin.tool_input) ? stdin.tool_input : {},
    use_id: optionalString(stdin.tool_use_id),
    response: stdin.tool_response ?? null,
    error,
    is_interrupt: stdin.is_interrupt === true,
    exit_code: parseExitCode(error),
  };
}

/** The argv event wins over `hook_event_name` (install registers one command per event). */
export function normalizeClaudeCode(stdin: ClaudeCodeHookStdin, argvEvent: HookEvent | null): NormalizedHookInput | null {
  const event = argvEvent ?? hookEventFromClaudeName(stdin.hook_event_name);
  if (event === null) return null;
  return {
    host: "claude-code",
    event,
    session_id: stdin.session_id,
    cwd: optionalString(stdin.cwd) ?? process.cwd(),
    permission_mode: optionalString(stdin.permission_mode),
    tool: normalizeClaudeCodeTool(stdin),
    prompt: typeof stdin.prompt === "string" ? stdin.prompt : null,
    prompt_id: optionalString(stdin.prompt_id),
    turn_id: null,
    last_assistant_message: typeof stdin.last_assistant_message === "string" ? stdin.last_assistant_message : null,
    stop_hook_active: stdin.stop_hook_active === true,
    trigger: optionalString(stdin.trigger),
    source: optionalString(stdin.source),
    agent_id: optionalString(stdin.agent_id),
    raw: stdin,
  };
}

/**
 * §7.2 / §8.6: ask / deny + reason on PreToolUse, `additionalContext` on the context-bearing events,
 * `systemMessage` only when the result carries one (confirm / soft_deny / deny / digest / notify).
 * Returns `{}` when there is nothing to say and null for the silent events.
 */
export function renderClaudeCode(result: Pick<HookResult, "event" | "decision" | "reason" | "additionalContext" | "systemMessage">): HookStdout | null {
  if (SILENT_EVENTS.has(result.event)) return null;
  const output: HookStdout = {};
  const specific: ClaudeHookSpecificOutput = { hookEventName: CLAUDE_CODE_EVENT_NAMES[result.event] };
  let hasSpecific = false;

  if (result.event === "pre-tool" && (result.decision === "ask" || result.decision === "deny")) {
    specific.permissionDecision = result.decision;
    specific.permissionDecisionReason = result.reason ?? "[harness-memory] a stored memory applies to this tool call";
    hasSpecific = true;
  }
  if (result.additionalContext !== null && result.additionalContext.length > 0) {
    specific.additionalContext = result.additionalContext;
    hasSpecific = true;
  }
  if (hasSpecific) output.hookSpecificOutput = specific;
  if (result.systemMessage !== null && result.systemMessage.length > 0) output.systemMessage = result.systemMessage;
  return output;
}
