/**
 * Hook bundle entry (`dist/hook-bundle.js`, loaded by the `dist/hook.js` launcher): `main(argv, io)`
 * reads Claude Code's stdin, normalizes it, runs the host-neutral hook core and prints exactly one
 * JSON object (nothing for the silent events). It never throws, never exits non-zero and never opens
 * SQLite (spec §6.2 steps 0–1, §8.6, §9.4 F4/F5).
 */

import type { DenseClient } from "./activation/before-model";
import type { SpawnWorkerFn } from "./activation/snapshot-reader";
import { createRuntime, runHook, summarizeHookResult, type HookResult } from "./adapters/hook-core";
import { appendHookLog, describeError, readStdin, writeStdout } from "./adapters/hook-io";
import { isHookEvent, normalizeClaudeCode, parseClaudeCodeStdin, renderClaudeCode, SILENT_EVENTS } from "./adapters/hosts/claude-code";
import { loadConfig } from "./core/config";
import type { HookRunSummary, HookStdout } from "./core/hook-types";
import { findInstalledRoot, resolvePaths, userHarnessDir, type HarnessPaths } from "./core/paths";
import type { HookEvent } from "./core/vocabulary";

export interface HookMainIo {
  readStdin(): Promise<string>;
  writeStdout(output: HookStdout | null): void;
  env: NodeJS.ProcessEnv;
  cwd(): string;
  clock(): string;
  /** Injected for tests; `undefined` uses the detached worker, `null` disables spawning. */
  spawnWorker?: SpawnWorkerFn | null;
  dense?: DenseClient | null;
  appendLog(paths: HarnessPaths, summary: HookRunSummary, detail: unknown, options: { debug: boolean; max_bytes: number; rotations: number; now: string }): void;
}

export interface HookMainOutcome {
  /** What was printed (null = nothing printed). */
  stdout: HookStdout | null;
  result: HookResult | null;
}

const defaultIo: HookMainIo = {
  readStdin: () => readStdin(),
  writeStdout: (output) => writeStdout(output),
  env: process.env,
  cwd: () => process.cwd(),
  clock: () => new Date().toISOString(),
  appendLog: (paths, summary, detail, options) =>
    appendHookLog(paths, summary, { debug: options.debug, detail, maxBytes: options.max_bytes, rotations: options.rotations, now: options.now }),
};

/** `~/.harness-memory` holds the model cache and the worker cwd, never a project install (spec §3.2). */
function isUserLevelRoot(root: string): boolean {
  return resolvePaths(root).dir === userHarnessDir();
}

/** Runs one hook invocation end to end. Resolves (never rejects) with what was printed. */
export async function main(argv: readonly string[], overrides: Partial<HookMainIo> = {}): Promise<HookMainOutcome> {
  const io: HookMainIo = { ...defaultIo, ...overrides };
  const started = Date.now();
  const argvEvent: HookEvent | null = isHookEvent(argv[0]) ? argv[0] : null;
  const silent = argvEvent !== null && SILENT_EVENTS.has(argvEvent);
  const emit = (output: HookStdout | null): HookStdout | null => {
    const printed = silent ? null : (output ?? {});
    io.writeStdout(printed);
    return printed;
  };

  // Recursion guard 1: hooks fired inside a nested `claude -p` exit before reading anything.
  if (io.env.HARNESS_MEMORY_DISABLE === "1") return { stdout: null, result: null };

  let paths: HarnessPaths | null = null;
  let logConfig = { debug: io.env.HARNESS_MEMORY_DEBUG === "1", max_bytes: 5 * 1024 * 1024, rotations: 3 };
  const installedRoot = (cwd: string): string | null => {
    const root = findInstalledRoot(cwd);
    return root === null || isUserLevelRoot(root) ? null : root;
  };
  const logFailure = (event: HookEvent, status: HookRunSummary["status"], detail: unknown): void => {
    if (paths === null) return;
    try {
      io.appendLog(
        paths,
        { event, status, duration_ms: Date.now() - started, gen: null, activated: 0, suppressed: 0, decision: "none", delivery: "none" },
        detail,
        { ...logConfig, now: io.clock() }
      );
    } catch {
      // never let logging fail the hook
    }
  };

  try {
    const raw = await io.readStdin();
    const stdin = parseClaudeCodeStdin(raw);
    if (stdin === null) {
      const root = installedRoot(io.cwd());
      if (root !== null) paths = resolvePaths(root);
      logFailure(argvEvent ?? "pre-tool", "bad_stdin", { bytes: raw.length });
      return { stdout: emit({}), result: null };
    }

    const input = normalizeClaudeCode(stdin, argvEvent);
    if (input === null) return { stdout: emit({}), result: null };

    const root = installedRoot(input.cwd) ?? installedRoot(io.cwd());
    if (root === null) return { stdout: emit({}), result: null };
    paths = resolvePaths(root);
    const config = loadConfig(paths.config);
    logConfig = { debug: logConfig.debug || config.log.debug, max_bytes: config.log.max_bytes, rotations: config.log.rotations };

    const runtime = createRuntime(paths, config, { clock: io.clock, spawnWorker: io.spawnWorker, dense: io.dense });
    const result = await runHook(input.event, input, runtime);
    const output = renderClaudeCode(result);
    const printed = SILENT_EVENTS.has(input.event) ? null : (output ?? {});
    io.writeStdout(printed);
    try {
      io.appendLog(paths, summarizeHookResult(result, Date.now() - started), result.detail, { ...logConfig, now: io.clock() });
    } catch {
      // never let logging fail the hook
    }
    return { stdout: printed, result };
  } catch (error) {
    logFailure(argvEvent ?? "pre-tool", `error:${describeError(error).slice(0, 40).replace(/[^A-Za-z0-9_]/g, "_")}`, { error: describeError(error) });
    return { stdout: emit({}), result: null };
  }
}
