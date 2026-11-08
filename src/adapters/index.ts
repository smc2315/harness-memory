// v0.6 host adapters (Phase B2): the hook core, hook process I/O and the Claude Code host mapping.
export {
  createRuntime,
  emptyResult,
  IDLE_TURN_MS,
  runHook,
  spawnedByWorker,
  summarizeHookResult,
  type HookResult,
  type HookRuntime,
  type WorkerCommand,
} from "./hook-core";
export { appendHookLog, describeError, formatHookLogLine, readStdin, rotateLog, writeStdout, type AppendHookLogOptions, type ReadStdinOptions } from "./hook-io";
export {
  CLAUDE_CODE_EVENT_NAMES,
  hookEventFromClaudeName,
  isHookEvent,
  normalizeClaudeCode,
  normalizeClaudeCodeTool,
  parseClaudeCodeStdin,
  renderClaudeCode,
  SILENT_EVENTS,
} from "./hosts/claude-code";
export {
  consumeNotify,
  createSessionState,
  ensureHookDirectories,
  isSessionState,
  ledgerSize,
  listStateFiles,
  queueHasFiles,
  readSessionState,
  writeJsonAtomic,
  writeQueueFile,
  writeSessionState,
} from "./session-state";
