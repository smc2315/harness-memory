/**
 * `claude -p` extraction provider (spec §5.4, m0-facts #2–#7, #16).
 *
 *   claude -p --output-format json --json-schema <schema> --tools "" --disallowedTools "mcp__*"
 *          --strict-mcp-config --no-session-persistence
 *          --settings '{"disableAllHooks":true,"autoMemoryEnabled":false}' [--model <cfg>]
 *
 * No `--max-turns` (it does not exist in 2.1.x; without tools there is one turn anyway). The prompt
 * goes in on stdin, the cwd is the empty per-repository worker directory outside any git checkout,
 * and the environment is the `providerEnv()` allowlist (CLAUDE* stripped) plus
 * CLAUDE_CODE_DISABLE_AUTO_MEMORY=1. The result envelope is `{type:"result", is_error, result,
 * structured_output, modelUsage, …}`: a missing `structured_output` is `invalid_output` unless the
 * error text classifies as `not_logged_in` or `nested_refusal`.
 */

import { mkdirSync } from "node:fs";

import { providerEnv, resolveClaudeBinary } from "../../../core/process";
import { workerCwd, type HarnessPaths } from "../../../core/paths";
import type { ProbeResult } from "../../../core/vocabulary";
import { runCommand } from "./run-command";
import {
  PROBE_PROMPT,
  PROBE_SCHEMA_JSON,
  type CommandRunResult,
  type CommandRunner,
  type ExtractOptions,
  type ExtractionProvider,
  type ProbeContext,
  type ProviderResult,
} from "./types";

export const CLAUDE_SETTINGS_JSON = JSON.stringify({ disableAllHooks: true, autoMemoryEnabled: false });

const NOT_LOGGED_IN = /not logged in|please run \/login|authentication[_ ]?(?:required|failed)|invalid api key/i;
const NESTED_REFUSAL =
  /nested|inside (?:a|another|an existing) claude|within (?:a|another) claude(?: code)? (?:session|process)|CLAUDECODE|already running (?:in|inside)|cannot (?:be )?(?:run|launch|start)(?:ed)? (?:from )?(?:inside|within)/i;

export interface ClaudeProviderOptions {
  /** Absolute path of the binary; defaults to `resolveClaudeBinary()` at call time. */
  binary?: string | null;
  /** Child-process runner (tests inject a fake). */
  runner?: CommandRunner;
  /** Working directory for the child; defaults to `workerCwd(paths.root)` (created on demand). */
  cwd?: string;
  env?: Record<string, string>;
}

export interface ClaudeEnvelope {
  type?: unknown;
  subtype?: unknown;
  is_error?: unknown;
  result?: unknown;
  structured_output?: unknown;
  modelUsage?: unknown;
  [key: string]: unknown;
}

export function buildClaudeArgs(schemaJson: string, model: string | null): string[] {
  const args = [
    "-p",
    "--output-format",
    "json",
    "--json-schema",
    schemaJson,
    "--tools",
    "",
    "--disallowedTools",
    "mcp__*",
    "--strict-mcp-config",
    "--no-session-persistence",
    "--settings",
    CLAUDE_SETTINGS_JSON,
  ];
  if (model !== null && model.length > 0) args.push("--model", model);
  return args;
}

export function claudeChildEnv(extra: Record<string, string> = {}): Record<string, string> {
  return providerEnv({ CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1", ...extra });
}

/** Finds the result envelope in stdout (a single JSON object, possibly surrounded by log noise). */
export function parseClaudeEnvelope(stdout: string): ClaudeEnvelope | null {
  const text = stdout.trim();
  if (text.length === 0) return null;
  const candidates = [text];
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first > 0 || (last >= 0 && last < text.length - 1)) {
    if (first >= 0 && last > first) candidates.push(text.slice(first, last + 1));
  }
  // --output-format stream-json style output: one JSON object per line, the last `result` wins.
  const lines = text.split(/\r?\n/).filter((line) => line.trim().startsWith("{"));
  for (let i = lines.length - 1; i >= 0; i -= 1) candidates.push(lines[i]!.trim());
  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        const envelope = parsed as ClaudeEnvelope;
        if (envelope.type === "result" || "structured_output" in envelope || "is_error" in envelope || "result" in envelope) {
          return envelope;
        }
      }
    } catch {
      // try the next candidate
    }
  }
  return null;
}

function modelOf(envelope: ClaudeEnvelope): string | undefined {
  const usage = envelope.modelUsage;
  if (typeof usage === "object" && usage !== null && !Array.isArray(usage)) {
    const keys = Object.keys(usage);
    if (keys.length > 0) return keys[0];
  }
  return undefined;
}

/** Maps one finished child run onto a ProviderResult (m0-facts #3, #7). */
export function classifyClaudeRun(run: CommandRunResult): ProviderResult {
  if (run.timedOut) {
    return { status: "timeout", raw: run.stdout, error: "claude -p exceeded the wall-clock cap" };
  }
  if (run.spawnError !== null) {
    return { status: "provider_error", raw: "", error: `spawn failed: ${run.spawnError}` };
  }
  const envelope = parseClaudeEnvelope(run.stdout);
  if (envelope === null) {
    const detail = `${run.stderr}\n${run.stdout}`.trim();
    if (NOT_LOGGED_IN.test(detail)) return { status: "not_logged_in", raw: run.stdout, error: oneLine(detail) };
    if (NESTED_REFUSAL.test(detail)) return { status: "nested_refusal", raw: run.stdout, error: oneLine(detail) };
    if (run.exitCode !== 0) {
      return { status: "provider_error", raw: run.stdout, error: oneLine(detail.length > 0 ? detail : `exit code ${String(run.exitCode)}`) };
    }
    return { status: "invalid_output", raw: run.stdout, error: "stdout is not a result envelope" };
  }
  const resultText = typeof envelope.result === "string" ? envelope.result : "";
  if (envelope.is_error === true) {
    const detail = `${resultText}\n${run.stderr}`.trim();
    if (NOT_LOGGED_IN.test(detail)) return { status: "not_logged_in", raw: run.stdout, error: oneLine(detail) };
    if (NESTED_REFUSAL.test(detail)) return { status: "nested_refusal", raw: run.stdout, error: oneLine(detail) };
    return { status: "provider_error", raw: run.stdout, error: oneLine(detail.length > 0 ? detail : "is_error without a message") };
  }
  const structured = envelope.structured_output;
  if (typeof structured === "object" && structured !== null) {
    return { status: "ok", raw: JSON.stringify(structured), structured, model: modelOf(envelope) };
  }
  return { status: "invalid_output", raw: run.stdout, error: "structured_output missing from the result envelope", model: modelOf(envelope) };
}

export function probeResultOf(result: ProviderResult): ProbeResult {
  switch (result.status) {
    case "ok":
      return "ok";
    case "not_logged_in":
      return "not_logged_in";
    case "nested_refusal":
      return "nested_refusal";
    case "timeout":
      return "probe_timeout";
    case "no_provider":
      return "missing";
    default:
      return "invalid_output";
  }
}

function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 500 ? `${flat.slice(0, 499)}…` : flat;
}

function ensureCwd(paths: HarnessPaths | undefined, override: string | undefined): string {
  const cwd = override ?? workerCwd(paths?.root ?? process.cwd());
  try {
    mkdirSync(cwd, { recursive: true });
  } catch {
    // the child will fail with a clear spawn error if the directory is unusable
  }
  return cwd;
}

export function createClaudeProvider(options: ClaudeProviderOptions = {}): ExtractionProvider {
  const runner = options.runner ?? runCommand;

  async function call(prompt: string, schemaJson: string, paths: HarnessPaths | undefined, model: string | null, timeoutMs: number): Promise<ProviderResult> {
    const binary = options.binary === undefined ? resolveClaudeBinary() : options.binary;
    if (binary === null || binary.length === 0) {
      return { status: "no_provider", raw: "", error: "claude binary not found" };
    }
    const run = await runner({
      binary,
      args: buildClaudeArgs(schemaJson, model),
      cwd: ensureCwd(paths, options.cwd),
      env: options.env ?? claudeChildEnv(),
      stdin: prompt,
      timeoutMs,
    });
    return classifyClaudeRun(run);
  }

  return {
    name: "claude",
    async probe(ctx: ProbeContext): Promise<ProbeResult> {
      const result = await call(PROBE_PROMPT, PROBE_SCHEMA_JSON, ctx.paths, ctx.config.extraction.model, ctx.config.extraction.probe_timeout_ms);
      if (result.status === "ok") {
        const structured = result.structured as { ok?: unknown } | null;
        return structured !== null && typeof structured === "object" && "ok" in structured ? "ok" : "invalid_output";
      }
      ctx.logger?.warn(`claude probe: ${result.status}${result.error === undefined ? "" : ` (${result.error})`}`);
      return probeResultOf(result);
    },
    extract(prompt: string, schemaJson: string, extractOptions: ExtractOptions): Promise<ProviderResult> {
      return call(prompt, schemaJson, extractOptions.paths, extractOptions.model, extractOptions.timeoutMs);
    },
  };
}
