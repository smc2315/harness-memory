/**
 * Install self-test (spec §8.7): run the registered hook once with a synthetic Claude Code stdin and
 * verify that `logs/hooks.log` gained a line for the event. Exercises the real `dist/hook.js` launcher
 * with the real node binary, exactly as Claude Code will spawn it.
 */

import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";

import type { HarnessPaths } from "../../core/paths";
import type { HookEvent } from "../../core/vocabulary";
import { CLAUDE_CODE_EVENT_NAMES } from "../../adapters/hosts/claude-code";
import { readHookLogTail, type HookLogEntry } from "./hooks-log";

export const SELF_TEST_SESSION_ID = "selftest";

export interface SelfTestOptions {
  paths: HarnessPaths;
  hookScript: string;
  execPath: string;
  event?: HookEvent;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

export interface SelfTestResult {
  ok: boolean;
  event: HookEvent;
  exitCode: number | null;
  signal: string | null;
  /** The hooks.log entry the call produced, when found. */
  logEntry: HookLogEntry | null;
  stdout: string;
  stderr: string;
  error: string | null;
  durationMs: number;
}

export function selfTestStdin(root: string, event: HookEvent): string {
  const base: Record<string, unknown> = { session_id: SELF_TEST_SESSION_ID, cwd: root, hook_event_name: CLAUDE_CODE_EVENT_NAMES[event] };
  if (event === "session-start") base.source = "startup";
  if (event === "prompt") {
    base.prompt = "harness-memory self-test";
    base.prompt_id = "selftest-prompt";
  }
  return JSON.stringify(base);
}

function logSize(file: string): number {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
}

/** Synchronous: the hook must finish well inside its registered timeout (10 s for SessionStart). */
export function runHookSelfTest(options: SelfTestOptions): SelfTestResult {
  const event = options.event ?? "session-start";
  const started = Date.now();
  const before = logSize(options.paths.hooksLog);
  const env: NodeJS.ProcessEnv = { ...(options.env ?? process.env) };
  // A CLI invoked from inside a nested `claude -p` carries the recursion guard; the self-test must not.
  delete env.HARNESS_MEMORY_DISABLE;

  let run: ReturnType<typeof spawnSync>;
  try {
    run = spawnSync(options.execPath, [options.hookScript, event], {
      cwd: options.paths.root,
      env,
      input: selfTestStdin(options.paths.root, event),
      encoding: "utf8",
      timeout: options.timeoutMs ?? 15_000,
      windowsHide: true,
    });
  } catch (error) {
    return {
      ok: false,
      event,
      exitCode: null,
      signal: null,
      logEntry: null,
      stdout: "",
      stderr: "",
      error: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - started,
    };
  }

  const stdout = typeof run.stdout === "string" ? run.stdout : "";
  const stderr = typeof run.stderr === "string" ? run.stderr : "";
  const spawnError = run.error === undefined ? null : run.error.message;
  const after = logSize(options.paths.hooksLog);
  let logEntry: HookLogEntry | null = null;
  if (after > before) {
    const entries = readHookLogTail(options.paths.hooksLog, Math.max(4096, after - before + 1024));
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      if (entries[index]!.event === event) {
        logEntry = entries[index]!;
        break;
      }
    }
  }
  let error = spawnError;
  if (error === null && run.status !== 0) error = `hook exited with ${run.status === null ? `signal ${String(run.signal)}` : `code ${String(run.status)}`}`;
  if (error === null && logEntry === null) error = `no ${event} line appeared in ${options.paths.hooksLog}`;
  return {
    ok: error === null,
    event,
    exitCode: run.status,
    signal: run.signal === null ? null : String(run.signal),
    logEntry,
    stdout,
    stderr,
    error,
    durationMs: Date.now() - started,
  };
}
