/**
 * Facts `status` and `doctor` share (spec §9.4, §11): database state through `Store.read` (no lock,
 * no migration), snapshot freshness through the hooks' own reader, queue depth, lock inspection,
 * worker.log waiting reason, hook-side touch files. Every reader is tolerant: a missing or damaged
 * input becomes a null/false fact plus an `error` string, never an exception.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";

import { isSnapshotStale, readActiveSnapshot } from "../../activation/snapshot-reader";
import type { HarnessConfig } from "../../core/config";
import type { HarnessPaths } from "../../core/paths";
import type { ActiveSnapshot, SnapshotCounts } from "../../core/snapshot-types";
import type { EpisodeStatus } from "../../core/vocabulary";
import { inspectDirLock, type LockInspection } from "../../db/locks";
import { META_KEYS, MetaRepository } from "../../db/repositories/meta";
import { EpisodeRepository } from "../../db/repositories/episodes";
import { ExtractionRunRepository, type ExtractionRunRecord } from "../../db/repositories/runs";
import { buildSnapshotData, type UnreachableMemory } from "../../db/snapshot";
import { quickCheck, tableExists } from "../../db/sql";
import type { Store } from "../../db/store";
import { readLastProbe, type ProbeCache } from "../../dream/extract/providers";
import { isProcessAlive } from "../../core/process";
import { spawnTouchFile } from "../../embed/client";

export interface DbFacts {
  exists: boolean;
  userVersion: number | null;
  migrationNeeded: boolean;
  newerThanCode: boolean;
  generation: number | null;
  quickCheck: string | null;
  counts: SnapshotCounts | null;
  unreachable: UnreachableMemory[];
  lastRun: ExtractionRunRecord | null;
  probe: ProbeCache | null;
  episodes: Record<EpisodeStatus, number> | null;
  installedVersion: string | null;
  lastDreamAt: string | null;
  /** Why the database could not be read (missing, corrupt, newer than code …). */
  error: string | null;
}

export async function readDbFacts(store: Store, paths: HarnessPaths, config: HarnessConfig, now: string): Promise<DbFacts> {
  const facts: DbFacts = {
    exists: existsSync(paths.db),
    userVersion: null,
    migrationNeeded: false,
    newerThanCode: false,
    generation: null,
    quickCheck: null,
    counts: null,
    unreachable: [],
    lastRun: null,
    probe: null,
    episodes: null,
    installedVersion: null,
    lastDreamAt: null,
    error: null,
  };
  if (!facts.exists) {
    facts.error = `no database at ${paths.db}`;
    return facts;
  }
  try {
    await store.read((db, ctx) => {
      facts.userVersion = ctx.userVersion;
      facts.migrationNeeded = ctx.migrationNeeded;
      facts.newerThanCode = ctx.newerThanCode;
      facts.generation = ctx.generation;
      facts.quickCheck = quickCheck(db);
      if (ctx.migrationNeeded || ctx.newerThanCode) return;
      const meta = new MetaRepository(db);
      facts.installedVersion = meta.get(META_KEYS.installedVersion);
      facts.lastDreamAt = meta.get(META_KEYS.lastDreamAt);
      facts.probe = readLastProbe(db);
      if (tableExists(db, "extraction_runs")) facts.lastRun = new ExtractionRunRepository(db).latest();
      if (tableExists(db, "episodes")) facts.episodes = new EpisodeRepository(db).countByStatus();
      const data = buildSnapshotData(db, paths, { now, config });
      facts.counts = data.active.counts;
      facts.unreachable = data.unreachable;
    });
  } catch (error) {
    facts.error = error instanceof Error ? error.message : String(error);
  }
  return facts;
}

export type SnapshotState = "fresh" | "stale" | "missing" | "corrupt";

export interface SnapshotFacts {
  state: SnapshotState;
  snapshot: ActiveSnapshot | null;
  generation: number | null;
  builtAt: string | null;
  counts: SnapshotCounts | null;
  lexicalExists: boolean;
  denseExists: boolean;
  /** Age of `snapshot/.reindex-requested` (a hook asked for a rebuild) or null when absent. */
  reindexRequestedAgeMs: number | null;
}

export function readSnapshotFacts(paths: HarnessPaths, nowMs: number): SnapshotFacts {
  const loaded = readActiveSnapshot(paths, { checkStale: false, spawnWorker: null });
  let state: SnapshotState;
  if (loaded === null) state = existsSync(paths.snapshotActive) ? "corrupt" : "missing";
  else state = isSnapshotStale(loaded.snapshot, paths) ? "stale" : "fresh";
  return {
    state,
    snapshot: loaded?.snapshot ?? null,
    generation: loaded?.snapshot.db_generation ?? null,
    builtAt: loaded?.snapshot.built_at ?? null,
    counts: loaded?.snapshot.counts ?? null,
    lexicalExists: existsSync(paths.snapshotLexical),
    denseExists: existsSync(paths.snapshotDense),
    reindexRequestedAgeMs: fileAgeMs(paths.reindexRequested, nowMs),
  };
}

export function fileAgeMs(file: string, nowMs: number): number | null {
  try {
    return Math.max(0, nowMs - statSync(file).mtimeMs);
  } catch {
    return null;
  }
}

export function countQueueFiles(paths: Pick<HarnessPaths, "queueDir">): number {
  try {
    return readdirSync(paths.queueDir).filter((name) => name.endsWith(".json")).length;
  } catch {
    return 0;
  }
}

export interface WorkerLogFacts {
  /** `waiting=<reason>` of the most recent `lease` line (null when the worker was not waiting). */
  waiting: string | null;
  lastLeaseAt: string | null;
  lastEnd: { command: string; exit: number; at: string } | null;
  lastError: string | null;
}

/** Worker log lines look like `<iso> <command> <event> k=v …`. Only the tail is read. */
export function readWorkerLogFacts(paths: Pick<HarnessPaths, "workerLog">, maxBytes = 512 * 1024): WorkerLogFacts {
  const facts: WorkerLogFacts = { waiting: null, lastLeaseAt: null, lastEnd: null, lastError: null };
  let text: string;
  try {
    const size = statSync(paths.workerLog).size;
    const buffer = readFileSync(paths.workerLog);
    text = buffer.subarray(Math.max(0, size - maxBytes)).toString("utf8");
  } catch {
    return facts;
  }
  const lines = text.split("\n");
  let leaseSeen = false;
  let endSeen = false;
  let errorSeen = false;
  for (let index = lines.length - 1; index >= 0 && !(leaseSeen && endSeen && errorSeen); index -= 1) {
    const parts = lines[index]!.trim().split(/\s+/);
    if (parts.length < 3) continue;
    const [ts, command, event] = parts as [string, string, string, ...string[]];
    if (!Number.isFinite(Date.parse(ts))) continue;
    if (!leaseSeen && event === "lease") {
      leaseSeen = true;
      facts.lastLeaseAt = ts;
      const waiting = parts.find((part) => part.startsWith("waiting="))?.slice("waiting=".length) ?? null;
      facts.waiting = waiting === null || waiting === "null" ? null : waiting;
    } else if (!endSeen && event === "end") {
      endSeen = true;
      const exit = Number(parts.find((part) => part.startsWith("exit="))?.slice("exit=".length));
      facts.lastEnd = { command, exit: Number.isFinite(exit) ? exit : -1, at: ts };
    } else if (!errorSeen && event === "error") {
      errorSeen = true;
      facts.lastError = `${ts} ${parts.slice(3).join(" ")}`;
    }
  }
  return facts;
}

export interface PidFileFacts {
  pid: number;
  alive: boolean;
}

export function readPidFile(file: string): PidFileFacts | null {
  try {
    const pid = Number(readFileSync(file, "utf8").trim());
    if (!Number.isInteger(pid) || pid <= 0) return null;
    return { pid, alive: isProcessAlive(pid) };
  } catch {
    return null;
  }
}

export interface LockFacts {
  db: LockInspection;
  worker: LockInspection;
  workerPid: PidFileFacts | null;
  embedHelperPid: PidFileFacts | null;
  embedSpawnAgeMs: number | null;
}

export function readLockFacts(paths: HarnessPaths, now: () => string, nowMs: number): LockFacts {
  return {
    db: inspectDirLock(paths.dbLock, { now }),
    worker: inspectDirLock(paths.workerLock, { now }),
    workerPid: readPidFile(paths.workerPid),
    embedHelperPid: readPidFile(paths.embedHelperPid),
    embedSpawnAgeMs: fileAgeMs(spawnTouchFile(paths), nowMs),
  };
}

/** Human guidance for a probe result (m0-facts #3). */
export function probeGuidance(result: string | null): string | null {
  switch (result) {
    case null:
      return null;
    case "ok":
      return null;
    case "not_logged_in":
      return "run `claude` once in a terminal and `/login`; extraction stays queued until the CLI is logged in";
    case "missing":
      return "no extraction CLI found (claude or codex); install one or set HARNESS_MEMORY_CLAUDE_BIN";
    case "nested_refusal":
      return "the probe ran inside a Claude Code session; run `hm install` or `hm extract` from a plain terminal";
    case "probe_timeout":
      return "the provider did not answer within extraction.probe_timeout_ms; check `claude -p` works in a terminal";
    case "invalid_output":
      return "the provider answered without the expected JSON; check `claude -p --output-format json` in a terminal";
    default:
      return `unexpected probe result ${result}`;
  }
}
