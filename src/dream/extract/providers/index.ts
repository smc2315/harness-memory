/**
 * Provider selection (`config.extraction.provider`, spec §5.4) and the daily probe cache kept in
 * `meta.last_probe_at` / `meta.last_probe_result` (read in lock session 1, written in lock session 2).
 *
 * `auto`: claude when its binary resolves, else codex, else null (`no_provider`). An explicit name
 * yields that provider only when it is usable. `HARNESS_MEMORY_PROVIDER` (allowlisted by providerEnv)
 * overrides the config so `eval:replay` can force the replay provider.
 */

import type { Database as SqlJsDatabase } from "sql.js";

import type { HarnessConfig } from "../../../core/config";
import type { HarnessPaths } from "../../../core/paths";
import { resolveClaudeBinary, resolveCodexBinary } from "../../../core/process";
import { PROBE_RESULTS, PROVIDERS, type ProbeResult, type ProviderName } from "../../../core/vocabulary";
import { META_KEYS, MetaRepository } from "../../../db/repositories/meta";
import { createClaudeProvider, type ClaudeProviderOptions } from "./claude";
import { createCodexProvider, type CodexProviderOptions } from "./codex";
import { createReplayProvider, type ReplayProviderOptions } from "./replay";
import { PROBE_CACHE_MS, type ExtractionProvider, type ProbeContext } from "./types";

export * from "./types";
export { buildClaudeArgs, classifyClaudeRun, claudeChildEnv, createClaudeProvider, parseClaudeEnvelope, probeResultOf, CLAUDE_SETTINGS_JSON } from "./claude";
export type { ClaudeEnvelope, ClaudeProviderOptions } from "./claude";
export { buildCodexArgs, classifyCodexRun, createCodexProvider, extractCodexMessage } from "./codex";
export type { CodexProviderOptions } from "./codex";
export { createReplayProvider } from "./replay";
export type { ReplayAnswer, ReplayProviderOptions } from "./replay";
export { killProcessTree, runCommand } from "./run-command";

export interface SelectProviderOptions {
  claude?: ClaudeProviderOptions;
  codex?: CodexProviderOptions;
  replay?: ReplayProviderOptions;
  /** Resolution seams for tests (default: core/process resolvers). */
  resolveClaude?: () => string | null;
  resolveCodex?: () => string | null;
  /** Environment override (default `process.env.HARNESS_MEMORY_PROVIDER`). */
  envOverride?: string | null;
  paths?: HarnessPaths;
}

function isProviderName(value: string | null | undefined): value is ProviderName {
  return typeof value === "string" && (PROVIDERS as readonly string[]).includes(value);
}

/** Null means `no_provider`: the episode stays queued and `status` explains why. */
export function selectProvider(config: Pick<HarnessConfig, "extraction">, options: SelectProviderOptions = {}): ExtractionProvider | null {
  const envOverride = options.envOverride === undefined ? process.env.HARNESS_MEMORY_PROVIDER ?? null : options.envOverride;
  const requested: "auto" | ProviderName = isProviderName(envOverride) ? envOverride : config.extraction.provider;
  const resolveClaude = options.resolveClaude ?? (() => options.claude?.binary ?? resolveClaudeBinary());
  const resolveCodex = options.resolveCodex ?? (() => options.codex?.binary ?? resolveCodexBinary());

  const claude = (): ExtractionProvider | null => {
    const binary = resolveClaude();
    return binary === null ? null : createClaudeProvider({ ...options.claude, binary });
  };
  const codex = (): ExtractionProvider | null => {
    const binary = resolveCodex();
    return binary === null ? null : createCodexProvider({ ...options.codex, binary });
  };

  switch (requested) {
    case "auto":
      return claude() ?? codex();
    case "claude":
      return claude();
    case "codex":
      return codex();
    case "replay":
      return createReplayProvider({ paths: options.paths, ...options.replay });
    case "opencode":
      // Out of scope for v1 (plan §1); the seam stays.
      return null;
  }
}

export interface ProbeCache {
  at: string;
  result: ProbeResult;
}

/** The cached probe when it is younger than 24 h, else null. */
export function readProbeCache(db: SqlJsDatabase, now: string, maxAgeMs: number = PROBE_CACHE_MS): ProbeCache | null {
  const meta = new MetaRepository(db);
  const at = meta.get(META_KEYS.lastProbeAt);
  const result = meta.get(META_KEYS.lastProbeResult);
  if (at === null || result === null || !(PROBE_RESULTS as readonly string[]).includes(result)) return null;
  const ageMs = Date.parse(now) - Date.parse(at);
  if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > maxAgeMs) return null;
  return { at, result: result as ProbeResult };
}

/** Any stored probe, regardless of age (status / doctor / snapshot display). */
export function readLastProbe(db: SqlJsDatabase): ProbeCache | null {
  const meta = new MetaRepository(db);
  const at = meta.get(META_KEYS.lastProbeAt);
  const result = meta.get(META_KEYS.lastProbeResult);
  if (at === null || result === null || !(PROBE_RESULTS as readonly string[]).includes(result)) return null;
  return { at, result: result as ProbeResult };
}

export function writeProbeCache(db: SqlJsDatabase, cache: ProbeCache): void {
  const meta = new MetaRepository(db);
  meta.set(META_KEYS.lastProbeAt, cache.at);
  meta.set(META_KEYS.lastProbeResult, cache.result);
}

/**
 * Runs the provider probe unless a fresh cached result exists. The replay provider is never probed
 * or cached (its "ok" would mask a real provider's failure in `status`).
 */
export async function probeWithCache(
  provider: ExtractionProvider,
  cached: ProbeCache | null,
  ctx: ProbeContext
): Promise<{ result: ProbeResult; fromCache: boolean; cacheable: boolean }> {
  if (provider.name === "replay") return { result: "ok", fromCache: false, cacheable: false };
  if (cached !== null) return { result: cached.result, fromCache: true, cacheable: false };
  const result = await provider.probe(ctx);
  return { result, fromCache: false, cacheable: true };
}
