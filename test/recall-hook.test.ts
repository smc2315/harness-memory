/**
 * Hook-side recall (A′, `src/activation/recall.ts`): index over summary + scope refs with the Hangul-aware
 * snapshot tokenizer, selection rules (min_score, current session excluded, items / bytes budget), the
 * `recall.v1.json` reader's tolerance, the prompt hook end to end through `runHook`, and the cost of
 * parse + index load + query on a 300-episode snapshot (< 10 ms median and best sample; the median gate alone
 * is loosened on CI). The hot-path guard (PreToolUse never opens the file) lives in recall-hot-path.test.ts.
 * Recall ships dark (`DEFAULT_CONFIG.recall.enabled = false`), so the hook fixtures here switch it on explicitly.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, test } from "vitest";

import { buildRecallIndex, readRecallSnapshot, renderRecallText, selectRecallItems, type RecallIndex } from "../src/activation/recall";
import { runHook, type HookResult } from "../src/adapters/hook-core";
import { normalizeClaudeCode } from "../src/adapters/hosts/claude-code";
import { LEXICAL_TOKENIZER_ID } from "../src/activation/lexical-snapshot";
import type { ClaudeCodeHookStdin } from "../src/core/hook-types";
import { resolvePaths, sessionKey } from "../src/core/paths";
import { RECALL_SNAPSHOT_SCHEMA, type RecallEpisode, type RecallSnapshot } from "../src/core/snapshot-types";
import { buildRecallSnapshot } from "../src/db/snapshot";
import { claudeStdin, createHarnessFixture, FIXTURE_HOST, FIXTURE_NOW, FIXTURE_SESSION_ID, fixtureMemory, recordingRuntime, type HarnessFixture } from "./helpers/snapshot-fixture";

let counter = 0;

function episode(overrides: Partial<RecallEpisode> = {}): RecallEpisode {
  counter += 1;
  const n = String(counter).padStart(3, "0");
  return {
    id: `ep-${n}`,
    session_key: `key-${n}`,
    host: "claude-code",
    closed_at: `2026-11-0${String((counter % 7) + 1)}T10:00:00.000Z`,
    summary: `"generic turn ${n}" | tools bash×1`,
    summary_kind: "derived",
    tools: ["bash"],
    scope_refs: [],
    failure_classes: [],
    ...overrides,
  };
}

/** What the snapshot builder writes (episodes + serialized index); `serialized: false` = the episodes-only form readers index themselves. */
function recallFile(episodes: RecallEpisode[], generation = 7, options: { serialized?: boolean } = {}): RecallSnapshot {
  if (options.serialized === false) return { schema: RECALL_SNAPSHOT_SCHEMA, built_at: FIXTURE_NOW, db_generation: generation, tokenizer: LEXICAL_TOKENIZER_ID, episodes };
  return buildRecallSnapshot({ builtAt: FIXTURE_NOW, dbGeneration: generation, episodes });
}

const PNPM = episode({ id: "ep-pnpm", session_key: "key-other", closed_at: "2026-11-06T09:00:00.000Z", summary: '"run the tests" | failed exit_1 pm test → resolved | tools bash×3', summary_kind: "extracted", failure_classes: ["exit_1"] });
const KOREAN = episode({ id: "ep-ko", session_key: "key-ko", closed_at: "2026-11-05T09:00:00.000Z", summary: '"테스트를 돌리기 전에 시드 스크립트를 실행해야 한다" [correction] | tools bash×2', scope_refs: ["scripts/seed.ts"] });
const SCOPED = episode({ id: "ep-scope", session_key: "key-scope", closed_at: "2026-11-04T09:00:00.000Z", summary: '"free the statements" | tools edit×2', scope_refs: ["src/db/store.ts", "src/db/sql.ts"] });
const NOISE = episode({ id: "ep-noise", session_key: "key-noise", summary: '"write the release notes for the docs site" | tools edit×4 | files docs/release.md' });

describe("recall index and selection", () => {
  test("indexes summary and scope refs with the snapshot tokenizer: English, Korean particles, path tokens", async () => {
    const index = await buildRecallIndex([PNPM, KOREAN, SCOPED, NOISE], { dbGeneration: 7, builtAt: FIXTURE_NOW });
    expect(index.episodeCount).toBe(4);
    expect(index.search("why does npm test fail here", 5)[0]?.episode.id).toBe("ep-pnpm");
    expect(index.search("시드 스크립트 먼저?", 5)[0]?.episode.id).toBe("ep-ko");
    expect(index.search("src/db/store.ts statements", 5)[0]?.episode.id).toBe("ep-scope");
    for (const hit of index.search("tests", 5)) {
      expect(hit.score).toBeGreaterThan(0);
      expect(hit.score).toBeLessThan(1);
      expect(hit.raw).toBeGreaterThan(hit.score);
    }
    expect(index.search("   ", 5)).toEqual([]);
    expect(index.search("tests", 0)).toEqual([]);
  });

  test("selectRecallItems: top hits above min_score, current session excluded, items and bytes capped, rendered as plain RECALL lines", async () => {
    const mine = episode({ id: "ep-mine", session_key: "key-me", summary: '"run the tests" | failed exit_1 pm test → unresolved | tools bash×1' });
    const index = await buildRecallIndex([PNPM, KOREAN, SCOPED, NOISE, mine], { dbGeneration: 7, builtAt: FIXTURE_NOW });
    const prompt = "the tests fail with npm test, what did we do last time?";
    const selection = selectRecallItems({ index, prompt, sessionKey: "key-me", maxItems: 2, maxBytes: 1_024, minScore: 0.5 });
    expect(selection.items.map((item) => item.id)).toEqual(["ep-pnpm"]);
    expect(selection.items[0]).toMatchObject({ session_key: "key-other", closed_at: "2026-11-06T09:00:00.000Z", summary_kind: "extracted" });
    expect(selection.text).toBe('[harness-memory] RECALL 2026-11-06: "run the tests" | failed exit_1 pm test → resolved | tools bash×3');
    expect(selection.bytes).toBe(Buffer.byteLength(selection.text!, "utf8"));
    expect(selection.text).not.toContain("permission");

    // Without the exclusion the same-session episode ranks too.
    const unfiltered = selectRecallItems({ index, prompt, sessionKey: null, maxItems: 2, maxBytes: 1_024, minScore: 0.5 });
    expect(unfiltered.items.map((item) => item.id).sort()).toEqual(["ep-mine", "ep-pnpm"]);
    expect(unfiltered.text!.split("\n")).toHaveLength(2);

    // Budget: one item max, then too few bytes for even one.
    expect(selectRecallItems({ index, prompt, sessionKey: null, maxItems: 1, maxBytes: 1_024, minScore: 0.5 }).items).toHaveLength(1);
    const starved = selectRecallItems({ index, prompt, sessionKey: null, maxItems: 2, maxBytes: 40, minScore: 0.5 });
    expect(starved.items).toEqual([]);
    expect(starved.dropped).toBe(2);
    expect(selectRecallItems({ index, prompt, sessionKey: null, maxItems: 0, maxBytes: 1_024, minScore: 0.5 }).items).toEqual([]);
    expect(selectRecallItems({ index, prompt: "  ", sessionKey: null, maxItems: 2, maxBytes: 1_024, minScore: 0.5 }).items).toEqual([]);

    // A strict threshold keeps weak, common-term matches out; an unrelated prompt recalls nothing.
    expect(selectRecallItems({ index, prompt, sessionKey: null, maxItems: 2, maxBytes: 1_024, minScore: 0.99 }).items).toEqual([]);
    expect(selectRecallItems({ index, prompt: "pancake recipe with blueberries", sessionKey: null, maxItems: 2, maxBytes: 1_024, minScore: 0.5 }).items).toEqual([]);
    expect(renderRecallText({ closed_at: "2026-11-08T23:59:59.000Z", summary: "a\u001b[31mb\u001b[0m  c" })).toBe("[harness-memory] RECALL 2026-11-08: ab c");
  });

  test("readRecallSnapshot tolerates a missing, corrupt or foreign file and drops malformed episodes", async () => {
    const root = mkdtempSync(join(tmpdir(), "hm-recall-"));
    try {
      const paths = resolvePaths(root);
      mkdirSync(paths.snapshotDir, { recursive: true });
      expect(await readRecallSnapshot(paths)).toBeNull();
      writeFileSync(paths.snapshotRecall, "{not json", "utf8");
      expect(await readRecallSnapshot(paths)).toBeNull();
      writeFileSync(paths.snapshotRecall, JSON.stringify({ schema: "active.v1", episodes: [] }), "utf8");
      expect(await readRecallSnapshot(paths)).toBeNull();
      writeFileSync(paths.snapshotRecall, JSON.stringify(recallFile([PNPM, { id: "broken" } as unknown as RecallEpisode], 9, { serialized: false })), "utf8");
      const loaded = await readRecallSnapshot(paths);
      expect(loaded?.episodeCount).toBe(1);
      expect(loaded?.dbGeneration).toBe(9);
      expect(loaded?.builtAt).toBe(FIXTURE_NOW);
      expect(loaded?.episodes.map((entry) => entry.id)).toEqual(["ep-pnpm"]);

      // The builder's form (serialized index) and the episodes-only form answer the same query identically.
      writeFileSync(paths.snapshotRecall, JSON.stringify(recallFile([PNPM, KOREAN, SCOPED, NOISE], 10)), "utf8");
      const serialized = (await readRecallSnapshot(paths))!;
      writeFileSync(paths.snapshotRecall, JSON.stringify(recallFile([PNPM, KOREAN, SCOPED, NOISE], 10, { serialized: false })), "utf8");
      const rebuilt = (await readRecallSnapshot(paths))!;
      for (const query of ["npm test fails", "시드 스크립트", "src/db/store.ts"]) {
        expect(serialized.search(query, 3).map((hit) => [hit.episode.id, hit.score.toFixed(6)])).toEqual(rebuilt.search(query, 3).map((hit) => [hit.episode.id, hit.score.toFixed(6)]));
      }
      // A file stamped with another tokenizer is re-indexed from its episodes instead of trusting its posting lists.
      writeFileSync(paths.snapshotRecall, JSON.stringify({ ...recallFile([PNPM], 11), tokenizer: "other.v0" }), "utf8");
      expect((await readRecallSnapshot(paths))?.search("npm test", 1)[0]?.episode.id).toBe("ep-pnpm");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("prompt hook with a recall snapshot", () => {
  let fixture: HarnessFixture | null = null;

  afterEach(() => {
    fixture?.cleanup();
    fixture = null;
  });

  async function prompt(fx: HarnessFixture, text: string, promptId: string): Promise<HookResult> {
    const stdin: ClaudeCodeHookStdin = claudeStdin(fx, "UserPromptSubmit", { prompt: text, prompt_id: promptId });
    const input = normalizeClaudeCode(stdin, "prompt")!;
    return runHook(input.event, input, recordingRuntime(fx).runtime);
  }

  test("UserPromptSubmit appends at most two RECALL lines after the memory items, skipping the current session; recall.enabled=false injects none", async () => {
    const baseline = fixtureMemory({ id: "baseline", type: "policy", activation_class: "baseline", lifecycle_triggers: ["before_model"], summary: "Always run eslint before committing", authority: "human" });
    fixture = createHarnessFixture({ memories: [baseline], config: { recall: { enabled: true } } });
    const ownKey = sessionKey(FIXTURE_HOST, FIXTURE_SESSION_ID);
    const own = episode({ id: "ep-own", session_key: ownKey, summary: '"run the tests" | failed exit_1 pm test → unresolved | tools bash×1' });
    const third = episode({ id: "ep-third", session_key: "key-3", closed_at: "2026-11-02T08:00:00.000Z", summary: '"npm test keeps failing in CI" | failed exit_1 pm test → resolved | tools bash×2' });
    writeFileSync(fixture.paths.snapshotRecall, JSON.stringify(recallFile([PNPM, KOREAN, SCOPED, NOISE, own, third])), "utf8");

    const result = await prompt(fixture, "npm test fails again — what fixed the tests last time?", "p-recall-1");
    expect(result.status).toBe("ok");
    expect(result.activated).toEqual(["baseline"]);
    expect(result.decision).toBe("none");
    expect(result.enforcement).toBeNull();
    expect(result.reason).toBeNull();
    const lines = result.additionalContext!.split("\n");
    expect(lines[0]).toContain("[harness-memory] POLICY (human): Always run eslint before committing");
    const recallLines = lines.slice(1);
    expect(recallLines).toHaveLength(2);
    for (const line of recallLines) expect(line).toMatch(/^\[harness-memory\] RECALL 2026-11-0\d: /);
    expect(result.detail.recall).toEqual(expect.arrayContaining(["ep-pnpm", "ep-third"]));
    expect(result.detail.recall).not.toContain("ep-own");
    expect(result.delivery).toBe("with_result");
    // No fired line is written for recall: the ledger holds only the prompt line.
    expect(fixture.readLedger().filter((line) => line.kind === "fired")).toEqual([]);

    const disabled = createHarnessFixture({ memories: [baseline], config: { recall: { enabled: false } } });
    try {
      writeFileSync(disabled.paths.snapshotRecall, JSON.stringify(recallFile([PNPM, third])), "utf8");
      const off = await prompt(disabled, "npm test fails again — what fixed the tests last time?", "p-recall-2");
      expect(off.additionalContext!.split("\n")).toHaveLength(1);
      expect(off.detail.recall).toEqual([]);
    } finally {
      disabled.cleanup();
    }
  });

  test("recall items yield to the before_model byte budget the memory items already used", async () => {
    const rows = Array.from({ length: 5 }, (_, index) =>
      fixtureMemory({ id: `b-${String(index)}`, type: "policy", activation_class: "baseline", lifecycle_triggers: ["before_model"], summary: `Baseline rule ${String(index)} about running the tests with pnpm`, details: "x".repeat(200), authority: "human" })
    );
    fixture = createHarnessFixture({ memories: rows, config: { before_model: { max_bytes: 1_300 }, recall: { enabled: true } } });
    writeFileSync(fixture.paths.snapshotRecall, JSON.stringify(recallFile([PNPM, KOREAN])), "utf8");
    const result = await prompt(fixture, "the tests fail with npm test", "p-recall-3");
    expect(Buffer.byteLength(result.additionalContext ?? "", "utf8")).toBeLessThanOrEqual(1_300);
    const recallLines = (result.additionalContext ?? "").split("\n").filter((line) => line.includes(" RECALL "));
    expect(recallLines.length).toBeLessThanOrEqual(1);
  });
});

describe("recall cost on a 300-episode snapshot", () => {
  test("parse + index build + query stays small (reported; target < 10 ms)", async () => {
    const root = mkdtempSync(join(tmpdir(), "hm-recall-cost-"));
    try {
      const paths = resolvePaths(root);
      mkdirSync(paths.snapshotDir, { recursive: true });
      const words = ["tests", "build", "lint", "migration", "snapshot", "worker", "ledger", "pnpm", "vitest", "sqlite", "hook", "deploy", "docker", "release", "docs"];
      const episodes: RecallEpisode[] = Array.from({ length: 300 }, (_, index) => {
        const a = words[index % words.length]!;
        const b = words[(index * 7) % words.length]!;
        const c = words[(index * 3) % words.length]!;
        return episode({
          id: `cost-${String(index).padStart(3, "0")}`,
          session_key: `key-${String(index % 40)}`,
          summary: `"fix the ${a} ${b} step in src/${c}/${a}.ts and rerun the ${c} pipeline" | failed exit_${String(index % 3)} pm ${a} → ${index % 2 === 0 ? "resolved" : "unresolved"} | tools bash×${String((index % 5) + 1)} edit×${String(index % 3)} | files src/${c}/${a}.ts, src/${b}/index.ts, test/${a}.test.ts`,
          scope_refs: [`src/${c}/${a}.ts`, `src/${b}/index.ts`, `test/${a}.test.ts`],
          failure_classes: [`exit_${String(index % 3)}`],
        });
      });
      const json = JSON.stringify(recallFile(episodes));
      writeFileSync(paths.snapshotRecall, json, "utf8");
      expect(json.length).toBeLessThan(300 * 1_000);

      const prompt = "the vitest tests fail after the sqlite migration, what did we do in the worker last time?";
      const run = async (): Promise<number> => {
        const started = performance.now();
        const index: RecallIndex | null = await readRecallSnapshot(paths);
        const selection = selectRecallItems({ index: index!, prompt, sessionKey: "key-1", maxItems: 2, maxBytes: 1_024, minScore: 0.5 });
        const elapsed = performance.now() - started;
        expect(index!.episodeCount).toBe(300);
        expect(selection.items.length).toBeGreaterThan(0);
        return elapsed;
      };
      for (let i = 0; i < 3; i += 1) await run();
      const samples: number[] = [];
      for (let i = 0; i < 20; i += 1) samples.push(await run());
      samples.sort((left, right) => left - right);
      const median = samples[Math.floor(samples.length / 2)]!;
      const p95 = samples[Math.floor(samples.length * 0.95)]!;
      console.info(`recall cost (300 episodes, ${String(json.length)} bytes, serialized index): median ${median.toFixed(2)} ms, p95 ${p95.toFixed(2)} ms, min ${samples[0]!.toFixed(2)} ms`);
      // The brief's number: parse + load + query under 10 ms (median and best sample) on a developer machine. The
      // in-hook index build this design replaced measured 12.2 ms median, so a regression back to it fails here.
      // CI runners are slower and noisier, so only the median gate is loosened there.
      const ci = process.env.CI !== undefined && process.env.CI !== "" && process.env.CI !== "false";
      expect(samples[0]!).toBeLessThan(10);
      expect(median).toBeLessThan(ci ? 25 : 10);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
