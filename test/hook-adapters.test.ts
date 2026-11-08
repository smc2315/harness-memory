/**
 * Host adapter and hook I/O: Claude Code stdin normalization and stdout rendering, stdin reading with
 * guards, hooks.log formatting and rotation.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, test } from "vitest";

import { emptyResult } from "../src/adapters/hook-core";
import { appendHookLog, formatHookLogLine, readStdin, rotateLog, writeStdout } from "../src/adapters/hook-io";
import {
  CLAUDE_CODE_EVENT_NAMES,
  hookEventFromClaudeName,
  isHookEvent,
  normalizeClaudeCode,
  parseClaudeCodeStdin,
  renderClaudeCode,
} from "../src/adapters/hosts/claude-code";
import type { HookRunSummary } from "../src/core/hook-types";
import { HOOK_EVENTS } from "../src/core/vocabulary";

describe("claude-code host adapter", () => {
  test("parseClaudeCodeStdin accepts only objects with a session_id", () => {
    expect(parseClaudeCodeStdin("")).toBeNull();
    expect(parseClaudeCodeStdin("not json")).toBeNull();
    expect(parseClaudeCodeStdin("[1,2]")).toBeNull();
    expect(parseClaudeCodeStdin('{"hook_event_name":"PreToolUse"}')).toBeNull();
    expect(parseClaudeCodeStdin('{"session_id":"s"}')).toMatchObject({ session_id: "s", hook_event_name: "" });
  });

  test("every hook event has a Claude Code name and maps back", () => {
    for (const event of HOOK_EVENTS) {
      expect(hookEventFromClaudeName(CLAUDE_CODE_EVENT_NAMES[event])).toBe(event);
      expect(isHookEvent(event)).toBe(true);
    }
    expect(hookEventFromClaudeName("Notification")).toBeNull();
    expect(isHookEvent("PreToolUse")).toBe(false);
  });

  test("normalizeClaudeCode canonicalizes tools, dialects, mcp names and exit codes", () => {
    const failure = normalizeClaudeCode(
      {
        session_id: "s1",
        hook_event_name: "PostToolUseFailure",
        cwd: "C:\\repo",
        tool_name: "PowerShell",
        tool_input: { command: "npm test" },
        tool_use_id: "toolu_1",
        error: "Exit code 2\nnpm ERR! Test failed.",
        is_interrupt: false,
        permission_mode: "plan",
        prompt_id: "p1",
      },
      null
    );
    expect(failure).toMatchObject({
      host: "claude-code",
      event: "post-tool-failure",
      cwd: "C:\\repo",
      permission_mode: "plan",
      prompt_id: "p1",
      tool: { host_name: "PowerShell", canonical: "bash", shell_dialect: "powershell", use_id: "toolu_1", exit_code: 2, is_interrupt: false },
    });

    const mcp = normalizeClaudeCode({ session_id: "s1", hook_event_name: "PreToolUse", tool_name: "mcp__GitHub__create_issue", tool_input: { title: "t" } }, "pre-tool");
    expect(mcp?.tool).toMatchObject({ canonical: "mcp:github/create_issue", shell_dialect: null, exit_code: null });

    const argvWins = normalizeClaudeCode({ session_id: "s1", hook_event_name: "PostToolUse", tool_name: "Read", tool_input: {} }, "post-tool-failure");
    expect(argvWins?.event).toBe("post-tool-failure");
    expect(argvWins?.tool?.canonical).toBe("read");

    expect(normalizeClaudeCode({ session_id: "s1", hook_event_name: "Notification" }, null)).toBeNull();
    const stop = normalizeClaudeCode({ session_id: "s1", hook_event_name: "Stop", last_assistant_message: "done", stop_hook_active: true }, null);
    expect(stop).toMatchObject({ event: "stop", last_assistant_message: "done", stop_hook_active: true, tool: null, prompt: null });
  });

  test("renderClaudeCode: ask / deny / context / silent", () => {
    const ask = { ...emptyResult("pre-tool", "ok"), decision: "ask" as const, reason: "why", systemMessage: "harness-memory: policy abc fired (confirm)" };
    expect(renderClaudeCode(ask)).toEqual({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: "why" },
      systemMessage: "harness-memory: policy abc fired (confirm)",
    });

    const deny = { ...emptyResult("pre-tool", "ok"), decision: "deny" as const, reason: "no", additionalContext: "also this" };
    expect(renderClaudeCode(deny)?.hookSpecificOutput).toEqual({ hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "no", additionalContext: "also this" });

    const context = { ...emptyResult("prompt", "ok"), additionalContext: "ctx" };
    expect(renderClaudeCode(context)).toEqual({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "ctx" } });

    // A decision on a non-PreToolUse event is never rendered as a permission decision.
    const promptDeny = { ...emptyResult("prompt", "ok"), decision: "deny" as const, reason: "x" };
    expect(renderClaudeCode(promptDeny)).toEqual({});

    expect(renderClaudeCode(emptyResult("post-tool", "ok"))).toEqual({});
    for (const event of ["stop", "stop-failure", "precompact", "session-end", "interrupt"] as const) {
      expect(renderClaudeCode({ ...emptyResult(event, "ok"), additionalContext: "never" })).toBeNull();
    }
  });
});

describe("hook io", () => {
  let dir: string | null = null;

  afterEach(() => {
    if (dir !== null) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  test("readStdin collects the whole stream and respects the byte cap and the timeout", async () => {
    const stream = new PassThrough();
    const pending = readStdin({ stream, timeoutMs: 2_000 });
    stream.write('{"a":');
    stream.write("1}");
    stream.end();
    expect(await pending).toBe('{"a":1}');

    const capped = new PassThrough();
    const cappedPending = readStdin({ stream: capped, maxBytes: 5, timeoutMs: 2_000 });
    capped.write("0123456789");
    expect(await cappedPending).toBe("01234");

    const silent = new PassThrough();
    const started = Date.now();
    const timedOut = await readStdin({ stream: silent, timeoutMs: 60 });
    expect(timedOut).toBe("");
    expect(Date.now() - started).toBeGreaterThanOrEqual(50);

    const tty = Object.assign(new PassThrough(), { isTTY: true });
    expect(await readStdin({ stream: tty, timeoutMs: 1_000 })).toBe("");
  });

  test("writeStdout prints one JSON line or nothing", () => {
    const chunks: string[] = [];
    const stream = { write: (chunk: string) => chunks.push(chunk) };
    writeStdout({}, stream);
    writeStdout(null, stream);
    writeStdout({ systemMessage: "m" }, stream);
    expect(chunks).toEqual(["{}\n", '{"systemMessage":"m"}\n']);
  });

  test("appendHookLog formats one line per call and rotates at the configured size", () => {
    dir = mkdtempSync(join(tmpdir(), "hm-log-"));
    const paths = { logsDir: join(dir, "logs"), hooksLog: join(dir, "logs", "hooks.log") };
    const summary: HookRunSummary = { event: "pre-tool", status: "ok", duration_ms: 63.4, tool: "bash", gen: 42, activated: 1, suppressed: 17, decision: "deny", delivery: "before", enforcement: "soft_deny" };
    expect(formatHookLogLine(summary, "2026-11-08T10:00:00.000Z")).toBe(
      "2026-11-08T10:00:00.000Z pre-tool tool=bash gen=42 activated=1 suppressed=17 decision=deny delivery=before enforcement=soft_deny dur=63ms ok"
    );

    for (let index = 0; index < 40; index += 1) {
      appendHookLog(paths, summary, { maxBytes: 600, rotations: 3, now: "2026-11-08T10:00:00.000Z" });
    }
    expect(existsSync(paths.hooksLog)).toBe(true);
    expect(existsSync(`${paths.hooksLog}.1`)).toBe(true);
    expect(existsSync(`${paths.hooksLog}.2`)).toBe(true);
    expect(existsSync(`${paths.hooksLog}.3`)).toBe(true);
    expect(existsSync(`${paths.hooksLog}.4`)).toBe(false);
    expect(statSync(paths.hooksLog).size).toBeLessThan(600 + 200);

    appendHookLog(paths, { ...summary, status: "bad_stdin", gen: null }, { debug: true, detail: { bytes: 3 }, now: "2026-11-08T10:00:01.000Z" });
    const lines = readFileSync(paths.hooksLog, "utf8").trim().split("\n");
    expect(lines.at(-2)).toContain("gen=- activated=1");
    expect(JSON.parse(lines.at(-1)!)).toMatchObject({ summary: { status: "bad_stdin" }, detail: { bytes: 3 } });

    // rotateLog on a missing file is a no-op.
    rotateLog(join(dir, "missing.log"), 10, 3);
  });
});
