/**
 * `hm eval:latency [--local] [--runs N] [--threshold MS] [--memories N] [--large] [--hook-script <path>]`
 * (spec §6.3, §11, §13.3): spawns `dist/hook.js pre-tool` 50× against a generated 300-memory fixture
 * project (or, with `--local`, the installed project under --root / cwd) and prints min / p50 / p95 / max.
 * Exit 1 when p95 exceeds the budget (90 ms unless overridden) or a hook run fails; the 2,000-memory pass
 * (`--large`) and the cold start are informational.
 */

import { EXIT_CODES } from "../../core/errors";
import { LATENCY_DEFAULTS, runLatencyEval, type LatencyPassReport, type LatencyReport } from "../../eval/latency";
import type { CommandContext } from "../context";
import { flagBoolean, flagNumber, flagString, type OptionSpecs } from "../lib/args";
import { resolveHookScript } from "../lib/paths";
import { EXIT_USAGE } from "../lib/store";

export const evalLatencyOptions: OptionSpecs = {
  local: { type: "boolean", description: "Measure the installed project (--root / cwd) instead of a generated fixture" },
  runs: { type: "number", description: `Timed pre-tool spawns (default ${String(LATENCY_DEFAULTS.runs)})`, placeholder: "<n>" },
  threshold: { type: "number", description: `p95 budget in ms; above it the command exits 1 (default ${String(LATENCY_DEFAULTS.thresholdMs)})`, placeholder: "<ms>" },
  memories: { type: "number", description: `Memories in the generated fixture snapshot (default ${String(LATENCY_DEFAULTS.memories)})`, placeholder: "<n>" },
  large: { type: "boolean", description: `Also run an informational pass against ${String(LATENCY_DEFAULTS.largeMemories)} memories` },
  "hook-script": { type: "string", description: "dist/hook.js to spawn (default: the launcher next to this bundle)", placeholder: "<path>" },
};

function renderPass(label: string, pass: LatencyPassReport): string[] {
  const stats = pass.stats;
  const lines = [
    `${label}: ${pass.memories === null ? "?" : String(pass.memories)} memories, ${String(stats.runs)} runs — min ${stats.min.toFixed(1)} / p50 ${stats.p50.toFixed(1)} / p95 ${stats.p95.toFixed(1)} / max ${stats.max.toFixed(1)} ms (mean ${stats.mean.toFixed(1)} ms)`,
    `  cold start (first spawn, informational): ${pass.cold_start_ms.toFixed(1)} ms; first pre-tool decision: ${pass.sample_decision ?? "?"}`,
  ];
  if (pass.failures > 0) lines.push(`  ${String(pass.failures)} failed run(s):`, ...pass.failure_detail.slice(0, 5).map((detail) => `    ${detail}`));
  return lines;
}

export function renderLatencyReport(report: LatencyReport): string[] {
  const lines = [
    `hook: ${report.hook_script}`,
    `node: ${report.node}${report.local ? " (local project)" : ""}`,
    ...renderPass("pre-tool", report.main),
  ];
  if (report.large !== null) lines.push(...renderPass("pre-tool (large, informational)", report.large));
  lines.push(`${report.pass ? "PASS" : "FAIL"}: ${report.verdict}`);
  return lines;
}

export async function runEvalLatency(ctx: CommandContext): Promise<number> {
  const runs = flagNumber(ctx.args, "runs") ?? LATENCY_DEFAULTS.runs;
  const threshold = flagNumber(ctx.args, "threshold") ?? LATENCY_DEFAULTS.thresholdMs;
  const memories = flagNumber(ctx.args, "memories") ?? LATENCY_DEFAULTS.memories;
  if (!Number.isInteger(runs) || runs < 1 || threshold <= 0 || !Number.isInteger(memories) || memories < 1) {
    ctx.stderr("error: --runs and --memories must be positive integers and --threshold a positive number of milliseconds\n");
    return EXIT_USAGE;
  }
  const hookScript = flagString(ctx.args, "hook-script") ?? ctx.seams.hookScript ?? resolveHookScript();
  const local = flagBoolean(ctx.args, "local");
  const report = await runLatencyEval({
    hookScript,
    execPath: ctx.execPath,
    runs,
    thresholdMs: threshold,
    memories,
    localRoot: local ? ctx.paths.root : null,
    large: flagBoolean(ctx.args, "large"),
    env: { ...ctx.env },
    now: ctx.clock(),
    log: (line) => {
      if (!ctx.json) ctx.stderr(`${line}\n`);
    },
  });
  ctx.out.result(report, renderLatencyReport);
  return report.pass ? EXIT_CODES.ok : EXIT_CODES.error;
}
