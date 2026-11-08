/**
 * `hm eval:replay [--scenario s01,s03] [--fixtures <dir>] [--keep] [--verbose]` (spec §11, §13.1–13.2):
 * drives the twelve recorded scenarios through the real hook entry (`main()`) and the real worker with the
 * replay provider, each in its own temp project, and asserts (a)–(k) plus the read-path checks. Fixtures
 * live in `test/fixtures/replay` of the package checkout (not shipped in the npm tarball). Exit 1 when any
 * scenario or preflight contract fails.
 */

import { existsSync } from "node:fs";

import { EXIT_CODES } from "../../core/errors";
import { resolveFixturesDir } from "../../eval/replay/fixtures";
import { runPreflight, type PreflightCheck } from "../../eval/replay/preflight";
import { runReplaySuite } from "../../eval/replay/run";
import type { ReplaySuiteReport } from "../../eval/replay/types";
import type { CommandContext } from "../context";
import { flagBoolean, flagString, type OptionSpecs } from "../lib/args";
import { EXIT_USAGE } from "../lib/store";

export const evalReplayOptions: OptionSpecs = {
  scenario: { type: "string", description: "Comma-separated scenario ids or id prefixes to run (default: all twelve)", placeholder: "<ids>" },
  fixtures: { type: "string", description: "Directory holding the replay fixtures (default: <package>/test/fixtures/replay)", placeholder: "<dir>" },
  keep: { type: "boolean", description: "Keep each scenario's temp project and print its path" },
  verbose: { type: "boolean", description: "Print every check, not only failures" },
};

export interface EvalReplayReport extends ReplaySuiteReport {
  preflight: PreflightCheck[];
}

export function renderReplayReport(report: EvalReplayReport, verbose: boolean): string[] {
  const lines: string[] = [];
  for (const check of report.preflight) {
    if (!check.ok || verbose) lines.push(`${check.ok ? "ok  " : "FAIL"} preflight ${check.id}: ${check.detail}`);
  }
  const width = report.scenarios.reduce((max, scenario) => Math.max(max, scenario.id.length), 3);
  for (const scenario of report.scenarios) {
    const failed = scenario.checks.filter((check) => !check.ok);
    lines.push(`${scenario.ok ? "PASS" : "FAIL"}  ${scenario.id.padEnd(width)}  ${String(scenario.checks.length).padStart(3)} checks  ${String(scenario.duration_ms).padStart(5)} ms  ${scenario.title} [${scenario.asserts.join(", ")}]`);
    if (scenario.error !== null) lines.push(`        error: ${scenario.error.split("\n")[0] ?? scenario.error}`);
    for (const check of verbose ? scenario.checks : failed) {
      lines.push(`        ${check.ok ? "ok  " : "FAIL"} ${check.name}${check.detail === undefined ? "" : ` — ${check.detail}`}`);
    }
    if (scenario.root !== null) lines.push(`        kept: ${scenario.root}`);
  }
  const totals = report.totals;
  lines.push(
    `${report.ok && report.preflight.every((check) => check.ok) ? "PASS" : "FAIL"}: ${String(totals.passed)}/${String(totals.scenarios)} scenarios, ${String(totals.checks - totals.checks_failed)}/${String(totals.checks)} checks, ${String(totals.hook_calls)} hook calls in ${String(totals.duration_ms)} ms`
  );
  return lines;
}

export async function runEvalReplay(ctx: CommandContext): Promise<number> {
  const fixturesDir = resolveFixturesDir({ explicit: flagString(ctx.args, "fixtures"), packageRoot: ctx.packageRoot, cwd: ctx.cwd });
  if (!existsSync(fixturesDir)) {
    ctx.stderr(`error: replay fixtures not found at ${fixturesDir} — run from a harness-memory checkout or pass --fixtures <dir>\n`);
    return EXIT_USAGE;
  }
  const filter = (flagString(ctx.args, "scenario") ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  const verbose = flagBoolean(ctx.args, "verbose");
  const preflight = runPreflight();
  const suite = await runReplaySuite({
    fixturesDir,
    filter,
    keep: flagBoolean(ctx.args, "keep"),
    log: (line) => {
      if (verbose && !ctx.json) ctx.stderr(`${line}\n`);
    },
  });
  if (suite.totals.scenarios === 0) {
    ctx.stderr(`error: no scenario matches ${filter.join(", ")}\n`);
    return EXIT_USAGE;
  }
  const report: EvalReplayReport = { ...suite, preflight };
  ctx.out.result(report, (value) => renderReplayReport(value, verbose));
  return report.ok && preflight.every((check) => check.ok) ? EXIT_CODES.ok : EXIT_CODES.error;
}
