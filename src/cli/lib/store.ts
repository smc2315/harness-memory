/**
 * Store composition for the CLI: the same hooks as the worker (post-migrate, derived policy rules,
 * snapshot build) via `composeStore` from src/dream/worker.ts, a logger that keeps the store's chatter
 * out of stdout (it goes to logs/worker.log; warnings/errors also to stderr), and the error → exit-code
 * mapping every command shares (LockBusyError → 75, DB errors → 1 with a plain message).
 */

import type { HarnessConfig } from "../../core/config";
import { DatabaseNewerThanCodeError, EXIT_CODES, LockBusyError } from "../../core/errors";
import type { HarnessPaths } from "../../core/paths";
import { DatabaseCorruptError, DatabaseMissingError } from "../../db/db-file";
import type { LockOwner } from "../../db/locks";
import type { Store, StoreLogger } from "../../db/store";
import { composeStore, createWorkerLogger } from "../../dream/worker";
import { SettingsParseError } from "./settings";

export const CLI_LOCK_WAIT_MS = 5_000;
export const EXIT_USAGE = 2;

export interface CliStoreOptions {
  paths: HarnessPaths;
  config: HarnessConfig;
  clock?: () => string;
  /** Receives warn/error lines (stderr); info lines only reach logs/worker.log. */
  stderr?: (text: string) => void;
  pid?: number;
}

export function cliLogger(paths: HarnessPaths, options: { clock?: () => string; stderr?: (text: string) => void } = {}): StoreLogger {
  const file = createWorkerLogger(paths, { command: "cli", clock: options.clock });
  const emit = options.stderr;
  return {
    log: (message) => file.log(message),
    warn: (message) => {
      file.warn(message);
      emit?.(`warning: ${message}\n`);
    },
    error: (message) => {
      file.error(message);
      emit?.(`error: ${message}\n`);
    },
  };
}

export function createCliStore(options: CliStoreOptions): Store {
  return composeStore({
    paths: options.paths,
    config: options.config,
    logger: cliLogger(options.paths, { clock: options.clock, stderr: options.stderr }),
    clock: options.clock,
    pid: options.pid,
  });
}

export interface CliFailure {
  exitCode: number;
  message: string;
  /** Short hint on what to do next (printed after the message in text mode). */
  hint: string | null;
}

function describeOwner(holder: unknown): string {
  if (typeof holder !== "object" || holder === null) return "unknown holder";
  const owner = holder as Partial<LockOwner>;
  const pid = typeof owner.pid === "number" ? `pid ${String(owner.pid)}` : "unknown pid";
  const purpose = typeof owner.purpose === "string" ? ` (${owner.purpose})` : "";
  const since = typeof owner.heartbeat_at === "string" ? `, last heartbeat ${owner.heartbeat_at}` : "";
  return `${pid}${purpose}${since}`;
}

/** Turns the errors the store and lib raise into a message + exit code; unknown errors keep their message. */
export function describeFailure(error: unknown, debug = false): CliFailure {
  if (error instanceof LockBusyError) {
    return {
      exitCode: EXIT_CODES.lock_busy,
      message: `database lock is busy: ${error.lockPath} held by ${describeOwner(error.holder)}`,
      hint: "a worker is writing; retry in a moment (stale locks are taken over after 120 s)",
    };
  }
  if (error instanceof DatabaseNewerThanCodeError) {
    return {
      exitCode: EXIT_CODES.error,
      message: error.message,
      hint: "upgrade harness-memory (npm install harness-memory@latest) before touching this database",
    };
  }
  if (error instanceof DatabaseMissingError) {
    return { exitCode: EXIT_CODES.error, message: `no database at ${error.dbPath}`, hint: "run `hm install --host claude` (or `hm db:migrate`) first" };
  }
  if (error instanceof DatabaseCorruptError) {
    return { exitCode: EXIT_CODES.error, message: error.message, hint: "run `hm doctor`; a writer restores memory.sqlite.prev automatically when it can" };
  }
  if (error instanceof SettingsParseError) {
    return { exitCode: EXIT_CODES.error, message: error.message, hint: null };
  }
  if (error instanceof Error) {
    const detail = debug && error.stack !== undefined ? error.stack : error.message;
    return { exitCode: EXIT_CODES.error, message: detail, hint: null };
  }
  return { exitCode: EXIT_CODES.error, message: String(error), hint: null };
}
