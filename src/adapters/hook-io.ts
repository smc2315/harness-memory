/**
 * Hook process I/O (spec §8.6, §9.4 observability): read all of stdin with a time and size guard,
 * print exactly one JSON object (or nothing for the silent events), and append one line per call to
 * `logs/hooks.log` with 5 MB × 3 rotation. `HARNESS_MEMORY_DEBUG=1` (or `log.debug`) adds the full
 * JSON of the run. Nothing here throws to the caller: every file error is swallowed.
 */

import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from "node:fs";

import { DEFAULT_CONFIG } from "../core/config";
import { HOOK_IO_LIMITS, type HookRunSummary, type HookStdout } from "../core/hook-types";
import type { HarnessPaths } from "../core/paths";

export interface ReadStdinOptions {
  timeoutMs?: number;
  maxBytes?: number;
  /** Injected stream for tests; defaults to `process.stdin`. */
  stream?: NodeJS.ReadableStream & { isTTY?: boolean; unref?: () => void };
}

/** Resolves with everything read so far when stdin ends, the cap is reached or the timeout fires (never rejects). */
export function readStdin(options: ReadStdinOptions = {}): Promise<string> {
  const timeoutMs = options.timeoutMs ?? HOOK_IO_LIMITS.stdin_timeout_ms;
  const maxBytes = options.maxBytes ?? HOOK_IO_LIMITS.stdin_bytes;
  const stream = options.stream ?? (process.stdin as ReadStdinOptions["stream"] & NodeJS.ReadableStream);

  return new Promise((resolve) => {
    if (stream.isTTY === true) {
      resolve("");
      return;
    }
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stream.removeListener("data", onData);
      stream.removeListener("end", finish);
      stream.removeListener("error", finish);
      stream.removeListener("close", finish);
      try {
        stream.pause();
        stream.unref?.();
      } catch {
        // stdin may already be closed
      }
      resolve(Buffer.concat(chunks).toString("utf8"));
    };

    const onData = (chunk: Buffer | string): void => {
      const buffer = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
      const remaining = maxBytes - total;
      if (buffer.length >= remaining) {
        chunks.push(buffer.subarray(0, remaining));
        total = maxBytes;
        finish();
        return;
      }
      chunks.push(buffer);
      total += buffer.length;
    };

    const timer = setTimeout(finish, timeoutMs);
    timer.unref?.();
    stream.on("data", onData);
    stream.on("end", finish);
    stream.on("error", finish);
    stream.on("close", finish);
    try {
      stream.resume();
    } catch {
      finish();
    }
  });
}

/** Writes exactly one JSON object followed by a newline; `null` writes nothing (stop / precompact / session-end / stop-failure / interrupt). */
export function writeStdout(output: HookStdout | null, stream: { write(chunk: string): unknown } = process.stdout): void {
  if (output === null) return;
  try {
    stream.write(`${JSON.stringify(output)}\n`);
  } catch {
    // a closed stdout must not turn into a hook error
  }
}

export interface AppendHookLogOptions {
  maxBytes?: number;
  rotations?: number;
  /** Append the full JSON of the run after the summary line. */
  debug?: boolean;
  detail?: unknown;
  now?: string;
}

/** `2026-11-08T10:00:00.000Z pre-tool tool=bash gen=42 activated=1 suppressed=17 decision=deny delivery=before enforcement=soft_deny dur=63ms ok` */
export function formatHookLogLine(summary: HookRunSummary, now: string): string {
  const parts = [
    now,
    summary.event,
    `tool=${summary.tool ?? "-"}`,
    `gen=${summary.gen === null ? "-" : String(summary.gen)}`,
    `activated=${summary.activated}`,
    `suppressed=${summary.suppressed}`,
    `decision=${summary.decision}`,
    `delivery=${summary.delivery}`,
    `enforcement=${summary.enforcement ?? "-"}`,
    `dur=${Math.round(summary.duration_ms)}ms`,
    summary.status,
  ];
  return parts.join(" ");
}

/** hooks.log → hooks.log.1 → … → hooks.log.<rotations>; the oldest file is dropped. */
export function rotateLog(file: string, maxBytes: number, rotations: number): void {
  let size: number;
  try {
    size = statSync(file).size;
  } catch {
    return;
  }
  if (size < maxBytes) return;
  const keep = Math.max(1, Math.floor(rotations));
  try {
    unlinkSync(`${file}.${keep}`);
  } catch {
    // nothing to drop
  }
  for (let index = keep - 1; index >= 1; index -= 1) {
    const from = `${file}.${index}`;
    if (!existsSync(from)) continue;
    try {
      renameSync(from, `${file}.${index + 1}`);
    } catch {
      // keep going; a failed rotation only costs history
    }
  }
  try {
    renameSync(file, `${file}.1`);
  } catch {
    // if the rename fails we simply keep appending to the current file
  }
}

export function appendHookLog(paths: Pick<HarnessPaths, "logsDir" | "hooksLog">, summary: HookRunSummary, options: AppendHookLogOptions = {}): void {
  try {
    mkdirSync(paths.logsDir, { recursive: true });
    rotateLog(paths.hooksLog, options.maxBytes ?? DEFAULT_CONFIG.log.max_bytes, options.rotations ?? DEFAULT_CONFIG.log.rotations);
    const now = options.now ?? new Date().toISOString();
    let payload = `${formatHookLogLine(summary, now)}\n`;
    if (options.debug === true) {
      payload += `${JSON.stringify({ ts: now, summary, detail: options.detail ?? null })}\n`;
    }
    appendFileSync(paths.hooksLog, payload, "utf8");
  } catch {
    // logging must never break a hook
  }
}

/** One-line error record for the log when a hook caught an exception. */
export function describeError(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    return `${error.name}${code !== undefined ? `(${code})` : ""}: ${error.message}`.replace(/\s+/g, " ").slice(0, 300);
  }
  return String(error).replace(/\s+/g, " ").slice(0, 300);
}
