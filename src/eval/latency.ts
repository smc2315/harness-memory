/**
 * eval:latency (spec §6.3, §13.3): spawn the real `dist/hook.js pre-tool` launcher against a project whose
 * snapshot holds N memories (300 by default) and measure the whole process — Node start-up, compile cache,
 * bundle load, snapshot read, decision, ledger append — exactly as Claude Code pays for it. Reports
 * min / p50 / p95 / max and fails when p95 exceeds the budget (90 ms). The fixture project is built with
 * the real Store (database + snapshot builder), never a hand-written snapshot.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import { DEFAULT_CONFIG, mergeConfig, type HarnessConfig } from "../core/config";
import type { ClaudeCodeHookStdin } from "../core/hook-types";
import { resolvePaths, stateDirectories, type HarnessPaths } from "../core/paths";
import type { ActiveSnapshot } from "../core/snapshot-types";
import type { TriggerSignature } from "../core/vocabulary";
import { composeStore, silentWorkerLogger } from "../dream/worker";
import { MemoryRepository, type CreateMemoryInput } from "../memory/repository";
import { compileSignature } from "../activation/signature";

export const LATENCY_DEFAULTS = {
  runs: 50,
  thresholdMs: 90,
  memories: 300,
  largeMemories: 2_000,
  spawnTimeoutMs: 30_000,
} as const;

export const LATENCY_SESSION_ID = "eval-latency";

// ---------------------------------------------------------------------------------------------
// Fixture project
// ---------------------------------------------------------------------------------------------

const SCOPES = ["**/*", "src/**", "src/db/**", "src/activation/**/*.ts", "docs/**/*.md", "test/**", "scripts/**", "src/dream/**"];
const COMMANDS = ["npm test", "npm run build", "git push --force", "npx vitest run", "npm publish", "rm -rf dist", "npm run lint", "git rebase"];
const GLOB_EXTENSIONS = ["env", "lock", "sqlite", "pem"];

function signatureKeyOf(signature: TriggerSignature): string {
  const compiled = compileSignature(signature);
  if (!compiled.ok) throw new Error(`latency fixture signature rejected (${compiled.code}): ${compiled.detail}`);
  return compiled.compiled.signature_key;
}

/** A realistic mix: cmd / glob / regex signatures, scoped and global rows, human and auto authority, all five types. */
export function latencyMemoryInputs(count: number, now: string): CreateMemoryInput[] {
  const rows: CreateMemoryInput[] = [];
  for (let index = 0; index < count; index += 1) {
    const scope = SCOPES[index % SCOPES.length]!;
    const kind = index % 6;
    const human = index % 3 === 0;
    let signature: TriggerSignature | null = null;
    let type: CreateMemoryInput["type"] = "pitfall";
    let triggers: CreateMemoryInput["lifecycleTriggers"] = ["before_tool"];
    let enforcement: CreateMemoryInput["enforcement"] = "advise";
    if (kind === 0) {
      signature = { tool: "bash", target: "command", pattern_kind: "cmd", pattern: COMMANDS[index % COMMANDS.length]! };
      enforcement = "soft_deny";
    } else if (kind === 1) {
      signature = { tool: "write|edit", target: "path", pattern_kind: "glob", pattern: `**/*.${GLOB_EXTENSIONS[index % GLOB_EXTENSIONS.length]!}` };
      type = "policy";
      enforcement = "confirm";
    } else if (kind === 2) {
      type = "workflow";
      triggers = ["before_model", "session_start"];
    } else if (kind === 3) {
      type = "decision";
      triggers = ["session_start", "before_model"];
    } else if (kind === 4) {
      signature = { tool: "bash", target: "command", pattern_kind: "regex", pattern: `git (push|pull) .*origin\\/${String(index)}` };
    } else {
      triggers = ["before_tool", "before_model"];
    }
    rows.push({
      id: `gen-${String(index).padStart(5, "0")}`,
      type,
      summary: `Generated memory ${String(index)} about ${scope} and ${COMMANDS[index % COMMANDS.length]!}`,
      details: `Rationale ${String(index)}: keep the ${scope} area consistent; learned from session ${String(index % 17)}.`,
      scopeGlob: scope,
      lifecycleTriggers: triggers,
      activationClass: signature !== null && signature.target === "command" ? "event" : "scoped",
      status: "active",
      authority: human ? "human" : "auto",
      sourceKind: human ? "manual" : "extraction",
      knowledgeKind: human ? "manual" : "correction",
      enforcement: human && enforcement === "soft_deny" ? "confirm" : enforcement,
      policySubtype: type === "policy" ? "hard" : null,
      triggerSignature: signature,
      signatureKey: signature === null ? "" : signatureKeyOf(signature),
      relevantTools: signature === null ? null : [signature.tool.split("|")[0] ?? "bash"],
      aliases: index % 5 === 0 ? ["테스트", `alias${String(index)}`] : [],
      confidence: 0.8,
      importance: 0.6,
      createdAt: now,
      updatedAt: now,
    });
  }
  return rows;
}

export interface LatencyFixture {
  root: string;
  paths: HarnessPaths;
  config: HarnessConfig;
  memories: number;
  cleanup(): void;
}

export interface BuildLatencyFixtureOptions {
  memories?: number;
  now?: string;
  tmpRoot?: string;
  config?: unknown;
}

/** Temp project with a real database and snapshot of N active memories (written through the Store). */
export async function buildLatencyFixture(options: BuildLatencyFixtureOptions = {}): Promise<LatencyFixture> {
  const count = options.memories ?? LATENCY_DEFAULTS.memories;
  const now = options.now ?? new Date().toISOString();
  const root = mkdtempSync(join(options.tmpRoot ?? tmpdir(), "hm-latency-"));
  const paths = resolvePaths(root);
  for (const dir of stateDirectories(paths)) mkdirSync(dir, { recursive: true });
  const config = mergeConfig(DEFAULT_CONFIG, options.config);
  writeFileSync(paths.config, JSON.stringify(config, null, 2), "utf8");
  const store = composeStore({ paths, config, logger: silentWorkerLogger, clock: () => now });
  await store.withWriteLock("eval:latency:seed", 5_000, (db) => {
    const repository = new MemoryRepository(db, { clock: () => now });
    for (const row of latencyMemoryInputs(count, now)) repository.create(row);
    return { id: null, kind: "eval:latency:seed", noop: false, wrote: true };
  });
  return {
    root,
    paths,
    config,
    memories: count,
    cleanup: () => {
      try {
        rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      } catch {
        // reclaimed by the OS
      }
    },
  };
}

/** Number of memories in an existing project's active snapshot (for `--local`), or null when unreadable. */
export function snapshotMemoryCount(paths: Pick<HarnessPaths, "snapshotActive">): number | null {
  try {
    const parsed = JSON.parse(readFileSync(paths.snapshotActive, "utf8")) as Partial<ActiveSnapshot>;
    return Array.isArray(parsed.memories) ? parsed.memories.length : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Spawning
// ---------------------------------------------------------------------------------------------

export interface HookSpawnRequest {
  execPath: string;
  hookScript: string;
  event: "session-start" | "prompt" | "pre-tool" | "post-tool";
  cwd: string;
  stdin: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}

export interface HookSpawnResult {
  status: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  error: string | null;
}

export type HookSpawner = (request: HookSpawnRequest) => HookSpawnResult;

/** The real thing: `node dist/hook.js <event>` with stdin, measured around spawnSync (process start included). */
export const spawnHookProcess: HookSpawner = (request) => {
  const started = performance.now();
  try {
    const run = spawnSync(request.execPath, [request.hookScript, request.event], {
      cwd: request.cwd,
      input: request.stdin,
      env: request.env,
      encoding: "utf8",
      timeout: request.timeoutMs,
      windowsHide: true,
    });
    return {
      status: run.status,
      stdout: typeof run.stdout === "string" ? run.stdout : "",
      stderr: typeof run.stderr === "string" ? run.stderr : "",
      durationMs: performance.now() - started,
      error: run.error === undefined ? null : run.error.message,
    };
  } catch (error) {
    return { status: null, stdout: "", stderr: "", durationMs: performance.now() - started, error: error instanceof Error ? error.message : String(error) };
  }
};

/** Child env for the hook: the recursion guard must be absent, debug logging off. */
export function hookEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  delete env.HARNESS_MEMORY_DISABLE;
  delete env.HARNESS_MEMORY_DEBUG;
  return env;
}

export function latencyStdin(root: string, event: HookSpawnRequest["event"], index: number): string {
  const base: ClaudeCodeHookStdin = { session_id: LATENCY_SESSION_ID, cwd: root, hook_event_name: "", permission_mode: "default" };
  switch (event) {
    case "session-start":
      return JSON.stringify({ ...base, hook_event_name: "SessionStart", source: "startup" });
    case "prompt":
      return JSON.stringify({ ...base, hook_event_name: "UserPromptSubmit", prompt: "run the tests and fix src/db/store.ts", prompt_id: `lat-${String(index)}` });
    case "post-tool":
      return JSON.stringify({ ...base, hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: `ls src/${String(index)}` }, tool_use_id: `lat-tu-${String(index)}`, tool_response: "ok" });
    case "pre-tool": {
      const calls = [
        { tool_name: "Bash", tool_input: { command: "npm test" } },
        { tool_name: "Edit", tool_input: { file_path: join(root, "src", "db", "store.ts"), old_string: "a", new_string: "b" } },
        { tool_name: "Bash", tool_input: { command: "git push --force origin main" } },
      ];
      const call = calls[index % calls.length]!;
      return JSON.stringify({ ...base, hook_event_name: "PreToolUse", ...call, tool_use_id: `lat-pre-${String(index)}` });
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------------------------

export interface LatencyStats {
  runs: number;
  min: number;
  p50: number;
  p95: number;
  max: number;
  mean: number;
}

/** Nearest-rank percentile over a non-empty sample. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[rank]!;
}

export function latencyStats(samples: readonly number[]): LatencyStats {
  if (samples.length === 0) return { runs: 0, min: Number.NaN, p50: Number.NaN, p95: Number.NaN, max: Number.NaN, mean: Number.NaN };
  const round = (value: number): number => Math.round(value * 100) / 100;
  return {
    runs: samples.length,
    min: round(Math.min(...samples)),
    p50: round(percentile(samples, 50)),
    p95: round(percentile(samples, 95)),
    max: round(Math.max(...samples)),
    mean: round(samples.reduce((sum, value) => sum + value, 0) / samples.length),
  };
}

export interface LatencyPassReport {
  memories: number | null;
  root: string;
  /** First spawn against the project (bundle + compile cache cold), not part of the gate. */
  cold_start_ms: number;
  stats: LatencyStats;
  /** Non-zero exits, spawn errors or non-JSON stdout among the timed runs. */
  failures: number;
  failure_detail: string[];
  /** Decision of the first timed `npm test` call (sanity: the fixture really fires). */
  sample_decision: string | null;
}

export interface MeasureLatencyOptions {
  root: string;
  hookScript: string;
  execPath?: string;
  runs?: number;
  memories?: number | null;
  spawn?: HookSpawner;
  env?: NodeJS.ProcessEnv;
  spawnTimeoutMs?: number;
  /** Warm the session (prompt + a few tool lines) before timing, so the tail read is realistic (default true). */
  warmSession?: boolean;
  log?: (line: string) => void;
}

/** Spawns the hook `runs` times (pre-tool) after one cold spawn and a short untimed warm-up. */
export function measureHookLatency(options: MeasureLatencyOptions): LatencyPassReport {
  const spawn = options.spawn ?? spawnHookProcess;
  const execPath = options.execPath ?? process.execPath;
  const env = options.env ?? hookEnv();
  const timeoutMs = options.spawnTimeoutMs ?? LATENCY_DEFAULTS.spawnTimeoutMs;
  const runs = options.runs ?? LATENCY_DEFAULTS.runs;
  const log = options.log ?? (() => undefined);
  const request = (event: HookSpawnRequest["event"], index: number): HookSpawnRequest => ({
    execPath,
    hookScript: options.hookScript,
    event,
    cwd: options.root,
    stdin: latencyStdin(options.root, event, index),
    env,
    timeoutMs,
  });

  const cold = spawn(request("session-start", 0));
  log(`cold start (session-start): ${cold.durationMs.toFixed(1)} ms exit=${String(cold.status)}`);
  if (options.warmSession !== false) {
    spawn(request("prompt", 0));
    for (let index = 0; index < 3; index += 1) spawn(request("post-tool", index));
  }

  const samples: number[] = [];
  const failureDetail: string[] = [];
  let sampleDecision: string | null = null;
  for (let index = 0; index < runs; index += 1) {
    const result = spawn(request("pre-tool", index));
    samples.push(result.durationMs);
    let parsed: unknown = null;
    let ok = result.error === null && result.status === 0;
    if (ok) {
      try {
        parsed = JSON.parse(result.stdout.trim().length === 0 ? "{}" : result.stdout);
      } catch {
        ok = false;
      }
    }
    if (!ok) {
      failureDetail.push(`run ${String(index)}: exit=${String(result.status)} error=${result.error ?? "-"} stdout=${result.stdout.slice(0, 120)} stderr=${result.stderr.slice(0, 200)}`);
    } else if (index === 0 && typeof parsed === "object" && parsed !== null) {
      const specific = (parsed as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput;
      sampleDecision = specific?.permissionDecision ?? "none";
    }
    if ((index + 1) % 10 === 0) log(`  ${String(index + 1)}/${String(runs)} runs, last ${result.durationMs.toFixed(1)} ms`);
  }
  return {
    memories: options.memories ?? null,
    root: options.root,
    cold_start_ms: Math.round(cold.durationMs * 100) / 100,
    stats: latencyStats(samples),
    failures: failureDetail.length,
    failure_detail: failureDetail,
    sample_decision: sampleDecision,
  };
}

export interface LatencyReport {
  hook_script: string;
  node: string;
  runs: number;
  threshold_ms: number;
  local: boolean;
  main: LatencyPassReport;
  /** Informational: the 2,000-memory pass when requested. */
  large: LatencyPassReport | null;
  pass: boolean;
  verdict: string;
}

export interface RunLatencyEvalOptions {
  hookScript: string;
  execPath?: string;
  runs?: number;
  thresholdMs?: number;
  memories?: number;
  /** Measure an existing installed project instead of a generated fixture (`--local`). */
  localRoot?: string | null;
  large?: boolean;
  spawn?: HookSpawner;
  env?: NodeJS.ProcessEnv;
  now?: string;
  tmpRoot?: string;
  log?: (line: string) => void;
}

export function latencyVerdict(report: Pick<LatencyReport, "threshold_ms" | "main">): { pass: boolean; verdict: string } {
  const { stats, failures } = report.main;
  if (failures > 0) return { pass: false, verdict: `${String(failures)} of ${String(stats.runs)} hook runs failed` };
  if (stats.runs === 0 || Number.isNaN(stats.p95)) return { pass: false, verdict: "no timed runs" };
  const pass = stats.p95 <= report.threshold_ms;
  return {
    pass,
    verdict: `p95 ${stats.p95.toFixed(1)} ms ${pass ? "≤" : ">"} ${String(report.threshold_ms)} ms budget (min ${stats.min.toFixed(1)} / p50 ${stats.p50.toFixed(1)} / p95 ${stats.p95.toFixed(1)} / max ${stats.max.toFixed(1)} ms over ${String(stats.runs)} runs)`,
  };
}

export async function runLatencyEval(options: RunLatencyEvalOptions): Promise<LatencyReport> {
  if (!existsSync(options.hookScript)) throw new Error(`hook launcher not found at ${options.hookScript} — run \`npm run build\` (or pass --hook-script)`);
  const runs = options.runs ?? LATENCY_DEFAULTS.runs;
  const thresholdMs = options.thresholdMs ?? LATENCY_DEFAULTS.thresholdMs;
  const log = options.log ?? (() => undefined);
  const common = { hookScript: options.hookScript, execPath: options.execPath, runs, spawn: options.spawn, env: options.env, log };

  let main: LatencyPassReport;
  if (options.localRoot !== undefined && options.localRoot !== null) {
    const paths = resolvePaths(options.localRoot);
    if (!existsSync(paths.snapshotActive)) throw new Error(`no snapshot at ${paths.snapshotActive} — install harness-memory in ${options.localRoot} first (hm install --host claude)`);
    log(`measuring the installed project at ${paths.root}`);
    main = measureHookLatency({ ...common, root: paths.root, memories: snapshotMemoryCount(paths) });
  } else {
    const fixture = await buildLatencyFixture({ memories: options.memories ?? LATENCY_DEFAULTS.memories, now: options.now, tmpRoot: options.tmpRoot });
    log(`fixture: ${String(fixture.memories)} memories at ${fixture.root}`);
    try {
      main = measureHookLatency({ ...common, root: fixture.root, memories: fixture.memories });
    } finally {
      fixture.cleanup();
    }
  }

  let large: LatencyPassReport | null = null;
  if (options.large === true) {
    const fixture = await buildLatencyFixture({ memories: LATENCY_DEFAULTS.largeMemories, now: options.now, tmpRoot: options.tmpRoot });
    log(`informational fixture: ${String(fixture.memories)} memories at ${fixture.root}`);
    try {
      large = measureHookLatency({ ...common, root: fixture.root, memories: fixture.memories, runs: Math.min(runs, 20) });
    } finally {
      fixture.cleanup();
    }
  }

  const report: LatencyReport = {
    hook_script: options.hookScript,
    node: options.execPath ?? process.execPath,
    runs,
    threshold_ms: thresholdMs,
    local: options.localRoot !== undefined && options.localRoot !== null,
    main,
    large,
    pass: false,
    verdict: "",
  };
  const verdict = latencyVerdict(report);
  report.pass = verdict.pass;
  report.verdict = verdict.verdict;
  return report;
}
