/**
 * `.harness-memory/config.json` schema, defaults and a tolerant loader (spec §6.1, §6.5, §7.3, §7.6, §5.3).
 * Unknown keys are ignored; invalid enum values fall back to the default so a bad config never breaks a hook.
 */

import { readFileSync } from "node:fs";

import {
  AUTONOMY_LEVELS,
  PROVIDERS,
  type AutonomyLevel,
  type ProviderName,
} from "./vocabulary";

export interface TriggerBudget {
  max_items: number;
  max_bytes: number;
}

export interface HarnessConfig {
  schema: "config.v1";
  autonomy_level: AutonomyLevel;
  before_tool: TriggerBudget & {
    /** Default enforcement for correction/failure-derived auto pitfalls with a specific signature. */
    auto_enforcement: "soft_deny" | "advise";
    /** Enforcement for approved hard policies with a signature. */
    hard_policy: "confirm" | "advise" | "deny";
  };
  before_model: TriggerBudget & {
    /** BM25 threshold for non-baseline rows (scope intersection is also required). */
    min_score: number;
    /** `helper` = idle-exit embedding helper over a named pipe; `off` = lexical only. */
    dense: "helper" | "off";
  };
  session_start: TriggerBudget;
  after_tool: TriggerBudget;
  extraction: {
    provider: "auto" | ProviderName;
    model: string | null;
    max_runs_per_day: number;
    max_auto_activations_per_day: number;
    max_auto_activations_per_episode: number;
    timeout_ms: number;
    probe_timeout_ms: number;
    /** Lease duration for a queued episode taken by a worker. */
    lease_seconds: number;
  };
  embeddings: {
    enabled: boolean;
    model: string;
    idle_exit_minutes: number;
    /** Null = ~/.harness-memory/models */
    cache_dir: string | null;
  };
  dream: {
    interval_hours: number;
  };
  retention: {
    ledger_days: number;
    raw_hours: number;
    audit_days: number;
    candidate_days: number;
    proposal_days: number;
  };
  log: {
    debug: boolean;
    max_bytes: number;
    rotations: number;
  };
}

export const DEFAULT_CONFIG: HarnessConfig = {
  schema: "config.v1",
  autonomy_level: "standard",
  before_tool: { max_items: 3, max_bytes: 2_048, auto_enforcement: "soft_deny", hard_policy: "confirm" },
  before_model: { max_items: 5, max_bytes: 3_072, min_score: 0.35, dense: "helper" },
  session_start: { max_items: 5, max_bytes: 3_072 },
  after_tool: { max_items: 2, max_bytes: 1_024 },
  extraction: {
    provider: "auto",
    model: null,
    max_runs_per_day: 40,
    max_auto_activations_per_day: 10,
    max_auto_activations_per_episode: 3,
    timeout_ms: 120_000,
    probe_timeout_ms: 20_000,
    lease_seconds: 180,
  },
  embeddings: {
    enabled: false,
    model: "Xenova/multilingual-e5-small",
    idle_exit_minutes: 15,
    cache_dir: null,
  },
  dream: { interval_hours: 6 },
  retention: { ledger_days: 14, raw_hours: 24, audit_days: 30, candidate_days: 45, proposal_days: 30 },
  log: { debug: false, max_bytes: 5 * 1024 * 1024, rotations: 3 },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pickNumber(value: unknown, fallback: number, min = 0): number {
  return typeof value === "number" && Number.isFinite(value) && value >= min ? value : fallback;
}

function pickBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function pickEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

function pickBudget(value: unknown, fallback: TriggerBudget): TriggerBudget {
  if (!isRecord(value)) return { ...fallback };
  return {
    max_items: pickNumber(value.max_items, fallback.max_items),
    max_bytes: pickNumber(value.max_bytes, fallback.max_bytes),
  };
}

export function mergeConfig(base: HarnessConfig, override: unknown): HarnessConfig {
  if (!isRecord(override)) return structuredClone(base);
  const beforeTool = isRecord(override.before_tool) ? override.before_tool : {};
  const beforeModel = isRecord(override.before_model) ? override.before_model : {};
  const extraction = isRecord(override.extraction) ? override.extraction : {};
  const embeddings = isRecord(override.embeddings) ? override.embeddings : {};
  const dream = isRecord(override.dream) ? override.dream : {};
  const retention = isRecord(override.retention) ? override.retention : {};
  const log = isRecord(override.log) ? override.log : {};

  return {
    schema: "config.v1",
    autonomy_level: pickEnum(override.autonomy_level, AUTONOMY_LEVELS, base.autonomy_level),
    before_tool: {
      ...pickBudget(override.before_tool, base.before_tool),
      auto_enforcement: pickEnum(beforeTool.auto_enforcement, ["soft_deny", "advise"] as const, base.before_tool.auto_enforcement),
      hard_policy: pickEnum(beforeTool.hard_policy, ["confirm", "advise", "deny"] as const, base.before_tool.hard_policy),
    },
    before_model: {
      ...pickBudget(override.before_model, base.before_model),
      min_score: pickNumber(beforeModel.min_score, base.before_model.min_score),
      dense: pickEnum(beforeModel.dense, ["helper", "off"] as const, base.before_model.dense),
    },
    session_start: pickBudget(override.session_start, base.session_start),
    after_tool: pickBudget(override.after_tool, base.after_tool),
    extraction: {
      provider: pickEnum(extraction.provider, ["auto", ...PROVIDERS] as const, base.extraction.provider),
      model: typeof extraction.model === "string" && extraction.model.length > 0 ? extraction.model : base.extraction.model,
      max_runs_per_day: pickNumber(extraction.max_runs_per_day, base.extraction.max_runs_per_day),
      max_auto_activations_per_day: pickNumber(extraction.max_auto_activations_per_day, base.extraction.max_auto_activations_per_day),
      max_auto_activations_per_episode: pickNumber(extraction.max_auto_activations_per_episode, base.extraction.max_auto_activations_per_episode),
      timeout_ms: pickNumber(extraction.timeout_ms, base.extraction.timeout_ms, 1_000),
      probe_timeout_ms: pickNumber(extraction.probe_timeout_ms, base.extraction.probe_timeout_ms, 1_000),
      lease_seconds: pickNumber(extraction.lease_seconds, base.extraction.lease_seconds, 10),
    },
    embeddings: {
      enabled: pickBoolean(embeddings.enabled, base.embeddings.enabled),
      model: typeof embeddings.model === "string" && embeddings.model.length > 0 ? embeddings.model : base.embeddings.model,
      idle_exit_minutes: pickNumber(embeddings.idle_exit_minutes, base.embeddings.idle_exit_minutes, 1),
      cache_dir: typeof embeddings.cache_dir === "string" && embeddings.cache_dir.length > 0 ? embeddings.cache_dir : base.embeddings.cache_dir,
    },
    dream: { interval_hours: pickNumber(dream.interval_hours, base.dream.interval_hours) },
    retention: {
      ledger_days: pickNumber(retention.ledger_days, base.retention.ledger_days, 1),
      raw_hours: pickNumber(retention.raw_hours, base.retention.raw_hours, 1),
      audit_days: pickNumber(retention.audit_days, base.retention.audit_days, 1),
      candidate_days: pickNumber(retention.candidate_days, base.retention.candidate_days, 1),
      proposal_days: pickNumber(retention.proposal_days, base.retention.proposal_days, 1),
    },
    log: {
      debug: pickBoolean(log.debug, base.log.debug),
      max_bytes: pickNumber(log.max_bytes, base.log.max_bytes, 1024),
      rotations: pickNumber(log.rotations, base.log.rotations, 1),
    },
  };
}

/** Synchronous and tolerant: a missing or malformed file yields the defaults. */
export function loadConfig(configPath: string): HarnessConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, "utf8"));
  } catch {
    return structuredClone(DEFAULT_CONFIG);
  }
  return mergeConfig(DEFAULT_CONFIG, parsed);
}
