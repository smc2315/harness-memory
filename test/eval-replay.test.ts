/**
 * eval:replay (spec §13.1–13.2): every scenario drives the real hook entry (`main()`) and the real worker
 * with the replay provider in its own temp project; a scenario passes when all of its checks pass.
 * Harness units (ledger → stdin script, fixture/hook ledger comparison, ref translation, placeholders)
 * are covered first so a scenario failure points at the pipeline, not at the harness.
 */

import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";

import type { ExtractionOutput } from "../src/core/extraction-types";
import type { LedgerLine } from "../src/core/ledger-types";
import { loadLedgerFixture, loadRecordedOutputs, materializeOutput, refResolver, resolveFixturesDir, translateRef, turnKeysOf, turnLines } from "../src/eval/replay/fixtures";
import { compareLedgerLines, hostToolFor, projectLine, scriptTurn, toolInputFor } from "../src/eval/replay/ledger-script";
import { checkExtractionEventIds } from "../src/eval/replay/preflight";
import { runReplaySuite, runScenario, selectScenarios } from "../src/eval/replay/run";
import { REPLAY_SCENARIOS } from "../src/eval/replay/scenarios";

const FIXTURES = resolve(__dirname, "fixtures", "replay");
const SCENARIO_TIMEOUT_MS = 120_000;

/**
 * Cross-module contract the write-path scenarios need: the extraction prompt must render event ids the
 * schema accepts. While it is broken (see the preflight test below), the scenarios that extract are
 * skipped with that reason instead of failing a dozen times on the same cause.
 */
const EVENT_IDS = checkExtractionEventIds();
const NEEDS_EXTRACTION = new Set(["s01", "s02", "s03", "s06", "s07", "s08", "s09", "s10", "s11", "s13"]);

describe("preflight: hooks ↔ prompt ↔ schema contracts", () => {
  test("the extraction prompt renders event ids the schema accepts for real (16-digit) ledger seqs", () => {
    expect(EVENT_IDS.ok, EVENT_IDS.detail).toBe(true);
  });
});

describe("replay fixtures", () => {
  test("thirteen scenarios, each with a ledger fixture; recorded outputs parse and cite fixture seqs", () => {
    expect(REPLAY_SCENARIOS.map((scenario) => scenario.id)).toEqual(["s01", "s02", "s03", "s04", "s05", "s06", "s07", "s08", "s09", "s10", "s11", "s12", "s13"]);
    const ledgers = readdirSync(FIXTURES).filter((name) => name.endsWith(".jsonl"));
    for (const id of REPLAY_SCENARIOS.map((scenario) => scenario.id)) {
      expect(ledgers.some((name) => name.startsWith(`${id}-`)), `ledger fixture for ${id}`).toBe(true);
    }
    for (const name of ledgers) {
      const fixture = loadLedgerFixture(FIXTURES, name);
      expect(fixture.badLines, `${name} has no bad lines`).toBe(0);
      expect(fixture.lines.length).toBeGreaterThan(0);
      expect(turnKeysOf(fixture.lines).length).toBeGreaterThan(0);
    }
    for (const name of readdirSync(FIXTURES).filter((entry) => entry.endsWith(".outputs.json"))) {
      const outputs = loadRecordedOutputs(FIXTURES, name);
      for (const [key, output] of Object.entries(outputs)) {
        expect(key).toMatch(/^[A-Z]\/[a-z]\d+$/);
        if (typeof output === "string") continue;
        for (const fact of output.facts) {
          for (const ref of fact.evidence_refs) expect(ref).toMatch(/^e\d+$/);
          expect(fact.summary.length).toBeGreaterThanOrEqual(12);
        }
      }
    }
    expect(resolveFixturesDir({ packageRoot: resolve(__dirname, "..") })).toBe(FIXTURES);
  });

  test("scriptTurn turns a recorded turn into the hook events Claude Code would fire", () => {
    const s02 = loadLedgerFixture(FIXTURES, "s02-fail-then-resolve.jsonl");
    const lines = turnLines(s02.lines, "p22");
    const events = scriptTurn(lines, { root: "C:\\proj" });
    expect(events.map((event) => event.event)).toEqual(["prompt", "pre-tool", "post-tool-failure", "pre-tool", "post-tool", "pre-tool", "post-tool", "stop"]);
    expect(events[0]!.stdin).toEqual({ prompt: "run the tests", prompt_id: "p22" });
    expect(events[2]!.stdin.tool_name).toBe("Bash");
    expect(events[2]!.stdin.error).toContain("Exit code 1");
    expect(events[2]!.stdin.tool_use_id).toBe("tu22-1");
    expect(events[1]!.fixtureSeq).toBeNull();
    expect(events[2]!.fixtureSeq).toBe(2202);
    expect(events[7]!.stdin.last_assistant_message).toContain("Tests pass");

    const s04 = loadLedgerFixture(FIXTURES, "s04-soft-deny-override.jsonl");
    const fired = scriptTurn(turnLines(s04.lines, "p4"), { root: "C:\\proj" });
    // a fired line is the PreToolUse of the following tool line: no second pre-tool is synthesized
    expect(fired.slice(0, 3).map((event) => event.event)).toEqual(["prompt", "pre-tool", "post-tool"]);
    expect(fired[1]!.fixtureSeq).toBe(4002);
    expect(fired[1]!.stdin.tool_input).toEqual({ command: "npm test", description: "replay" });

    expect(hostToolFor("bash", "powershell")).toBe("PowerShell");
    expect(hostToolFor("mcp:github/create_issue", null)).toBe("mcp__github__create_issue");
    expect(toolInputFor("edit", "src/index.ts", "C:\\proj")).toEqual({ file_path: join("C:\\proj", "src", "index.ts"), old_string: "before", new_string: "after" });
    expect(toolInputFor("fetch", "https://example.com", "C:\\proj")).toEqual({ url: "https://example.com" });
  });

  test("compareLedgerLines pairs non-fired lines, maps seqs and reports field diffs", () => {
    const fixture = turnLines(loadLedgerFixture(FIXTURES, "s02-fail-then-resolve.jsonl").lines, "p22");
    const produced: LedgerLine[] = fixture.map((line, index) => ({ ...line, seq: 9000 + index, ts: "2026-11-08T12:00:00.000Z" }));
    const same = compareLedgerLines(fixture, produced);
    expect(same.mismatches).toEqual([]);
    expect(same.seqMap.get(2202)).toBe(9001);
    expect(same.seqMap.get(2204)).toBe(9003);

    const broken = produced.map((line) => (line.kind === "tool_ok" && line.input_digest === "pnpm test" ? { ...line, resolution_of: null } : line));
    const diff = compareLedgerLines(fixture, broken);
    expect(diff.mismatches).toHaveLength(1);
    expect(diff.mismatches[0]).toContain("resolution_of");

    const extraFired = [...produced.slice(0, 1), { ...produced[1]!, kind: "fired", memory_ids: ["x"], rule_codes: [], tool: "bash", target_digest: "npm test", delivery: "before", decision: "deny", enforcement: "soft_deny" } as LedgerLine, ...produced.slice(1)];
    expect(compareLedgerLines(fixture, extraFired).mismatches).toEqual([]);
    expect(compareLedgerLines(fixture, extraFired, { compareFired: true }).mismatches[0]).toContain("fired count");
    expect(projectLine(fixture[0]!)).toEqual({ kind: "prompt", text: "run the tests", correction: 0, remember: 0 });
  });

  test("materializeOutput translates refs and resolves $created placeholders", () => {
    const outputs = loadRecordedOutputs(FIXTURES, "s02.outputs.json");
    const second = outputs["B/p22"] as ExtractionOutput;
    expect(second.facts[0]!.target_memory_id).toBe("$created:A/p21");
    // fixture seq → produced seq → event id rendered by the prompt builder
    const refOf = refResolver(
      new Map([
        [2202, 7001],
        [2204, 7003],
      ]),
      new Map([
        [7001, "e2"],
        [7003, "e4"],
      ])
    );
    const materialized = materializeOutput(second, { refOf, created: new Map([["A/p21", ["mem-created-1"]]]) }) as ExtractionOutput;
    expect(materialized.facts[0]!.target_memory_id).toBe("mem-created-1");
    expect(materialized.facts[0]!.evidence_refs).toEqual(["e2", "e4"]);
    // the recorded fixture is left untouched
    expect(second.facts[0]!.evidence_refs).toEqual(["e2202", "e2204"]);
    expect(translateRef("e2203", refOf)).toBe("e2203");
    expect(translateRef("e2202", refOf)).toBe("e2");
    expect(materializeOutput("not json at all", { refOf, created: new Map() })).toBe("not json at all");
    expect(() => materializeOutput(second, { refOf, created: new Map() })).toThrow(/placeholder/);
  });

  test("selectScenarios filters by id prefix or title", () => {
    expect(selectScenarios(["s0"]).map((scenario) => scenario.id)).toEqual(["s01", "s02", "s03", "s04", "s05", "s06", "s07", "s08", "s09"]);
    expect(selectScenarios(["budget"]).map((scenario) => scenario.id)).toEqual(["s12"]);
    expect(selectScenarios(["remember"]).map((scenario) => scenario.id)).toEqual(["s13"]);
    expect(selectScenarios([]).length).toBe(13);
  });
});

describe("replay scenarios (real hook entry + worker with the replay provider)", () => {
  for (const scenario of REPLAY_SCENARIOS) {
    test.skipIf(!EVENT_IDS.ok && NEEDS_EXTRACTION.has(scenario.id))(
      `${scenario.id} ${scenario.title} [${scenario.asserts.join(", ")}]`,
      async () => {
        const report = await runScenario(scenario, { fixturesDir: FIXTURES, log: () => undefined });
        const failures = report.checks.filter((check) => !check.ok).map((check) => `${check.name}${check.detail === undefined ? "" : ` — ${check.detail}`}`);
        expect(report.error, "scenario threw").toBeNull();
        expect(failures, `${scenario.id} failed checks`).toEqual([]);
        expect(report.checks.length).toBeGreaterThan(3);
        expect(report.hook_calls).toBeGreaterThan(0);
        expect(report.ok).toBe(true);
      },
      SCENARIO_TIMEOUT_MS
    );
  }

  test(
    "the suite report aggregates per-scenario results",
    async () => {
      // s05 does not depend on extraction, so this stays meaningful while the event-id contract is broken.
      const report = await runReplaySuite({ fixturesDir: FIXTURES, filter: ["s05"], log: () => undefined });
      expect(report.totals.scenarios).toBe(1);
      expect(report.scenarios[0]!.id).toBe("s05");
      expect(report.ok).toBe(report.scenarios[0]!.ok);
      expect(report.scenarios[0]!.root).toBeNull();
      expect(report.totals.checks).toBe(report.scenarios[0]!.checks.length);
      expect(existsSync(report.fixtures_dir)).toBe(true);
    },
    SCENARIO_TIMEOUT_MS
  );
});
