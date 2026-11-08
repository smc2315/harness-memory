/**
 * Host-neutral hook core (spec §5.1–5.2 capture, §6 read path, §8.2 event table, §9.1, §9.4 F2/F4/F7).
 *
 * `runHook(event, input, runtime)` never throws: every handler runs inside a catch that turns the
 * failure into `status: error:<code>` and an empty result. Hooks never open SQLite; they read the
 * snapshot files, append to the session ledger, write the state / queue files owned by the
 * host-serialized events, and spawn the detached worker through the injected `spawnWorker`.
 */

import { basename } from "node:path";
import { readFileSync, statSync } from "node:fs";

import { selectAfterToolHints } from "../activation/after-tool";
import { activateBeforeModel, type DenseClient } from "../activation/before-model";
import { decideBeforeTool } from "../activation/before-tool";
import type { InjectedItem } from "../activation/injection";
import { buildDigestMessage, selectSessionStartItems } from "../activation/session-start";
import {
  defaultSpawnWorker,
  readActiveSnapshot,
  readLexicalSnapshot,
  type LoadedSnapshot,
  type SpawnWorkerFn,
} from "../activation/snapshot-reader";
import { pickTarget, type PickedTarget } from "../activation/tool-vocabulary";
import type { HarnessConfig } from "../core/config";
import type { EpisodeDescriptor } from "../core/episode-types";
import type { HookRunStatus, HookRunSummary, NormalizedHookInput, NormalizedToolCall } from "../core/hook-types";
import {
  LEDGER_LIMITS,
  type AssistantLine,
  type FiredLine,
  type LedgerLine,
  type MarkerKind,
  type MarkerLine,
  type PromptLine,
  type SessionState,
  type ToolFailLine,
  type ToolOkLine,
} from "../core/ledger-types";
import { ledgerFile, notifyFile, sessionKey as computeSessionKey, stateFile, TARGET_USER_VERSION, type HarnessPaths } from "../core/paths";
import type { CloseReason, Delivery, Enforcement, HookDecision, HookEvent, Host } from "../core/vocabulary";
import { buildEpisodeDescriptor, isEligibleForExtraction } from "../dream/episode";
import {
  appendLedgerLine,
  classifyFailure,
  deriveTailState,
  detectCorrection,
  detectRemember,
  detectResolution,
  failureSignature,
  makeSeq,
  readLedgerRangeLines,
  readLedgerTailLines,
  type OffsetLedgerLine,
} from "../dream/ledger";
import { createDenseClient } from "../embed/client";
import {
  consumeNotify,
  createSessionState,
  ensureHookDirectories,
  ledgerSize,
  listStateFiles,
  queueHasFiles,
  readSessionState,
  writeQueueFile,
  writeSessionState,
} from "./session-state";

export type WorkerCommand = "extract" | "dream" | "reindex";

export interface HookRuntime {
  paths: HarnessPaths;
  config: HarnessConfig;
  clock: () => string;
  /** Detached worker spawn (`dist/worker.js <root> <command>`); null disables spawning (tests, dry runs). */
  spawnWorker: SpawnWorkerFn | null;
  /** Dense retrieval through the embedding helper; null = lexical only. */
  dense: DenseClient | null;
}

export interface HookResult {
  event: HookEvent;
  status: HookRunStatus;
  /** ask | deny | none — the hook never emits `allow`. */
  decision: HookDecision;
  enforcement: Enforcement | null;
  delivery: Delivery;
  reason: string | null;
  additionalContext: string | null;
  systemMessage: string | null;
  /** Ids of the injected memories (rule items appear as `rule:<code>`). */
  activated: string[];
  suppressed: number;
  tool: string | null;
  gen: number | null;
  /** Episode written to the queue by this call, if any. */
  episodeId: string | null;
  spawned: WorkerCommand[];
  /** Free-form debugging detail (full JSON line under HARNESS_MEMORY_DEBUG=1). */
  detail: Record<string, unknown>;
}

/** Idle sweep (§5.8 / session-start): an open turn whose ledger has been quiet this long is closed as `idle`. */
export const IDLE_TURN_MS = 60 * 60 * 1000;
/** Notify messages are joined for `systemMessage`; cap the total so a chatty worker cannot flood the user. */
const NOTIFY_MAX_CHARS = 1_000;

export function createRuntime(
  paths: HarnessPaths,
  config: HarnessConfig,
  options: { clock?: () => string; spawnWorker?: SpawnWorkerFn | null; dense?: DenseClient | null } = {}
): HookRuntime {
  const useHelper = config.before_model.dense === "helper" && config.embeddings.enabled;
  return {
    paths,
    config,
    clock: options.clock ?? (() => new Date().toISOString()),
    spawnWorker: options.spawnWorker === undefined ? defaultSpawnWorker : options.spawnWorker,
    dense: options.dense === undefined ? (useHelper ? createDenseClient(paths, { timeoutMs: config.before_model.dense_timeout_ms }) : null) : options.dense,
  };
}

export function emptyResult(event: HookEvent, status: HookRunStatus, tool: string | null = null): HookResult {
  return {
    event,
    status,
    decision: "none",
    enforcement: null,
    delivery: "none",
    reason: null,
    additionalContext: null,
    systemMessage: null,
    activated: [],
    suppressed: 0,
    tool,
    gen: null,
    episodeId: null,
    spawned: [],
    detail: {},
  };
}

export function summarizeHookResult(result: HookResult, durationMs: number): HookRunSummary {
  return {
    event: result.event,
    status: result.status,
    duration_ms: durationMs,
    ...(result.tool !== null ? { tool: result.tool } : {}),
    gen: result.gen,
    activated: result.activated.length,
    suppressed: result.suppressed,
    decision: result.decision,
    delivery: result.delivery,
    enforcement: result.enforcement,
  };
}

// ---------------------------------------------------------------------------------------------
// Session context and ledger line helpers
// ---------------------------------------------------------------------------------------------

interface SessionContext {
  host: Host;
  sessionId: string;
  sessionKey: string;
  ledger: string;
  stateFile: string;
  notifyFile: string;
  state: SessionState | null;
  now: string;
  nowMs: number;
  agentId: string | null;
}

function sessionContext(input: NormalizedHookInput, runtime: HookRuntime): SessionContext {
  const key = computeSessionKey(input.host, input.session_id);
  const now = runtime.clock();
  const file = stateFile(runtime.paths, input.host, key);
  return {
    host: input.host,
    sessionId: input.session_id,
    sessionKey: key,
    ledger: ledgerFile(runtime.paths, input.host, key),
    stateFile: file,
    notifyFile: notifyFile(runtime.paths, input.host, key),
    state: readSessionState(file),
    now,
    nowMs: Date.parse(now),
    agentId: input.agent_id,
  };
}

function lineBase(ctx: SessionContext, turnKey: string): { ts: string; seq: number; turn_key: string; agent_id?: string } {
  return {
    ts: ctx.now,
    seq: makeSeq(Number.isNaN(ctx.nowMs) ? Date.now() : ctx.nowMs),
    turn_key: turnKey,
    ...(ctx.agentId !== null ? { agent_id: ctx.agentId } : {}),
  };
}

/** The open turn's key, else the host's prompt id, else a positional fallback (§3.4). */
function turnKeyFor(ctx: SessionContext, input: NormalizedHookInput): string {
  return ctx.state?.turn_key ?? input.prompt_id ?? `p:${ctx.sessionKey}:${ledgerSize(ctx.ledger)}`;
}

function appendMarker(ctx: SessionContext, turnKey: string, marker: MarkerKind, detail?: string | null): void {
  const line: MarkerLine = {
    kind: "marker",
    ...lineBase(ctx, turnKey),
    marker,
    ...(detail !== null && detail !== undefined && detail.length > 0 ? { detail } : {}),
  };
  appendLedgerLine(ctx.ledger, line);
}

function hasEpisodeContent(lines: readonly LedgerLine[]): boolean {
  return lines.some((line) => line.kind === "prompt" || line.kind === "tool_ok" || line.kind === "tool_fail" || line.kind === "fired");
}

function isToolLine(line: LedgerLine): line is ToolOkLine | ToolFailLine {
  return line.kind === "tool_ok" || line.kind === "tool_fail";
}

interface CloseSegmentParams {
  paths: HarnessPaths;
  ledger: string;
  stateFile: string;
  state: SessionState & { turn_key: string };
  host: Host;
  sessionId: string;
  sessionKey: string;
  closeReason: CloseReason;
  now: string;
  /** End of the segment; defaults to the current ledger size. */
  eof?: number;
}

interface ClosedSegment {
  descriptor: EpisodeDescriptor;
  eligible: boolean;
  state: SessionState;
  queueFile: string;
}

/**
 * §5.2: read `[turn_start_offset, EOF)` (≤ 4 MB), build the descriptor (with the corrected episode's
 * tool lines as context), write `queue/<id>.json`, advance the state. Returns null when the segment
 * holds nothing worth an episode (only assistant / marker lines) — the state is left untouched.
 */
function closeSegment(params: CloseSegmentParams): ClosedSegment | null {
  const { state } = params;
  const eof = params.eof ?? ledgerSize(params.ledger);
  const start = state.turn_start_offset;
  if (start >= eof) return null;
  const end = Math.min(eof, start + LEDGER_LIMITS.turn_read_bytes);
  const parsed = readLedgerRangeLines(params.ledger, start, end);
  if (!hasEpisodeContent(parsed.lines)) return null;

  let contextLines: LedgerLine[] | null = null;
  const range = state.last_episode_range;
  if (state.correction_for !== undefined && range !== undefined && range.end > range.start) {
    const previous = readLedgerRangeLines(params.ledger, range.start, Math.min(range.end, range.start + LEDGER_LIMITS.turn_read_bytes));
    contextLines = previous.lines.filter(isToolLine);
  }

  const descriptor = buildEpisodeDescriptor({
    host: params.host,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    turnKey: state.turn_key,
    segment: state.segment,
    lines: parsed.lines,
    byteStart: start,
    byteEnd: eof,
    ledgerFileName: basename(params.ledger),
    closeReason: params.closeReason,
    now: params.now,
    correctionFor: state.correction_for ?? null,
    contextLines,
  });
  const file = writeQueueFile(params.paths, descriptor);
  const nextState: SessionState = {
    ...state,
    turn_start_offset: eof,
    segment: state.segment + 1,
    last_episode_id: descriptor.id,
    last_episode_range: { start, end: eof },
    updated_at: params.now,
  };
  writeSessionState(params.stateFile, nextState);
  return { descriptor, eligible: isEligibleForExtraction(descriptor).eligible, state: nextState, queueFile: file };
}

function spawn(runtime: HookRuntime, command: WorkerCommand, spawned: WorkerCommand[]): void {
  if (runtime.spawnWorker === null || spawned.includes(command)) return;
  try {
    if (runtime.spawnWorker(command, runtime.paths.root) !== null) spawned.push(command);
  } catch {
    // a failed spawn is retried by the next hook; never surfaces to the host
  }
}

function hasOpenTurn(state: SessionState | null): state is SessionState & { turn_key: string } {
  return state !== null && state.turn_key !== null;
}

function loadSnapshot(runtime: HookRuntime, nowMs: number, checkStale = true): LoadedSnapshot | null {
  return readActiveSnapshot(runtime.paths, { spawnWorker: runtime.spawnWorker, nowMs, checkStale });
}

function itemIds(items: readonly InjectedItem[]): string[] {
  return items.map((item) => item.id);
}

// ---------------------------------------------------------------------------------------------
// Recursion guard 2: hooks fired by the worker's own headless CLI (POSIX /proc walk; Windows skipped)
// ---------------------------------------------------------------------------------------------

function parentPidOf(pid: number): number | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    const fields = stat.slice(close + 2).split(" ");
    const ppid = Number.parseInt(fields[1] ?? "", 10);
    return Number.isFinite(ppid) && ppid > 0 ? ppid : null;
  } catch {
    return null;
  }
}

/**
 * True when `locks/worker.pid` names an ancestor of this process. On Windows there is no cheap parent
 * chain without spawning `wmic`/PowerShell (which would cost more than the hook itself), so the check
 * is skipped there; recursion guard 1 (`HARNESS_MEMORY_DISABLE=1` in `providerEnv()`) still applies.
 */
export function spawnedByWorker(paths: Pick<HarnessPaths, "workerPid">, options: { platform?: NodeJS.Platform; ppid?: number; maxDepth?: number } = {}): boolean {
  const platform = options.platform ?? process.platform;
  if (platform === "win32") return false;
  let workerPid: number;
  try {
    workerPid = Number.parseInt(readFileSync(paths.workerPid, "utf8").trim(), 10);
  } catch {
    return false;
  }
  if (!Number.isFinite(workerPid) || workerPid <= 1) return false;
  let current: number | null = options.ppid ?? process.ppid;
  for (let depth = 0; depth < (options.maxDepth ?? 6) && current !== null && current > 1; depth += 1) {
    if (current === workerPid) return true;
    current = parentPidOf(current);
  }
  return false;
}

// ---------------------------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------------------------

function sweepIdleTurns(ctx: SessionContext, runtime: HookRuntime): number {
  let closed = 0;
  for (const file of listStateFiles(runtime.paths.stateDir)) {
    if (file === ctx.stateFile) continue;
    const state = readSessionState(file);
    if (state === null || !hasOpenTurn(state)) continue;
    const ledger = ledgerFile(runtime.paths, state.host, state.session_key);
    let size: number;
    let mtimeMs: number;
    try {
      const stat = readLedgerStat(ledger);
      size = stat.size;
      mtimeMs = stat.mtimeMs;
    } catch {
      continue;
    }
    if (state.turn_start_offset >= size || ctx.nowMs - mtimeMs < IDLE_TURN_MS) continue;
    try {
      const result = closeSegment({
        paths: runtime.paths,
        ledger,
        stateFile: file,
        state,
        host: state.host,
        sessionId: state.session_id,
        sessionKey: state.session_key,
        closeReason: "idle",
        now: ctx.now,
        eof: size,
      });
      if (result === null) continue;
      const marker: MarkerLine = { kind: "marker", ts: ctx.now, seq: makeSeq(ctx.nowMs), turn_key: state.turn_key, marker: "idle_close" };
      appendLedgerLine(ledger, marker);
      closed += 1;
    } catch {
      // one broken session must not stop the sweep
    }
  }
  return closed;
}

function readLedgerStat(file: string): { size: number; mtimeMs: number } {
  const stat = statSync(file);
  return { size: stat.size, mtimeMs: stat.mtimeMs };
}

async function handleSessionStart(input: NormalizedHookInput, runtime: HookRuntime): Promise<HookResult> {
  const result = emptyResult("session-start", "ok");
  ensureHookDirectories(runtime.paths);
  const ctx = sessionContext(input, runtime);
  appendMarker(ctx, turnKeyFor(ctx, input), "session_start", input.source);

  const idleClosed = sweepIdleTurns(ctx, runtime);
  result.detail.idle_closed = idleClosed;
  if (idleClosed > 0) spawn(runtime, "extract", result.spawned);

  const loaded = loadSnapshot(runtime, ctx.nowMs);
  if (loaded === null) {
    result.status = "snapshot_missing";
    if (queueHasFiles(runtime.paths)) spawn(runtime, "extract", result.spawned);
    return result;
  }
  result.gen = loaded.snapshot.db_generation;
  result.detail.stale = loaded.stale;
  if (loaded.snapshot.user_version < TARGET_USER_VERSION) spawn(runtime, "reindex", result.spawned);
  if (queueHasFiles(runtime.paths)) spawn(runtime, "extract", result.spawned);

  const startup = selectSessionStartItems({ loaded, host: input.host, config: runtime.config, now: ctx.now });
  result.activated = itemIds(startup.items);
  result.suppressed = startup.suppressed.length;
  result.additionalContext = startup.text;
  result.delivery = startup.items.length > 0 ? "with_result" : "none";
  result.detail.suppressed = startup.suppressed;

  const digest = buildDigestMessage(loaded.snapshot.counts, ctx.state?.last_digest_date, ctx.now);
  if (digest !== null) {
    result.systemMessage = digest;
    const state = ctx.state ?? createSessionState(input.host, input.session_id, ctx.sessionKey, ctx.now);
    writeSessionState(ctx.stateFile, { ...state, last_digest_date: ctx.now.slice(0, 10), updated_at: ctx.now });
  }
  return result;
}

async function handlePrompt(input: NormalizedHookInput, runtime: HookRuntime): Promise<HookResult> {
  const result = emptyResult("prompt", "ok");
  ensureHookDirectories(runtime.paths);
  const ctx = sessionContext(input, runtime);
  const text = input.prompt ?? "";

  // (1) the offset BEFORE appending: the prompt line belongs to the new segment.
  const offset = ledgerSize(ctx.ledger);
  let state = ctx.state;
  let lastEpisodeId = state?.last_episode_id;
  const openTurn = hasOpenTurn(state) && state.turn_start_offset < offset;
  const prevStart = state === null ? 0 : openTurn ? state.turn_start_offset : (state.last_episode_range?.start ?? state.turn_start_offset);

  // (2) a turn without a close record → interrupted (Claude Code runs no Stop hook on interrupts).
  if (hasOpenTurn(state) && openTurn) {
    const closed = closeSegment({
      paths: runtime.paths,
      ledger: ctx.ledger,
      stateFile: ctx.stateFile,
      state,
      host: input.host,
      sessionId: input.session_id,
      sessionKey: ctx.sessionKey,
      closeReason: "interrupted",
      now: ctx.now,
      eof: offset,
    });
    if (closed !== null) {
      state = closed.state;
      lastEpisodeId = closed.descriptor.id;
      result.episodeId = closed.descriptor.id;
      result.detail.closed_as = "interrupted";
      if (closed.eligible) spawn(runtime, "extract", result.spawned);
    }
  }

  // Correction / remember flags from the previous turn's tail and the prompt text.
  const tail = readLedgerTailLines(ctx.ledger, LEDGER_LIMITS.tail_read_bytes);
  const prevTurnLines = tail.lines.filter((line) => line.offset >= prevStart && line.offset < offset);
  const correction = detectCorrection({ prevTurnLines, text });
  const remember: 0 | 1 = detectRemember(text) ? 1 : 0;

  // (3) prompt line.
  const turnKey = input.prompt_id !== null && input.prompt_id !== state?.turn_key ? input.prompt_id : `p:${ctx.sessionKey}:${offset}`;
  const promptLine: PromptLine = {
    kind: "prompt",
    ...lineBase(ctx, turnKey),
    text,
    correction,
    remember,
    ...(input.prompt_id !== null ? { prompt_id: input.prompt_id } : {}),
  };
  appendLedgerLine(ctx.ledger, promptLine);

  // (4) new state (tmp + rename).
  const nextState: SessionState = {
    ...(state ?? createSessionState(input.host, input.session_id, ctx.sessionKey, ctx.now)),
    turn_key: turnKey,
    turn_start_offset: offset,
    segment: 0,
    updated_at: ctx.now,
  };
  delete nextState.correction_for;
  if (correction === 1 && lastEpisodeId !== undefined) nextState.correction_for = lastEpisodeId;
  if (lastEpisodeId !== undefined) nextState.last_episode_id = lastEpisodeId;
  writeSessionState(ctx.stateFile, nextState);
  result.detail.turn_key = turnKey;
  result.detail.correction = correction;
  result.detail.remember = remember;

  // before_model injection.
  const loaded = loadSnapshot(runtime, ctx.nowMs);
  if (loaded === null) {
    result.status = "snapshot_missing";
  } else {
    result.gen = loaded.snapshot.db_generation;
    const lexical = await readLexicalSnapshot(runtime.paths);
    const useDense = runtime.config.before_model.dense === "helper" && runtime.config.embeddings.enabled;
    const lastScopeRef = deriveTailState(tail.lines, { turnStartOffset: offset }).lastScopeRef;
    const activation = await activateBeforeModel({
      loaded,
      lexical,
      dense: useDense ? runtime.dense : null,
      prompt: text,
      lastScopeRef,
      host: input.host,
      config: runtime.config,
      now: ctx.now,
    });
    result.activated = itemIds(activation.items);
    result.suppressed = activation.suppressed.length;
    result.additionalContext = activation.text;
    result.delivery = activation.items.length > 0 ? "with_result" : "none";
    result.detail.lexical = activation.lexicalUsed;
    result.detail.dense = activation.denseUsed;
    result.detail.suppressed = activation.suppressed;
  }

  // Worker → user notifications (§7.4).
  const messages = consumeNotify(ctx.notifyFile);
  if (messages.length > 0) {
    const joined = messages.join("\n");
    result.systemMessage = joined.length > NOTIFY_MAX_CHARS ? `${joined.slice(0, NOTIFY_MAX_CHARS - 1)}…` : joined;
  }
  return result;
}

function pickedTarget(tool: NormalizedToolCall, runtime: HookRuntime): PickedTarget {
  return pickTarget(tool.canonical, tool.input, { dialect: tool.shell_dialect, root: runtime.paths.root });
}

async function handlePreTool(input: NormalizedHookInput, runtime: HookRuntime): Promise<HookResult> {
  const tool = input.tool;
  if (tool === null) return emptyResult("pre-tool", "skipped:no_tool");
  const result = emptyResult("pre-tool", "ok", tool.canonical);
  const ctx = sessionContext(input, runtime);

  const loaded = loadSnapshot(runtime, ctx.nowMs);
  if (loaded === null) {
    result.status = "snapshot_missing";
    return result;
  }
  result.gen = loaded.snapshot.db_generation;
  result.detail.stale = loaded.stale;

  const tail = readLedgerTailLines(ctx.ledger, LEDGER_LIMITS.tail_read_bytes);
  const tailState = deriveTailState(tail.lines, { turnStartOffset: ctx.state?.turn_start_offset ?? 0 });
  const picked = pickedTarget(tool, runtime);
  const decision = decideBeforeTool({
    loaded,
    tailState,
    input: {
      canonical: tool.canonical,
      dialect: tool.shell_dialect,
      targetKind: picked.kind,
      target: picked.target,
      scopeRefs: picked.scopeRefs,
      permissionMode: input.permission_mode,
    },
    config: runtime.config,
    now: ctx.now,
  });

  if (decision.fired !== null) {
    ensureHookDirectories(runtime.paths);
    const fired: FiredLine = { ...decision.fired, ...lineBase(ctx, turnKeyFor(ctx, input)) };
    appendLedgerLine(ctx.ledger, fired);
  }

  result.decision = decision.decision;
  result.enforcement = decision.enforcement;
  result.delivery = decision.delivery;
  result.reason = decision.reason;
  result.additionalContext = decision.additionalContext;
  result.systemMessage = decision.systemMessage;
  result.activated = itemIds(decision.activated);
  result.suppressed = decision.suppressed.length;
  result.detail.suppressed = decision.suppressed;
  result.detail.rules = decision.rules.map((rule) => rule.ruleCode);
  result.detail.downgraded = decision.downgraded;
  result.detail.target_kind = picked.kind;
  return result;
}

function renderToolOutput(response: unknown): { head: string; tail: string } {
  let text: string;
  if (typeof response === "string") {
    text = response;
  } else if (response === null || response === undefined) {
    text = "";
  } else if (typeof response === "object") {
    const record = response as Record<string, unknown>;
    const parts: string[] = [];
    for (const key of ["stdout", "stderr", "output", "content", "result", "message"]) {
      const value = record[key];
      if (typeof value === "string" && value.length > 0) parts.push(value);
    }
    if (parts.length > 0) {
      text = parts.join("\n");
    } else {
      try {
        text = JSON.stringify(response) ?? "";
      } catch {
        text = "";
      }
    }
  } else {
    text = String(response);
  }
  const head = text.slice(0, LEDGER_LIMITS.output_head);
  const tail = text.length > LEDGER_LIMITS.output_head ? text.slice(-LEDGER_LIMITS.output_tail) : "";
  return { head, tail };
}

function inputDigestFor(tool: NormalizedToolCall, picked: PickedTarget): string {
  if (picked.target !== null) return picked.target;
  try {
    return JSON.stringify(tool.input).slice(0, LEDGER_LIMITS.input_digest);
  } catch {
    return "";
  }
}

async function handlePostTool(event: "post-tool" | "post-tool-failure", input: NormalizedHookInput, runtime: HookRuntime): Promise<HookResult> {
  const tool = input.tool;
  if (tool === null) return emptyResult(event, "skipped:no_tool");
  const result = emptyResult(event, "ok", tool.canonical);
  ensureHookDirectories(runtime.paths);
  const ctx = sessionContext(input, runtime);

  const tail = readLedgerTailLines(ctx.ledger, LEDGER_LIMITS.tail_read_bytes);
  if (tool.use_id !== null && tail.lines.some((line) => isToolLine(line) && line.tool_use_id === tool.use_id)) {
    result.status = "skipped:duplicate";
    return result;
  }
  const tailState = deriveTailState(tail.lines, { turnStartOffset: ctx.state?.turn_start_offset ?? 0 });
  const picked = pickedTarget(tool, runtime);
  const output = renderToolOutput(tool.response);
  const base = {
    ...lineBase(ctx, turnKeyFor(ctx, input)),
    tool_use_id: tool.use_id,
    tool: tool.canonical,
    host_tool: tool.host_name,
    shell_dialect: tool.shell_dialect,
    input_digest: inputDigestFor(tool, picked),
    scope_refs: picked.scopeRefs,
    program_token: picked.programToken,
    output_head: output.head,
    output_tail: output.tail,
  };

  if (event === "post-tool") {
    const line: ToolOkLine = { kind: "tool_ok", ...base, resolution_of: detectResolution(tailState.pendingFailures, base) };
    appendLedgerLine(ctx.ledger, line);
    result.detail.resolution_of = line.resolution_of;
    return result;
  }

  const failureClass = classifyFailure({ error: tool.error, exitCode: tool.exit_code, isInterrupt: tool.is_interrupt });
  const line: ToolFailLine = {
    kind: "tool_fail",
    ...base,
    error: tool.error ?? "",
    is_interrupt: tool.is_interrupt,
    exit_code: tool.exit_code,
    failure_class: failureClass,
    failure_sig: failureSignature(tool.canonical, failureClass, picked.scopeRefs[0] ?? picked.programToken),
  };
  appendLedgerLine(ctx.ledger, line);
  result.detail.failure_class = failureClass;
  result.detail.failure_sig = line.failure_sig;

  const loaded = loadSnapshot(runtime, ctx.nowMs);
  if (loaded === null) {
    result.status = "snapshot_missing";
    return result;
  }
  result.gen = loaded.snapshot.db_generation;
  const hints = selectAfterToolHints({ loaded, failureClass, canonical: tool.canonical, config: runtime.config, now: ctx.now });
  result.activated = itemIds(hints.items);
  result.suppressed = hints.skipped.length;
  result.additionalContext = hints.text;
  result.delivery = hints.items.length > 0 ? "with_result" : "none";
  return result;
}

async function handleClose(event: "stop" | "precompact" | "session-end", input: NormalizedHookInput, runtime: HookRuntime): Promise<HookResult> {
  const result = emptyResult(event, "ok");
  ensureHookDirectories(runtime.paths);
  const ctx = sessionContext(input, runtime);
  const turnKey = turnKeyFor(ctx, input);

  if (event === "stop") {
    const line: AssistantLine = {
      kind: "assistant",
      ...lineBase(ctx, turnKey),
      text: input.last_assistant_message ?? "",
      ...(input.stop_hook_active ? { stop_hook_active: true } : {}),
    };
    appendLedgerLine(ctx.ledger, line);
  } else if (event === "precompact") {
    appendMarker(ctx, turnKey, "precompact", input.trigger);
  } else {
    const reason = typeof (input.raw as Record<string, unknown> | null)?.reason === "string" ? String((input.raw as Record<string, unknown>).reason) : null;
    appendMarker(ctx, turnKey, "session_end", reason);
  }

  const closeReason: CloseReason = event === "stop" ? "stop" : event === "precompact" ? "precompact" : "session_end";
  if (hasOpenTurn(ctx.state)) {
    const closed = closeSegment({
      paths: runtime.paths,
      ledger: ctx.ledger,
      stateFile: ctx.stateFile,
      state: ctx.state,
      host: input.host,
      sessionId: input.session_id,
      sessionKey: ctx.sessionKey,
      closeReason,
      now: ctx.now,
    });
    if (closed === null) {
      result.status = "skipped:empty_segment";
    } else {
      result.episodeId = closed.descriptor.id;
      result.detail.evidence_weight = closed.descriptor.evidence_weight;
      result.detail.eligible = closed.eligible;
      if (closed.eligible) spawn(runtime, "extract", result.spawned);
    }
  } else {
    result.status = "skipped:no_open_turn";
  }

  if (event === "session-end") {
    const loaded = loadSnapshot(runtime, ctx.nowMs, false);
    const lastDream = loaded?.snapshot.last_dream_at ?? null;
    const intervalMs = runtime.config.dream.interval_hours * 60 * 60 * 1000;
    const due = lastDream === null || Number.isNaN(Date.parse(lastDream)) || ctx.nowMs - Date.parse(lastDream) >= intervalMs;
    if (due) spawn(runtime, "dream", result.spawned);
    result.detail.dream_due = due;
  }
  return result;
}

async function handleMarkerOnly(event: "stop-failure" | "interrupt", input: NormalizedHookInput, runtime: HookRuntime): Promise<HookResult> {
  const result = emptyResult(event, "ok");
  ensureHookDirectories(runtime.paths);
  const ctx = sessionContext(input, runtime);
  const error = typeof (input.raw as Record<string, unknown> | null)?.error === "string" ? String((input.raw as Record<string, unknown>).error) : null;
  appendMarker(ctx, turnKeyFor(ctx, input), event === "stop-failure" ? "stop_failure" : "interrupt", error);
  return result;
}

// ---------------------------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------------------------

function errorCode(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    return (code ?? error.name).replace(/[^A-Za-z0-9_]/g, "_").slice(0, 40);
  }
  return "unknown";
}

/** Runs one hook event. Never throws; never opens SQLite; never emits `allow`. */
export async function runHook(event: HookEvent, input: NormalizedHookInput, runtime: HookRuntime): Promise<HookResult> {
  try {
    if (spawnedByWorker(runtime.paths)) return emptyResult(event, "disabled");
    switch (event) {
      case "session-start":
        return await handleSessionStart(input, runtime);
      case "prompt":
        return await handlePrompt(input, runtime);
      case "pre-tool":
        return await handlePreTool(input, runtime);
      case "post-tool":
      case "post-tool-failure":
        return await handlePostTool(event, input, runtime);
      case "stop":
      case "precompact":
      case "session-end":
        return await handleClose(event, input, runtime);
      case "stop-failure":
      case "interrupt":
        return await handleMarkerOnly(event, input, runtime);
      default:
        return emptyResult(event, "skipped:unknown_event");
    }
  } catch (error) {
    const result = emptyResult(event, `error:${errorCode(error)}`, input.tool?.canonical ?? null);
    result.detail.error = error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300);
    return result;
  }
}
