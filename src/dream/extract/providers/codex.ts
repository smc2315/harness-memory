/**
 * `codex exec` extraction provider (spec §5.4):
 *
 *   codex exec - --output-schema <file> --ephemeral --sandbox read-only --skip-git-repo-check --json
 *              -c features.hooks=false [--model <cfg>]
 *
 * Same cwd / env discipline as the claude provider. `--json` prints JSONL events; the last agent
 * message text is the model output. Codex is not installed on the reference machine (m0-facts), so
 * the event parsing is tolerant: when no agent message is found the whole stdout is handed to the
 * validator, whose V1 parser copes with fences and prose.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { providerEnv, resolveCodexBinary } from "../../../core/process";
import { workerCwd, type HarnessPaths } from "../../../core/paths";
import type { ProbeResult } from "../../../core/vocabulary";
import { probeResultOf } from "./claude";
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

const AUTH_FAILURE = /not logged in|login required|please (?:run )?codex login|unauthori[sz]ed|invalid api key|authentication/i;

export interface CodexProviderOptions {
  binary?: string | null;
  runner?: CommandRunner;
  cwd?: string;
  env?: Record<string, string>;
}

export function buildCodexArgs(schemaFile: string, model: string | null): string[] {
  const args = [
    "exec",
    "-",
    "--output-schema",
    schemaFile,
    "--ephemeral",
    "--sandbox",
    "read-only",
    "--skip-git-repo-check",
    "--json",
    "-c",
    "features.hooks=false",
  ];
  if (model !== null && model.length > 0) args.push("--model", model);
  return args;
}

interface CodexEvent {
  type?: unknown;
  item?: { type?: unknown; text?: unknown; [key: string]: unknown };
  msg?: { type?: unknown; message?: unknown; text?: unknown; [key: string]: unknown };
  text?: unknown;
  message?: unknown;
  error?: unknown;
  [key: string]: unknown;
}

function textOf(event: CodexEvent): string | null {
  const item = event.item;
  if (item !== undefined && typeof item === "object" && item !== null) {
    if (typeof item.text === "string" && (item.type === undefined || String(item.type).includes("message"))) return item.text;
  }
  const msg = event.msg;
  if (msg !== undefined && typeof msg === "object" && msg !== null) {
    if (typeof msg.message === "string" && String(msg.type ?? "").includes("message")) return msg.message;
    if (typeof msg.text === "string") return msg.text;
  }
  if (typeof event.text === "string") return event.text;
  if (typeof event.message === "string" && event.type !== "error") return event.message;
  return null;
}

/** Last agent message text from `--json` events, or null when stdout holds no recognizable event. */
export function extractCodexMessage(stdout: string): { text: string | null; errors: string[] } {
  const errors: string[] = [];
  let text: string | null = null;
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let event: CodexEvent;
    try {
      event = JSON.parse(trimmed) as CodexEvent;
    } catch {
      continue;
    }
    if (event.type === "error" || (event.msg !== undefined && event.msg !== null && typeof event.msg === "object" && event.msg.type === "error")) {
      const message = typeof event.message === "string" ? event.message : typeof event.msg?.message === "string" ? event.msg.message : trimmed;
      errors.push(message);
      continue;
    }
    const candidate = textOf(event);
    if (candidate !== null && candidate.trim().length > 0) text = candidate;
  }
  return { text, errors };
}

export function classifyCodexRun(run: CommandRunResult): ProviderResult {
  if (run.timedOut) return { status: "timeout", raw: run.stdout, error: "codex exec exceeded the wall-clock cap" };
  if (run.spawnError !== null) return { status: "provider_error", raw: "", error: `spawn failed: ${run.spawnError}` };
  const { text, errors } = extractCodexMessage(run.stdout);
  const detail = [...errors, run.stderr].join("\n").trim();
  if (text === null) {
    if (AUTH_FAILURE.test(detail)) return { status: "not_logged_in", raw: run.stdout, error: oneLine(detail) };
    if (run.exitCode !== 0) {
      return { status: "provider_error", raw: run.stdout, error: oneLine(detail.length > 0 ? detail : `exit code ${String(run.exitCode)}`) };
    }
    // Plain (non --json) output: let the validator's V1 parser decide.
    return run.stdout.trim().length > 0
      ? { status: "ok", raw: run.stdout }
      : { status: "invalid_output", raw: run.stdout, error: "empty output" };
  }
  return { status: "ok", raw: text };
}

function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 500 ? `${flat.slice(0, 499)}…` : flat;
}

export function createCodexProvider(options: CodexProviderOptions = {}): ExtractionProvider {
  const runner = options.runner ?? runCommand;

  async function call(prompt: string, schemaJson: string, paths: HarnessPaths | undefined, model: string | null, timeoutMs: number): Promise<ProviderResult> {
    const binary = options.binary === undefined ? resolveCodexBinary() : options.binary;
    if (binary === null || binary.length === 0) return { status: "no_provider", raw: "", error: "codex binary not found" };
    const cwd = options.cwd ?? workerCwd(paths?.root ?? process.cwd());
    try {
      mkdirSync(cwd, { recursive: true });
    } catch {
      // reported by the spawn error below
    }
    const schemaFile = join(cwd, `schema-${String(process.pid)}-${String(Date.now())}.json`);
    try {
      writeFileSync(schemaFile, schemaJson, "utf8");
    } catch (error) {
      return { status: "provider_error", raw: "", error: `cannot write schema file: ${error instanceof Error ? error.message : String(error)}` };
    }
    try {
      const run = await runner({
        binary,
        args: buildCodexArgs(schemaFile, model),
        cwd,
        env: options.env ?? providerEnv(),
        stdin: prompt,
        timeoutMs,
      });
      return classifyCodexRun(run);
    } finally {
      rmSync(schemaFile, { force: true });
    }
  }

  return {
    name: "codex",
    async probe(ctx: ProbeContext): Promise<ProbeResult> {
      const result = await call(PROBE_PROMPT, PROBE_SCHEMA_JSON, ctx.paths, ctx.config.extraction.model, ctx.config.extraction.probe_timeout_ms);
      if (result.status !== "ok") {
        ctx.logger?.warn(`codex probe: ${result.status}${result.error === undefined ? "" : ` (${result.error})`}`);
        return probeResultOf(result);
      }
      try {
        const parsed: unknown = JSON.parse(result.raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, ""));
        return typeof parsed === "object" && parsed !== null && "ok" in parsed ? "ok" : "invalid_output";
      } catch {
        return "invalid_output";
      }
    },
    extract(prompt: string, schemaJson: string, extractOptions: ExtractOptions): Promise<ProviderResult> {
      return call(prompt, schemaJson, extractOptions.paths, extractOptions.model, extractOptions.timeoutMs);
    },
  };
}
