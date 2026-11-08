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
  error?: string;
}

export interface ExtractionProvider {
  name: ProviderName;
  /** A real one-field schema call (20 s); cached daily by the worker through `meta.last_probe_*`. */
  probe(ctx: ProbeContext): Promise<ProbeResult>;
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

/** Cache lifetime of a probe result in `meta.last_probe_at` (spec §5.4: daily). */
export const PROBE_CACHE_MS = 24 * 60 * 60 * 1000;
