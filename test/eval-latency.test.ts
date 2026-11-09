/**
 * eval:latency (spec §6.3, §13.3): the generated fixture is a real database + snapshot of N memories, the
 * measurement spawns `dist/hook.js pre-tool` N times after a cold spawn and a warm-up, the gate fails on
 * p95 > budget or any failed run. The spawner is injectable, so the statistics and the verdict are tested
 * deterministically; the real launcher is measured only when `npm run build` has produced dist/.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";

import type { LatencyReport } from "../src/eval/latency";
import { buildLatencyFixture, latencyMemoryInputs, latencyStats, latencyStdin, latencyVerdict, measureHookLatency, percentile, runLatencyEval, type HookSpawnRequest, type HookSpawner } from "../src/eval/latency";
import { createCliProject, runHm } from "./helpers/cli-run";

const DIST_HOOK = resolve(__dirname, "..", "dist", "hook.js");
const built = existsSync(DIST_HOOK) && existsSync(resolve(__dirname, "..", "dist", "hook-bundle.js"));
/**
 * The hard p95 ≤ 90 ms gate is `hm eval:latency` (spec §13.3, exit 1). This suite measures the real launcher
 * when dist/ exists (run alone: `npm run test:latency`, excluded from `npm test` because parallel suites would
 * inflate the numbers) and fails only on a gross regression (2× the budget) unless HM_LATENCY_BUDGET_MS pins the
 * gate, because a unit-test run shares the machine with other workers and start-up cost varies by host
 * (`node -e 0` alone was 33 ms at M0 and 50 ms during the C2 run on the same machine).
 */
const SPEC_BUDGET_MS = 90;
const BUDGET_MS = Number.parseFloat(process.env.HM_LATENCY_BUDGET_MS ?? String(SPEC_BUDGET_MS * 2));

function fakeSpawner(durations: readonly number[], options: { failAt?: number; decision?: string } = {}): HookSpawner & { requests: HookSpawnRequest[] } {
  const requests: HookSpawnRequest[] = [];
  let timed = 0;
  const spawner = ((request: HookSpawnRequest) => {
    requests.push(request);
    if (request.event !== "pre-tool") return { status: 0, stdout: "{}\n", stderr: "", durationMs: 40, error: null };
    const index = timed;
    timed += 1;
    if (options.failAt === index) return { status: 1, stdout: "", stderr: "boom", durationMs: durations[index] ?? 50, error: null };
    const stdout = index === 0 && options.decision !== undefined ? JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: options.decision } }) : "{}";
    return { status: 0, stdout, stderr: "", durationMs: durations[index] ?? 50, error: null };
  }) as HookSpawner & { requests: HookSpawnRequest[] };
  spawner.requests = requests;
  return spawner;
}

describe("latency fixture", () => {
  test("latencyMemoryInputs mixes signatures, types, triggers and authorities with unique ids", () => {
    const rows = latencyMemoryInputs(24, "2026-11-08T12:00:00.000Z");
    expect(new Set(rows.map((row) => row.id)).size).toBe(24);
    expect(rows.every((row) => row.status === "active" && (row.authority === "human" || row.authority === "auto"))).toBe(true);
    expect(rows.filter((row) => row.triggerSignature?.pattern_kind === "cmd").length).toBeGreaterThan(0);
    expect(rows.filter((row) => row.triggerSignature?.pattern_kind === "glob").length).toBeGreaterThan(0);
    expect(rows.filter((row) => row.triggerSignature?.pattern_kind === "regex").length).toBeGreaterThan(0);
    expect(rows.filter((row) => row.lifecycleTriggers.includes("session_start")).length).toBeGreaterThan(0);
    expect(rows.filter((row) => row.triggerSignature !== null).every((row) => row.signatureKey !== undefined && row.signatureKey.length > 0)).toBe(true);
  });

  test("buildLatencyFixture writes a real database and a snapshot holding every generated memory", async () => {
    const fixture = await buildLatencyFixture({ memories: 25, now: "2026-11-08T12:00:00.000Z" });
    try {
      expect(fixture.memories).toBe(25);
      expect(existsSync(fixture.paths.db)).toBe(true);
      expect(existsSync(fixture.paths.config)).toBe(true);
      const snapshot = JSON.parse(readFileSync(fixture.paths.snapshotActive, "utf8")) as { memories: unknown[]; db_generation: number; counts: { active: number; unreachable: number } };
      expect(snapshot.memories).toHaveLength(25);
      expect(snapshot.counts.active).toBe(25);
      expect(snapshot.counts.unreachable).toBe(0);
      expect(snapshot.db_generation).toBe(1);
      expect(existsSync(fixture.paths.snapshotLexical)).toBe(true);
    } finally {
      fixture.cleanup();
    }
    expect(existsSync(fixture.root)).toBe(false);
  }, 60_000);

  test("latencyStdin shapes every event with the fixture root as cwd", () => {
    const pre = JSON.parse(latencyStdin("C:\\proj", "pre-tool", 1)) as { cwd: string; hook_event_name: string; tool_name: string; tool_input: { file_path: string } };
    expect(pre.cwd).toBe("C:\\proj");
    expect(pre.hook_event_name).toBe("PreToolUse");
    expect(pre.tool_name).toBe("Edit");
    expect(pre.tool_input.file_path).toBe(join("C:\\proj", "src", "db", "store.ts"));
    expect((JSON.parse(latencyStdin("C:\\proj", "session-start", 0)) as { source: string }).source).toBe("startup");
    expect((JSON.parse(latencyStdin("C:\\proj", "prompt", 3)) as { prompt_id: string }).prompt_id).toBe("lat-3");
    expect((JSON.parse(latencyStdin("C:\\proj", "post-tool", 2)) as { tool_use_id: string }).tool_use_id).toBe("lat-tu-2");
  });
});

describe("measurement and verdict", () => {
  test("percentiles use the nearest rank and stats round to 0.01 ms", () => {
    const sample = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    expect(percentile(sample, 50)).toBe(50);
    expect(percentile(sample, 95)).toBe(100);
    expect(percentile([5], 95)).toBe(5);
    const stats = latencyStats([3.14159, 1, 2]);
    expect(stats).toEqual({ runs: 3, min: 1, p50: 2, p95: 3.14, max: 3.14, mean: 2.05 });
    expect(Number.isNaN(latencyStats([]).p95)).toBe(true);
  });

  test("measureHookLatency: one cold spawn, a warm-up, then N timed pre-tool spawns; the cold run is reported apart", () => {
    const durations = Array.from({ length: 50 }, (_unused, index) => 30 + index);
    const spawner = fakeSpawner(durations, { decision: "deny" });
    const report = measureHookLatency({ root: "C:\\proj", hookScript: "C:\\pkg\\dist\\hook.js", execPath: "node", runs: 50, memories: 300, spawn: spawner, env: {} });
    expect(spawner.requests.map((request) => request.event).slice(0, 5)).toEqual(["session-start", "prompt", "post-tool", "post-tool", "post-tool"]);
    expect(spawner.requests.filter((request) => request.event === "pre-tool")).toHaveLength(50);
    expect(spawner.requests.every((request) => request.cwd === "C:\\proj" && request.hookScript === "C:\\pkg\\dist\\hook.js" && request.execPath === "node")).toBe(true);
    expect(spawner.requests[0]!.stdin).toContain('"SessionStart"');
    expect(report.cold_start_ms).toBe(40);
    expect(report.stats).toEqual({ runs: 50, min: 30, p50: 54, p95: 77, max: 79, mean: 54.5 });
    expect(report.failures).toBe(0);
    expect(report.sample_decision).toBe("deny");
    expect(report.memories).toBe(300);
  });

  test("a failed hook run is counted and fails the verdict; the budget gate compares p95", () => {
    const failing = measureHookLatency({ root: "r", hookScript: "h", runs: 10, spawn: fakeSpawner(Array(10).fill(20), { failAt: 3 }), env: {}, warmSession: false });
    expect(failing.failures).toBe(1);
    expect(failing.failure_detail[0]).toContain("run 3");
    expect(latencyVerdict({ threshold_ms: 90, main: failing }).pass).toBe(false);

    const fast = measureHookLatency({ root: "r", hookScript: "h", runs: 20, spawn: fakeSpawner(Array(20).fill(42)), env: {}, warmSession: false });
    expect(latencyVerdict({ threshold_ms: 90, main: fast })).toEqual({ pass: true, verdict: expect.stringContaining("p95 42.0 ms ≤ 90 ms budget") });
    expect(latencyVerdict({ threshold_ms: 40, main: fast }).pass).toBe(false);
    expect(latencyVerdict({ threshold_ms: 40, main: fast }).verdict).toContain("> 40 ms budget");
  });

  test("runLatencyEval refuses a missing hook launcher with a build hint", async () => {
    await expect(runLatencyEval({ hookScript: "C:\\nope\\hook.js", spawn: fakeSpawner([]) })).rejects.toThrow(/npm run build/);
  });
});

describe("hm eval:latency (CLI, fake launcher)", () => {
  test("prints the report, honours --runs / --memories / --threshold and exits 1 above the budget", async () => {
    const project = createCliProject();
    try {
      const ok = await runHm(project, ["eval:latency", "--runs", "4", "--memories", "12", "--threshold", "60000", "--json"]);
      expect(ok.stderr).toBe("");
      expect(ok.code).toBe(0);
      const report = ok.json<LatencyReport>();
      expect(report.runs).toBe(4);
      expect(report.main.memories).toBe(12);
      expect(report.main.stats.runs).toBe(4);
      expect(report.main.failures).toBe(0);
      expect(report.hook_script).toBe(project.hookScript);
      expect(report.pass).toBe(true);
      expect(report.local).toBe(false);
      expect(report.large).toBeNull();

      const slow = await runHm(project, ["eval:latency", "--runs", "2", "--memories", "5", "--threshold", "0.001"]);
      expect(slow.code).toBe(1);
      expect(slow.stdout).toMatch(/FAIL: p95 .* > 0\.001 ms budget/);
      expect(slow.stdout).toContain("cold start");

      const usage = await runHm(project, ["eval:latency", "--runs", "0"]);
      expect(usage.code).toBe(2);
      const local = await runHm(project, ["eval:latency", "--local", "--runs", "1"]);
      expect(local.code).toBe(1);
      expect(local.stderr).toContain("no snapshot");
    } finally {
      project.cleanup();
    }
  }, 120_000);
});

describe.skipIf(!built)("hm eval:latency against the built dist/hook.js (requires npm run build)", () => {
  test(`50 spawned pre-tool hooks over 300 memories all succeed and p95 stays within ${String(BUDGET_MS)} ms (spec gate ${String(SPEC_BUDGET_MS)} ms via hm eval:latency)`, async () => {
    const report = await runLatencyEval({ hookScript: DIST_HOOK, runs: 50, memories: 300, thresholdMs: SPEC_BUDGET_MS, now: new Date().toISOString() });
    // eslint-disable-next-line no-console
    console.info(`eval:latency dist/hook.js pre-tool: ${report.verdict}; cold start ${report.main.cold_start_ms.toFixed(1)} ms; decision ${report.main.sample_decision ?? "?"}${report.pass ? "" : " — the spec gate fails on this machine; see hm eval:latency"}`);
    expect(report.main.failures, report.main.failure_detail.join("\n")).toBe(0);
    expect(report.main.stats.runs).toBe(50);
    expect(report.main.sample_decision === "ask" || report.main.sample_decision === "deny").toBe(true);
    expect(report.main.stats.p95, report.verdict).toBeLessThanOrEqual(BUDGET_MS);
  }, 300_000);
});
