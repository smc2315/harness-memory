/**
 * In-process hook runs with synthetic Claude Code stdin against a fixture snapshot (plan §4 B2 tests).
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { runHook, type HookResult } from "../src/adapters/hook-core";
import { normalizeClaudeCode, renderClaudeCode } from "../src/adapters/hosts/claude-code";
import type { EpisodeDescriptor } from "../src/core/episode-types";
import type { ClaudeCodeHookStdin, NormalizedHookInput } from "../src/core/hook-types";
import type { FiredLine, PromptLine, ToolFailLine, ToolOkLine } from "../src/core/ledger-types";
import { episodeId } from "../src/core/ids";
import { main } from "../src/hook";
import {
  bashStdin,
  claudeStdin,
  createHarnessFixture,
  FIXTURE_NOW,
  FIXTURE_SESSION_ID,
  fixtureMemory,
  recordingRuntime,
  writeStdin,
  type HarnessFixture,
  type RecordingRuntime,
} from "./helpers/snapshot-fixture";

const envPolicy = fixtureMemory({
  id: "11111111-env-policy",
  type: "policy",
  authority: "human",
  enforcement: "confirm",
  policy_subtype: "hard",
  knowledge_kind: "manual",
  summary: "Never write secrets into .env files from the agent",
  details: "Secrets go through the vault CLI; .env edits need a human.",
  signature: { tool: "write|edit", target: "path", pattern_kind: "glob", pattern: "**/.env*" },
  lifecycle_triggers: ["before_tool"],
  importance: 0.9,
  confidence: 0.95,
});

const seedPitfall = fixtureMemory({
  id: "22222222-seed-pitfall",
  type: "pitfall",
  authority: "auto",
  enforcement: "soft_deny",
  knowledge_kind: "correction",
  summary: "Run scripts/seed.js before the test script",
  details: "The integration tests read seeded rows; without the seed step the suite fails with empty tables.",
  signature: { tool: "bash", target: "command", pattern_kind: "cmd", pattern: "pm test" },
  lifecycle_triggers: ["before_tool", "before_model"],
  aliases: ["시드 스크립트", "테스트 전 시드", "seed first"],
  importance: 0.7,
  confidence: 0.85,
});

const adviseWorkflow = fixtureMemory({
  id: "33333333-push-workflow",
  type: "workflow",
  authority: "human",
  enforcement: "advise",
  knowledge_kind: "manual",
  summary: "Run the full test suite before pushing",
  details: "CI is slow; pushing red commits blocks the team.",
  signature: { tool: "bash", target: "command", pattern_kind: "cmd", pattern: "git push" },
  lifecycle_triggers: ["before_tool"],
});

const startupDecision = fixtureMemory({
  id: "44444444-startup-decision",
  type: "decision",
  authority: "human",
  activation_class: "startup",
  knowledge_kind: "decision",
  summary: "We decided to use sql.js instead of better-sqlite3 for portability",
  details: "No native build step on install.",
  lifecycle_triggers: ["session_start", "before_model"],
  importance: 0.8,
  confidence: 0.9,
});

const beforeToolOnlyPitfall = fixtureMemory({
  id: "55555555-bt-only",
  type: "pitfall",
  summary: "Do not run migrations against the production database",
  details: "Use the staging copy.",
  scope_glob: "src/db/**",
  lifecycle_triggers: ["before_tool"],
});

const hostLoadedRow = fixtureMemory({
  id: "66666666-claude-md",
  type: "workflow",
  authority: "human",
  activation_class: "startup",
  summary: "Prefer small commits (from CLAUDE.md)",
  details: "",
  source_file: "CLAUDE.md",
  lifecycle_triggers: ["session_start", "before_model"],
});

const scopedConvention = fixtureMemory({
  id: "77777777-scoped-convention",
  type: "workflow",
  authority: "human",
  knowledge_kind: "convention",
  summary: "Free every sql.js statement in a finally block after prepare",
  details: "Leaked statements keep the database file locked on Windows.",
  scope_glob: "src/db/**",
  lifecycle_triggers: ["before_model"],
});

const failureHint = fixtureMemory({
  id: "88888888-enoent-hint",
  type: "pitfall",
  authority: "auto",
  knowledge_kind: "failure_resolution",
  summary: "Install dependencies with npm ci before running the CLI",
  details: "ENOENT on package.json means the command ran outside the repo root.",
  lifecycle_triggers: ["after_tool"],
  failure_classes: ["enoent"],
});

const ALL_MEMORIES = [envPolicy, seedPitfall, adviseWorkflow, startupDecision, beforeToolOnlyPitfall, hostLoadedRow, scopedConvention, failureHint];

function normalize(stdin: ClaudeCodeHookStdin): NormalizedHookInput {
  const input = normalizeClaudeCode(stdin, null);
  if (input === null) throw new Error(`cannot normalize ${stdin.hook_event_name}`);
  return input;
}

describe("hook core (in-process, synthetic Claude Code stdin)", () => {
  let fixture: HarnessFixture;
  let recording: RecordingRuntime;

  async function run(stdin: ClaudeCodeHookStdin): Promise<HookResult> {
    const input = normalize(stdin);
    return runHook(input.event, input, recording.runtime);
  }

  beforeEach(() => {
    fixture = createHarnessFixture({
      memories: ALL_MEMORIES,
      failureIndex: { enoent: [failureHint.id] },
      counts: { open_proposals: 3, expiring_7d: 1 },
    });
    recording = recordingRuntime(fixture);
  });

  afterEach(() => {
    fixture.cleanup();
  });

  test("s03: writing .env hits the confirm policy → ask with a reason and a systemMessage", async () => {
    const result = await run(writeStdin(fixture, ".env", "SECRET=1"));
    expect(result.status).toBe("ok");
    expect(result.decision).toBe("ask");
    expect(result.enforcement).toBe("confirm");
    expect(result.delivery).toBe("before");
    expect(result.reason).toContain("[harness-memory] POLICY (human)");
    expect(result.reason).toContain("Never write secrets");
    expect(result.systemMessage).toBe(`harness-memory: policy ${envPolicy.id.slice(0, 8)} fired (confirm)`);
    expect(result.activated).toEqual([envPolicy.id]);

    const stdout = renderClaudeCode(result);
    expect(stdout?.hookSpecificOutput).toMatchObject({ hookEventName: "PreToolUse", permissionDecision: "ask" });
    expect(stdout?.hookSpecificOutput?.permissionDecisionReason?.length ?? 0).toBeLessThanOrEqual(600);

    const fired = fixture.readLedger().filter((line): line is FiredLine => line.kind === "fired");
    expect(fired).toHaveLength(1);
    expect(fired[0]).toMatchObject({
      memory_ids: [envPolicy.id],
      tool: "write",
      decision: "ask",
      delivery: "before",
      enforcement: "confirm",
      signature_keys: [envPolicy.signature!.signature_key],
    });
    expect(fired[0]!.target_digest).toBe(".env");
  });

  test("soft_deny: the first `npm test` is denied, the same-turn retry passes, both leave the right ledger trail", async () => {
    await run(claudeStdin(fixture, "UserPromptSubmit", { prompt: "run the tests", prompt_id: "p-1" }));

    const first = await run(bashStdin(fixture, "npm test"));
    expect(first.decision).toBe("deny");
    expect(first.enforcement).toBe("soft_deny");
    expect(first.delivery).toBe("before");
    expect(first.reason).toContain("PITFALL (auto, provisional)");
    expect(first.reason).toContain("call the tool again to proceed");
    expect(first.systemMessage).toContain("fired (soft_deny)");
    const stdout = renderClaudeCode(first);
    expect(stdout?.hookSpecificOutput?.permissionDecision).toBe("deny");

    const retry = await run(bashStdin(fixture, "npm test"));
    expect(retry.decision).toBe("none");
    expect(retry.activated).toEqual([]);
    expect(retry.detail.suppressed).toEqual(expect.arrayContaining([expect.objectContaining({ id: seedPitfall.id, kind: "already_fired" })]));
    expect(renderClaudeCode(retry)).toEqual({});

    const fired = fixture.readLedger().filter((line): line is FiredLine => line.kind === "fired");
    expect(fired).toHaveLength(1);
    expect(fired[0]).toMatchObject({ enforcement: "soft_deny", decision: "deny", tool: "bash", turn_key: "p-1" });
    expect(fired[0]!.signature_keys).toEqual([seedPitfall.signature!.signature_key]);

    // A different package manager spelling is the same canonical command → still the same turn's retry.
    const pnpm = await run(bashStdin(fixture, "pnpm test"));
    expect(pnpm.decision).toBe("none");
  });

  test("bypassPermissions downgrades confirm to soft_deny with delivery before_downgraded", async () => {
    const result = await run(writeStdin(fixture, "config/.env.local", "X=1", { permission_mode: "bypassPermissions" }));
    expect(result.decision).toBe("deny");
    expect(result.enforcement).toBe("soft_deny");
    expect(result.delivery).toBe("before_downgraded");
    expect(result.detail.downgraded).toBe(true);
    expect(result.reason).toContain("call the tool again");
    const fired = fixture.readLedger().filter((line): line is FiredLine => line.kind === "fired");
    expect(fired[0]).toMatchObject({ delivery: "before_downgraded", enforcement: "soft_deny", decision: "deny" });
  });

  test("advise rows produce additionalContext only — no permission decision, no systemMessage", async () => {
    const result = await run(bashStdin(fixture, "git push origin main"));
    expect(result.decision).toBe("none");
    expect(result.enforcement).toBe("advise");
    expect(result.delivery).toBe("with_result");
    expect(result.additionalContext).toContain("WORKFLOW (human)");
    expect(result.systemMessage).toBeNull();
    const stdout = renderClaudeCode(result);
    expect(stdout).toEqual({
      hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: result.additionalContext },
    });
    const fired = fixture.readLedger().filter((line): line is FiredLine => line.kind === "fired");
    expect(fired[0]).toMatchObject({ delivery: "with_result", decision: "none", enforcement: "advise" });
  });

  test("a non-matching command is a signature_mismatch, not a scope rescue", async () => {
    const result = await run(bashStdin(fixture, "npm run build"));
    expect(result.decision).toBe("none");
    expect(result.activated).toEqual([]);
    expect(result.detail.suppressed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: seedPitfall.id, kind: "signature_mismatch" }),
        expect.objectContaining({ id: adviseWorkflow.id, kind: "signature_mismatch" }),
      ])
    );
    expect(fixture.readLedger().filter((line) => line.kind === "fired")).toHaveLength(0);
  });

  test("stop closes the segment into queue/<id>.json with fired outcome, evidence weight and advanced state", async () => {
    await run(claudeStdin(fixture, "UserPromptSubmit", { prompt: "don't run npm test directly, seed first instead", prompt_id: "p-2" }));
    const denied = await run(bashStdin(fixture, "npm test"));
    expect(denied.decision).toBe("deny");
    await run(bashStdin(fixture, "npm test"));
    await run(claudeStdin(fixture, "PostToolUse", { tool_name: "Bash", tool_input: { command: "npm test" }, tool_use_id: "toolu_ok_1", tool_response: { stdout: "42 passing", stderr: "" } }));
    const stop = await run(claudeStdin(fixture, "Stop", { last_assistant_message: "Tests pass after seeding.", stop_hook_active: false, prompt_id: "p-2" }));

    expect(stop.status).toBe("ok");
    expect(stop.episodeId).toBe(episodeId("claude-code", FIXTURE_SESSION_ID, "p-2", 0));
    const queue = fixture.readQueue() as EpisodeDescriptor[];
    expect(queue).toHaveLength(1);
    const descriptor = queue[0]!;
    expect(descriptor.close_reason).toBe("stop");
    expect(descriptor.flags).toEqual({ correction: 1 });
    expect(descriptor.evidence_weight).toBe(2);
    expect(descriptor.tools).toEqual(["bash"]);
    expect(descriptor.fired).toEqual([{ memory_id: seedPitfall.id, enforcement: "soft_deny", outcome: "override", tool: "bash" }]);
    expect(descriptor.last_assistant_message).toBe("Tests pass after seeding.");
    expect(descriptor.ledger_ref).toBe(`ledger/${basename(fixture.ledgerPath())}#0-${String(descriptor.ledger_ref.split("-").pop())}`);
    expect(stop.spawned).toEqual(["extract"]);

    const state = fixture.readState();
    expect(state).toMatchObject({ turn_key: "p-2", segment: 1, last_episode_id: descriptor.id });
    expect(state!.turn_start_offset).toBe(readFileSync(fixture.ledgerPath()).length);
    expect(state!.last_episode_range).toEqual({ start: 0, end: state!.turn_start_offset });

    // A second Stop with stop_hook_active (another Stop hook continued the turn) has nothing new → no junk episode.
    const again = await run(claudeStdin(fixture, "Stop", { last_assistant_message: "Done.", stop_hook_active: true, prompt_id: "p-2" }));
    expect(again.status).toBe("skipped:empty_segment");
    expect(fixture.queueFiles()).toHaveLength(1);
  });

  test("a prompt after a failed tool closes the previous turn as interrupted and flags correction", async () => {
    await run(claudeStdin(fixture, "UserPromptSubmit", { prompt: "run the integration tests", prompt_id: "p-3" }));
    await run(bashStdin(fixture, "npm run build"));
    const failure = await run(
      claudeStdin(fixture, "PostToolUseFailure", {
        tool_name: "Bash",
        tool_input: { command: "npm run build" },
        tool_use_id: "toolu_fail_1",
        error: "Exit code 1\nTypeError: cannot read properties of undefined",
      })
    );
    expect(failure.detail.failure_class).toBe("exit_1");
    expect(fixture.queueFiles()).toHaveLength(0);

    const prompt = await run(claudeStdin(fixture, "UserPromptSubmit", { prompt: "please fix the build", prompt_id: "p-4" }));
    expect(prompt.status).toBe("ok");
    expect(prompt.detail.closed_as).toBe("interrupted");
    expect(prompt.detail.correction).toBe(1);
    expect(prompt.spawned).toEqual(["extract"]);

    const queue = fixture.readQueue() as EpisodeDescriptor[];
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({ turn_key: "p-3", close_reason: "interrupted", evidence_weight: 1 });
    expect(queue[0]!.failure_signatures[0]).toMatchObject({ class: "exit_1", tool: "bash", program_token: "pm build", resolved_seq: null });

    const promptLines = fixture.readLedger().filter((line): line is PromptLine => line.kind === "prompt");
    expect(promptLines).toHaveLength(2);
    expect(promptLines[1]).toMatchObject({ text: "please fix the build", correction: 1, remember: 0, turn_key: "p-4" });

    const state = fixture.readState();
    expect(state).toMatchObject({ turn_key: "p-4", segment: 0, correction_for: queue[0]!.id, last_episode_id: queue[0]!.id });

    // Closing the correcting turn carries the corrected episode's tool lines as context.
    await run(claudeStdin(fixture, "PostToolUse", { tool_name: "Bash", tool_input: { command: "npm run build" }, tool_use_id: "toolu_ok_2", tool_response: "ok" }));
    const stop = await run(claudeStdin(fixture, "Stop", { last_assistant_message: "Fixed the undefined access.", prompt_id: "p-4" }));
    const second = (fixture.readQueue() as EpisodeDescriptor[]).find((entry) => entry.id === stop.episodeId);
    expect(second).toBeDefined();
    expect(second!.correction_for).toBe(queue[0]!.id);
    expect(second!.context_ref).toContain("(prev) tool_fail bash(bash): npm run build");
    expect(second!.flags).toEqual({ correction: 1 });
    // The build success resolves the earlier failure of the same program token.
    const okLines = fixture.readLedger().filter((line): line is ToolOkLine => line.kind === "tool_ok");
    expect(okLines[0]!.resolution_of).toBe("bash|exit_1|pm build");
  });

  test("session-start injects startup rows only, skips before_tool-only pitfalls and host-loaded rows, and digests once a day", async () => {
    const first = await run(claudeStdin(fixture, "SessionStart", { source: "startup" }));
    expect(first.status).toBe("ok");
    expect(first.activated).toEqual([startupDecision.id]);
    expect(first.additionalContext).toContain("DECISION (human)");
    expect(first.additionalContext).not.toContain("production database");
    expect(first.additionalContext).not.toContain("CLAUDE.md");
    expect(first.systemMessage).toBe("harness-memory: 3 proposals open, 1 expiring within 7 days — run `hm review`");
    expect(first.spawned).toEqual([]);
    expect(fixture.readLedger()[0]).toMatchObject({ kind: "marker", marker: "session_start", detail: "startup" });

    const stdout = renderClaudeCode(first);
    expect(stdout?.hookSpecificOutput?.hookEventName).toBe("SessionStart");
    expect(stdout?.systemMessage).toContain("3 proposals");

    const second = await run(claudeStdin(fixture, "SessionStart", { source: "resume" }));
    expect(second.systemMessage).toBeNull();
    expect(fixture.readState()?.last_digest_date).toBe(FIXTURE_NOW.slice(0, 10));
  });

  test("session-start spawns the worker when the queue is non-empty or the snapshot predates the schema", async () => {
    writeFileSync(`${fixture.paths.queueDir}/pending.json`, "{}", "utf8");
    const result = await run(claudeStdin(fixture, "SessionStart", { source: "startup" }));
    expect(result.spawned).toEqual(["extract"]);

    fixture.rewriteSnapshot({ userVersion: 16 });
    const old = await run(claudeStdin(fixture, "SessionStart", { source: "startup" }));
    expect(old.spawned).toEqual(expect.arrayContaining(["reindex", "extract"]));
  });

  test("before_model: a Korean prompt reaches a memory through its aliases; scoped rows need a path token", async () => {
    const korean = await run(claudeStdin(fixture, "UserPromptSubmit", { prompt: "테스트 전에 시드 스크립트를 먼저 실행해야 해?", prompt_id: "p-5" }));
    expect(korean.status).toBe("ok");
    expect(korean.activated).toContain(seedPitfall.id);
    expect(korean.activated).not.toContain(hostLoadedRow.id);
    expect(korean.activated).not.toContain(scopedConvention.id);
    expect(korean.detail.lexical).toBe(true);
    expect(renderClaudeCode(korean)?.hookSpecificOutput?.hookEventName).toBe("UserPromptSubmit");

    const scoped = await run(claudeStdin(fixture, "UserPromptSubmit", { prompt: "how should I prepare statements in src/db/store.ts?", prompt_id: "p-6" }));
    expect(scoped.activated).toContain(scopedConvention.id);

    const unscoped = await run(claudeStdin(fixture, "UserPromptSubmit", { prompt: "how should I prepare statements?", prompt_id: "p-7" }));
    expect(unscoped.activated).not.toContain(scopedConvention.id);
    expect(unscoped.detail.suppressed).toEqual(expect.arrayContaining([expect.objectContaining({ id: scopedConvention.id, kind: "scope_mismatch" })]));
  });

  test("before_model consumes the worker notify file into a systemMessage and uses the dense client when configured", async () => {
    const dense = { topk: async () => ({ ids: [scopedConvention.id], scores: [0.91] }) };
    const withDense = recordingRuntime(fixture, {
      dense,
      config: { ...fixture.config, embeddings: { ...fixture.config.embeddings, enabled: true } },
    });
    const state = fixture.readState();
    expect(state).toBeNull();
    writeFileSync(
      `${fixture.paths.stateDir}/claude-code-${basename(fixture.ledgerPath(), ".jsonl").replace("claude-code-", "")}.notify.json`,
      JSON.stringify({ schema: "notify.v1", messages: ["harness-memory: 1 memory activated from your correction"], created_at: FIXTURE_NOW }),
      "utf8"
    );
    const input = normalize(claudeStdin(fixture, "UserPromptSubmit", { prompt: "statements in src/db/store.ts leak", prompt_id: "p-8" }));
    const result = await runHook(input.event, input, withDense.runtime);
    expect(result.systemMessage).toBe("harness-memory: 1 memory activated from your correction");
    expect(result.detail.dense).toBe(true);
    expect(withDense.denseCalls).toHaveLength(1);
    expect(result.activated).toContain(scopedConvention.id);
    expect(existsSync(`${fixture.paths.stateDir}/${basename(fixture.ledgerPath(), ".jsonl")}.notify.json`)).toBe(false);
  });

  test("after_tool: an ENOENT failure gets the failure-index hint as additionalContext", async () => {
    const result = await run(
      claudeStdin(fixture, "PostToolUseFailure", {
        tool_name: "Bash",
        tool_input: { command: "hm status" },
        tool_use_id: "toolu_fail_2",
        error: "ENOENT: no such file or directory, open 'package.json'",
      })
    );
    expect(result.status).toBe("ok");
    expect(result.detail.failure_class).toBe("enoent");
    expect(result.activated).toEqual([failureHint.id]);
    expect(result.additionalContext).toContain("npm ci");
    expect(renderClaudeCode(result)?.hookSpecificOutput).toMatchObject({ hookEventName: "PostToolUseFailure" });
    const failLines = fixture.readLedger().filter((line): line is ToolFailLine => line.kind === "tool_fail");
    expect(failLines[0]).toMatchObject({ failure_class: "enoent", failure_sig: "bash|enoent|hm", program_token: "hm", host_tool: "Bash" });
  });

  test("post-tool de-duplicates by tool_use_id and records scope refs / program tokens", async () => {
    const stdin = claudeStdin(fixture, "PostToolUse", {
      tool_name: "Edit",
      tool_input: { file_path: `${fixture.root}/src/db/store.ts`, old_string: "a", new_string: "b" },
      tool_use_id: "toolu_edit_1",
      tool_response: { filePath: "src/db/store.ts" },
    });
    const first = await run(stdin);
    expect(first.status).toBe("ok");
    const second = await run(stdin);
    expect(second.status).toBe("skipped:duplicate");
    const okLines = fixture.readLedger().filter((line): line is ToolOkLine => line.kind === "tool_ok");
    expect(okLines).toHaveLength(1);
    expect(okLines[0]).toMatchObject({ tool: "edit", input_digest: "src/db/store.ts", scope_refs: ["src/db/store.ts"], program_token: null });
  });

  test("session-end appends a marker, closes an open turn and spawns dream when due; stop-failure only marks", async () => {
    await run(claudeStdin(fixture, "UserPromptSubmit", { prompt: "remember: always seed before tests", prompt_id: "p-9" }));
    const stopFailure = await run(claudeStdin(fixture, "StopFailure", { error: "API overloaded" }));
    expect(stopFailure.status).toBe("ok");
    expect(renderClaudeCode(stopFailure)).toBeNull();

    const end = await run(claudeStdin(fixture, "SessionEnd", { reason: "prompt_input_exit" } as Partial<ClaudeCodeHookStdin>));
    expect(end.status).toBe("ok");
    expect(end.episodeId).not.toBeNull();
    expect(end.spawned).toEqual(["extract", "dream"]);
    const markers = fixture.readLedger().filter((line) => line.kind === "marker");
    expect(markers.map((line) => (line.kind === "marker" ? line.marker : ""))).toEqual(["stop_failure", "session_end"]);
    const descriptor = (fixture.readQueue() as EpisodeDescriptor[])[0]!;
    expect(descriptor.close_reason).toBe("session_end");
    expect(descriptor.flags).toEqual({ remember: 1 });
    expect(descriptor.evidence_weight).toBe(3);
  });

  test("missing, corrupt and stale snapshots never throw and request one reindex per minute", async () => {
    writeFileSync(fixture.paths.snapshotActive, "{not json", "utf8");
    const corrupt = await run(bashStdin(fixture, "npm test"));
    expect(corrupt.status).toBe("snapshot_missing");
    expect(corrupt.decision).toBe("none");
    expect(recording.spawns).toEqual(["reindex"]);
    expect(renderClaudeCode(corrupt)).toEqual({});

    const again = await run(bashStdin(fixture, "npm test"));
    expect(again.status).toBe("snapshot_missing");
    expect(recording.spawns).toEqual(["reindex"]);

    fixture.rewriteSnapshot();
    fixture.touchDb();
    const stale = await run(bashStdin(fixture, "git push"));
    expect(stale.status).toBe("ok");
    expect(stale.detail.stale).toBe(true);
    expect(stale.activated).toEqual([adviseWorkflow.id]);
  });

  test("a corrupt state file and odd inputs degrade gracefully", async () => {
    writeFileSync(`${fixture.paths.stateDir}/garbage.json`, "garbage", "utf8");
    const noTool = await run(claudeStdin(fixture, "PreToolUse", {}));
    expect(noTool.status).toBe("skipped:no_tool");
    const mcp = await run(
      claudeStdin(fixture, "PreToolUse", { tool_name: "mcp__github__create_issue", tool_input: { title: "x", body: "y" }, tool_use_id: "toolu_mcp" })
    );
    expect(mcp.status).toBe("ok");
    expect(mcp.tool).toBe("mcp:github/create_issue");
    const noOpenTurn = await run(claudeStdin(fixture, "Stop", { last_assistant_message: "hi" }));
    expect(noOpenTurn.status).toBe("skipped:no_open_turn");
  });
});

describe("hook main (process wrapper)", () => {
  let fixture: HarnessFixture;

  beforeEach(() => {
    fixture = createHarnessFixture({ memories: ALL_MEMORIES });
  });

  afterEach(() => {
    fixture.cleanup();
  });

  function io(stdin: unknown, env: NodeJS.ProcessEnv = {}) {
    const printed: Array<unknown> = [];
    return {
      printed,
      overrides: {
        readStdin: async () => (typeof stdin === "string" ? stdin : JSON.stringify(stdin)),
        writeStdout: (output: unknown) => {
          printed.push(output);
        },
        env,
        cwd: () => fixture.root,
        clock: () => FIXTURE_NOW,
        spawnWorker: null,
        dense: null,
      },
    };
  }

  test("prints exactly one JSON object for PreToolUse and logs one line", async () => {
    const { printed, overrides } = io(writeStdin(fixture, ".env", "SECRET=1"));
    const outcome = await main(["pre-tool"], overrides);
    expect(printed).toHaveLength(1);
    expect(outcome.stdout).toEqual(printed[0]);
    expect(outcome.stdout?.hookSpecificOutput?.permissionDecision).toBe("ask");
    const log = readFileSync(fixture.paths.hooksLog, "utf8").trim().split("\n");
    expect(log).toHaveLength(1);
    expect(log[0]).toMatch(/^2026-11-08T12:00:00\.000Z pre-tool tool=write gen=7 activated=1 suppressed=\d+ decision=ask delivery=before enforcement=confirm dur=\d+ms ok$/);
  });

  test("bad stdin prints {} and logs bad_stdin; the disable flag prints nothing before reading", async () => {
    const bad = io("this is not json");
    const outcome = await main(["pre-tool"], bad.overrides);
    expect(outcome.stdout).toEqual({});
    expect(bad.printed).toEqual([{}]);
    expect(readFileSync(fixture.paths.hooksLog, "utf8")).toContain("bad_stdin");

    const disabled = io(bashStdin(fixture, "npm test"), { HARNESS_MEMORY_DISABLE: "1" });
    const silent = await main(["pre-tool"], disabled.overrides);
    expect(silent.stdout).toBeNull();
    expect(disabled.printed).toEqual([]);
  });

  test("silent events print nothing; an uninstalled project prints {}", async () => {
    const stop = io(claudeStdin(fixture, "Stop", { last_assistant_message: "x" }));
    const outcome = await main(["stop"], stop.overrides);
    expect(outcome.stdout).toBeNull();
    expect(stop.printed).toEqual([null]);

    const elsewhere = createHarnessFixture({ withActive: false, withDb: false, withLexical: false });
    try {
      const outside = io({ ...bashStdin(fixture, "npm test"), cwd: `${elsewhere.root}-nope` });
      outside.overrides.cwd = () => `${elsewhere.root}-nope`;
      const result = await main(["pre-tool"], outside.overrides);
      expect(result.stdout).toEqual({});
      expect(result.result).toBeNull();
    } finally {
      elsewhere.cleanup();
    }
  });

  test("unknown argv falls back to hook_event_name and never throws on a broken config", async () => {
    writeFileSync(fixture.paths.config, "{broken", "utf8");
    const { overrides } = io(claudeStdin(fixture, "SessionStart", { source: "startup" }));
    const outcome = await main([], overrides);
    expect(outcome.result?.event).toBe("session-start");
    expect(outcome.stdout?.hookSpecificOutput?.hookEventName).toBe("SessionStart");
  });
});
