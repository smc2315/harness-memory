/**
 * `ScenarioRun`: one replay scenario's world — a temporary `.harness-memory/` with a real database,
 * config and snapshot (written through the same `Store` the worker and CLI use), the real hook entry
 * (`main()` from src/hook.ts, synthetic Claude Code stdin, injected clock, captured worker spawns) and
 * the real worker (`runWorker`) with the replay provider answering from recorded extractor outputs.
 *
 * Scenarios call the driver methods and record checks; nothing here depends on vitest so the same code
 * backs `hm eval:replay` and test/eval-replay.test.ts.
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database as SqlJsDatabase } from "sql.js";

import { CLAUDE_CODE_EVENT_NAMES } from "../../adapters/hosts/claude-code";
import { readSessionState } from "../../adapters/session-state";
import { renderSqlDump } from "../../cli/lib/export";
import { DEFAULT_CONFIG, mergeConfig, type HarnessConfig } from "../../core/config";
import type { EpisodeDescriptor } from "../../core/episode-types";
import type { ClaudeCodeHookStdin, HookStdout } from "../../core/hook-types";
import type { LedgerLine, SessionState } from "../../core/ledger-types";
import { ledgerFile, queueFile, resolvePaths, sessionKey, stateDirectories, stateFile, type HarnessPaths } from "../../core/paths";
import type { HookEvent } from "../../core/vocabulary";
import type { ReadContext, Store, WriteContext, WriteOp } from "../../db/store";
import { buildExtractionPrompt } from "../../dream/extract/prompt";
import { createReplayProvider, type ReplayAnswer } from "../../dream/extract/providers/replay";
import { readLedgerRangeLines, type OffsetLedgerLine } from "../../dream/ledger";
import { composeStore, runWorker, silentWorkerLogger, type WorkerResult } from "../../dream/worker";
import { main } from "../../hook";
import { MemoryRepository, type CreateMemoryInput, type MemoryRecord } from "../../memory/repository";
import { loadLedgerFixture, loadRecordedOutputs, materializeOutput, refResolver, turnKeysOf, turnLines, type RecordedOutputs } from "./fixtures";
import { compareLedgerLines, scriptTurn } from "./ledger-script";
import type { HookCall, ReplayCheck, TurnRecord } from "./types";

export const REPLAY_T0 = "2026-11-08T10:00:00.000Z";

export interface ScenarioRunOptions {
  scenarioId: string;
  fixturesDir: string;
  /** Partial config.json overrides (merged over the defaults). */
  config?: unknown;
  /** Clock at the start of the scenario (ISO). */
  startAt?: string;
  /** Keep the temp project after the run (printed in the report). */
  keep?: boolean;
  /** Where to create the temp project (default os.tmpdir()). */
  tmpRoot?: string;
  log?: (line: string) => void;
}

export interface ToolCallInput {
  /** Claude Code tool name (`Bash`, `PowerShell`, `Write`, `Edit`, `Read`, `WebFetch`, `mcp__s__t`, …). */
  tool: string;
  /** Bash / PowerShell command. */
  command?: string;
  /** Repository-relative path for Write / Edit / Read (joined onto the project root). */
  path?: string;
  url?: string;
  input?: Record<string, unknown>;
  toolUseId?: string;
  permissionMode?: string;
  /** PostToolUse response text. */
  response?: string;
  /** PostToolUseFailure error text (first line `Exit code N` yields the exit code). */
  error?: string;
  isInterrupt?: boolean;
  at?: string;
}

export interface TurnOptions {
  /** Turn key inside the fixture file (default: the first one). */
  turnKey?: string;
  at?: string;
  /** Compare the fixture's fired lines too (requires seeded memories with the fixture's ids). */
  compareFired?: boolean;
  /** Skip the SessionStart even when the fixture carries a session_start marker. */
  skipSessionStart?: boolean;
}

export interface ExtractOptions {
  at?: string;
  /** Recorded outputs: a `sNN.outputs.json` name or an inline map keyed `<session>/<turn_key>`. */
  outputs?: string | RecordedOutputs;
  /** Extra answers keyed by episode id (already materialized). */
  answers?: Record<string, ReplayAnswer>;
}

export interface DbExport {
  dump: string;
  bytes: Buffer;
}

const SECOND_MS = 1000;

function parseLedgerRef(ref: string): { start: number; end: number } | null {
  const match = /#(\d+)-(\d+)$/.exec(ref);
  if (match === null) return null;
  return { start: Number(match[1]), end: Number(match[2]) };
}

export class ScenarioRun {
  readonly scenarioId: string;
  readonly fixturesDir: string;
  readonly root: string;
  readonly paths: HarnessPaths;
  readonly config: HarnessConfig;
  readonly checks: ReplayCheck[] = [];
  readonly hookCalls: HookCall[] = [];
  readonly workerRuns: WorkerResult[] = [];
  readonly turns = new Map<string, TurnRecord>();
  /** `<session>/<turn_key>` → memory ids created by the extract step that processed the turn. */
  readonly created = new Map<string, string[]>();
  private readonly turnByEpisode = new Map<string, string>();
  private readonly startedSessions = new Set<string>();
  private readonly store: Store;
  private readonly keep: boolean;
  private readonly log: (line: string) => void;
  private clockIso: string;
  private toolUseCounter = 0;

  constructor(options: ScenarioRunOptions) {
    this.scenarioId = options.scenarioId;
    this.fixturesDir = options.fixturesDir;
    this.keep = options.keep === true;
    this.log = options.log ?? (() => undefined);
    this.clockIso = options.startAt ?? REPLAY_T0;
    this.root = mkdtempSync(join(options.tmpRoot ?? tmpdir(), `hm-replay-${options.scenarioId}-`));
    this.paths = resolvePaths(this.root);
    for (const dir of stateDirectories(this.paths)) mkdirSync(dir, { recursive: true });
    this.config = mergeConfig(DEFAULT_CONFIG, options.config);
    writeFileSync(this.paths.config, JSON.stringify(this.config, null, 2), "utf8");
    this.store = composeStore({ paths: this.paths, config: this.config, logger: silentWorkerLogger, clock: () => this.clockIso });
  }

  // -------------------------------------------------------------------------------------------
  // Clock
  // -------------------------------------------------------------------------------------------

  now(): string {
    return this.clockIso;
  }

  nowMs(): number {
    return Date.parse(this.clockIso);
  }

  /** Moves the injected clock; never backwards (ledger seqs stay monotonic). */
  at(iso: string): void {
    if (Date.parse(iso) < this.nowMs()) throw new Error(`${this.scenarioId}: clock would move backwards (${this.clockIso} → ${iso})`);
    this.clockIso = iso;
  }

  advance(offset: { seconds?: number; minutes?: number; hours?: number; days?: number }): string {
    const ms = (offset.seconds ?? 0) * SECOND_MS + (offset.minutes ?? 0) * 60 * SECOND_MS + (offset.hours ?? 0) * 3600 * SECOND_MS + (offset.days ?? 0) * 86_400 * SECOND_MS;
    this.clockIso = new Date(this.nowMs() + ms).toISOString();
    return this.clockIso;
  }

  private tick(): void {
    this.advance({ seconds: 1 });
  }

  // -------------------------------------------------------------------------------------------
  // Checks
  // -------------------------------------------------------------------------------------------

  check(name: string, ok: boolean, detail?: string): boolean {
    this.checks.push(detail === undefined ? { name, ok } : { name, ok, detail });
    if (!ok) this.log(`  FAIL ${name}${detail === undefined ? "" : ` — ${detail}`}`);
    return ok;
  }

  equal<T>(name: string, actual: T, expected: T): boolean {
    const left = JSON.stringify(actual);
    const right = JSON.stringify(expected);
    return this.check(name, left === right, left === right ? undefined : `expected ${right}, got ${left}`);
  }

  fail(name: string, detail: string): false {
    this.check(name, false, detail);
    return false;
  }

  get failed(): ReplayCheck[] {
    return this.checks.filter((check) => !check.ok);
  }

  // -------------------------------------------------------------------------------------------
  // Database
  // -------------------------------------------------------------------------------------------

  /** Creates rows through the Store (derived rules, generation bump and snapshot included). */
  async seed(rows: readonly CreateMemoryInput[], options: { at?: string } = {}): Promise<MemoryRecord[]> {
    if (options.at !== undefined) this.at(options.at);
    const created: MemoryRecord[] = [];
    await this.store.withWriteLock("eval:seed", 5_000, (db) => {
      const repository = new MemoryRepository(db, { clock: () => this.clockIso });
      for (const row of rows) created.push(repository.create(row));
      return { id: null, kind: "eval:seed", noop: false, wrote: true };
    });
    this.tick();
    return created;
  }

  /** Arbitrary write through the Store (the callback returns the WriteOp like any writer). */
  async write(purpose: string, fn: (db: SqlJsDatabase, ctx: WriteContext) => WriteOp | Promise<WriteOp>, options: { at?: string } = {}): Promise<void> {
    if (options.at !== undefined) this.at(options.at);
    await this.store.withWriteLock(purpose, 5_000, fn);
    this.tick();
  }

  read<T>(fn: (db: SqlJsDatabase, ctx: ReadContext) => T): Promise<T> {
    return this.store.read((db, ctx) => fn(db, ctx));
  }

  memory(id: string): Promise<MemoryRecord | null> {
    return this.read((db) => new MemoryRepository(db).getById(id));
  }

  memories(filter: Parameters<MemoryRepository["list"]>[0] = {}): Promise<MemoryRecord[]> {
    return this.read((db) => new MemoryRepository(db).list(filter));
  }

  /** Deterministic SQL dump (§13.2 (d)) plus the raw file bytes. */
  async export(): Promise<DbExport> {
    const dump = await this.read((db) => renderSqlDump(db));
    return { dump, bytes: readFileSync(this.paths.db) };
  }

  // -------------------------------------------------------------------------------------------
  // Hooks (real entry point, in-process)
  // -------------------------------------------------------------------------------------------

  sessionId(session: string): string {
    return `${this.scenarioId}-${session}`;
  }

  ledgerPath(session: string): string {
    return ledgerFile(this.paths, "claude-code", sessionKey("claude-code", this.sessionId(session)));
  }

  state(session: string): SessionState | null {
    return readSessionState(stateFile(this.paths, "claude-code", sessionKey("claude-code", this.sessionId(session))));
  }

  ledgerLines(session: string): OffsetLedgerLine[] {
    const file = this.ledgerPath(session);
    if (!existsSync(file)) return [];
    return readLedgerRangeLines(file, 0, Number.MAX_SAFE_INTEGER).lines;
  }

  async hook(event: HookEvent, session: string, stdin: Partial<ClaudeCodeHookStdin> = {}, options: { at?: string } = {}): Promise<HookCall> {
    if (options.at !== undefined) this.at(options.at);
    const full: ClaudeCodeHookStdin = {
      session_id: this.sessionId(session),
      transcript_path: join(this.root, "transcript.jsonl"),
      cwd: this.root,
      hook_event_name: CLAUDE_CODE_EVENT_NAMES[event],
      permission_mode: "default",
      ...stdin,
    };
    const printed: Array<HookStdout | null> = [];
    const spawned: string[] = [];
    const outcome = await main([event], {
      readStdin: async () => JSON.stringify(full),
      writeStdout: (output) => {
        printed.push(output);
      },
      env: {},
      cwd: () => this.root,
      clock: () => this.clockIso,
      spawnWorker: (command) => {
        spawned.push(command);
        return 4242;
      },
      dense: null,
    });
    if (event === "session-start") this.startedSessions.add(session);
    const call: HookCall = { event, session, at: this.clockIso, stdin: full, stdout: outcome.stdout, result: outcome.result, spawned };
    this.hookCalls.push(call);
    this.tick();
    return call;
  }

  sessionStart(session: string, options: { source?: string; at?: string } = {}): Promise<HookCall> {
    return this.hook("session-start", session, { source: options.source ?? "startup" }, { at: options.at });
  }

  prompt(session: string, text: string, options: { promptId: string; at?: string }): Promise<HookCall> {
    return this.hook("prompt", session, { prompt: text, prompt_id: options.promptId }, { at: options.at });
  }

  private toolStdin(call: ToolCallInput): Partial<ClaudeCodeHookStdin> {
    let input: Record<string, unknown>;
    if (call.input !== undefined) input = call.input;
    else if (call.command !== undefined) input = { command: call.command, description: "replay" };
    else if (call.path !== undefined) input = { file_path: join(this.root, ...call.path.split("/")), content: "" };
    else if (call.url !== undefined) input = { url: call.url };
    else input = {};
    this.toolUseCounter += 1;
    return {
      tool_name: call.tool,
      tool_input: input,
      tool_use_id: call.toolUseId ?? `tu-${this.scenarioId}-${String(this.toolUseCounter)}`,
      ...(call.permissionMode !== undefined ? { permission_mode: call.permissionMode } : {}),
    };
  }

  preTool(session: string, call: ToolCallInput): Promise<HookCall> {
    return this.hook("pre-tool", session, this.toolStdin(call), { at: call.at });
  }

  /** PostToolUse, or PostToolUseFailure when `error` is given. */
  postTool(session: string, call: ToolCallInput): Promise<HookCall> {
    const stdin = this.toolStdin(call);
    if (call.error !== undefined) {
      return this.hook("post-tool-failure", session, { ...stdin, tool_response: call.response ?? "", error: call.error, is_interrupt: call.isInterrupt === true }, { at: call.at });
    }
    return this.hook("post-tool", session, { ...stdin, tool_response: call.response ?? "" }, { at: call.at });
  }

  stop(session: string, lastAssistantMessage: string, options: { at?: string; stopHookActive?: boolean } = {}): Promise<HookCall> {
    return this.hook("stop", session, { last_assistant_message: lastAssistantMessage, ...(options.stopHookActive === true ? { stop_hook_active: true } : {}) }, { at: options.at });
  }

  /**
   * Replays one fixture turn through the hooks: the fixture's lines become the stdin script, the Stop
   * closes the segment, and the hooks' own ledger is compared with the fixture (capture regression).
   */
  async turn(session: string, fixtureName: string, options: TurnOptions = {}): Promise<TurnRecord> {
    if (options.at !== undefined) this.at(options.at);
    const fixture = loadLedgerFixture(this.fixturesDir, fixtureName);
    const keys = turnKeysOf(fixture.lines);
    const turnKey = options.turnKey ?? keys[0];
    if (turnKey === undefined) throw new Error(`${fixtureName}: no turn in the fixture`);
    const lines = turnLines(fixture.lines, turnKey);
    if (lines.length === 0) throw new Error(`${fixtureName}: no lines for turn ${turnKey}`);

    const calls: HookCall[] = [];
    const startMarker = fixture.lines.find((line) => line.kind === "marker" && line.marker === "session_start" && line.turn_key === "");
    if (startMarker !== undefined && startMarker.kind === "marker" && options.skipSessionStart !== true && !this.startedSessions.has(session)) {
      calls.push(await this.sessionStart(session, { source: startMarker.detail ?? "startup" }));
    }
    for (const event of scriptTurn(lines, { root: this.root })) {
      calls.push(await this.hook(event.event, session, event.stdin));
    }

    const close = [...calls].reverse().find((call) => call.event === "stop" || call.event === "precompact" || call.event === "session-end");
    const episodeId = close?.result?.episodeId ?? null;
    const descriptor = episodeId === null ? null : this.readQueue(episodeId);
    let produced: OffsetLedgerLine[];
    const range = descriptor === null ? null : parseLedgerRef(descriptor.ledger_ref);
    if (range !== null) {
      produced = readLedgerRangeLines(this.ledgerPath(session), range.start, range.end).lines;
    } else {
      produced = this.ledgerLines(session).filter((line) => line.turn_key === turnKey);
    }
    const comparison = compareLedgerLines(lines, produced, { compareFired: options.compareFired });
    // The event ids the extractor must cite are whatever the real prompt builder renders for these lines.
    const refMap = new Map<number, string>();
    if (descriptor !== null) {
      const built = buildExtractionPrompt({ descriptor, lines: produced, existingMemories: [] });
      for (const [ref, line] of built.seqMap) refMap.set(line.seq, ref);
    }
    const record: TurnRecord = {
      session,
      turnKey,
      fixture: fixtureName,
      fixtureLines: lines,
      producedLines: produced,
      episodeId,
      descriptor,
      seqMap: comparison.seqMap,
      refMap,
      calls,
      mismatches: comparison.mismatches,
    };
    this.turns.set(this.turnId(session, turnKey), record);
    if (episodeId !== null) this.turnByEpisode.set(episodeId, this.turnId(session, turnKey));
    return record;
  }

  turnId(session: string, turnKey: string): string {
    return `${session}/${turnKey}`;
  }

  /** Common checks after a replayed turn: every hook call ok, the ledger reproduced, an episode queued. */
  checkTurn(record: TurnRecord, options: { expectEpisode?: boolean; label?: string } = {}): void {
    const label = options.label ?? record.fixture;
    const bad = record.calls.filter((call) => call.result === null || call.result.status.startsWith("error:") || call.result.status === "bad_stdin");
    this.check(`${label}: every hook call completed without error`, bad.length === 0, bad.map((call) => `${call.event}:${call.result?.status ?? "null"}`).join(", "));
    this.check(`${label}: hooks reproduced the recorded ledger`, record.mismatches.length === 0, record.mismatches.join(" | "));
    if (options.expectEpisode !== false) {
      this.check(`${label}: stop closed the segment into queue/<id>.json`, record.episodeId !== null && record.descriptor !== null, `episodeId=${String(record.episodeId)}`);
    }
  }

  // -------------------------------------------------------------------------------------------
  // Queue files
  // -------------------------------------------------------------------------------------------

  readQueue(episodeId: string): EpisodeDescriptor | null {
    const file = queueFile(this.paths, episodeId);
    if (!existsSync(file)) return null;
    return JSON.parse(readFileSync(file, "utf8")) as EpisodeDescriptor;
  }

  queueFiles(): string[] {
    try {
      return readdirSync(this.paths.queueDir)
        .filter((name) => name.endsWith(".json"))
        .sort();
    } catch {
      return [];
    }
  }

  /** Puts a descriptor back into the queue (the worker deletes queue files after lock session 1). */
  requeue(descriptor: EpisodeDescriptor): void {
    writeFileSync(queueFile(this.paths, descriptor.id), JSON.stringify(descriptor), "utf8");
  }

  // -------------------------------------------------------------------------------------------
  // Worker (real pipeline, replay provider)
  // -------------------------------------------------------------------------------------------

  async extract(options: ExtractOptions = {}): Promise<WorkerResult> {
    if (options.at !== undefined) this.at(options.at);
    const answers: Record<string, ReplayAnswer> = { ...(options.answers ?? {}) };
    const recorded: RecordedOutputs = typeof options.outputs === "string" ? loadRecordedOutputs(this.fixturesDir, options.outputs) : (options.outputs ?? {});
    for (const [key, output] of Object.entries(recorded)) {
      const turn = this.turns.get(key);
      // A recorded-outputs file holds every turn of the scenario; turns not replayed yet are simply not answered.
      if (turn === undefined) continue;
      if (turn.episodeId === null) {
        this.fail(`extract: recorded output for ${key}`, "the turn produced no episode");
        continue;
      }
      answers[turn.episodeId] = materializeOutput(output, { refOf: refResolver(turn.seqMap, turn.refMap), created: this.created });
    }
    const provider = createReplayProvider({ answers, missingStatus: "no_provider" });
    const result = await runWorker({
      paths: this.paths,
      config: this.config,
      store: this.store,
      command: "extract",
      provider,
      clock: () => this.clockIso,
      logger: silentWorkerLogger,
      workerLockWaitMs: 500,
      dbLockWaitMs: 10_000,
    });
    this.workerRuns.push(result);
    for (const processed of result.processed) {
      const key = this.turnByEpisode.get(processed.episodeId);
      if (key !== undefined && (processed.created.length > 0 || !this.created.has(key))) this.created.set(key, processed.created);
    }
    this.tick();
    return result;
  }

  /** `worker dream` (empties the queue with the replay provider first, then consolidates). */
  async dream(options: { at?: string } = {}): Promise<WorkerResult> {
    if (options.at !== undefined) this.at(options.at);
    const result = await runWorker({
      paths: this.paths,
      config: this.config,
      store: this.store,
      command: "dream",
      provider: createReplayProvider({ missingStatus: "no_provider" }),
      clock: () => this.clockIso,
      logger: silentWorkerLogger,
      workerLockWaitMs: 500,
      dbLockWaitMs: 10_000,
    });
    this.workerRuns.push(result);
    this.tick();
    return result;
  }

  /** Common checks after a worker run. */
  checkWorker(result: WorkerResult, label: string, options: { processed?: number; statuses?: readonly string[] } = {}): void {
    this.check(`${label}: worker exit 0 without errors`, result.exitCode === 0 && result.errors.length === 0, `exit=${String(result.exitCode)} errors=${result.errors.join("; ")}`);
    // Cross-module contract: a run whose every fact was rejected as `schema` on evidence_refs means the prompt's
    // event ids are not accepted by the schema (see preflight.ts) — name it once instead of failing every check downstream.
    for (const processed of result.processed) {
      const outcomes = (processed.op as { report?: { outcomes?: Array<{ outcome: string; rejection?: string; detail?: string }> } }).report?.outcomes ?? [];
      const refRejects = outcomes.filter((outcome) => outcome.outcome === "rejected" && outcome.rejection === "schema" && (outcome.detail ?? "").includes("evidence_refs"));
      if (refRejects.length > 0 && refRejects.length === outcomes.length) {
        this.fail(`${label}: PIPELINE DEFECT extraction event ids`, `all ${String(outcomes.length)} fact(s) of episode ${processed.episodeId} rejected on evidence_refs: the prompt renders raw 16-digit ledger seqs while the schema accepts ^e[0-9]{1,4}$ (see src/eval/replay/preflight.ts)`);
      }
    }
    if (options.processed !== undefined) {
      this.equal(`${label}: processed ${String(options.processed)} episode(s)`, result.processed.length, options.processed);
    }
    if (options.statuses !== undefined) {
      this.equal(`${label}: run statuses`, result.processed.map((entry) => entry.status), [...options.statuses]);
    }
  }

  createdFor(session: string, turnKey: string): string[] {
    return this.created.get(this.turnId(session, turnKey)) ?? [];
  }

  // -------------------------------------------------------------------------------------------
  // Teardown
  // -------------------------------------------------------------------------------------------

  cleanup(): void {
    if (this.keep) return;
    try {
      rmSync(this.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
      // a lingering handle on Windows; the temp directory is reclaimed by the OS
    }
  }
}

/** Fixture lines helper re-exported for scenario code that needs raw lines (e.g. padding a ledger). */
export { loadLedgerFixture, turnLines } from "./fixtures";
export type { LedgerLine };
