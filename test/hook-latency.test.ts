/**
 * Latency smoke (plan §4 B2): the in-process `pre-tool` path against a 300-memory snapshot must stay
 * well under the 50–90 ms process budget of spec §6.3 — median ≤ 15 ms here (override with
 * HM_LATENCY_BUDGET_MS on slow CI boxes). Every run re-reads the snapshot and the ledger tail from
 * disk, exactly like a fresh hook process would.
 */

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { runHook } from "../src/adapters/hook-core";
import { normalizeClaudeCode } from "../src/adapters/hosts/claude-code";
import type { ClaudeCodeHookStdin, NormalizedHookInput } from "../src/core/hook-types";
import { bashStdin, claudeStdin, createHarnessFixture, generateMemories, recordingRuntime, type HarnessFixture, type RecordingRuntime } from "./helpers/snapshot-fixture";

const BUDGET_MS = Number.parseFloat(process.env.HM_LATENCY_BUDGET_MS ?? "15");
const RUNS = 31;

function normalize(stdin: ClaudeCodeHookStdin): NormalizedHookInput {
  const input = normalizeClaudeCode(stdin, null);
  if (input === null) throw new Error("bad stdin");
  return input;
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)]!;
}

describe("pre-tool latency smoke (300 memories)", () => {
  let fixture: HarnessFixture;
  let recording: RecordingRuntime;

  beforeAll(async () => {
    fixture = createHarnessFixture({ memories: generateMemories(300) });
    recording = recordingRuntime(fixture);
    // A realistic ledger tail: one prompt and a few tool lines.
    const prompt = normalize(claudeStdin(fixture, "UserPromptSubmit", { prompt: "run the tests", prompt_id: "p-lat" }));
    await runHook(prompt.event, prompt, recording.runtime);
    for (let index = 0; index < 5; index += 1) {
      const ok = normalize(claudeStdin(fixture, "PostToolUse", { tool_name: "Bash", tool_input: { command: `ls src/${String(index)}` }, tool_use_id: `toolu_${String(index)}`, tool_response: "ok" }));
      await runHook(ok.event, ok, recording.runtime);
    }
  });

  afterAll(() => {
    fixture.cleanup();
  });

  test(`median in-process pre-tool run ≤ ${String(BUDGET_MS)} ms for Bash and Edit calls`, async () => {
    const inputs = [
      normalize(bashStdin(fixture, "npm test")),
      normalize(claudeStdin(fixture, "PreToolUse", { tool_name: "Edit", tool_input: { file_path: `${fixture.root}/src/db/store.ts`, old_string: "a", new_string: "b" }, tool_use_id: "toolu_edit" })),
      normalize(bashStdin(fixture, "git push --force origin main")),
    ];
    // Warm-up: module caches, regex caches, JIT.
    for (let index = 0; index < 5; index += 1) {
      for (const input of inputs) await runHook(input.event, input, recording.runtime);
    }
    const samples: number[] = [];
    for (let index = 0; index < RUNS; index += 1) {
      const input = inputs[index % inputs.length]!;
      const started = performance.now();
      const result = await runHook(input.event, input, recording.runtime);
      samples.push(performance.now() - started);
      expect(result.status).toBe("ok");
    }
    const p50 = median(samples);
    const max = Math.max(...samples);
    // eslint-disable-next-line no-console
    console.info(`pre-tool in-process: p50 ${p50.toFixed(2)} ms, max ${max.toFixed(2)} ms over ${String(RUNS)} runs / 300 memories`);
    expect(p50).toBeLessThanOrEqual(BUDGET_MS);
  });

  test("the 300-memory snapshot still yields decisions (sanity)", async () => {
    // A new prompt opens a new turn, so the soft_deny rows fired during the timing loop are eligible again.
    const prompt = normalize(claudeStdin(fixture, "UserPromptSubmit", { prompt: "run them again", prompt_id: "p-lat-2" }));
    await runHook(prompt.event, prompt, recording.runtime);
    const input = normalize(bashStdin(fixture, "npm test"));
    const result = await runHook(input.event, input, recording.runtime);
    expect(result.decision).toBe("deny");
    expect(result.activated.length).toBeGreaterThan(0);
    expect(result.activated.length).toBeLessThanOrEqual(3);
  });
});
