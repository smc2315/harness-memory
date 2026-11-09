/**
 * Scenario contract: an id (`s01`–`s12`), the spec §13 assertions it covers and an async body that drives
 * a `ScenarioRun`. Bodies record checks through `run.check` / `run.equal`; throwing aborts the scenario and
 * is reported as `error`.
 */

import type { ScenarioRun } from "./harness";

export interface ReplayScenario {
  id: string;
  title: string;
  /** `a`–`k` for §13.2, `13.1:<topic>` for the read-path assertions. */
  asserts: readonly string[];
  /** Partial config.json for this scenario's project. */
  config?: unknown;
  run(run: ScenarioRun): Promise<void>;
}

export function defineScenario(scenario: ReplayScenario): ReplayScenario {
  return scenario;
}
