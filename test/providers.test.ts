/**
 * Extraction providers (spec §5.4, m0-facts #2–#7, #16): argument shapes, envelope classification,
 * replay answers, provider selection, the daily probe cache and the allowlisted child environment.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { DEFAULT_CONFIG } from "../src/core/config";
import { EXTRACTION_SCHEMA_JSON } from "../src/core/extraction-types";
import { rawFile, resolvePaths } from "../src/core/paths";
import { providerEnv } from "../src/core/process";
import {
  PROBE_SCHEMA_JSON,
  buildClaudeArgs,
  buildCodexArgs,
  classifyClaudeRun,
  classifyCodexRun,
  claudeChildEnv,
  createClaudeProvider,
  createCodexProvider,
  createReplayProvider,
  extractCodexMessage,
  parseClaudeEnvelope,
  probeWithCache,
  readProbeCache,
  selectProvider,
  writeProbeCache,
  type CommandRunInput,
  type CommandRunResult,
} from "../src/dream/extract/providers";
import { createTestDb } from "./helpers/create-test-db";
import { T0, isoPlus } from "./helpers/memory-fixtures";

const okRun = (stdout: string, extra: Partial<CommandRunResult> = {}): CommandRunResult => ({ stdout, stderr: "", exitCode: 0, timedOut: false, spawnError: null, ...extra });

describe("claude provider", () => {
  test("buildClaudeArgs: documented flags, no --max-turns, model only when configured", () => {
    const args = buildClaudeArgs("{}", null);
    expect(args).toEqual([
      "-p", "--output-format", "json", "--json-schema", "{}", "--tools", "", "--disallowedTools", "mcp__*",
      "--strict-mcp-config", "--no-session-persistence", "--settings", '{"disableAllHooks":true,"autoMemoryEnabled":false}',
    ]);
    expect(args).not.toContain("--max-turns");
    expect(buildClaudeArgs("{}", "claude-sonnet-4-5").slice(-2)).toEqual(["--model", "claude-sonnet-4-5"]);
  });

  test("classifyClaudeRun maps envelopes onto run statuses", () => {
    const structured = { episode_summary: "s", nothing_to_learn: true, facts: [] };
    const ok = classifyClaudeRun(okRun(JSON.stringify({ type: "result", is_error: false, result: "", structured_output: structured, modelUsage: { "claude-sonnet-4-5": {} } })));
    expect(ok).toMatchObject({ status: "ok", structured, model: "claude-sonnet-4-5" });
    expect(JSON.parse(ok.raw)).toEqual(structured);

    expect(classifyClaudeRun(okRun(JSON.stringify({ type: "result", is_error: true, result: "Not logged in · Please run /login" }), { exitCode: 1 })).status).toBe("not_logged_in");
    expect(classifyClaudeRun(okRun(JSON.stringify({ type: "result", is_error: true, result: "Claude Code cannot be launched inside another Claude Code session (CLAUDECODE is set)" }))).status).toBe("nested_refusal");
    expect(classifyClaudeRun(okRun(JSON.stringify({ type: "result", is_error: true, result: "rate limited" }))).status).toBe("provider_error");
    expect(classifyClaudeRun(okRun(JSON.stringify({ type: "result", is_error: false, result: "plain text answer" }))).status).toBe("invalid_output");
    expect(classifyClaudeRun(okRun("not json at all"))).toMatchObject({ status: "invalid_output" });
    expect(classifyClaudeRun(okRun("", { exitCode: 1, stderr: "boom" }))).toMatchObject({ status: "provider_error", error: "boom" });
    expect(classifyClaudeRun(okRun("", { exitCode: 1, stderr: "Not logged in" })).status).toBe("not_logged_in");
    expect(classifyClaudeRun(okRun("", { timedOut: true })).status).toBe("timeout");
    expect(classifyClaudeRun(okRun("", { spawnError: "ENOENT" })).status).toBe("provider_error");
  });

  test("parseClaudeEnvelope tolerates log noise and stream-json lines", () => {
    expect(parseClaudeEnvelope(`warning: something\n${JSON.stringify({ type: "result", result: "x" })}\n`)).toMatchObject({ type: "result" });
    expect(parseClaudeEnvelope(`${JSON.stringify({ type: "system" })}\n${JSON.stringify({ type: "result", result: "y" })}`)).toMatchObject({ result: "y" });
    expect(parseClaudeEnvelope("")).toBeNull();
    expect(parseClaudeEnvelope("[1,2]")).toBeNull();
  });

  test("probe/extract run the binary with the prompt on stdin and the allowlisted env", async () => {
    const calls: CommandRunInput[] = [];
    const runner = async (input: CommandRunInput): Promise<CommandRunResult> => {
      calls.push(input);
      const schemaIsProbe = input.args[4] === PROBE_SCHEMA_JSON;
      return okRun(JSON.stringify({ type: "result", is_error: false, result: "", structured_output: schemaIsProbe ? { ok: true } : { episode_summary: "s", nothing_to_learn: true, facts: [] } }));
    };
    const cwd = mkdtempSync(join(tmpdir(), "hm-provider-"));
    const provider = createClaudeProvider({ binary: "C:/fake/claude.exe", runner, cwd });
    const paths = resolvePaths(cwd);
    expect(await provider.probe({ config: DEFAULT_CONFIG, paths, now: T0 })).toEqual({ result: "ok", detail: null });
    const result = await provider.extract("PROMPT", EXTRACTION_SCHEMA_JSON, { timeoutMs: 1000, model: null, paths });
    expect(result.status).toBe("ok");
    const pinned = await provider.extract("PROMPT", EXTRACTION_SCHEMA_JSON, { timeoutMs: 1000, model: "claude-haiku-5-5", paths });
    expect(pinned.status).toBe("ok");
    expect(calls).toHaveLength(3);
    expect(calls[0]!.binary).toBe("C:/fake/claude.exe");
    expect(calls[0]!.timeoutMs).toBe(DEFAULT_CONFIG.extraction.probe_timeout_ms);
    // extraction.model null → the sonnet alias, never the interactive default of ~/.claude/settings.json
    expect(calls[0]!.args.slice(-2)).toEqual(["--model", "sonnet"]);
    expect(calls[1]!.args.slice(-2)).toEqual(["--model", "sonnet"]);
    expect(calls[2]!.args.slice(-2)).toEqual(["--model", "claude-haiku-5-5"]);
    expect(calls[1]!.stdin).toBe("PROMPT");
    expect(calls[1]!.args[4]).toBe(EXTRACTION_SCHEMA_JSON);
    expect(calls[1]!.cwd).toBe(cwd);
    expect(calls[1]!.env.HARNESS_MEMORY_DISABLE).toBe("1");
    expect(calls[1]!.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe("1");
    rmSync(cwd, { recursive: true, force: true });
  });

  test("probe maps failures: not_logged_in, nested_refusal, probe_timeout, provider_error (with the message), missing binary", async () => {
    const make = (result: CommandRunResult) => createClaudeProvider({ binary: "x", runner: async () => result, cwd: tmpdir() });
    const ctx = { config: DEFAULT_CONFIG, paths: resolvePaths(tmpdir()), now: T0 };
    expect(await make(okRun(JSON.stringify({ type: "result", is_error: true, result: "Not logged in" }))).probe(ctx)).toMatchObject({ result: "not_logged_in" });
    expect(await make(okRun(JSON.stringify({ type: "result", is_error: true, result: "nested session refused" }))).probe(ctx)).toMatchObject({ result: "nested_refusal" });
    expect(await make(okRun("", { timedOut: true })).probe(ctx)).toMatchObject({ result: "probe_timeout" });
    expect(await make(okRun(JSON.stringify({ type: "result", result: "no schema" }))).probe(ctx)).toMatchObject({ result: "invalid_output" });
    // The 2.1.317 envelope of a failed API call: is_error with api_error_status; 404 on the model keeps its message, 401 is auth.
    const modelError = "There's an issue with the selected model (anthropic.claude-opus-5[1m]). It may not exist or you may not have access to it.";
    expect(await make(okRun(JSON.stringify({ type: "result", subtype: "success", is_error: true, api_error_status: 404, result: modelError }), { exitCode: 1 })).probe(ctx)).toEqual({ result: "provider_error", detail: `api 404: ${modelError}` });
    expect(await make(okRun(JSON.stringify({ type: "result", is_error: true, api_error_status: 401, result: "unauthorized" }), { exitCode: 1 })).probe(ctx)).toMatchObject({ result: "not_logged_in" });
    const missing = createClaudeProvider({ binary: null, runner: async () => okRun("") , cwd: tmpdir() });
    expect(await missing.probe(ctx)).toMatchObject({ result: "missing" });
    expect((await missing.extract("p", "{}", { timeoutMs: 10, model: null })).status).toBe("no_provider");
  });
});

describe("claude provider — model and cost of a run", () => {
  test("the answering model is the modelUsage entry with the most output tokens; total_cost_usd is carried", () => {
    const envelope = {
      type: "result",
      is_error: false,
      result: "{}",
      structured_output: { ok: true },
      total_cost_usd: 0.0231,
      modelUsage: { "claude-haiku-4-5-20251001": { outputTokens: 12, costUSD: 0.0001 }, "claude-sonnet-5-5": { outputTokens: 1480, costUSD: 0.023 } },
    };
    expect(classifyClaudeRun(okRun(JSON.stringify(envelope)))).toMatchObject({ status: "ok", model: "claude-sonnet-5-5", costUsd: 0.0231 });
    expect(classifyClaudeRun(okRun(JSON.stringify({ type: "result", structured_output: { ok: true } }))).costUsd).toBeUndefined();
  });
});

describe("codex provider", () => {
  test("buildCodexArgs and message extraction from JSONL events", () => {
    expect(buildCodexArgs("schema.json", null)).toEqual(["exec", "-", "--output-schema", "schema.json", "--ephemeral", "--sandbox", "read-only", "--skip-git-repo-check", "--json", "-c", "features.hooks=false"]);
    const events = [
      JSON.stringify({ type: "item.started", item: { type: "reasoning" } }),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: '{"episode_summary":"s","nothing_to_learn":true,"facts":[]}' } }),
      JSON.stringify({ type: "turn.completed" }),
    ].join("\n");
    expect(extractCodexMessage(events).text).toBe('{"episode_summary":"s","nothing_to_learn":true,"facts":[]}');
    expect(classifyCodexRun(okRun(events))).toMatchObject({ status: "ok" });
    expect(classifyCodexRun(okRun(JSON.stringify({ type: "error", message: "login required" }), { exitCode: 1 })).status).toBe("not_logged_in");
    expect(classifyCodexRun(okRun("", { timedOut: true })).status).toBe("timeout");
    expect(classifyCodexRun(okRun("plain json {\"ok\":true}"))).toMatchObject({ status: "ok" });
  });

  test("extract writes the schema file into the cwd and removes it afterwards", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "hm-codex-"));
    let seenArgs: readonly string[] = [];
    const provider = createCodexProvider({
      binary: "codex",
      cwd,
      runner: async (input) => {
        seenArgs = input.args;
        return okRun(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "{\"ok\":true}" } }));
      },
    });
    expect(await provider.probe({ config: DEFAULT_CONFIG, paths: resolvePaths(cwd), now: T0 })).toEqual({ result: "ok", detail: null });
    expect(seenArgs[3]!.startsWith(join(cwd, "schema-"))).toBe(true);
    rmSync(cwd, { recursive: true, force: true });
  });
});

describe("replay provider and selection", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "hm-replay-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("answers by episode id, run id, raw directory, else no_provider", async () => {
    const paths = resolvePaths(root);
    mkdirSync(paths.rawDir, { recursive: true });
    writeFileSync(rawFile(paths, "run-cached"), '{"from":"disk"}');
    const output = { episode_summary: "s", nothing_to_learn: true, facts: [] };
    const calls: string[] = [];
    const provider = createReplayProvider({ answers: { "ep-1": output, "run-2": "raw string" }, paths, onExtract: (options) => void calls.push(options.episodeId ?? "?") });
    expect(await provider.probe({ config: DEFAULT_CONFIG, paths, now: T0 })).toBe("ok");
    expect(await provider.extract("p", "{}", { timeoutMs: 1, model: null, episodeId: "ep-1", runId: "x" })).toMatchObject({ status: "ok", structured: output, model: "replay" });
    expect(await provider.extract("p", "{}", { timeoutMs: 1, model: null, episodeId: "ep-2", runId: "run-2" })).toMatchObject({ status: "ok", raw: "raw string" });
    expect(await provider.extract("p", "{}", { timeoutMs: 1, model: null, episodeId: "ep-3", runId: "run-cached" })).toMatchObject({ status: "ok", raw: '{"from":"disk"}' });
    expect(await provider.extract("p", "{}", { timeoutMs: 1, model: null, episodeId: "ep-4", runId: "run-4" })).toMatchObject({ status: "no_provider" });
    expect(calls).toEqual(["ep-1", "ep-2", "ep-3", "ep-4"]);
  });

  test("selectProvider: auto prefers claude, falls back to codex, else null; env override wins", () => {
    const config = { extraction: { ...DEFAULT_CONFIG.extraction } };
    expect(selectProvider(config, { resolveClaude: () => "claude.exe", resolveCodex: () => null, envOverride: null })?.name).toBe("claude");
    expect(selectProvider(config, { resolveClaude: () => null, resolveCodex: () => "codex.exe", envOverride: null })?.name).toBe("codex");
    expect(selectProvider(config, { resolveClaude: () => null, resolveCodex: () => null, envOverride: null })).toBeNull();
    expect(selectProvider({ extraction: { ...config.extraction, provider: "claude" } }, { resolveClaude: () => null, resolveCodex: () => "codex.exe", envOverride: null })).toBeNull();
    expect(selectProvider({ extraction: { ...config.extraction, provider: "replay" } }, { envOverride: null })?.name).toBe("replay");
    expect(selectProvider(config, { resolveClaude: () => "claude.exe", envOverride: "replay" })?.name).toBe("replay");
    expect(selectProvider({ extraction: { ...config.extraction, provider: "opencode" } }, { envOverride: null })).toBeNull();
  });
});

describe("probe cache", () => {
  test("readProbeCache trusts an ok probe for 24 h and a failed probe for 10 min; probeWithCache skips the probe when cached and never caches replay", async () => {
    const db = await createTestDb({ now: T0 });
    expect(readProbeCache(db, T0)).toBeNull();
    writeProbeCache(db, { at: T0, result: "not_logged_in" });
    expect(readProbeCache(db, isoPlus(T0, { minutes: 9 }))).toEqual({ at: T0, result: "not_logged_in", detail: null });
    expect(readProbeCache(db, isoPlus(T0, { minutes: 11 }))).toBeNull();
    expect(readProbeCache(db, isoPlus(T0, { hours: 23 }))).toBeNull();
    writeProbeCache(db, { at: T0, result: "ok" });
    expect(readProbeCache(db, isoPlus(T0, { hours: 23 }))).toEqual({ at: T0, result: "ok", detail: null });
    expect(readProbeCache(db, isoPlus(T0, { hours: 25 }))).toBeNull();

    let probes = 0;
    const provider = createClaudeProvider({ binary: "x", cwd: tmpdir(), runner: async () => { probes += 1; return okRun(JSON.stringify({ type: "result", structured_output: { ok: true } })); } });
    const ctx = { config: DEFAULT_CONFIG, paths: resolvePaths(tmpdir()), now: T0 };
    expect(await probeWithCache(provider, { at: T0, result: "not_logged_in", detail: "api 401: unauthorized" }, ctx)).toEqual({ result: "not_logged_in", detail: "api 401: unauthorized", fromCache: true, cacheable: false });
    expect(await probeWithCache(provider, null, ctx)).toEqual({ result: "ok", detail: null, fromCache: false, cacheable: true });
    expect(probes).toBe(1);
    expect(await probeWithCache(createReplayProvider(), null, ctx)).toEqual({ result: "ok", detail: null, fromCache: false, cacheable: false });
    // The message round-trips through meta and is dropped again by an ok probe.
    writeProbeCache(db, { at: T0, result: "provider_error", detail: "api 404: no such model" });
    expect(readProbeCache(db, isoPlus(T0, { minutes: 1 }))).toEqual({ at: T0, result: "provider_error", detail: "api 404: no such model" });
    writeProbeCache(db, { at: T0, result: "ok" });
    expect(readProbeCache(db, isoPlus(T0, { minutes: 1 }))).toEqual({ at: T0, result: "ok", detail: null });
    db.close();
  });
});

describe("providerEnv", () => {
  test("strips CLAUDE* / CODEX* variables, keeps the allowlist and sets HARNESS_MEMORY_DISABLE", () => {
    const saved = { ...process.env };
    process.env.CLAUDECODE = "1";
    process.env.CLAUDE_CODE_EXECPATH = "C:/claude.exe";
    process.env.CLAUDE_CODE_ENTRYPOINT = "cli";
    process.env.CODEX_SANDBOX = "1";
    process.env.ANTHROPIC_API_KEY = "sk-test";
    process.env.HARNESS_MEMORY_SECRET_X = "no";
    try {
      const env = providerEnv();
      expect(env.CLAUDECODE).toBeUndefined();
      expect(env.CLAUDE_CODE_EXECPATH).toBeUndefined();
      expect(env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
      expect(env.CODEX_SANDBOX).toBeUndefined();
      expect(env.HARNESS_MEMORY_SECRET_X).toBeUndefined();
      expect(env.ANTHROPIC_API_KEY).toBe("sk-test");
      expect(env.HARNESS_MEMORY_DISABLE).toBe("1");
      expect(Object.keys(env).some((key) => key.toUpperCase() === "PATH")).toBe(true);
      const child = claudeChildEnv();
      expect(child.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe("1");
      expect(Object.keys(child).filter((key) => key.startsWith("CLAUDE"))).toEqual(["CLAUDE_CODE_DISABLE_AUTO_MEMORY"]);
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
      Object.assign(process.env, saved);
    }
  });
});
