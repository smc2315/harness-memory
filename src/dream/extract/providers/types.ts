/**
 * Extraction provider contract (spec §5.4). A provider turns the rendered episode prompt into the
 * raw model output; it never touches the database. The worker runs it between the two lock
 * sessions of §9.3 and classifies the result into `extraction_runs.status`.
 */

import type { HarnessConfig } from "../../../core/config";
import type { HarnessPaths } from "../../../core/paths";
import type { ProbeResult, ProviderName, RunStatus } from "../../../core/vocabulary";

export interface ProviderLogger {
  log(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface ProbeContext {
  config: HarnessConfig;
  paths: HarnessPaths;
  now: string;
  logger?: ProviderLogger;
}

export interface ExtractOptions {
  /** Wall-clock cap for one call; the child tree is killed afterwards (`timeout`). */
  timeoutMs: number;
  model: string | null;
  /** Deterministic run id (`replay` reads `raw/<run_id>.json`). */
  runId?: string;
  /** Episode the prompt renders (`replay` may answer from an injected map). */
  episodeId?: string;
  paths?: HarnessPaths;
  logger?: ProviderLogger;
}

/**
 * `status: 'ok'` carries the model output in `raw` (and `structured` when the provider already
 * parsed it); every other status is a RunStatus explaining why there is nothing to validate.
 */
export interface ProviderResult {
  status: "ok" | Exclude<RunStatus, "started" | "ok">;
  raw: string;
  structured?: unknown;
  model?: string;
  /** `total_cost_usd` of the envelope (claude), when the CLI reports it. */
  costUsd?: number;
  error?: string;
}

/** What `probe()` reports: the classification plus the provider's own message for a failure (null when ok). */
export interface ProbeOutcome {
  result: ProbeResult;
  detail: string | null;
}

/** Providers may return the bare result (replay, fakes) or an outcome with the message. */
export function normalizeProbe(value: ProbeResult | ProbeOutcome): ProbeOutcome {
  return typeof value === "string" ? { result: value, detail: null } : value;
}

export interface ExtractionProvider {
  name: ProviderName;
  /**
   * A real one-field schema call (20 s); cached by the worker through `meta.last_probe_*` (a day when `ok`, ten
   * minutes otherwise). The CLI providers return a ProbeOutcome so the provider's message (a 404 on the model, …)
   * reaches `hm install` / `hm status` / `hm doctor`.
   */
  probe(ctx: ProbeContext): Promise<ProbeResult | ProbeOutcome>;
  extract(prompt: string, schemaJson: string, options: ExtractOptions): Promise<ProviderResult>;
}

/** Minimal child-process result the CLI providers consume; tests inject a fake runner. */
export interface CommandRunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  /** Spawn-level failure (ENOENT, EACCES …) before the child produced anything. */
  spawnError: string | null;
}

export interface CommandRunInput {
  binary: string;
  args: readonly string[];
  cwd: string;
  env: Record<string, string>;
  stdin: string;
  timeoutMs: number;
}

export type CommandRunner = (input: CommandRunInput) => Promise<CommandRunResult>;

/** Schema used by `probe()`: one boolean field, so a successful call proves `--json-schema` works. */
export const PROBE_SCHEMA = {
  type: "object",
  required: ["ok"],
  additionalProperties: false,
  properties: { ok: { type: "boolean" } },
} as const;

export const PROBE_SCHEMA_JSON = JSON.stringify(PROBE_SCHEMA);

export const PROBE_PROMPT = 'Reply with the JSON object {"ok": true} and nothing else.';

/** Cache lifetime of a successful (`ok`) probe in `meta.last_probe_at` (spec §5.4: daily). */
export const PROBE_CACHE_MS = 24 * 60 * 60 * 1000;
/**
 * Cache lifetime of a failed probe (`not_logged_in`, `missing`, `nested_refusal`, `probe_timeout`, `invalid_output`):
 * the worker retries after ten minutes, so a login or an install is picked up at the next run instead of a day later;
 * `PROVIDER_UNAVAILABLE_RETRY_MS` (reconcile) requeues the waiting episodes for the same moment.
 */
export const PROBE_FAILURE_CACHE_MS = 10 * 60 * 1000;
