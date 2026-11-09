/**
 * Fixture builder for the hook tests (B2): a temporary `.harness-memory/` holding a config, a stub
 * `memory.sqlite` (header only — hooks never open it), `snapshot/active.v1.json`, `lexical.v1.json`
 * (built with the same MiniSearch options the reader uses) and optionally `dense.v1.bin`; plus
 * synthetic Claude Code stdin objects and a recording hook runtime.
 */

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import MiniSearch from "minisearch";

import type { DenseClient } from "../../src/activation/before-model";
import {
  LEXICAL_TOKENIZER_ID,
  lexicalDefaultOptions,
  lexicalSnapshotOptions,
  toLexicalDocument,
  type LexicalSnapshotDocument,
} from "../../src/activation/lexical-snapshot";
import { compileGlobSource, compileSignature } from "../../src/activation/signature";
import { createRuntime, type HookRuntime, type WorkerCommand } from "../../src/adapters/hook-core";
import { readSessionState } from "../../src/adapters/session-state";
import { DEFAULT_CONFIG, mergeConfig, type HarnessConfig } from "../../src/core/config";
import type { ClaudeCodeHookStdin } from "../../src/core/hook-types";
import type { LedgerLine, SessionState } from "../../src/core/ledger-types";
import { ledgerFile, resolvePaths, sessionKey, stateDirectories, stateFile, TARGET_USER_VERSION, type HarnessPaths } from "../../src/core/paths";
import {
  ACTIVE_SNAPSHOT_SCHEMA,
  DENSE_SNAPSHOT_SCHEMA,
  LEXICAL_SNAPSHOT_SCHEMA,
  type ActiveSnapshot,
  type DenseSnapshotHeader,
  type LexicalSnapshot,
  type RecentSummary,
  type SnapshotCounts,
  type SnapshotMemory,
  type SnapshotRule,
} from "../../src/core/snapshot-types";
import { isGlobalScope, type TriggerSignature } from "../../src/core/vocabulary";
import { readLedgerTailLines } from "../../src/dream/ledger";
import { encodeDenseSnapshot } from "../../src/embed/dense-file";

export const FIXTURE_NOW = "2026-11-08T12:00:00.000Z";
export const FIXTURE_SESSION_ID = "sess-0001";
export const FIXTURE_HOST = "claude-code" as const;

const DAY_MS = 24 * 60 * 60 * 1000;

export function isoBefore(now: string, days: number): string {
  return new Date(Date.parse(now) - days * DAY_MS).toISOString();
}

let memoryCounter = 0;

export type FixtureMemoryInput = Partial<Omit<SnapshotMemory, "signature">> & { signature?: TriggerSignature | null };

/** A snapshot row with every field filled; `signature` is compiled through A3's `compileSignature` (throws when invalid). */
export function fixtureMemory(overrides: FixtureMemoryInput = {}): SnapshotMemory {
  memoryCounter += 1;
  const id = overrides.id ?? `mem-${String(memoryCounter).padStart(4, "0")}`;
  const scopeGlob = overrides.scope_glob ?? "**/*";
  const scopeRegex = overrides.scope_regex !== undefined ? overrides.scope_regex : isGlobalScope(scopeGlob) ? null : compileGlobSource(scopeGlob);
  let signature: SnapshotMemory["signature"] = null;
  if (overrides.signature !== undefined && overrides.signature !== null) {
    const compiled = compileSignature(overrides.signature);
    if (!compiled.ok) throw new Error(`fixture signature rejected (${compiled.code}): ${compiled.detail}`);
    signature = compiled.compiled;
  }
  const { signature: _ignored, ...rest } = overrides;
  return {
    id,
    type: "pitfall",
    summary: `Fixture memory ${String(memoryCounter)}`,
    details: `Details for fixture memory ${String(memoryCounter)}.`,
    scope_glob: scopeGlob,
    scope_regex: scopeRegex,
    activation_class: "scoped",
    lifecycle_triggers: ["before_tool"],
    relevant_tools: null,
    signature,
    authority: "auto",
    enforcement: "advise",
    status: "active",
    knowledge_kind: "correction",
    policy_subtype: null,
    confidence: 0.8,
    importance: 0.6,
    evidence_score: 2,
    evidence_count: 1,
    validation_count: 0,
    fire_count: 0,
    override_count: 0,
    ttl_expires_at: null,
    source_file: null,
    aliases: [],
    contested: 0,
    import_unconfirmed: 0,
    failure_classes: [],
    created_at: isoBefore(FIXTURE_NOW, 1),
    updated_at: isoBefore(FIXTURE_NOW, 1),
    last_verified_at: null,
    ...rest,
  };
}

let ruleCounter = 0;

export function fixtureRule(overrides: Partial<SnapshotRule> = {}): SnapshotRule {
  ruleCounter += 1;
  const scopeGlob = overrides.scope_glob ?? "**/*";
  return {
    id: `rule-${String(ruleCounter).padStart(3, "0")}`,
    rule_code: `RULE_${String(ruleCounter)}`,
    memory_id: null,
    severity: "warning",
    trigger_kind: "before_tool",
    scope_glob: scopeGlob,
    scope_regex: overrides.scope_regex !== undefined ? overrides.scope_regex : isGlobalScope(scopeGlob) ? null : compileGlobSource(scopeGlob),
    tool_pattern: "*",
    target_kind: "any",
    pattern_kind: null,
    arg_pattern: null,
    enforcement: "advise",
    message: `Fixture rule ${String(ruleCounter)}`,
    ...overrides,
  };
}

export function defaultCounts(overrides: Partial<SnapshotCounts> = {}): SnapshotCounts {
  return { active: 0, candidates: 0, open_proposals: 0, auto_active: 0, expiring_7d: 0, unreachable: 0, queue: 0, ...overrides };
}

export interface BuildSnapshotOptions {
  memories?: readonly SnapshotMemory[];
  rules?: readonly SnapshotRule[];
  failureIndex?: Record<string, string[]>;
  counts?: Partial<SnapshotCounts>;
  now?: string;
  source?: { mtime_ms: number; size: number };
  dbGeneration?: number;
  userVersion?: number;
  lastDreamAt?: string | null;
}

export function buildActiveSnapshot(options: BuildSnapshotOptions = {}): ActiveSnapshot {
  const memories = [...(options.memories ?? [])];
  return {
    schema: ACTIVE_SNAPSHOT_SCHEMA,
    built_at: options.now ?? FIXTURE_NOW,
    db_generation: options.dbGeneration ?? 7,
    user_version: options.userVersion ?? TARGET_USER_VERSION,
    last_dream_at: options.lastDreamAt ?? null,
    last_probe: null,
    source: options.source ?? { mtime_ms: 0, size: 0 },
    memories,
    rules: [...(options.rules ?? [])],
    failure_index: options.failureIndex ?? {},
    counts: defaultCounts({
      active: memories.filter((memory) => memory.status === "active").length,
      auto_active: memories.filter((memory) => memory.status === "active" && memory.authority === "auto").length,
      ...options.counts,
    }),
  };
}

export function buildLexicalSnapshot(
  memories: readonly SnapshotMemory[],
  recentSummaries: readonly RecentSummary[] = [],
  options: { now?: string; dbGeneration?: number; defaultTokenizer?: boolean } = {}
): LexicalSnapshot {
  const index = new MiniSearch<LexicalSnapshotDocument>(options.defaultTokenizer === true ? lexicalDefaultOptions() : lexicalSnapshotOptions());
  index.addAll(memories.map(toLexicalDocument));
  return {
    schema: LEXICAL_SNAPSHOT_SCHEMA,
    built_at: options.now ?? FIXTURE_NOW,
    db_generation: options.dbGeneration ?? 7,
    fields: ["summary", "details", "aliases"],
    ...(options.defaultTokenizer === true ? {} : { tokenizer: LEXICAL_TOKENIZER_ID }),
    index: index.toJSON(),
    recent_summaries: [...recentSummaries],
  };
}

export interface DenseFixture {
  model?: string;
  dims: number;
  /** id → vector (ids must be snapshot memory ids). */
  vectors: Record<string, ArrayLike<number>>;
}

export function buildDenseSnapshot(dense: DenseFixture, options: { now?: string; dbGeneration?: number } = {}): Buffer {
  const ids = Object.keys(dense.vectors);
  const header: DenseSnapshotHeader = {
    schema: DENSE_SNAPSHOT_SCHEMA,
    built_at: options.now ?? FIXTURE_NOW,
    db_generation: options.dbGeneration ?? 7,
    model: dense.model ?? DEFAULT_CONFIG.embeddings.model,
    dims: dense.dims,
    dtype: "float32",
    ids,
  };
  return encodeDenseSnapshot(header, ids.map((id) => dense.vectors[id]!));
}

export interface HarnessFixtureOptions extends BuildSnapshotOptions {
  recentSummaries?: readonly RecentSummary[];
  /** Partial config.json overrides (merged over the defaults). */
  config?: unknown;
  dense?: DenseFixture;
  /** Write `lexical.v1.json` (default true). */
  withLexical?: boolean;
  /** Write `active.v1.json` (default true; false simulates a missing snapshot). */
  withActive?: boolean;
  /** Write the stub `memory.sqlite` (default true). */
  withDb?: boolean;
}

export interface HarnessFixture {
  root: string;
  paths: HarnessPaths;
  config: HarnessConfig;
  snapshot: ActiveSnapshot;
  memories: SnapshotMemory[];
  /** Rewrites the snapshot files (e.g. after changing memories); keeps `source` in sync with the stub DB. */
  rewriteSnapshot(options?: BuildSnapshotOptions & { recentSummaries?: readonly RecentSummary[] }): void;
  /** Appends bytes to the stub DB so the snapshot becomes stale. */
  touchDb(): void;
  ledgerPath(sessionId?: string): string;
  readLedger(sessionId?: string): LedgerLine[];
  readState(sessionId?: string): SessionState | null;
  queueFiles(): string[];
  readQueue(): unknown[];
  cleanup(): void;
}

const SQLITE_HEADER = Buffer.from("SQLite format 3\0", "latin1");

function writeStubDb(path: string): void {
  const stub = Buffer.alloc(4096);
  SQLITE_HEADER.copy(stub, 0);
  writeFileSync(path, stub);
}

export function createHarnessFixture(options: HarnessFixtureOptions = {}): HarnessFixture {
  const root = mkdtempSync(join(tmpdir(), "hm-hook-"));
  const paths = resolvePaths(root);
  for (const dir of stateDirectories(paths)) mkdirSync(dir, { recursive: true });
  const config = mergeConfig(DEFAULT_CONFIG, options.config);
  writeFileSync(paths.config, JSON.stringify(config, null, 2), "utf8");
  if (options.withDb !== false) writeStubDb(paths.db);

  const memories = [...(options.memories ?? [])];
  let snapshot = buildActiveSnapshot({ ...options, memories });

  const write = (writeOptions: BuildSnapshotOptions & { recentSummaries?: readonly RecentSummary[] }): void => {
    const rows = writeOptions.memories !== undefined ? [...writeOptions.memories] : memories;
    let source = writeOptions.source;
    if (source === undefined && options.withDb !== false) {
      const stat = statSync(paths.db);
      source = { mtime_ms: stat.mtimeMs, size: stat.size };
    }
    snapshot = buildActiveSnapshot({ ...options, ...writeOptions, memories: rows, source });
    if (options.withActive !== false) writeFileSync(paths.snapshotActive, JSON.stringify(snapshot), "utf8");
    if (options.withLexical !== false) {
      writeFileSync(paths.snapshotLexical, JSON.stringify(buildLexicalSnapshot(rows, writeOptions.recentSummaries ?? options.recentSummaries ?? [], writeOptions)), "utf8");
    }
    if (options.dense !== undefined) writeFileSync(paths.snapshotDense, buildDenseSnapshot(options.dense, writeOptions));
  };
  write({});

  const ledgerPath = (sessionId = FIXTURE_SESSION_ID): string => ledgerFile(paths, FIXTURE_HOST, sessionKey(FIXTURE_HOST, sessionId));

  return {
    root,
    paths,
    config,
    get snapshot() {
      return snapshot;
    },
    memories,
    rewriteSnapshot: (writeOptions = {}) => write(writeOptions),
    touchDb: () => {
      const current = readFileSync(paths.db);
      writeFileSync(paths.db, Buffer.concat([current, Buffer.alloc(512)]));
    },
    ledgerPath,
    readLedger: (sessionId = FIXTURE_SESSION_ID) => readLedgerTailLines(ledgerPath(sessionId), 8 * 1024 * 1024).lines,
    readState: (sessionId = FIXTURE_SESSION_ID) => readSessionState(stateFile(paths, FIXTURE_HOST, sessionKey(FIXTURE_HOST, sessionId))),
    queueFiles: () => {
      try {
        return readdirSync(paths.queueDir)
          .filter((name) => name.endsWith(".json"))
          .sort()
          .map((name) => join(paths.queueDir, name));
      } catch {
        return [];
      }
    },
    readQueue: () => {
      const files = readdirSync(paths.queueDir)
        .filter((name) => name.endsWith(".json"))
        .sort();
      return files.map((name) => JSON.parse(readFileSync(join(paths.queueDir, name), "utf8")) as unknown);
    },
    cleanup: () => {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

export type ClaudeEventName =
  | "SessionStart"
  | "UserPromptSubmit"
  | "PreToolUse"
  | "PostToolUse"
  | "PostToolUseFailure"
  | "Stop"
  | "StopFailure"
  | "PreCompact"
  | "SessionEnd";

/** Synthetic Claude Code stdin (fields per host-hook-facts.md). */
export function claudeStdin(fixture: Pick<HarnessFixture, "root">, event: ClaudeEventName, overrides: Partial<ClaudeCodeHookStdin> = {}): ClaudeCodeHookStdin {
  return {
    session_id: FIXTURE_SESSION_ID,
    transcript_path: join(fixture.root, "transcript.jsonl"),
    cwd: fixture.root,
    hook_event_name: event,
    permission_mode: "default",
    ...overrides,
  };
}

export function bashStdin(fixture: Pick<HarnessFixture, "root">, command: string, overrides: Partial<ClaudeCodeHookStdin> = {}): ClaudeCodeHookStdin {
  return claudeStdin(fixture, "PreToolUse", { tool_name: "Bash", tool_input: { command, description: "test" }, tool_use_id: `toolu_${String(Date.now())}_${String(Math.random()).slice(2, 8)}`, ...overrides });
}

export function writeStdin(fixture: Pick<HarnessFixture, "root">, filePath: string, content = "", overrides: Partial<ClaudeCodeHookStdin> = {}): ClaudeCodeHookStdin {
  return claudeStdin(fixture, "PreToolUse", { tool_name: "Write", tool_input: { file_path: join(fixture.root, filePath), content }, tool_use_id: `toolu_w_${String(Math.random()).slice(2, 8)}`, ...overrides });
}

export interface RecordingRuntime {
  runtime: HookRuntime;
  spawns: WorkerCommand[];
  denseCalls: string[];
}

/** Runtime with a fixed clock, a recording worker spawn and an optional dense stub. */
export function recordingRuntime(fixture: Pick<HarnessFixture, "paths" | "config">, options: { now?: string; dense?: DenseClient | null; config?: HarnessConfig } = {}): RecordingRuntime {
  const spawns: WorkerCommand[] = [];
  const denseCalls: string[] = [];
  const dense: DenseClient | null =
    options.dense === undefined
      ? null
      : options.dense === null
        ? null
        : {
            topk: async (text: string, k: number) => {
              denseCalls.push(text);
              return options.dense!.topk(text, k);
            },
          };
  const runtime = createRuntime(fixture.paths, options.config ?? fixture.config, {
    clock: () => options.now ?? FIXTURE_NOW,
    spawnWorker: (command) => {
      spawns.push(command);
      return 4242;
    },
    dense,
  });
  return { runtime, spawns, denseCalls };
}

/** A realistic 300-memory snapshot for the latency smoke: mixed scopes, signatures and triggers. */
export function generateMemories(count: number): SnapshotMemory[] {
  const scopes = ["**/*", "src/**", "src/db/**", "src/activation/**/*.ts", "docs/**/*.md", "test/**", "scripts/**", "src/dream/**"];
  const commands = ["pm test", "pm build", "git push --force", "bin vitest run", "npm publish", "rm -rf dist", "pm lint", "git rebase"];
  const rows: SnapshotMemory[] = [];
  for (let index = 0; index < count; index += 1) {
    const scope = scopes[index % scopes.length]!;
    const kind = index % 6;
    let signature: TriggerSignature | null = null;
    let type: SnapshotMemory["type"] = "pitfall";
    let triggers: SnapshotMemory["lifecycle_triggers"] = ["before_tool"];
    if (kind === 0) {
      signature = { tool: "bash", target: "command", pattern_kind: "cmd", pattern: commands[index % commands.length]! };
    } else if (kind === 1) {
      signature = { tool: "write|edit", target: "path", pattern_kind: "glob", pattern: `**/*.${["env", "lock", "sqlite", "pem"][index % 4]!}` };
      type = "policy";
    } else if (kind === 2) {
      type = "workflow";
      triggers = ["before_model", "session_start"];
    } else if (kind === 3) {
      type = "decision";
      triggers = ["session_start", "before_model"];
    } else if (kind === 4) {
      signature = { tool: "bash", target: "command", pattern_kind: "regex", pattern: `git (push|pull) .*origin\\/${String(index)}` };
    } else {
      triggers = ["before_tool", "before_model"];
    }
    rows.push(
      fixtureMemory({
        id: `gen-${String(index).padStart(4, "0")}`,
        type,
        summary: `Generated memory ${String(index)} about ${scope} and ${commands[index % commands.length]!}`,
        details: `Rationale ${String(index)}: keep the ${scope} area consistent; learned from session ${String(index % 17)}.`,
        scope_glob: scope,
        lifecycle_triggers: triggers,
        signature,
        authority: index % 3 === 0 ? "human" : "auto",
        enforcement: kind === 0 ? "soft_deny" : kind === 1 ? "confirm" : "advise",
        aliases: index % 5 === 0 ? ["테스트", `alias${String(index)}`] : [],
      })
    );
  }
  return rows;
}
