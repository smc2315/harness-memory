/**
 * Ledger fixture → synthetic Claude Code stdin. A recorded ledger turn is the script the hooks are
 * replayed against: a `prompt` line becomes UserPromptSubmit, a `tool_ok`/`tool_fail` line becomes
 * PreToolUse (Claude Code always runs it first) + PostToolUse / PostToolUseFailure, a `fired` line is
 * the PreToolUse that fired, an `assistant` line is Stop. The hooks then re-record the ledger, and
 * `compareLedgerLines` checks that the capture path reproduced the fixture field by field.
 */

import { join } from "node:path";

import type { ClaudeCodeHookStdin } from "../../core/hook-types";
import type { LedgerLine, ToolFailLine, ToolOkLine } from "../../core/ledger-types";
import type { HookEvent } from "../../core/vocabulary";

export interface ScriptedEvent {
  event: HookEvent;
  stdin: Partial<ClaudeCodeHookStdin>;
  /** The fixture line this event stands for (null for the synthesized PreToolUse before a tool line). */
  fixtureSeq: number | null;
}

type ToolLine = ToolOkLine | ToolFailLine;

function isToolLine(line: LedgerLine): line is ToolLine {
  return line.kind === "tool_ok" || line.kind === "tool_fail";
}

/** Claude Code tool name for a canonical tool (fired lines carry no host name). */
export function hostToolFor(canonical: string, dialect: string | null | undefined): string {
  switch (canonical) {
    case "bash":
      return dialect === "powershell" ? "PowerShell" : "Bash";
    case "edit":
      return "Edit";
    case "write":
      return "Write";
    case "read":
      return "Read";
    case "grep":
      return "Grep";
    case "glob":
      return "Glob";
    case "fetch":
      return "WebFetch";
    case "task":
      return "Task";
    default:
      if (canonical.startsWith("mcp:")) {
        const [server, tool] = canonical.slice(4).split("/");
        return `mcp__${server ?? "server"}__${tool ?? "tool"}`;
      }
      return canonical;
  }
}

/** `tool_input` that makes `pickTarget` reproduce the recorded `input_digest` / `target_digest`. */
export function toolInputFor(canonical: string, digest: string, root: string): Record<string, unknown> {
  switch (canonical) {
    case "bash":
      return { command: digest, description: "replay" };
    case "edit":
      return { file_path: join(root, ...digest.split("/")), old_string: "before", new_string: "after" };
    case "write":
      return { file_path: join(root, ...digest.split("/")), content: "" };
    case "read":
      return { file_path: join(root, ...digest.split("/")) };
    case "grep":
      return { pattern: digest, path: root };
    case "glob":
      return { pattern: digest, path: root };
    case "fetch":
      return { url: digest };
    default: {
      try {
        const parsed: unknown = JSON.parse(digest);
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
      } catch {
        // not JSON: fall through
      }
      return { input: digest };
    }
  }
}

function toolStdin(line: ToolLine, root: string): Partial<ClaudeCodeHookStdin> {
  return {
    tool_name: line.host_tool,
    tool_input: toolInputFor(line.tool, line.input_digest, root),
    ...(line.tool_use_id !== null ? { tool_use_id: line.tool_use_id } : {}),
  };
}

function responseOf(line: ToolLine): string {
  return line.output_tail.length > 0 ? `${line.output_head}${line.output_tail}` : line.output_head;
}

export interface ScriptTurnOptions {
  root: string;
  /** Emit a PreToolUse before tool lines that are not preceded by a fired line (default true). */
  preToolBeforeToolLines?: boolean;
}

/** Turns the fixture lines of one turn into the hook events Claude Code would have fired. */
export function scriptTurn(lines: readonly LedgerLine[], options: ScriptTurnOptions): ScriptedEvent[] {
  const events: ScriptedEvent[] = [];
  const emitPreTool = options.preToolBeforeToolLines !== false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    switch (line.kind) {
      case "prompt":
        events.push({ event: "prompt", stdin: { prompt: line.text, prompt_id: line.prompt_id ?? line.turn_key }, fixtureSeq: line.seq });
        break;
      case "fired": {
        const next = lines[index + 1];
        const dialect = next !== undefined && isToolLine(next) && next.tool === line.tool ? next.shell_dialect : null;
        events.push({
          event: "pre-tool",
          stdin: { tool_name: hostToolFor(line.tool, dialect), tool_input: toolInputFor(line.tool, line.target_digest, options.root) },
          fixtureSeq: line.seq,
        });
        break;
      }
      case "tool_ok":
      case "tool_fail": {
        const previous = lines[index - 1];
        const firedBefore = previous !== undefined && previous.kind === "fired" && previous.tool === line.tool;
        const stdin = toolStdin(line, options.root);
        if (emitPreTool && !firedBefore) events.push({ event: "pre-tool", stdin, fixtureSeq: null });
        if (line.kind === "tool_ok") {
          events.push({ event: "post-tool", stdin: { ...stdin, tool_response: responseOf(line) }, fixtureSeq: line.seq });
        } else {
          events.push({
            event: "post-tool-failure",
            stdin: { ...stdin, tool_response: responseOf(line), error: line.error, is_interrupt: line.is_interrupt },
            fixtureSeq: line.seq,
          });
        }
        break;
      }
      case "assistant":
        events.push({
          event: "stop",
          stdin: { last_assistant_message: line.text, ...(line.stop_hook_active === true ? { stop_hook_active: true } : {}) },
          fixtureSeq: line.seq,
        });
        break;
      case "marker":
        switch (line.marker) {
          case "session_start":
            events.push({ event: "session-start", stdin: { source: line.detail ?? "startup" }, fixtureSeq: line.seq });
            break;
          case "precompact":
            events.push({ event: "precompact", stdin: { trigger: line.detail ?? "manual" }, fixtureSeq: line.seq });
            break;
          case "session_end":
            events.push({ event: "session-end", stdin: { reason: line.detail ?? "other" }, fixtureSeq: line.seq });
            break;
          case "stop_failure":
            events.push({ event: "stop-failure", stdin: { error: line.detail ?? "error" }, fixtureSeq: line.seq });
            break;
          case "interrupt":
            events.push({ event: "interrupt", stdin: {}, fixtureSeq: line.seq });
            break;
          default:
            break; // idle_close is produced by sweeps, never replayed
        }
        break;
      default:
        break;
    }
  }
  return events;
}

// ---------------------------------------------------------------------------------------------
// Comparing the fixture with what the hooks recorded
// ---------------------------------------------------------------------------------------------

/** The fields the capture path must reproduce (ts / seq / turn_key / tool_use_id are process facts). */
export function projectLine(line: LedgerLine): Record<string, unknown> {
  switch (line.kind) {
    case "prompt":
      return { kind: line.kind, text: line.text, correction: line.correction, remember: line.remember };
    case "tool_ok":
      return {
        kind: line.kind,
        tool: line.tool,
        host_tool: line.host_tool,
        shell_dialect: line.shell_dialect,
        input_digest: line.input_digest,
        scope_refs: line.scope_refs,
        program_token: line.program_token,
        output_head: line.output_head,
        resolution_of: line.resolution_of,
      };
    case "tool_fail":
      return {
        kind: line.kind,
        tool: line.tool,
        host_tool: line.host_tool,
        shell_dialect: line.shell_dialect,
        input_digest: line.input_digest,
        scope_refs: line.scope_refs,
        program_token: line.program_token,
        error: line.error,
        is_interrupt: line.is_interrupt,
        exit_code: line.exit_code,
        failure_class: line.failure_class,
        failure_sig: line.failure_sig,
      };
    case "assistant":
      return { kind: line.kind, text: line.text };
    case "marker":
      return { kind: line.kind, marker: line.marker, ...(line.detail !== undefined ? { detail: line.detail } : {}) };
    case "fired":
      return {
        kind: line.kind,
        memory_ids: [...line.memory_ids].sort(),
        tool: line.tool,
        target_digest: line.target_digest,
        decision: line.decision,
        enforcement: line.enforcement,
        delivery: line.delivery,
        ...(line.signature_keys !== undefined ? { signature_keys: [...line.signature_keys].sort() } : {}),
      };
  }
}

export interface LedgerComparison {
  /** fixture seq → produced seq for the non-fired lines paired by position. */
  seqMap: Map<number, number>;
  mismatches: string[];
}

function diffProjection(expected: Record<string, unknown>, actual: Record<string, unknown>): string[] {
  const diffs: string[] = [];
  for (const key of Object.keys(expected)) {
    const left = JSON.stringify(expected[key]);
    const right = JSON.stringify(actual[key]);
    if (left !== right) diffs.push(`${key}: fixture ${left} vs hook ${right}`);
  }
  return diffs;
}

/**
 * Pairs the fixture's non-fired lines with the produced non-fired lines by position and compares their
 * projections; fired lines are paired separately (the hooks may fire more or fewer times than a
 * hand-written fixture shows, so they are compared only when `compareFired` is set).
 */
export function compareLedgerLines(fixture: readonly LedgerLine[], produced: readonly LedgerLine[], options: { compareFired?: boolean } = {}): LedgerComparison {
  const seqMap = new Map<number, number>();
  const mismatches: string[] = [];
  const expected = fixture.filter((line) => line.kind !== "fired");
  const actual = produced.filter((line) => line.kind !== "fired");
  if (expected.length !== actual.length) {
    mismatches.push(`line count: fixture ${String(expected.length)} non-fired lines vs hook ${String(actual.length)} (${actual.map((line) => line.kind).join(",")})`);
  }
  const pairs = Math.min(expected.length, actual.length);
  for (let index = 0; index < pairs; index += 1) {
    const left = expected[index]!;
    const right = actual[index]!;
    seqMap.set(left.seq, right.seq);
    const diffs = diffProjection(projectLine(left), projectLine(right));
    if (diffs.length > 0) mismatches.push(`line ${String(index)} (${left.kind} e${String(left.seq)}): ${diffs.join("; ")}`);
  }
  if (options.compareFired === true) {
    const expectedFired = fixture.filter((line) => line.kind === "fired");
    const actualFired = produced.filter((line) => line.kind === "fired");
    if (expectedFired.length !== actualFired.length) {
      mismatches.push(`fired count: fixture ${String(expectedFired.length)} vs hook ${String(actualFired.length)}`);
    }
    const firedPairs = Math.min(expectedFired.length, actualFired.length);
    for (let index = 0; index < firedPairs; index += 1) {
      const left = expectedFired[index]!;
      const right = actualFired[index]!;
      seqMap.set(left.seq, right.seq);
      const diffs = diffProjection(projectLine(left), projectLine(right));
      if (diffs.length > 0) mismatches.push(`fired ${String(index)} (e${String(left.seq)}): ${diffs.join("; ")}`);
    }
  }
  return { seqMap, mismatches };
}
