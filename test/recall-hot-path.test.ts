/**
 * Hot-path invariant of the recall layer (A′): PreToolUse never opens `snapshot/recall.v1.json` — nothing new is
 * loaded on the tool path, the only reader runs inside the prompt hook (hook-core `handlePrompt`). `node:fs` is
 * wrapped so every path the hooks open is recorded; the prompt hook is the positive control that proves the
 * recording sees the recall file when it is read.
 */

import { afterEach, describe, expect, test, vi } from "vitest";

const recorded = vi.hoisted(() => ({ paths: [] as string[] }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const record = (file: unknown): void => {
    if (typeof file === "string") recorded.paths.push(file);
    else if (file instanceof URL) recorded.paths.push(file.pathname);
  };
  const wrap =
    <A extends unknown[], R>(fn: (...args: A) => R) =>
    (...args: A): R => {
      record(args[0]);
      return fn(...args);
    };
  const mocked = {
    ...actual,
    readFileSync: wrap(actual.readFileSync),
    openSync: wrap(actual.openSync),
    statSync: wrap(actual.statSync),
    lstatSync: wrap(actual.lstatSync),
    existsSync: wrap(actual.existsSync),
    accessSync: wrap(actual.accessSync),
    createReadStream: wrap(actual.createReadStream),
  };
  return { ...mocked, default: mocked };
});

import { writeFileSync } from "node:fs";

import { runHook } from "../src/adapters/hook-core";
import { normalizeClaudeCode } from "../src/adapters/hosts/claude-code";
import type { RecallEpisode } from "../src/core/snapshot-types";
import { buildRecallSnapshot } from "../src/db/snapshot";
import { bashStdin, claudeStdin, createHarnessFixture, FIXTURE_NOW, fixtureMemory, recordingRuntime, type HarnessFixture } from "./helpers/snapshot-fixture";

function slash(path: string): string {
  return path.replace(/\\/g, "/");
}

function opened(file: string): boolean {
  const wanted = slash(file);
  return recorded.paths.some((path) => slash(path) === wanted);
}

function episode(id: string, sessionKey: string, summary: string, extra: Partial<RecallEpisode> = {}): RecallEpisode {
  return { id, session_key: sessionKey, host: "claude-code", closed_at: "2026-11-06T09:00:00.000Z", summary, summary_kind: "derived", tools: ["bash"], scope_refs: [], failure_classes: [], ...extra };
}

const EPISODES: RecallEpisode[] = [
  episode("ep-pnpm", "key-a", '"run the tests" | failed exit_1 pm test → resolved | tools bash×3', { summary_kind: "extracted", failure_classes: ["exit_1"] }),
  episode("ep-seed", "key-b", '"테스트 전에 시드 스크립트를 실행해야 한다" [correction] | tools bash×2', { scope_refs: ["scripts/seed.ts"] }),
  episode("ep-docs", "key-c", '"write the release notes for the docs site" | tools edit×4 | files docs/release.md'),
  episode("ep-store", "key-d", '"free the statements" | tools edit×2', { scope_refs: ["src/db/store.ts"] }),
];

describe("recall hot path", () => {
  let fixture: HarnessFixture | null = null;

  afterEach(() => {
    fixture?.cleanup();
    fixture = null;
  });

  test("PreToolUse never opens recall.v1.json; UserPromptSubmit is the only reader", async () => {
    const baseline = fixtureMemory({ id: "baseline", type: "policy", activation_class: "baseline", lifecycle_triggers: ["before_model", "before_tool"], summary: "Always run eslint before committing", authority: "human" });
    // Recall ships dark (DEFAULT_CONFIG.recall.enabled = false): the positive control switches it on.
    fixture = createHarnessFixture({ memories: [baseline], config: { recall: { enabled: true } } });
    writeFileSync(fixture.paths.snapshotRecall, JSON.stringify(buildRecallSnapshot({ builtAt: FIXTURE_NOW, dbGeneration: 7, episodes: EPISODES })), "utf8");
    const runtime = recordingRuntime(fixture).runtime;

    recorded.paths.length = 0;
    const preTool = await runHook("pre-tool", normalizeClaudeCode(bashStdin(fixture, "npm test"), "pre-tool")!, runtime);
    expect(preTool.status).toBe("ok");
    expect(preTool.gen).toBe(7);
    // The recording sees what the tool hook does read (the active snapshot) …
    expect(opened(fixture.paths.snapshotActive)).toBe(true);
    // … and the recall file is not among it, nor the lexical index: PreToolUse is snapshot-only.
    expect(opened(fixture.paths.snapshotRecall)).toBe(false);
    expect(opened(fixture.paths.snapshotLexical)).toBe(false);
    expect(preTool.detail.recall).toBeUndefined();
    expect(preTool.additionalContext ?? "").not.toContain("RECALL");

    recorded.paths.length = 0;
    const prompt = await runHook("prompt", normalizeClaudeCode(claudeStdin(fixture, "UserPromptSubmit", { prompt: "npm test fails again — what fixed the tests last time?", prompt_id: "p-hot-1" }), "prompt")!, runtime);
    expect(prompt.status).toBe("ok");
    expect(opened(fixture.paths.snapshotRecall)).toBe(true);
    expect(prompt.detail.recall).toEqual(["ep-pnpm"]);
    expect(prompt.additionalContext).toContain("[harness-memory] RECALL 2026-11-06: ");
  });

  test("recall.enabled = false: the prompt hook does not open the file either", async () => {
    fixture = createHarnessFixture({ config: { recall: { enabled: false } } });
    writeFileSync(fixture.paths.snapshotRecall, JSON.stringify(buildRecallSnapshot({ builtAt: FIXTURE_NOW, dbGeneration: 7, episodes: EPISODES })), "utf8");
    const runtime = recordingRuntime(fixture).runtime;
    recorded.paths.length = 0;
    const prompt = await runHook("prompt", normalizeClaudeCode(claudeStdin(fixture, "UserPromptSubmit", { prompt: "npm test fails again — what fixed the tests last time?", prompt_id: "p-hot-2" }), "prompt")!, runtime);
    expect(prompt.status).toBe("ok");
    expect(opened(fixture.paths.snapshotRecall)).toBe(false);
    expect(prompt.detail.recall).toEqual([]);
  });
});
