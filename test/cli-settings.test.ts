import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import { parseHookLogLine, percentile, summarizeHookLog } from "../src/cli/lib/hooks-log";
import {
  buildHookCommand,
  chooseHookForm,
  claudeVersionSpawn,
  compareVersions,
  detectClaudeVersion,
  EXEC_FORM_MIN_VERSION,
  HOOK_REGISTRATIONS,
  isHarnessHookCommand,
  isWindowsShim,
  listHarnessHooks,
  mergeHarnessHooks,
  serializeSettings,
  stripHarnessHooks,
  type HookCommandSpec,
} from "../src/cli/lib/settings";

const spec: HookCommandSpec = { execPath: "C:\\Program Files\\nodejs\\node.exe", hookScript: "C:\\repo\\node_modules\\harness-memory\\dist\\hook.js", form: "exec", shell: null };

describe("hook registrations (§8.2)", () => {
  test("nine events with the spec's matchers and timeouts", () => {
    const byEvent = Object.fromEntries(HOOK_REGISTRATIONS.map((registration) => [registration.claudeEvent, registration]));
    expect(Object.keys(byEvent).sort()).toEqual(["PostToolUse", "PostToolUseFailure", "PreCompact", "PreToolUse", "SessionEnd", "SessionStart", "Stop", "StopFailure", "UserPromptSubmit"]);
    expect(byEvent.PreToolUse!.matcher).toBe("Bash|PowerShell|Edit|MultiEdit|Write|NotebookEdit|WebFetch|mcp__.*");
    expect(byEvent.PreToolUse!.timeout).toBe(5);
    expect(byEvent.PostToolUse!.matcher).toBe(".*");
    expect(byEvent.PostToolUseFailure!.timeout).toBe(5);
    expect(byEvent.PreCompact!.matcher).toBe("manual|auto");
    expect(byEvent.SessionEnd!.timeout).toBe(1);
    expect(byEvent.SessionStart!.matcher).toBeNull();
    expect(byEvent.SessionStart!.timeout).toBe(10);
  });

  test("exec form carries the node binary and [hook.js, event] args; shell form quotes both paths", () => {
    const preTool = HOOK_REGISTRATIONS.find((registration) => registration.event === "pre-tool")!;
    expect(buildHookCommand(spec, preTool)).toEqual({ type: "command", command: spec.execPath, args: [spec.hookScript, "pre-tool"], timeout: 5 });
    const shell = buildHookCommand({ ...spec, form: "shell", shell: "powershell" }, preTool);
    expect(shell).toEqual({ type: "command", command: `"${spec.execPath}" "${spec.hookScript}" pre-tool`, timeout: 5, shell: "powershell" });
    expect(isHarnessHookCommand(shell)).toBe(true);
  });
});

describe("settings merge", () => {
  const foreign = { type: "command", command: "echo other", timeout: 3 };
  const oldHarness = { type: "command", command: "/usr/bin/node", args: ["/old/place/dist/hook.js", "pre-tool"], timeout: 5 };

  test("recognises our entries by shape only", () => {
    expect(isHarnessHookCommand(oldHarness)).toBe(true);
    expect(isHarnessHookCommand(foreign)).toBe(false);
    expect(isHarnessHookCommand({ type: "command", command: "node", args: ["/x/hook.js", "not-an-event"] })).toBe(false);
    expect(isHarnessHookCommand({ type: "command", command: "node some/other/hook.js pre-tool" })).toBe(true);
  });

  test("merge replaces earlier harness entries, keeps foreign hooks and is idempotent", () => {
    const settings = {
      permissions: { allow: ["Bash(npm test)"] },
      hooks: {
        PreToolUse: [{ matcher: "Bash", hooks: [foreign, oldHarness] }],
        Notification: [{ hooks: [{ ...oldHarness, args: ["/old/place/dist/hook.js", "session-start"] }] }],
      },
    };
    const first = mergeHarnessHooks(settings, spec);
    expect(first.replaced).toBe(2);
    expect(first.written).toBe(HOOK_REGISTRATIONS.length);
    const hooks = first.settings.hooks as Record<string, Array<{ matcher?: string; hooks: unknown[] }>>;
    expect(hooks.Notification).toBeUndefined();
    expect(hooks.PreToolUse).toHaveLength(2);
    expect(hooks.PreToolUse![0]).toEqual({ matcher: "Bash", hooks: [foreign] });
    expect(hooks.PreToolUse![1]!.matcher).toBe("Bash|PowerShell|Edit|MultiEdit|Write|NotebookEdit|WebFetch|mcp__.*");
    expect((first.settings as { permissions: unknown }).permissions).toEqual(settings.permissions);

    const second = mergeHarnessHooks(first.settings, spec);
    expect(second.replaced).toBe(HOOK_REGISTRATIONS.length);
    expect(serializeSettings(second.settings)).toBe(serializeSettings(first.settings));
    expect(listHarnessHooks(second.settings)).toHaveLength(HOOK_REGISTRATIONS.length);
    expect(listHarnessHooks(second.settings).map((entry) => entry.event)).toContain("session-end");
  });

  test("strip removes every harness entry and drops empty groups and the empty hooks object", () => {
    const merged = mergeHarnessHooks({}, spec).settings;
    const stripped = stripHarnessHooks(merged);
    expect(stripped.removed).toBe(HOOK_REGISTRATIONS.length);
    expect(stripped.settings).toEqual({});
    const mixed = stripHarnessHooks({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [foreign, oldHarness] }] } });
    expect(mixed.removed).toBe(1);
    expect(mixed.settings).toEqual({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [foreign] }] } });
  });
});

describe("hook form selection", () => {
  test("compares versions numerically", () => {
    expect(compareVersions("2.1.172", EXEC_FORM_MIN_VERSION)).toBe(1);
    expect(compareVersions("2.1.139", "2.1.139")).toBe(0);
    expect(compareVersions("2.0.9", "2.1.0")).toBe(-1);
    expect(compareVersions("10.0.0", "9.9.9")).toBe(1);
  });

  test("exec unless the host is known to be older than the exec-form minimum", () => {
    expect(chooseHookForm("2.1.172")).toBe("exec");
    expect(chooseHookForm(null)).toBe("exec");
    expect(chooseHookForm("2.1.100")).toBe("shell");
    expect(chooseHookForm("2.1.100", "exec")).toBe("exec");
    expect(chooseHookForm("2.1.172", "shell")).toBe("shell");
  });
});

describe("claude version probe", () => {
  test("a Windows .cmd shim is run by cmd.exe as one quoted command string; everything else directly", () => {
    const shim = "C:\\Program Files\\nodejs\\claude.cmd";
    expect(isWindowsShim(shim, "win32")).toBe(true);
    expect(isWindowsShim("C:\\Users\\me\\claude.BAT", "win32")).toBe(true);
    expect(isWindowsShim("C:\\Users\\me\\claude.exe", "win32")).toBe(false);
    expect(isWindowsShim("/home/me/claude.cmd", "linux")).toBe(false);
    expect(claudeVersionSpawn(shim, true)).toEqual({ command: `"${shim}" --version`, args: [], shell: true });
    expect(claudeVersionSpawn("/usr/local/bin/claude", false)).toEqual({ command: "/usr/local/bin/claude", args: ["--version"], shell: false });
  });

  test("detects the version of a binary installed under a path with a space (HARNESS_MEMORY_CLAUDE_BIN)", () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "hm-claude-")));
    const dir = join(base, "Program Files", "claude code");
    mkdirSync(dir, { recursive: true });
    const windows = process.platform === "win32";
    const binary = join(dir, windows ? "claude.cmd" : "claude");
    writeFileSync(binary, windows ? "@echo off\r\necho 9.9.9 (Claude Code)\r\n" : '#!/bin/sh\necho "9.9.9 (Claude Code)"\n');
    if (!windows) chmodSync(binary, 0o755);
    const previous = process.env.HARNESS_MEMORY_CLAUDE_BIN;
    process.env.HARNESS_MEMORY_CLAUDE_BIN = binary;
    try {
      expect(detectClaudeVersion()).toBe("9.9.9");
    } finally {
      if (previous === undefined) delete process.env.HARNESS_MEMORY_CLAUDE_BIN;
      else process.env.HARNESS_MEMORY_CLAUDE_BIN = previous;
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("hooks.log reader", () => {
  const line = "2026-11-08T10:00:00.000Z pre-tool tool=bash gen=42 activated=1 suppressed=17 decision=deny delivery=before enforcement=soft_deny dur=63ms ok";

  test("parses the one-line format and skips debug JSON", () => {
    expect(parseHookLogLine(line)).toEqual({
      ts: "2026-11-08T10:00:00.000Z",
      event: "pre-tool",
      tool: "bash",
      gen: 42,
      activated: 1,
      suppressed: 17,
      decision: "deny",
      delivery: "before",
      enforcement: "soft_deny",
      durationMs: 63,
      status: "ok",
    });
    expect(parseHookLogLine('{"ts":"x"}')).toBeNull();
    expect(parseHookLogLine("2026-11-08T10:00:00.000Z session-start tool=- gen=- activated=0 suppressed=0 decision=none delivery=none enforcement=- dur=9ms snapshot_missing")?.gen).toBeNull();
  });

  test("summarizes last call per event, p95 and errors", () => {
    const entries = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => parseHookLogLine(line.replace("dur=63ms", `dur=${n * 10}ms`).replace("T10:00:00", `T10:00:${String(n).padStart(2, "0")}`))!);
    entries.push(parseHookLogLine("2026-11-08T11:00:00.000Z prompt tool=- gen=42 activated=2 suppressed=0 decision=none delivery=none enforcement=- dur=30ms error:ENOENT")!);
    const summary = summarizeHookLog(entries);
    expect(summary.total).toBe(11);
    expect(summary.p95PreTool).toBe(100);
    expect(summary.lastByEvent.prompt?.status).toBe("error:ENOENT");
    expect(summary.lastByEvent["pre-tool"]?.ts).toBe("2026-11-08T10:00:10.000Z");
    expect(summary.errors).toBe(1);
    expect(percentile([], 95)).toBeNull();
    expect(percentile([5], 95)).toBe(5);
  });
});
