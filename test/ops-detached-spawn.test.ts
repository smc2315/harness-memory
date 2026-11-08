/**
 * Operations suite (spec §13.4, m0-facts #1): the detached worker and embedding helper are spawned with
 * exactly `{detached: true, stdio: "ignore", windowsHide: true}` (no console window on Windows), the node
 * binary itself, an allowlisted env that drops CLAUDECODE / CLAUDE_CODE_* and carries the recursion guard,
 * and `unref()` so the hook can exit. Asserted through an injected `node:child_process.spawn`, never by
 * looking for windows.
 */

import type { ChildProcess } from "node:child_process";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

interface RecordedSpawn {
  command: string;
  args: string[];
  options: { detached?: boolean; stdio?: unknown; windowsHide?: boolean; cwd?: string; env?: Record<string, string | undefined> };
  unref: () => void;
}

const recorded: RecordedSpawn[] = [];

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (command: string, args: string[], options: RecordedSpawn["options"]) => {
      const unref = vi.fn();
      recorded.push({ command, args, options, unref });
      return { pid: 4242 + recorded.length, unref } as unknown as ChildProcess;
    },
  };
});

import { defaultSpawnWorker, requestReindex } from "../src/activation/snapshot-reader";
import { createRuntime, runHook } from "../src/adapters/hook-core";
import { normalizeClaudeCode } from "../src/adapters/hosts/claude-code";
import { providerEnv, spawnDetached } from "../src/core/process";
import { ensureHelper } from "../src/embed/client";
import { claudeStdin, createHarnessFixture, fixtureMemory, FIXTURE_NOW, type HarnessFixture } from "./helpers/snapshot-fixture";

const POISON: Record<string, string> = {
  CLAUDECODE: "1",
  CLAUDE_CODE_EXECPATH: "C:\\claude\\claude.exe",
  CLAUDE_CODE_ENTRYPOINT: "cli",
  CODEX_SANDBOX: "1",
  HARNESS_MEMORY_DEBUG: "1",
};

let fixture: HarnessFixture;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  recorded.length = 0;
  for (const [key, value] of Object.entries(POISON)) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
  fixture = createHarnessFixture({ memories: [fixtureMemory({ id: "spawn-fixture", signature: { tool: "bash", target: "command", pattern_kind: "cmd", pattern: "pm test" } })] });
});

afterEach(() => {
  for (const key of Object.keys(POISON)) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  fixture.cleanup();
});

function expectDetached(call: RecordedSpawn, expectedArgs: { script: RegExp; rest: string[] }): void {
  expect(call.command).toBe(process.execPath);
  expect(call.args[0]).toMatch(expectedArgs.script);
  expect(call.args.slice(1)).toEqual(expectedArgs.rest);
  expect(call.options.detached).toBe(true);
  expect(call.options.stdio).toBe("ignore");
  expect(call.options.windowsHide).toBe(true);
  expect(call.unref).toHaveBeenCalledTimes(1);
  const env = call.options.env ?? {};
  expect(env.HARNESS_MEMORY_DISABLE).toBe("1");
  for (const key of Object.keys(env)) {
    expect(key, `env leaks ${key}`).not.toMatch(/^CLAUDE/);
    expect(key, `env leaks ${key}`).not.toMatch(/^CODEX_SANDBOX/);
  }
  expect(env.HARNESS_MEMORY_DEBUG).toBe("1");
  expect(env.PATH ?? env.Path).toBeDefined();
}

describe("detached spawns never open a console window", () => {
  test("spawnDetached: node binary, detached, stdio ignore, windowsHide, allowlisted env, unref", () => {
    const pid = spawnDetached("C:\\pkg\\dist\\worker.js", ["C:\\proj", "extract"], { cwd: "C:\\proj" });
    expect(pid).toBe(4243);
    expect(recorded).toHaveLength(1);
    expectDetached(recorded[0]!, { script: /worker\.js$/, rest: ["C:\\proj", "extract"] });
    expect(recorded[0]!.options.cwd).toBe("C:\\proj");
    expect(providerEnv().CLAUDECODE).toBeUndefined();
  });

  test("the hook's default worker spawn (stale snapshot at session-start → worker reindex) carries the same options", async () => {
    fixture.touchDb(); // stat(memory.sqlite) no longer matches snapshot.source → stale
    const runtime = createRuntime(fixture.paths, fixture.config, { clock: () => FIXTURE_NOW, dense: null });
    expect(runtime.spawnWorker).toBe(defaultSpawnWorker);
    const input = normalizeClaudeCode(claudeStdin(fixture, "SessionStart", { source: "startup" }), "session-start");
    const result = await runHook("session-start", input!, runtime);
    expect(result.status).toBe("ok");
    expect(result.detail.stale).toBe(true);
    // The reindex request is made by the snapshot reader (throttled touch file + detached spawn), so it is
    // visible through the spawn seam rather than through HookResult.spawned (reserved for extract/dream).
    expect(recorded).toHaveLength(1);
    expectDetached(recorded[0]!, { script: /worker\.js$/, rest: [fixture.root, "reindex"] });
    expect(recorded[0]!.options.cwd).toBe(fixture.root);
  });

  test("requestReindex is throttled: one spawn per minute per project", () => {
    const nowMs = Date.parse(FIXTURE_NOW);
    expect(requestReindex(fixture.paths, { nowMs })).toBe(true);
    expect(requestReindex(fixture.paths, { nowMs: nowMs + 10_000 })).toBe(false);
    expect(requestReindex(fixture.paths, { nowMs: nowMs + 61_000 })).toBe(true);
    expect(recorded).toHaveLength(2);
    for (const call of recorded) expectDetached(call, { script: /worker\.js$/, rest: [fixture.root, "reindex"] });
  });

  test("the embedding helper spawn uses spawnDetached too (and is throttled by the touch file)", () => {
    expect(ensureHelper(fixture.paths, { scriptPath: "C:\\pkg\\dist\\embed-helper.js", nowMs: 1_000_000 })).toBe(true);
    expect(ensureHelper(fixture.paths, { scriptPath: "C:\\pkg\\dist\\embed-helper.js", nowMs: 1_030_000 })).toBe(false);
    expect(recorded).toHaveLength(1);
    expectDetached(recorded[0]!, { script: /embed-helper\.js$/, rest: [fixture.root] });
  });
});
