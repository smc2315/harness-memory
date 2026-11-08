/**
 * Runs the replay suite: every scenario in its own temp project, sequentially (they share the process
 * clock-independent `makeSeq` counter and the sql.js module, nothing else), collecting a report.
 */

import type { ScenarioRun } from "./harness";
import { ScenarioRun as ScenarioRunImpl } from "./harness";
import type { ReplayScenario } from "./scenario";
import { REPLAY_SCENARIOS } from "./scenarios";
import type { ReplayScenarioReport, ReplaySuiteReport } from "./types";

export interface RunReplaySuiteOptions {
  fixturesDir: string;
  /** Scenario ids (or id prefixes) to run; everything when empty. */
  filter?: readonly string[];
  keep?: boolean;
  tmpRoot?: string;
  log?: (line: string) => void;
  scenarios?: readonly ReplayScenario[];
}

export function selectScenarios(filter: readonly string[] | undefined, scenarios: readonly ReplayScenario[] = REPLAY_SCENARIOS): ReplayScenario[] {
  if (filter === undefined || filter.length === 0) return [...scenarios];
  const wanted = filter.map((entry) => entry.trim().toLowerCase()).filter((entry) => entry.length > 0);
  return scenarios.filter((scenario) => wanted.some((entry) => scenario.id === entry || scenario.id.startsWith(entry) || scenario.title.toLowerCase().includes(entry)));
}

export async function runScenario(scenario: ReplayScenario, options: Omit<RunReplaySuiteOptions, "filter" | "scenarios">): Promise<ReplayScenarioReport> {
  const started = Date.now();
  const log = options.log ?? (() => undefined);
  log(`${scenario.id} ${scenario.title}`);
  let run: ScenarioRun | null = null;
  let error: string | null = null;
  try {
    run = new ScenarioRunImpl({ scenarioId: scenario.id, fixturesDir: options.fixturesDir, config: scenario.config, keep: options.keep, tmpRoot: options.tmpRoot, log });
    await scenario.run(run);
  } catch (caught) {
    error = caught instanceof Error ? (caught.stack ?? caught.message) : String(caught);
    log(`  ERROR ${error.split("\n")[0] ?? error}`);
  } finally {
    run?.cleanup();
  }
  const checks = run?.checks ?? [];
  const ok = error === null && checks.every((check) => check.ok);
  return {
    id: scenario.id,
    title: scenario.title,
    asserts: [...scenario.asserts],
    ok,
    checks,
    duration_ms: Date.now() - started,
    error,
    root: options.keep === true && run !== null ? run.root : null,
    hook_calls: run?.hookCalls.length ?? 0,
    worker_runs: run?.workerRuns.length ?? 0,
  };
}

export async function runReplaySuite(options: RunReplaySuiteOptions): Promise<ReplaySuiteReport> {
  const started = Date.now();
  const scenarios = selectScenarios(options.filter, options.scenarios);
  const reports: ReplayScenarioReport[] = [];
  for (const scenario of scenarios) {
    reports.push(await runScenario(scenario, options));
  }
  const checks = reports.reduce((sum, report) => sum + report.checks.length, 0);
  const checksFailed = reports.reduce((sum, report) => sum + report.checks.filter((check) => !check.ok).length, 0);
  const passed = reports.filter((report) => report.ok).length;
  return {
    ok: reports.length > 0 && passed === reports.length,
    fixtures_dir: options.fixturesDir,
    scenarios: reports,
    totals: {
      scenarios: reports.length,
      passed,
      failed: reports.length - passed,
      checks,
      checks_failed: checksFailed,
      hook_calls: reports.reduce((sum, report) => sum + report.hook_calls, 0),
      duration_ms: Date.now() - started,
    },
  };
}
