/**
 * Replay harness types (spec §13.1–13.2, plan §5 C2). A scenario is TypeScript that drives a `ScenarioRun`
 * (temp `.harness-memory`, real hook entry `main()`, real worker with the replay provider) and records
 * checks; the suite report is what `hm eval:replay` prints and what test/eval-replay.test.ts asserts on.
 */

import type { ClaudeCodeHookStdin, HookStdout } from "../../core/hook-types";
import type { EpisodeDescriptor } from "../../core/episode-types";
import type { LedgerLine } from "../../core/ledger-types";
import type { HookEvent } from "../../core/vocabulary";
import type { HookResult } from "../../adapters/hook-core";
import type { OffsetLedgerLine } from "../../dream/ledger";

export interface ReplayCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface ReplayScenarioReport {
  id: string;
  title: string;
  /** Spec §13 assertion labels this scenario covers (`a`–`k`, `13.1:s03`, …). */
  asserts: string[];
  ok: boolean;
  checks: ReplayCheck[];
  duration_ms: number;
  /** Uncaught exception while driving the scenario (counts as a failure). */
  error: string | null;
  /** Temp project root, only when `keep` was requested. */
  root: string | null;
  hook_calls: number;
  worker_runs: number;
}

export interface ReplaySuiteReport {
  ok: boolean;
  fixtures_dir: string;
  scenarios: ReplayScenarioReport[];
  totals: {
    scenarios: number;
    passed: number;
    failed: number;
    checks: number;
    checks_failed: number;
    hook_calls: number;
    duration_ms: number;
  };
}

/** One `main()` invocation of the hook entry. */
export interface HookCall {
  event: HookEvent;
  session: string;
  at: string;
  stdin: ClaudeCodeHookStdin;
  stdout: HookStdout | null;
  result: HookResult | null;
  /** Worker commands the hook asked to spawn (captured; the harness runs the worker itself). */
  spawned: string[];
}

/** A fixture turn replayed through the hooks. */
export interface TurnRecord {
  session: string;
  turnKey: string;
  fixture: string;
  fixtureLines: LedgerLine[];
  producedLines: OffsetLedgerLine[];
  episodeId: string | null;
  descriptor: EpisodeDescriptor | null;
  /** fixture `seq` → produced `seq` for the non-fired lines (extractor refs are translated through it). */
  seqMap: Map<number, number>;
  /** produced `seq` → the event id the extraction prompt renders for that line (what the extractor must cite). */
  refMap: Map<number, string>;
  calls: HookCall[];
  /** Projection mismatches between the fixture and what the hooks recorded (empty = reproduced). */
  mismatches: string[];
}
