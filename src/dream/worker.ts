/**
 * worker — `extract | dream | reindex | import <descriptor-file>` (spec §5.4, §9.3 A–E, §9.4 F3).
 *
 *   A  worker.lock (one per repository, 5 s jittered wait; busy → exit quietly, the holder rescans in E)
 *   B  lock session 1 (≤ 1 s): queue/*.json → episodes INSERT OR IGNORE, fire roll-up only for newly inserted
 *      episodes, expired leases / due retries back to queued, daily cap (corrections excluded), probe cache,
 *      lease ≤ 3 episodes correction-first (an all-ineligible batch is skipped and the lease repeated), prompt
 *      inputs (intersecting memories, live ids, corrected episode)
 *   C  no lock: raw/<run_id>.json (V1-valid) is reused, else probe (daily) → provider (≤ 120 s) → raw cache;
 *      a failed probe never burns an episode attempt (the batch waits like `no_provider`)
 *   D  lock session 2 (≤ 2 s): write_ops(run_id) → extracted; else V1–V11 → reconcile → commit (§9.2)
 *   E  queue files deleted; loop ≤ 10 times while eligible episodes remain; worker.lock released, then queue/
 *      is rescanned and the loop re-entered when a hook queued more while this worker ran (a loser exited)
 *
 * `reindex` only rebuilds the snapshot; `dream` empties the queue first and then runs consolidate (§5.8);
 * `import` copies the given descriptor(s) into queue/ and runs the extract loop.
 */

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";

import type { Database as SqlJsDatabase } from "sql.js";

import { globMatchesPath } from "../activation/signature";
import { toolGlobMatches } from "../activation/tool-vocabulary";
import type { HarnessConfig } from "../core/config";
import { EPISODE_SCHEMA, type EpisodeDescriptor } from "../core/episode-types";
import { LockBusyError } from "../core/errors";
import { EXTRACTION_SCHEMA_JSON, EXTRACTOR_VERSION } from "../core/extraction-types";
import { extractionRunId, sha256Hex } from "../core/ids";
import type { LedgerLine } from "../core/ledger-types";
import { queueFile, rawFile, type HarnessPaths } from "../core/paths";
import { redactCredentials } from "../core/signals";
import { CLOSE_REASONS, HOSTS, LIVE_STATUSES, type ProbeResult, type RunStatus } from "../core/vocabulary";
import { acquireDirLock, type LockHandle } from "../db/locks";
import { runPostMigrate } from "../db/post-migrate";
import { EpisodeRepository, episodeRecordToDescriptor, type EpisodeRecord } from "../db/repositories/episodes";
import { ExtractionRunRepository } from "../db/repositories/runs";
import { buildSnapshot } from "../db/snapshot";
import { selectOne } from "../db/sql";
import { Store, type StoreHooks, type StoreLogger, type WriteContext, type WriteOp } from "../db/store";
import { MemoryNotFoundError, MemoryRepository } from "../memory/repository";
import { derivePolicyRules } from "../policy/derive";
import { applyEmbeddings, embedBacklog, runDream, selectEmbeddingBacklog, type DreamReport, type EmbedFn } from "./consolidate";
import { isEligibleForExtraction } from "./episode";
import { buildExtractionPrompt, eventIdMap, type PromptMemory } from "./extract/prompt";
import { parseExtractionOutput } from "./extract/schema";
import { validateRawExtraction } from "./extract/validate";
import {
  probeWithCache,
  readProbeCache,
  selectProvider,
  writeProbeCache,
  type ExtractionProvider,
  type ProbeCache,
  type ProviderResult,
} from "./extract/providers";
import { readLedgerRangeLines } from "./ledger";
import { recordExtractionFailure, reconcileRun, type ReconcileRunInfo, type ReconcileWriteOp } from "./reconcile";
import { createTransformersEmbedder, type Embedder } from "../embed/helper";

export const WORKER_COMMANDS = ["extract", "dream", "reindex", "import"] as const;
export type WorkerCommand = (typeof WORKER_COMMANDS)[number];

export const WORKER_LOCK_WAIT_MS = 5_000;
export const DB_LOCK_WAIT_MS = 30_000;
export const MAX_LOOPS_PER_RUN = 10;
export const LEASE_BATCH = 3;
/** Lease rounds inside one lock session when every leased episode turns out ineligible (3 skips per round). */
export const MAX_SKIP_ROUNDS = 10;
/** Post-release queue rescans per run (§9.3 E): a hook that queued while this worker held worker.lock is served here. */
export const MAX_RESCANS_PER_RUN = 3;
/** Rows embedded per `worker extract` beyond the rows the run created; `worker dream` drains the rest. */
export const EMBED_BACKLOG_PER_RUN = 64;
export const PROVIDER_WALL_CLOCK_MS = 120_000;
export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_LOCK_BUSY = 75;

export interface WorkerLogger extends StoreLogger {
  /** Structured one-liner into logs/worker.log (`<iso> <command> <event> k=v …`). */
  line(event: string, fields?: Record<string, string | number | boolean | null | undefined>): void;
}

export interface WorkerOptions {
  paths: HarnessPaths;
  config: HarnessConfig;
  store: Store;
  command: WorkerCommand;
  args?: readonly string[];
  /** Explicit provider (tests / eval:replay); `undefined` → selectProvider(config), `null` → no_provider. */
  provider?: ExtractionProvider | null;
  clock?: () => string;
  logger?: WorkerLogger;
  maxLoops?: number;
  dbLockWaitMs?: number;
  workerLockWaitMs?: number;
  embed?: EmbedFn | null;
  pid?: number;
}

export interface ProcessedEpisode {
  episodeId: string;
  runId: string;
  status: RunStatus;
  fromCache: boolean;
  op: WriteOp;
  outcomes: number;
  created: string[];
  activated: string[];
  proposals: string[];
}

export interface WorkerResult {
  command: WorkerCommand;
  exitCode: number;
  busy: boolean;
  loops: number;
  inserted: number;
  processed: ProcessedEpisode[];
  skipped: string[];
  waiting: { count: number; reason: string } | null;
  dream: DreamReport | null;
  snapshotBuilt: boolean;
  errors: string[];
}

// ---------------------------------------------------------------------------------------------
// Composition helpers (also used by the CLI)
// ---------------------------------------------------------------------------------------------

export function composeStoreHooks(config: HarnessConfig): StoreHooks {
  return {
    postMigrate: (db, ctx) => runPostMigrate(db, { now: ctx.now, logger: ctx.logger }),
    deriveRules: (db, ctx: WriteContext) => derivePolicyRules(db, { now: ctx.now }),
    buildSnapshot: (db, ctx: WriteContext) => buildSnapshot(db, ctx.paths, { now: ctx.now, config, generation: ctx.generation }),
  };
}

/**
 * Document-side embedder (`EmbedFn` for backfillEmbeddings): lazily loads the same @xenova/transformers pipeline
 * the embedding helper uses, with the e5 `passage: ` prefix. Null when embeddings are disabled; an empty batch
 * only warms the model. Shared by the detached worker entry and the in-process CLI runs.
 */
export function createWorkerEmbed(config: HarnessConfig): EmbedFn | null {
  if (!config.embeddings.enabled) return null;
  const factory = createTransformersEmbedder(config);
  let loading: Promise<Embedder> | null = null;
  return async (texts: string[]): Promise<Float32Array[]> => {
    loading ??= factory();
    const embedder = await loading;
    const vectors: Float32Array[] = [];
    for (const text of texts) {
      vectors.push(embedder.embedPassage !== undefined ? await embedder.embedPassage(text) : await embedder.embedQuery(text));
    }
    return vectors;
  };
}

export interface ComposeStoreOptions {
  paths: HarnessPaths;
  config: HarnessConfig;
  logger?: StoreLogger;
  clock?: () => string;
  pid?: number;
}

export function composeStore(options: ComposeStoreOptions): Store {
  return new Store({
    paths: options.paths,
    hooks: composeStoreHooks(options.config),
    logger: options.logger,
    clock: options.clock,
    pid: options.pid,
  });
}

export interface WorkerLoggerOptions {
  clock?: () => string;
  command?: string;
  maxBytes?: number;
  rotations?: number;
}

function rotate(file: string, maxBytes: number, rotations: number): void {
  try {
    if (statSync(file).size < maxBytes) return;
  } catch {
    return;
  }
  for (let index = rotations - 1; index >= 1; index -= 1) {
    const from = index === 1 ? file : `${file}.${String(index - 1)}`;
    const to = `${file}.${String(index)}`;
    try {
      if (existsSync(from)) renameSync(from, to);
    } catch {
      // best effort
    }
  }
}

/** `logs/worker.log` writer (5 MB × 3 by default) that also satisfies the store's logger interface. */
export function createWorkerLogger(paths: HarnessPaths, options: WorkerLoggerOptions = {}): WorkerLogger {
  const clock = options.clock ?? (() => new Date().toISOString());
  const maxBytes = options.maxBytes ?? 5 * 1024 * 1024;
  const rotations = options.rotations ?? 3;
  const command = options.command ?? "worker";
  const write = (level: string, text: string): void => {
    try {
      mkdirSync(paths.logsDir, { recursive: true });
      rotate(paths.workerLog, maxBytes, rotations);
      appendFileSync(paths.workerLog, `${clock()} ${command} ${level} ${text.replace(/\s+/g, " ").trim()}\n`, "utf8");
    } catch {
      // logging never fails the worker
    }
  };
  return {
    log: (message) => write("info", message),
    warn: (message) => write("warn", message),
    error: (message) => write("error", message),
    line: (event, fields = {}) => {
      const rendered = Object.entries(fields)
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => `${key}=${String(value)}`)
        .join(" ");
      write(event, rendered);
    },
  };
}

export const silentWorkerLogger: WorkerLogger = { log() {}, warn() {}, error() {}, line() {} };

export interface ParsedWorkerArgv {
  root: string;
  command: WorkerCommand;
  args: string[];
}

export function parseWorkerArgv(argv: readonly string[]): ParsedWorkerArgv | null {
  const [root, command, ...args] = argv;
  if (root === undefined || command === undefined) return null;
  if (!(WORKER_COMMANDS as readonly string[]).includes(command)) return null;
  return { root, command: command as WorkerCommand, args };
}

// ---------------------------------------------------------------------------------------------
// Queue files
// ---------------------------------------------------------------------------------------------

export interface QueueEntry {
  file: string;
  descriptor: EpisodeDescriptor;
}

const HOST_SET: ReadonlySet<string> = new Set(HOSTS);
const CLOSE_REASON_SET: ReadonlySet<string> = new Set(CLOSE_REASONS);

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || value === null || typeof value === "string";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The whole `EpisodeDescriptor` contract that `EpisodeRepository.insertIfAbsent` and the fire roll-up rely on
 * (not just the id fields): a file that passes here can be inserted, so a malformed one is removed instead of
 * wedging every later lease session on the same throw.
 */
export function isEpisodeDescriptor(value: unknown): value is EpisodeDescriptor {
  if (!isPlainObject(value)) return false;
  const record = value;
  return (
    record.schema === EPISODE_SCHEMA &&
    typeof record.id === "string" &&
    record.id.length > 0 &&
    typeof record.host === "string" &&
    HOST_SET.has(record.host) &&
    typeof record.session_id === "string" &&
    typeof record.session_key === "string" &&
    typeof record.turn_key === "string" &&
    isNonNegativeInt(record.segment) &&
    typeof record.started_at === "string" &&
    typeof record.closed_at === "string" &&
    typeof record.close_reason === "string" &&
    CLOSE_REASON_SET.has(record.close_reason) &&
    typeof record.ledger_ref === "string" &&
    isOptionalString(record.correction_for) &&
    isOptionalString(record.context_ref) &&
    Array.isArray(record.scope_refs) &&
    Array.isArray(record.tools) &&
    Array.isArray(record.failure_signatures) &&
    record.failure_signatures.every(isPlainObject) &&
    isPlainObject(record.flags) &&
    Array.isArray(record.fired) &&
    record.fired.every((entry) => isPlainObject(entry) && typeof entry.memory_id === "string") &&
    typeof record.evidence_weight === "number" &&
    Number.isFinite(record.evidence_weight) &&
    isNonNegativeInt(record.event_count) &&
    isOptionalString(record.prompt_text) &&
    isOptionalString(record.last_assistant_message)
  );
}

export function scanQueue(paths: HarnessPaths, logger: WorkerLogger): QueueEntry[] {
  let names: string[];
  try {
    names = readdirSync(paths.queueDir).filter((name) => name.endsWith(".json")).sort();
  } catch {
    return [];
  }
  const entries: QueueEntry[] = [];
  for (const name of names) {
    const file = join(paths.queueDir, name);
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
      if (!isEpisodeDescriptor(parsed)) {
        logger.warn(`queue file ${name} is not an episode descriptor; removed`);
        rmSync(file, { force: true });
        continue;
      }
      entries.push({ file, descriptor: parsed });
    } catch (error) {
      logger.warn(`queue file ${name} unreadable (${error instanceof Error ? error.message : String(error)}); removed`);
      rmSync(file, { force: true });
    }
  }
  return entries;
}

// ---------------------------------------------------------------------------------------------
// Lock session 1
// ---------------------------------------------------------------------------------------------

export interface LeasedWork {
  record: EpisodeRecord;
  /** Queue descriptor when this worker inserted it (carries prompt_text / last_assistant_message). */
  queued: EpisodeDescriptor | null;
  existingMemories: PromptMemory[];
  correctionFor: EpisodeRecord | null;
}

export interface LeaseSessionResult {
  inserted: number;
  rolledUp: number;
  leased: LeasedWork[];
  skipped: string[];
  /** Queue files whose insert threw (quarantined as `<file>.bad` by the loop instead of failing the session). */
  rejected: string[];
  moreDue: boolean;
  probeCache: ProbeCache | null;
  needProbe: boolean;
  waiting: { count: number; reason: string } | null;
}

function startOfUtcDay(iso: string): string {
  return `${iso.slice(0, 10)}T00:00:00.000Z`;
}

const CORRECTION_SQL = "(e.correction_for IS NOT NULL OR e.flags_json LIKE '%\"correction\":1%')";

function countDue(db: SqlJsDatabase, now: string): { corrections: number; plain: number } {
  const row = selectOne(
    db,
    `SELECT SUM(CASE WHEN ${CORRECTION_SQL} THEN 1 ELSE 0 END) AS corrections,
            SUM(CASE WHEN ${CORRECTION_SQL} THEN 0 ELSE 1 END) AS plain
     FROM episodes e
     WHERE e.status = 'queued' AND (e.next_attempt_at IS NULL OR e.next_attempt_at <= ?)`,
    [now]
  );
  return { corrections: Number(row?.corrections ?? 0), plain: Number(row?.plain ?? 0) };
}

/** Existing memories whose scope or signature tool intersects the episode (≤ 40, active first). */
export function selectPromptMemories(repository: MemoryRepository, descriptor: Pick<EpisodeDescriptor, "scope_refs" | "tools">, limit = 40): PromptMemory[] {
  const statusRank: Record<string, number> = { active: 0, stale: 1, candidate: 2 };
  return repository
    .list({ status: LIVE_STATUSES })
    .filter((memory) => {
      if (memory.scopeGlob === "**/*" || memory.scopeGlob === "**" || memory.scopeGlob === "*") return true;
      if (descriptor.scope_refs.some((ref) => globMatchesPath(memory.scopeGlob, ref))) return true;
      return memory.triggerSignature !== null && descriptor.tools.some((tool) => toolGlobMatches(memory.triggerSignature!.tool, tool));
    })
    .sort((left, right) => {
      const rank = (statusRank[left.status] ?? 3) - (statusRank[right.status] ?? 3);
      if (rank !== 0) return rank;
      if (right.evidenceScore !== left.evidenceScore) return right.evidenceScore - left.evidenceScore;
      return left.createdAt.localeCompare(right.createdAt);
    })
    .slice(0, limit)
    .map((memory) => ({
      id: memory.id,
      type: memory.type,
      status: memory.status,
      authority: memory.authority,
      scopeGlob: memory.scopeGlob,
      signatureKey: memory.signatureKey,
      summary: memory.summary,
    }));
}

function rollUpFires(repository: MemoryRepository, descriptor: EpisodeDescriptor): number {
  let count = 0;
  for (const fired of descriptor.fired) {
    try {
      repository.recordFire(fired.memory_id, { at: descriptor.closed_at, count: 1, overrideDelta: fired.outcome === "override" ? 1 : 0 });
      count += 1;
    } catch (error) {
      if (!(error instanceof MemoryNotFoundError)) throw error;
    }
  }
  return count;
}

export function leaseSession(
  db: SqlJsDatabase,
  ctx: WriteContext,
  queued: readonly QueueEntry[],
  options: { config: HarnessConfig; provider: ExtractionProvider | null; logger: WorkerLogger }
): LeaseSessionResult & { op: WriteOp } {
  const { config, provider } = options;
  const now = ctx.now;
  const episodes = new EpisodeRepository(db);
  const runs = new ExtractionRunRepository(db);
  const repository = new MemoryRepository(db, { clock: () => now });
  const queuedById = new Map<string, EpisodeDescriptor>();
  const rejected: string[] = [];
  let wrote = false;
  let inserted = 0;
  let rolledUp = 0;

  queued.forEach((entry, index) => {
    // One savepoint per file: a descriptor the validator let through but the repository rejects is quarantined
    // by the loop; it must not roll back the other inserts or abort the session (§9.3 B).
    const savepoint = `sp_queue_${String(index)}`;
    db.run(`SAVEPOINT ${savepoint}`);
    try {
      if (episodes.insertIfAbsent(entry.descriptor, now)) {
        inserted += 1;
        wrote = true;
        rolledUp += rollUpFires(repository, entry.descriptor);
      }
      queuedById.set(entry.descriptor.id, entry.descriptor);
      db.run(`RELEASE ${savepoint}`);
    } catch (error) {
      db.run(`ROLLBACK TO ${savepoint}`);
      db.run(`RELEASE ${savepoint}`);
      rejected.push(entry.file);
      options.logger.warn(`queue file ${basename(entry.file)} could not be inserted (${error instanceof Error ? error.message : String(error)}); quarantined`);
    }
  });
  if (episodes.releaseExpiredLeases(now) > 0) wrote = true;
  if (episodes.requeueDueFailures(now) > 0) wrote = true;

  const result: LeaseSessionResult = { inserted, rolledUp, leased: [], skipped: [], rejected, moreDue: false, probeCache: null, needProbe: false, waiting: null };
  const due = countDue(db, now);
  const dueTotal = due.corrections + due.plain;

  if (provider === null) {
    const cached = readProbeCache(db, now);
    if (cached === null || cached.result !== "missing") {
      writeProbeCache(db, { at: now, result: "missing" });
      wrote = true;
    }
    if (dueTotal > 0) result.waiting = { count: dueTotal, reason: "no_provider" };
    return { ...result, op: { id: null, kind: "extract:lease", noop: true, wrote } };
  }

  const cached = provider.name === "replay" ? null : readProbeCache(db, now);
  result.probeCache = cached;
  if (cached !== null && cached.result !== "ok") {
    if (dueTotal > 0) result.waiting = { count: dueTotal, reason: cached.result };
    return { ...result, op: { id: null, kind: "extract:lease", noop: true, wrote } };
  }
  result.needProbe = provider.name !== "replay" && cached === null;

  const usedToday = runs.countSince(startOfUtcDay(now), { excludeCorrection: true });
  const remainingDaily = Math.max(0, config.extraction.max_runs_per_day - usedToday);

  // The lease SQL knows nothing about eligibility (§5.3): a batch made only of no_signal episodes is marked
  // skipped and the lease repeated, so ineligible rows never end a run while eligible ones are still due (R3).
  for (let round = 0; round < MAX_SKIP_ROUNDS && result.leased.length === 0; round += 1) {
    const pending = round === 0 ? due : countDue(db, now);
    const take = Math.min(LEASE_BATCH, pending.corrections + Math.min(pending.plain, remainingDaily));
    if (take === 0) {
      if (pending.plain > 0 && remainingDaily === 0) result.waiting = { count: pending.plain, reason: "daily_cap" };
      break;
    }

    const leased = episodes.lease(take, { leaseSeconds: config.extraction.lease_seconds, now, correctionFirst: true });
    if (leased.length === 0) break;
    wrote = true;

    for (const record of leased) {
      const queuedDescriptor = queuedById.get(record.id) ?? null;
      const eligibility = isEligibleForExtraction(episodeRecordToDescriptor(record));
      if (!eligibility.eligible) {
        episodes.markSkipped(record.id, eligibility.reason);
        result.skipped.push(record.id);
        continue;
      }
      const descriptor = queuedDescriptor ?? episodeRecordToDescriptor(record);
      const correctionFor = record.correctionFor === null ? null : episodes.getById(record.correctionFor);
      result.leased.push({
        record,
        queued: queuedDescriptor,
        existingMemories: selectPromptMemories(repository, descriptor),
        correctionFor,
      });
    }
  }

  const after = countDue(db, now);
  result.moreDue = after.corrections + after.plain > 0 && (after.corrections > 0 || remainingDaily - result.leased.length > 0);
  return { ...result, op: { id: null, kind: "extract:lease", noop: true, wrote } };
}

// ---------------------------------------------------------------------------------------------
// Unlocked phase (C)
// ---------------------------------------------------------------------------------------------

const LEDGER_REF = /^ledger\/(.+)#(\d+)-(\d+)$/;
const IMPORT_REF = /^import:(.+?)(?:#L(\d+))?$/;

export interface EpisodeLines {
  lines: LedgerLine[];
  badLines: number;
}

/** `raw/<episode_id>.import.txt`: the bullet text of an import episode, kept so a retry never re-reads the source file. */
export function importTextFile(paths: Pick<HarnessPaths, "rawDir">, episodeId: string): string {
  return join(paths.rawDir, `${episodeId}.import.txt`);
}

/** Lock-free: written when the queue file is consumed (the descriptor carried the text), removed by the raw GC. */
export function rememberImportText(paths: Pick<HarnessPaths, "rawDir">, descriptor: EpisodeDescriptor): void {
  if (descriptor.host !== "import" || descriptor.prompt_text === null || descriptor.prompt_text === undefined) return;
  mkdirSync(paths.rawDir, { recursive: true });
  const file = importTextFile(paths, descriptor.id);
  const tmp = `${file}.tmp-${String(process.pid)}`;
  writeFileSync(tmp, descriptor.prompt_text, "utf8");
  renameSync(tmp, file);
}

function readStoredImportText(paths: Pick<HarnessPaths, "rawDir">, episodeId: string): string | null {
  try {
    return readFileSync(importTextFile(paths, episodeId), "utf8");
  } catch {
    return null;
  }
}

/**
 * `import:<path>` resolved against the project root; null for anything outside it. The path comes from a queue
 * file (`ledger_ref`), which is untrusted input: the worker never reads an arbitrary file named by one.
 */
export function resolveImportSource(paths: Pick<HarnessPaths, "root">, importPath: string): string | null {
  const resolved = resolve(paths.root, importPath);
  const rel = relative(paths.root, resolved);
  if (rel.length === 0 || rel.startsWith("..") || isAbsolute(rel)) return null;
  return resolved;
}

function readImportSourceLine(paths: Pick<HarnessPaths, "root">, importPath: string, lineNo: number | null): string | null {
  const source = resolveImportSource(paths, importPath);
  if (source === null) return null;
  try {
    const content = readFileSync(source, "utf8");
    return lineNo === null ? content : (content.split(/\r?\n/)[lineNo - 1] ?? null);
  } catch {
    return null;
  }
}

/**
 * Reads the byte range named by `ledger_ref`; import episodes synthesize a prompt line from the queue descriptor,
 * the text kept by `rememberImportText`, or (inside the project root only) the source file. The synthesized line
 * goes through the same credential redaction as ledger lines (§5.1).
 */
export function readEpisodeLines(paths: HarnessPaths, record: EpisodeRecord, queued: EpisodeDescriptor | null): EpisodeLines {
  const ledgerMatch = LEDGER_REF.exec(record.ledgerRef);
  if (ledgerMatch !== null) {
    const file = join(paths.ledgerDir, basename(ledgerMatch[1]!));
    const parsed = readLedgerRangeLines(file, Number(ledgerMatch[2]), Number(ledgerMatch[3]));
    return { lines: parsed.lines, badLines: parsed.badLines };
  }
  let text = queued?.prompt_text ?? null;
  const importMatch = IMPORT_REF.exec(record.ledgerRef);
  if (text === null && importMatch !== null) text = readStoredImportText(paths, record.id);
  if (text === null && importMatch !== null) text = readImportSourceLine(paths, importMatch[1]!, importMatch[2] === undefined ? null : Number(importMatch[2]));
  if (text === null) return { lines: [], badLines: 0 };
  return {
    lines: [{ kind: "prompt", ts: record.startedAt, seq: 1, turn_key: record.turnKey, text: redactCredentials(text), correction: record.flags.correction ?? 0, remember: record.flags.remember ?? 0 }],
    badLines: 0,
  };
}

function toolLinesOf(paths: HarnessPaths, record: EpisodeRecord | null): LedgerLine[] | null {
  if (record === null) return null;
  const lines = readEpisodeLines(paths, record, null).lines.filter((line) => line.kind === "tool_ok" || line.kind === "tool_fail");
  return lines.length > 0 ? lines : null;
}

/** Fills prompt_text / last_assistant_message (not stored in `episodes`) from the ledger lines. */
export function hydrateDescriptor(record: EpisodeRecord, queued: EpisodeDescriptor | null, lines: readonly LedgerLine[]): EpisodeDescriptor {
  const base = queued ?? episodeRecordToDescriptor(record);
  const prompt = lines.find((line) => line.kind === "prompt");
  const assistants = lines.filter((line) => line.kind === "assistant");
  const last = assistants.length > 0 ? assistants[assistants.length - 1]! : null;
  return {
    ...base,
    prompt_text: base.prompt_text ?? (prompt !== undefined && prompt.kind === "prompt" ? prompt.text : null),
    last_assistant_message: base.last_assistant_message ?? (last !== null && last.kind === "assistant" ? last.text : null),
  };
}

export interface ExtractedWork {
  work: LeasedWork;
  descriptor: EpisodeDescriptor;
  runId: string;
  seqMap: Map<string, LedgerLine>;
  run: ReconcileRunInfo;
  result: ProviderResult;
  fromCache: boolean;
  /** The failure is the provider's (probe), not this episode's: lock session 2 requeues it without burning an attempt. */
  providerUnavailable: boolean;
}

function probeFailureStatus(result: ProbeResult): Exclude<RunStatus, "started" | "ok"> {
  switch (result) {
    case "not_logged_in":
      return "not_logged_in";
    case "nested_refusal":
      return "nested_refusal";
    case "missing":
      return "no_provider";
    case "probe_timeout":
      return "timeout";
    case "provider_error":
      return "provider_error";
    default:
      return "invalid_output";
  }
}

function writeRawCache(paths: HarnessPaths, runId: string, raw: string, attempt: number | undefined): string {
  mkdirSync(paths.rawDir, { recursive: true });
  const file = rawFile(paths, runId, attempt);
  const tmp = `${file}.tmp-${String(process.pid)}`;
  writeFileSync(tmp, raw, "utf8");
  renameSync(tmp, file);
  return `raw/${basename(file)}`;
}

export interface UnlockedPhaseOptions {
  paths: HarnessPaths;
  config: HarnessConfig;
  provider: ExtractionProvider;
  probe: { needed: boolean; cached: ProbeCache | null };
  clock: () => string;
  logger: WorkerLogger;
}

export interface UnlockedPhaseResult {
  extracted: ExtractedWork[];
  probeResult: { result: ProbeResult; detail: string | null; cacheable: boolean } | null;
}

/** Phase C for one lease batch: prompt → raw cache or probe + provider → raw cache. */
export async function unlockedPhase(batch: readonly LeasedWork[], options: UnlockedPhaseOptions): Promise<UnlockedPhaseResult> {
  const { paths, config, provider, logger } = options;
  const extracted: ExtractedWork[] = [];
  let probeResult: { result: ProbeResult; detail: string | null; cacheable: boolean } | null = null;
  let probed = false;

  for (const work of batch) {
    const startedAt = options.clock();
    const { lines } = readEpisodeLines(paths, work.record, work.queued);
    const descriptor = hydrateDescriptor(work.record, work.queued, lines);
    const built = buildExtractionPrompt({
      descriptor,
      lines,
      contextLines: toolLinesOf(paths, work.correctionFor),
      existingMemories: work.existingMemories,
      host: descriptor.host,
    });
    const runId = extractionRunId(descriptor.id, EXTRACTOR_VERSION);
    const run: ReconcileRunInfo = {
      provider: provider.name,
      model: config.extraction.model,
      promptSha256: sha256Hex(built.prompt),
      inputChars: built.prompt.length,
      startedAt,
      rawOutputRef: null,
    };

    // Raw cache reuse (V1-valid only). The cached output cites event ids of an earlier render, which may have
    // dropped other lines than this one: resolve its refs over every event id of the episode (ids are positional
    // over the full line list, so the same id names the same ledger line in both renders).
    const cached = rawFile(paths, runId);
    if (existsSync(cached)) {
      try {
        const raw = readFileSync(cached, "utf8");
        if (parseExtractionOutput(raw).ok) {
          extracted.push({ work, descriptor, runId, seqMap: eventIdMap(lines), run: { ...run, rawOutputRef: `raw/${basename(cached)}` }, result: { status: "ok", raw, model: "cache" }, fromCache: true, providerUnavailable: false });
          logger.line("cache_reuse", { episode: descriptor.id, run: runId });
          continue;
        }
      } catch {
        // fall through to the provider
      }
    }

    if (options.probe.needed && !probed) {
      probed = true;
      const probe = await probeWithCache(provider, options.probe.cached, { config, paths, now: options.clock(), logger });
      probeResult = { result: probe.result, detail: probe.detail, cacheable: probe.cacheable };
      logger.line("probe", { provider: provider.name, result: probe.result, cached: probe.fromCache, ...(probe.detail === null ? {} : { detail: probe.detail }) });
    }
    if (probeResult !== null && probeResult.result !== "ok") {
      // A failed probe says nothing about this episode: it is recorded for `doctor` but waits like `no_provider`
      // (§9.4 F3 "N episodes waiting") instead of consuming one of its three attempts.
      const status = probeFailureStatus(probeResult.result);
      extracted.push({ work, descriptor, runId, seqMap: built.seqMap, run, result: { status, raw: "", error: `probe: ${probeResult.result}${probeResult.detail === null ? "" : ` — ${probeResult.detail}`}` }, fromCache: false, providerUnavailable: true });
      continue;
    }

    const timeoutMs = Math.min(config.extraction.timeout_ms, PROVIDER_WALL_CLOCK_MS);
    let result: ProviderResult;
    try {
      result = await provider.extract(built.prompt, EXTRACTION_SCHEMA_JSON, { timeoutMs, model: config.extraction.model, runId, episodeId: descriptor.id, paths, logger });
    } catch (error) {
      result = { status: "provider_error", raw: "", error: error instanceof Error ? error.message : String(error) };
    }
    let rawOutputRef: string | null = null;
    if (result.status === "ok") {
      try {
        const parsed = parseExtractionOutput(result.raw);
        rawOutputRef = parsed.ok ? writeRawCache(paths, runId, result.raw, undefined) : writeRawCache(paths, runId, result.raw, work.record.attemptCount);
        if (!parsed.ok) result = { ...result, status: "invalid_output", error: `${parsed.code}: ${parsed.detail}` };
      } catch (error) {
        logger.warn(`raw cache not written for ${runId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    } else if (result.raw.length > 0) {
      try {
        rawOutputRef = writeRawCache(paths, runId, result.raw, work.record.attemptCount);
      } catch {
        // best effort
      }
    }
    logger.line("provider", {
      episode: descriptor.id,
      run: runId,
      provider: provider.name,
      status: result.status,
      chars: built.prompt.length,
      ...(result.model === undefined ? {} : { model: result.model }),
      ...(result.costUsd === undefined ? {} : { cost_usd: result.costUsd }),
    });
    extracted.push({ work, descriptor, runId, seqMap: built.seqMap, run: { ...run, rawOutputRef, model: result.model ?? run.model }, result, fromCache: false, providerUnavailable: false });
  }

  return { extracted, probeResult };
}

// ---------------------------------------------------------------------------------------------
// Lock session 2 (D)
// ---------------------------------------------------------------------------------------------

export interface ReconcileSessionOptions {
  paths: HarnessPaths;
  config: HarnessConfig;
  logger: WorkerLogger;
  /** Written once per worker run after a fresh probe. */
  probeToCache: ProbeCache | null;
}

export function reconcileSession(db: SqlJsDatabase, ctx: WriteContext, item: ExtractedWork, options: ReconcileSessionOptions): WriteOp & { status: RunStatus; outcomes: number; created: string[]; activated: string[]; proposals: string[] } {
  const now = ctx.now;
  if (options.probeToCache !== null) writeProbeCache(db, options.probeToCache);

  if (item.result.status !== "ok") {
    const failure = recordExtractionFailure(db, {
      episodeId: item.descriptor.id,
      runId: item.runId,
      run: item.run,
      status: item.result.status,
      error: item.result.error ?? item.result.status,
      now,
      attemptCount: item.work.record.attemptCount,
      providerUnavailable: item.providerUnavailable,
    });
    options.logger.line("failed", { episode: item.descriptor.id, run: item.runId, status: item.result.status, disposition: failure.disposition, next: failure.nextAttemptAt });
    return { ...failure.op, status: item.result.status, outcomes: 0, created: [], activated: [], proposals: [] };
  }

  const repository = new MemoryRepository(db, { clock: () => now });
  const existingMemoryIds = new Set(repository.list({ status: LIVE_STATUSES }).map((memory) => memory.id));
  const validated = validateRawExtraction({
    raw: item.result.raw,
    descriptor: item.descriptor,
    seqMap: item.seqMap,
    existingMemoryIds,
    nowIso: now,
    correctionForEpisode: item.work.correctionFor === null ? null : { scope_refs: item.work.correctionFor.scopeRefs, tools: item.work.correctionFor.tools },
  });

  if (validated.suspect) {
    // Keep the original for inspection but never reuse it: retries call the provider again (§9.3 C).
    const main = rawFile(options.paths, item.runId);
    if (existsSync(main)) {
      try {
        renameSync(main, rawFile(options.paths, item.runId, item.work.record.attemptCount));
      } catch {
        rmSync(main, { force: true });
      }
    }
  }

  const op: ReconcileWriteOp = reconcileRun(db, {
    descriptor: item.descriptor,
    runId: item.runId,
    validated,
    ctx: {
      now,
      config: options.config,
      run: item.run,
      seqMap: item.seqMap,
      correctionForEpisode: item.work.correctionFor,
      paths: options.paths,
      alreadyApplied: ctx.alreadyApplied,
      logger: options.logger,
    },
  });
  options.logger.line("reconciled", {
    episode: item.descriptor.id,
    run: item.runId,
    status: op.report.status,
    facts: op.report.factsTotal,
    accepted: op.report.factsAccepted,
    created: op.report.created.length,
    activated: op.report.activated.length,
    proposals: op.report.proposals.length,
    noop: op.noop,
  });
  return { ...op, status: op.report.status, outcomes: op.report.outcomes.length, created: op.report.created, activated: op.report.activated, proposals: op.report.proposals };
}

// ---------------------------------------------------------------------------------------------
// The extract loop (B–E)
// ---------------------------------------------------------------------------------------------

interface LoopContext {
  options: WorkerOptions;
  provider: ExtractionProvider | null;
  logger: WorkerLogger;
  clock: () => string;
  result: WorkerResult;
  /** `result.processed` entries before this index were already offered to the embedding pass. */
  embedCursor: number;
}

function quarantineQueueFile(file: string, logger: WorkerLogger): void {
  try {
    renameSync(file, `${file}.bad`);
  } catch (error) {
    logger.warn(`queue file ${basename(file)} could not be quarantined (${error instanceof Error ? error.message : String(error)}); removed`);
    rmSync(file, { force: true });
  }
}

async function extractLoop(ctx: LoopContext): Promise<void> {
  const { options, logger, provider } = ctx;
  const maxLoops = options.maxLoops ?? MAX_LOOPS_PER_RUN;
  const dbLockWaitMs = options.dbLockWaitMs ?? DB_LOCK_WAIT_MS;
  let probeToCache: ProbeCache | null = null;

  for (let loop = 0; loop < maxLoops; loop += 1) {
    ctx.result.loops += 1;
    const queued = scanQueue(options.paths, logger);

    let lease!: LeaseSessionResult;
    await options.store.withWriteLock("extract:lease", dbLockWaitMs, (db, wctx) => {
      const session = leaseSession(db, wctx, queued, { config: options.config, provider, logger });
      lease = session;
      return session.op;
    });
    for (const entry of queued) {
      if (lease.rejected.includes(entry.file)) {
        quarantineQueueFile(entry.file, logger);
        continue;
      }
      try {
        rememberImportText(options.paths, entry.descriptor);
      } catch (error) {
        logger.warn(`import text for ${entry.descriptor.id} not kept: ${error instanceof Error ? error.message : String(error)}`);
      }
      rmSync(entry.file, { force: true });
    }
    ctx.result.inserted += lease.inserted;
    ctx.result.skipped.push(...lease.skipped);
    logger.line("lease", { loop, queued: queued.length, inserted: lease.inserted, fires: lease.rolledUp, leased: lease.leased.length, skipped: lease.skipped.length, rejected: lease.rejected.length, waiting: lease.waiting?.reason ?? null });
    if (lease.waiting !== null) ctx.result.waiting = lease.waiting;
    if (provider === null) break;
    if (lease.leased.length === 0) {
      // Only ineligible rows were leased this time and eligible ones are still due: lease again (R3).
      if (lease.skipped.length > 0 && lease.moreDue) continue;
      break;
    }

    const unlocked = await unlockedPhase(lease.leased, {
      paths: options.paths,
      config: options.config,
      provider,
      probe: { needed: lease.needProbe, cached: lease.probeCache },
      clock: ctx.clock,
      logger,
    });
    if (unlocked.probeResult !== null && unlocked.probeResult.cacheable) {
      probeToCache = { at: ctx.clock(), result: unlocked.probeResult.result, detail: unlocked.probeResult.detail };
    }

    for (const item of unlocked.extracted) {
      let processed: ProcessedEpisode | null = null;
      await options.store.withWriteLock("extract:reconcile", dbLockWaitMs, (db, wctx) => {
        const op = reconcileSession(db, wctx, item, { paths: options.paths, config: options.config, logger, probeToCache });
        probeToCache = null;
        processed = { episodeId: item.descriptor.id, runId: item.runId, status: op.status, fromCache: item.fromCache, op, outcomes: op.outcomes, created: op.created, activated: op.activated, proposals: op.proposals };
        return op;
      });
      if (processed !== null) ctx.result.processed.push(processed);
    }

    if (unlocked.probeResult !== null && unlocked.probeResult.result !== "ok") {
      ctx.result.waiting = { count: lease.leased.length, reason: unlocked.probeResult.result };
      break;
    }
    if (!lease.moreDue) break;
  }
}

// ---------------------------------------------------------------------------------------------
// runWorker
// ---------------------------------------------------------------------------------------------

/**
 * Post-extraction embedding pass (§4.8 dense leg): when the worker has an embedder and this run created rows,
 * embed them (plus up to EMBED_BACKLOG_PER_RUN older rows without a vector; `worker dream` drains the rest).
 * The rows are read and the model runs WITHOUT the database lock (§9.2: a lock session lasts seconds and never
 * wraps a model call); a short lock session then stores the vectors of rows whose text did not change meanwhile.
 * Failures are logged, never fatal.
 */
async function embedNewRows(ctx: LoopContext): Promise<void> {
  const embed = ctx.options.embed ?? null;
  if (embed === null) return;
  const fresh = ctx.result.processed.slice(ctx.embedCursor);
  ctx.embedCursor = ctx.result.processed.length;
  const createdIds = new Set(fresh.flatMap((item) => item.created));
  if (createdIds.size === 0) return;
  try {
    const items = await ctx.options.store.read((db) => selectEmbeddingBacklog(new MemoryRepository(db), { preferIds: createdIds, limit: EMBED_BACKLOG_PER_RUN }));
    if (items.length === 0) return;
    const computed = await embedBacklog(embed, items, ctx.logger);
    ctx.result.errors.push(...computed.errors);
    let embedded = 0;
    if (computed.vectors.size > 0) {
      const write = await ctx.options.store.withWriteLock("embed", ctx.options.dbLockWaitMs ?? DB_LOCK_WAIT_MS, (db) => {
        embedded = applyEmbeddings(new MemoryRepository(db), items, computed.vectors);
        return { id: null, kind: "embed", noop: embedded === 0, wrote: embedded > 0 };
      });
      if (write.snapshotBuilt) ctx.result.snapshotBuilt = true;
    }
    ctx.logger.line("embed", { selected: items.length, embedded, errors: computed.errors.length });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.result.errors.push(`embed: ${message}`);
    ctx.logger.warn(`embedding pass skipped: ${message}`);
  }
}

function queueHasDescriptors(paths: HarnessPaths): boolean {
  try {
    return readdirSync(paths.queueDir).some((name) => name.endsWith(".json"));
  } catch {
    return false;
  }
}

/** Commands whose run ends with the §9.3 E rescan of queue/ (`reindex` touches no episodes). */
const RESCAN_COMMANDS: ReadonlySet<WorkerCommand> = new Set<WorkerCommand>(["extract", "dream", "import"]);

function writePidFile(paths: HarnessPaths, pid: number): void {
  try {
    mkdirSync(paths.locksDir, { recursive: true });
    writeFileSync(paths.workerPid, String(pid), "utf8");
  } catch {
    // the ppid guard is best effort
  }
}

function removePidFile(paths: HarnessPaths, pid: number): void {
  try {
    if (readFileSync(paths.workerPid, "utf8").trim() === String(pid)) rmSync(paths.workerPid, { force: true });
  } catch {
    // already gone
  }
}

function readImportDescriptors(file: string): EpisodeDescriptor[] {
  const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
  const list = Array.isArray(parsed) ? parsed : [parsed];
  const descriptors: EpisodeDescriptor[] = [];
  for (const entry of list) {
    if (!isEpisodeDescriptor(entry)) throw new Error(`${file}: not an episode descriptor`);
    descriptors.push(entry);
  }
  return descriptors;
}

export async function runWorker(options: WorkerOptions): Promise<WorkerResult> {
  const logger = options.logger ?? silentWorkerLogger;
  const clock = options.clock ?? (() => new Date().toISOString());
  const pid = options.pid ?? process.pid;
  const result: WorkerResult = {
    command: options.command,
    exitCode: EXIT_OK,
    busy: false,
    loops: 0,
    inserted: 0,
    processed: [],
    skipped: [],
    waiting: null,
    dream: null,
    snapshotBuilt: false,
    errors: [],
  };

  const dirs = [options.paths.dir, options.paths.queueDir, options.paths.rawDir, options.paths.locksDir, options.paths.logsDir, options.paths.snapshotDir, options.paths.stateDir, options.paths.ledgerDir];
  for (const dir of dirs) mkdirSync(dir, { recursive: true });

  let provider: ExtractionProvider | null;
  try {
    provider = options.provider === undefined ? selectProvider(options.config, { paths: options.paths }) : options.provider;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    result.errors.push(message);
    result.exitCode = EXIT_ERROR;
    logger.error(`${options.command} failed: ${message}`);
    return result;
  }
  const loopCtx: LoopContext = { options, provider, logger, clock, result, embedCursor: 0 };

  // §9.3 A/E: a worker that finds worker.lock busy exits because the holder rescans queue/ after releasing it.
  // Round 0 runs the command; later rounds re-enter the extract loop for files queued while the lock was held.
  for (let round = 0; round <= MAX_RESCANS_PER_RUN; round += 1) {
    let lock: LockHandle;
    try {
      lock = await acquireDirLock(options.paths.workerLock, { purpose: `worker:${options.command}`, waitMs: round === 0 ? (options.workerLockWaitMs ?? WORKER_LOCK_WAIT_MS) : 0, now: clock });
    } catch (error) {
      if (!(error instanceof LockBusyError)) throw error;
      if (round === 0) {
        logger.line("busy", { lock: options.paths.workerLock });
        return { ...result, busy: true };
      }
      // Another worker took over between our release and the rescan; it scans the queue itself.
      logger.line("rescan_busy", { round });
      break;
    }
    writePidFile(options.paths, pid);
    logger.line(round === 0 ? "start" : "rescan", { command: options.command, pid, round });

    try {
      if (round > 0) {
        await extractLoop(loopCtx);
        await embedNewRows(loopCtx);
      } else {
        switch (options.command) {
          case "reindex": {
            const write = await options.store.rebuildSnapshot(options.dbLockWaitMs ?? DB_LOCK_WAIT_MS);
            result.snapshotBuilt = write.snapshotBuilt;
            break;
          }
          case "import": {
            const file = options.args?.[0];
            if (file === undefined) throw new Error("import needs a descriptor file");
            const descriptors = readImportDescriptors(file);
            for (const descriptor of descriptors) {
              const target = queueFile(options.paths, descriptor.id);
              const tmp = `${target}.tmp-${String(pid)}`;
              writeFileSync(tmp, JSON.stringify(descriptor), "utf8");
              renameSync(tmp, target);
            }
            logger.line("import", { file, descriptors: descriptors.length });
            await extractLoop(loopCtx);
            await embedNewRows(loopCtx);
            break;
          }
          case "extract": {
            await extractLoop(loopCtx);
            await embedNewRows(loopCtx);
            break;
          }
          case "dream": {
            await extractLoop(loopCtx);
            const write = await options.store.withWriteLock("dream", options.dbLockWaitMs ?? DB_LOCK_WAIT_MS, async (db, wctx) => {
              const op = await runDream(db, { paths: options.paths, config: options.config, now: wctx.now, embed: options.embed ?? null, logger });
              result.dream = op.report;
              return op;
            });
            result.snapshotBuilt = write.snapshotBuilt;
            logger.line("dream", {
              staled: result.dream?.staled.length ?? 0,
              rejected: result.dream?.rejectedCandidates.length ?? 0,
              expired: result.dream?.expiredProposals.length ?? 0,
              merges: result.dream?.mergeProposals.length ?? 0,
              idle: result.dream?.idleClosed.length ?? 0,
              errors: result.dream?.errors.length ?? 0,
            });
            break;
          }
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.errors.push(message);
      result.exitCode = error instanceof LockBusyError ? EXIT_LOCK_BUSY : EXIT_ERROR;
      logger.error(`${options.command} failed: ${message}`);
    } finally {
      removePidFile(options.paths, pid);
      lock.release();
      logger.line("end", { command: options.command, exit: result.exitCode, processed: result.processed.length, errors: result.errors.length, round });
    }

    if (result.exitCode !== EXIT_OK || !RESCAN_COMMANDS.has(options.command) || !queueHasDescriptors(options.paths)) break;
  }
  return result;
}

/** sha256 of a prompt (exposed for tests comparing `extraction_runs.prompt_sha256`). */
export function promptDigest(prompt: string): string {
  return createHash("sha256").update(prompt, "utf8").digest("hex");
}
