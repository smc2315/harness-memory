/**
 * Snapshot read path for the hooks (spec §4.8, §6.2 step 3, §9.4 F2). Reads `snapshot/active.v1.json`
 * with `readFileSync` + `JSON.parse`, precompiles the scope / signature regexes it carries, detects a
 * stale snapshot by comparing `statSync(memory.sqlite)` with `snapshot.source`, and requests a reindex
 * through a throttled touch file + detached `worker reindex`. The lexical index is loaded lazily
 * (`await import("minisearch")`) because only `prompt` / `session-start` need it.
 *
 * Never opens SQLite, never imports sql.js / minimatch / transformers.
 */

import { existsSync, readFileSync, statSync, utimesSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { HarnessPaths } from "../core/paths";
import { spawnDetached } from "../core/process";
import {
  ACTIVE_SNAPSHOT_SCHEMA,
  LEXICAL_SNAPSHOT_SCHEMA,
  type ActiveSnapshot,
  type LexicalSnapshot,
  type RecentSummary,
  type SnapshotMemory,
} from "../core/snapshot-types";
import { lexicalOptionsFor } from "./lexical-snapshot";
import { globRegexFlags } from "./signature";

/** `.reindex-requested` younger than this suppresses another spawn (parallel hooks, §6.2 step 3). */
export const REINDEX_THROTTLE_MS = 60_000;
/** Tolerance for mtime comparison (file systems round to 1–2 s on some platforms; writers rename atomically). */
export const SNAPSHOT_MTIME_TOLERANCE_MS = 1;

export type SpawnWorkerFn = (command: "extract" | "dream" | "reindex", root: string) => number | null;

export interface CompiledSnapshotRegexes {
  /**
   * memory id → compiled scope RegExp. `readActiveSnapshot` starts with an empty map and `scopeMatches` fills it
   * on first use (a PreToolUse call touches a handful of rows, never all 300); `compileSnapshotRegexes` fills it
   * eagerly for CLI tools. Invalid sources are stored as a never-matching RegExp.
   */
  scopeRegex: Map<string, RegExp>;
  /** memory id → compiled glob/regex signature RegExp (eager form only; `matchSignature` keeps its own cache). */
  signatureRegex: Map<string, RegExp>;
}

/** Never matches; stored for scope sources that fail to compile so they are not retried per call. */
const NEVER_MATCHES = /(?!)/;

export function emptyCompiledRegexes(): CompiledSnapshotRegexes {
  return { scopeRegex: new Map(), signatureRegex: new Map() };
}

export interface LoadedSnapshot {
  snapshot: ActiveSnapshot;
  compiled: CompiledSnapshotRegexes;
  /** `statSync(memory.sqlite)` differed from `snapshot.source` (a reindex was requested; the snapshot is still used). */
  stale: boolean;
  /** Memory ids → rows for O(1) lookups (failure_index, rules). */
  byId: Map<string, SnapshotMemory>;
}

export interface ReadSnapshotOptions {
  /** Injected for tests; defaults to a detached `worker reindex`. */
  spawnWorker?: SpawnWorkerFn | null;
  nowMs?: number;
  /** Skip the staleness check and reindex request (CLI tools that only want to read). */
  checkStale?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Structural check: enough to trust the fields the hooks read; unknown extra keys are ignored. */
export function isActiveSnapshot(value: unknown): value is ActiveSnapshot {
  if (!isRecord(value)) return false;
  return (
    value.schema === ACTIVE_SNAPSHOT_SCHEMA &&
    Array.isArray(value.memories) &&
    Array.isArray(value.rules) &&
    isRecord(value.failure_index) &&
    isRecord(value.counts) &&
    isRecord(value.source) &&
    typeof value.db_generation === "number" &&
    typeof value.user_version === "number"
  );
}

const SHARED_REGEX_CACHE = new Map<string, RegExp>();

function sharedRegExp(source: string, flags: string): RegExp | null {
  const key = `${flags}:${source}`;
  const cached = SHARED_REGEX_CACHE.get(key);
  if (cached !== undefined) return cached;
  try {
    const regex = new RegExp(source, flags);
    SHARED_REGEX_CACHE.set(key, regex);
    return regex;
  } catch {
    return null;
  }
}

export function compileSnapshotRegexes(memories: readonly SnapshotMemory[]): CompiledSnapshotRegexes {
  const scopeRegex = new Map<string, RegExp>();
  const signatureRegex = new Map<string, RegExp>();
  const globFlags = globRegexFlags();
  for (const memory of memories) {
    if (typeof memory.scope_regex === "string" && memory.scope_regex.length > 0) {
      const regex = sharedRegExp(memory.scope_regex, globFlags);
      if (regex !== null) scopeRegex.set(memory.id, regex);
    }
    const signature = memory.signature;
    if (signature !== null && signature.regex_source !== null) {
      const regex = sharedRegExp(signature.regex_source, signature.pattern_kind === "glob" ? globFlags : "");
      if (regex !== null) signatureRegex.set(memory.id, regex);
    }
  }
  return { scopeRegex, signatureRegex };
}

/** `scope_regex` null → global; otherwise the (lazily compiled, cached) RegExp must match the normalized ref. */
export function scopeMatches(loaded: Pick<LoadedSnapshot, "compiled">, memory: Pick<SnapshotMemory, "id" | "scope_regex">, ref: string): boolean {
  if (memory.scope_regex === null) return true;
  let regex = loaded.compiled.scopeRegex.get(memory.id);
  if (regex === undefined) {
    regex = memory.scope_regex.length > 0 ? (sharedRegExp(memory.scope_regex, globRegexFlags()) ?? NEVER_MATCHES) : NEVER_MATCHES;
    loaded.compiled.scopeRegex.set(memory.id, regex);
  }
  regex.lastIndex = 0;
  return regex.test(normalizeRef(ref));
}

export function normalizeRef(ref: string): string {
  return ref.trim().replace(/\\/g, "/").replace(/^(\.\/)+/, "");
}

/** True when `memory.sqlite` exists and its stat differs from what the snapshot was built from. */
export function isSnapshotStale(snapshot: Pick<ActiveSnapshot, "source">, paths: Pick<HarnessPaths, "db">): boolean {
  let stat;
  try {
    stat = statSync(paths.db);
  } catch {
    return false;
  }
  if (stat.size !== snapshot.source.size) return true;
  return Math.abs(stat.mtimeMs - snapshot.source.mtime_ms) > SNAPSHOT_MTIME_TOLERANCE_MS;
}

/** Sibling bundle (`dist/worker.js`) of the running module; tests inject `spawnWorker` instead. */
export function resolveWorkerScript(): string {
  return fileURLToPath(new URL("./worker.js", import.meta.url));
}

export function defaultSpawnWorker(command: "extract" | "dream" | "reindex", root: string): number | null {
  return spawnDetached(resolveWorkerScript(), [root, command], { cwd: root });
}

/**
 * Touches `snapshot/.reindex-requested` and spawns `worker reindex` unless the touch file is younger
 * than 60 s (parallel hooks must not start a worker storm). Returns true when a worker was spawned.
 */
export function requestReindex(
  paths: Pick<HarnessPaths, "snapshotDir" | "reindexRequested" | "root" | "db">,
  options: { spawnWorker?: SpawnWorkerFn | null; nowMs?: number } = {}
): boolean {
  if (!existsSync(paths.db)) return false;
  const nowMs = options.nowMs ?? Date.now();
  try {
    const stat = statSync(paths.reindexRequested);
    if (nowMs - stat.mtimeMs < REINDEX_THROTTLE_MS) return false;
    const stamp = new Date(nowMs);
    utimesSync(paths.reindexRequested, stamp, stamp);
  } catch {
    try {
      mkdirSync(paths.snapshotDir, { recursive: true });
      writeFileSync(paths.reindexRequested, `${new Date(nowMs).toISOString()}\n`, "utf8");
      const stamp = new Date(nowMs);
      utimesSync(paths.reindexRequested, stamp, stamp);
    } catch {
      return false;
    }
  }
  const spawnWorker = options.spawnWorker === undefined ? defaultSpawnWorker : options.spawnWorker;
  if (spawnWorker === null) return false;
  return spawnWorker("reindex", paths.root) !== null;
}

/**
 * Reads and validates `active.v1.json`. Missing or corrupt → null (and a reindex request when the
 * database exists). Stale → the snapshot is returned with `stale: true` after requesting a reindex.
 */
export function readActiveSnapshot(paths: HarnessPaths, options: ReadSnapshotOptions = {}): LoadedSnapshot | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(paths.snapshotActive, "utf8"));
  } catch {
    if (options.checkStale !== false) requestReindex(paths, options);
    return null;
  }
  if (!isActiveSnapshot(parsed)) {
    if (options.checkStale !== false) requestReindex(paths, options);
    return null;
  }
  const stale = options.checkStale === false ? false : isSnapshotStale(parsed, paths);
  if (stale) requestReindex(paths, options);
  return {
    snapshot: parsed,
    compiled: emptyCompiledRegexes(),
    stale,
    byId: new Map(parsed.memories.map((memory) => [memory.id, memory])),
  };
}

export interface LexicalHit {
  id: string;
  /** Raw MiniSearch BM25 score. */
  score: number;
}

export interface LexicalSearcher {
  search(query: string, limit: number): LexicalHit[];
  readonly documentCount: number;
  readonly dbGeneration: number;
  readonly recentSummaries: RecentSummary[];
  /** Tokenizer stamp found in the file (undefined = MiniSearch defaults were used by the builder). */
  readonly tokenizer: string | undefined;
}

interface MiniSearchLike {
  search(query: string): Array<{ id: unknown; score: number }>;
  readonly documentCount: number;
}

interface MiniSearchModule {
  default: { loadJS(js: unknown, options: unknown): MiniSearchLike };
}

function isLexicalSnapshot(value: unknown): value is LexicalSnapshot {
  return isRecord(value) && value.schema === LEXICAL_SNAPSHOT_SCHEMA && isRecord(value.index) && Array.isArray(value.recent_summaries);
}

/** Loads `lexical.v1.json` with a lazy `import("minisearch")`; null when the file is missing/corrupt. */
export async function readLexicalSnapshot(paths: Pick<HarnessPaths, "snapshotLexical">): Promise<LexicalSearcher | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(paths.snapshotLexical, "utf8"));
  } catch {
    return null;
  }
  if (!isLexicalSnapshot(parsed)) return null;
  try {
    const mod = (await import("minisearch")) as unknown as MiniSearchModule;
    const tokenizer = typeof parsed.tokenizer === "string" ? parsed.tokenizer : undefined;
    const index = mod.default.loadJS(parsed.index, lexicalOptionsFor(tokenizer));
    const recentSummaries = parsed.recent_summaries;
    const dbGeneration = parsed.db_generation;
    return {
      documentCount: index.documentCount,
      dbGeneration,
      recentSummaries,
      tokenizer,
      search(query: string, limit: number): LexicalHit[] {
        if (query.trim().length === 0 || limit <= 0) return [];
        return index
          .search(query)
          .slice(0, limit)
          .map((hit) => ({ id: String(hit.id), score: hit.score }));
      },
    };
  } catch {
    return null;
  }
}
