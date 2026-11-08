/**
 * worker — `extract | dream | reindex | import <descriptor-file>` (spec §5.4, §9.3 A–E, §9.4 F3).
 *
 *   A  worker.lock (one per repository, 5 s jittered wait; busy → exit quietly, the holder rescans in E)
 *   B  lock session 1 (≤ 1 s): queue/*.json → episodes INSERT OR IGNORE, fire roll-up only for newly inserted
 *      episodes, expired leases / due retries back to queued, daily cap (corrections excluded), probe cache,
 *      lease ≤ 3 episodes correction-first, prompt inputs (intersecting memories, live ids, corrected episode)
 *   C  no lock: raw/<run_id>.json (V1-valid) is reused, else probe (daily) → provider (≤ 120 s) → raw cache
 *   D  lock session 2 (≤ 2 s): write_ops(run_id) → extracted; else V1–V11 → reconcile → commit (§9.2)
 *   E  queue files deleted; loop ≤ 10 times while eligible episodes remain; worker.lock released
 *
 * `reindex` only rebuilds the snapshot; `dream` empties the queue first and then runs consolidate (§5.8);
 * `import` copies the given descriptor(s) into queue/ and runs the extract loop.
 */

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

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
import { LIVE_STATUSES, type ProbeResult, type RunStatus } from "../core/vocabulary";
import { acquireDirLock, type LockHandle } from "../db/locks";
import { runPostMigrate } from "../db/post-migrate";
import { EpisodeRepository, episodeRecordToDescriptor, type EpisodeRecord } from "../db/repositories/episodes";
import { ExtractionRunRepository } from "../db/repositories/runs";
import { buildSnapshot } from "../db/snapshot";
import { selectOne } from "../db/sql";
import { Store, type StoreHooks, type StoreLogger, type WriteContext, type WriteOp } from "../db/store";
import { MemoryNotFoundError, MemoryRepository } from "../memory/repository";
import { derivePolicyRules } from "../policy/derive";
import { backfillEmbeddingsOp, runDream, type DreamReport, type EmbedFn } from "./consolidate";
import { isEligibleForExtraction } from "./episode";
import { buildExtractionPrompt, type PromptMemory } from "./extract/prompt";
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

export function isEpisodeDescriptor(value: unknown): value is EpisodeDescriptor {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record.schema === EPISODE_SCHEMA &&
    typeof record.id === "string" &&
    typeof record.host === "string" &&
    typeof record.session_id === "string" &&
    typeof record.turn_key === "string" &&
    typeof record.closed_at === "string" &&
    typeof record.ledger_ref === "string" &&
    Array.isArray(record.scope_refs) &&
    Array.isArray(record.tools) &&
    typeof record.flags === "object" &&
    record.flags !== null
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
  let wrote = false;
  let inserted = 0;
  let rolledUp = 0;

  for (const entry of queued) {
    queuedById.set(entry.descriptor.id, entry.descriptor);
    if (episodes.insertIfAbsent(entry.descriptor, now)) {
      inserted += 1;
      wrote = true;
      rolledUp += rollUpFires(repository, entry.descriptor);
    }
  }
  if (episodes.releaseExpiredLeases(now) > 0) wrote = true;
  if (episodes.requeueDueFailures(now) > 0) wrote = true;

  const result: LeaseSessionResult = { inserted, rolledUp, leased: [], skipped: [], moreDue: false, probeCache: null, needProbe: false, waiting: null };
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
  const take = Math.min(LEASE_BATCH, due.corrections + Math.min(due.plain, remainingDaily));
  if (take === 0) {
    if (due.plain > 0 && remainingDaily === 0) result.waiting = { count: due.plain, reason: "daily_cap" };
    return { ...result, op: { id: null, kind: "extract:lease", noop: true, wrote } };
  }

  const leased = episodes.lease(take, { leaseSeconds: config.extraction.lease_seconds, now, correctionFirst: true });
  if (leased.length > 0) wrote = true;

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

/** Reads the byte range named by `ledger_ref`; import episodes synthesize a prompt line from the source file / queue descriptor. */
export function readEpisodeLines(paths: HarnessPaths, record: EpisodeRecord, queued: EpisodeDescriptor | null): EpisodeLines {
  const ledgerMatch = LEDGER_REF.exec(record.ledgerRef);
  if (ledgerMatch !== null) {
    const file = join(paths.ledgerDir, basename(ledgerMatch[1]!));
    const parsed = readLedgerRangeLines(file, Number(ledgerMatch[2]), Number(ledgerMatch[3]));
    return { lines: parsed.lines, badLines: parsed.badLines };
  }
  let text = queued?.prompt_text ?? null;
  const importMatch = IMPORT_REF.exec(record.ledgerRef);
  if (text === null && importMatch !== null) {
    try {
      const content = readFileSync(importMatch[1]!, "utf8");
      if (importMatch[2] !== undefined) {
        const lineNo = Number(importMatch[2]);
        text = content.split(/\r?\n/)[lineNo - 1] ?? null;
      } else {
        text = content;
      }
    } catch {
      text = null;
    }
  }
  if (text === null) return { lines: [], badLines: 0 };
  return {
    lines: [{ kind: "prompt", ts: record.startedAt, seq: 1, turn_key: record.turnKey, text, correction: record.flags.correction ?? 0, remember: record.flags.remember ?? 0 }],
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
  probeResult: { result: ProbeResult; cacheable: boolean } | null;
}

/** Phase C for one lease batch: prompt → raw cache or probe + provider → raw cache. */
export async function unlockedPhase(batch: readonly LeasedWork[], options: UnlockedPhaseOptions): Promise<UnlockedPhaseResult> {
  const { paths, config, provider, logger } = options;
  const extracted: ExtractedWork[] = [];
  let probeResult: { result: ProbeResult; cacheable: boolean } | null = null;
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

    // Raw cache reuse (V1-valid only).
    const cached = rawFile(paths, runId);
    if (existsSync(cached)) {
      try {
        const raw = readFileSync(cached, "utf8");
        if (parseExtractionOutput(raw).ok) {
          extracted.push({ work, descriptor, runId, seqMap: built.seqMap, run: { ...run, rawOutputRef: `raw/${basename(cached)}` }, result: { status: "ok", raw, model: "cache" }, fromCache: true });
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
      probeResult = { result: probe.result, cacheable: probe.cacheable };
      logger.line("probe", { provider: provider.name, result: probe.result, cached: probe.fromCache });
    }
    if (probeResult !== null && probeResult.result !== "ok") {
      const status = probeFailureStatus(probeResult.result);
      extracted.push({ work, descriptor, runId, seqMap: built.seqMap, run, result: { status, raw: "", error: `probe: ${probeResult.result}` }, fromCache: false });
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
    logger.line("provider", { episode: descriptor.id, run: runId, provider: provider.name, status: result.status, chars: built.prompt.length });
    extracted.push({ work, descriptor, runId, seqMap: built.seqMap, run: { ...run, rawOutputRef, model: result.model ?? run.model }, result, fromCache: false });
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
}

async function extractLoop(ctx: LoopContext): Promise<void> {
  const { options, logger, provider } = ctx;
  const maxLoops = options.maxLoops ?? MAX_LOOPS_PER_RUN;
  const dbLockWaitMs = options.dbLockWaitMs ?? DB_LOCK_WAIT_MS;
  let probeToCache: ProbeCache | null = null;

  for (let loop = 0; loop < maxLoops; loop += 1) {
    ctx.result.loops = loop + 1;
    const queued = scanQueue(options.paths, logger);

    let lease!: LeaseSessionResult;
    await options.store.withWriteLock("extract:lease", dbLockWaitMs, (db, wctx) => {
      const session = leaseSession(db, wctx, queued, { config: options.config, provider, logger });
      lease = session;
      return session.op;
    });
    for (const entry of queued) rmSync(entry.file, { force: true });
    ctx.result.inserted += lease.inserted;
    ctx.result.skipped.push(...lease.skipped);
    logger.line("lease", { loop, queued: queued.length, inserted: lease.inserted, fires: lease.rolledUp, leased: lease.leased.length, skipped: lease.skipped.length, waiting: lease.waiting?.reason ?? null });
    if (lease.waiting !== null) ctx.result.waiting = lease.waiting;
    if (lease.leased.length === 0 || provider === null) break;

    const unlocked = await unlockedPhase(lease.leased, {
      paths: options.paths,
      config: options.config,
      provider,
      probe: { needed: lease.needProbe, cached: lease.probeCache },
      clock: ctx.clock,
      logger,
    });
    if (unlocked.probeResult !== null && unlocked.probeResult.cacheable) {
      probeToCache = { at: ctx.clock(), result: unlocked.probeResult.result };
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
 * embed every live row that still lacks a vector in its own lock session. The embedder is warmed with an empty
 * batch first so the database lock is not held while the model loads. Failures are logged, never fatal.
 */
async function embedNewRows(ctx: LoopContext): Promise<void> {
  const embed = ctx.options.embed ?? null;
  if (embed === null) return;
  const created = ctx.result.processed.reduce((count, item) => count + item.created.length, 0);
  if (created === 0) return;
  try {
    await embed([]);
    let embedded = 0;
    let errors: string[] = [];
    const write = await ctx.options.store.withWriteLock("embed", ctx.options.dbLockWaitMs ?? DB_LOCK_WAIT_MS, async (db) => {
      const op = await backfillEmbeddingsOp(db, { embed, logger: ctx.logger });
      embedded = op.result.embedded;
      errors = op.result.errors;
      return op;
    });
    if (write.snapshotBuilt) ctx.result.snapshotBuilt = true;
    ctx.result.errors.push(...errors);
    ctx.logger.line("embed", { embedded, errors: errors.length });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.result.errors.push(`embed: ${message}`);
    ctx.logger.warn(`embedding pass skipped: ${message}`);
  }
}

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

  let lock: LockHandle;
  try {
    lock = await acquireDirLock(options.paths.workerLock, { purpose: `worker:${options.command}`, waitMs: options.workerLockWaitMs ?? WORKER_LOCK_WAIT_MS, now: clock });
  } catch (error) {
    if (error instanceof LockBusyError) {
      logger.line("busy", { lock: options.paths.workerLock });
      return { ...result, busy: true };
    }
    throw error;
  }
  writePidFile(options.paths, pid);
  logger.line("start", { command: options.command, pid });

  try {
    const provider = options.provider === undefined ? selectProvider(options.config, { paths: options.paths }) : options.provider;
    const loopCtx: LoopContext = { options, provider, logger, clock, result };

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
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    result.errors.push(message);
    result.exitCode = error instanceof LockBusyError ? EXIT_LOCK_BUSY : EXIT_ERROR;
    logger.error(`${options.command} failed: ${message}`);
  } finally {
    removePidFile(options.paths, pid);
    lock.release();
    logger.line("end", { command: options.command, exit: result.exitCode, processed: result.processed.length, errors: result.errors.length });
  }
  return result;
}

/** sha256 of a prompt (exposed for tests comparing `extraction_runs.prompt_sha256`). */
export function promptDigest(prompt: string): string {
  return createHash("sha256").update(prompt, "utf8").digest("hex");
}
