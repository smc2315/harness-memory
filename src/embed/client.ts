/**
 * Hook-side client for the embedding helper (plan §4 B2, deviation note in §1 of the plan): connect to
 * the named pipe / socket, send one `topk` request, wait at most `timeoutMs` (default 30 ms) and
 * return null on any failure. When nothing is listening (ECONNREFUSED / ENOENT) the helper is spawned
 * detached at most once per 60 s through the `locks/embed-helper.spawn` touch file; the current hook
 * simply proceeds without a dense leg.
 *
 * No transformers import here: the hook never loads the model.
 */

import { mkdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { DenseClient, DenseHits } from "../activation/before-model";
import type { HarnessPaths } from "../core/paths";
import { spawnDetached } from "../core/process";
import { EMBED_CLIENT_TIMEOUT_MS, EMBED_SPAWN_INTERVAL_MS, encodeMessage, parseResponse, type EmbedResponse } from "./protocol";

export type EmbedPaths = Pick<HarnessPaths, "embedHelperSocket" | "locksDir" | "root">;
export type SpawnFn = (scriptPath: string, args: readonly string[]) => number | null;

export interface EnsureHelperOptions {
  spawn?: SpawnFn;
  /** Defaults to the `embed-helper.js` bundle next to the running module. */
  scriptPath?: string;
  nowMs?: number;
  minIntervalMs?: number;
}

export function embedHelperScriptPath(): string {
  return fileURLToPath(new URL("./embed-helper.js", import.meta.url));
}

export function spawnTouchFile(paths: Pick<HarnessPaths, "locksDir">): string {
  return join(paths.locksDir, "embed-helper.spawn");
}

/** Spawns the detached helper unless one was spawned less than `minIntervalMs` ago. Returns true when spawned. */
export function ensureHelper(paths: EmbedPaths, options: EnsureHelperOptions = {}): boolean {
  const nowMs = options.nowMs ?? Date.now();
  const touch = spawnTouchFile(paths);
  const minInterval = options.minIntervalMs ?? EMBED_SPAWN_INTERVAL_MS;
  try {
    const stat = statSync(touch);
    if (nowMs - stat.mtimeMs < minInterval) return false;
    const stamp = new Date(nowMs);
    utimesSync(touch, stamp, stamp);
  } catch {
    try {
      mkdirSync(paths.locksDir, { recursive: true });
      writeFileSync(touch, `${new Date(nowMs).toISOString()}\n`, "utf8");
      const stamp = new Date(nowMs);
      utimesSync(touch, stamp, stamp);
    } catch {
      return false;
    }
  }
  const spawn = options.spawn ?? ((script, args) => spawnDetached(script, args, { cwd: paths.root }));
  try {
    return spawn(options.scriptPath ?? embedHelperScriptPath(), [paths.root]) !== null;
  } catch {
    return false;
  }
}

export interface QueryDenseOptions {
  text: string;
  k: number;
  timeoutMs?: number;
  /** Passed to `ensureHelper` when nothing is listening. */
  ensure?: EnsureHelperOptions | false;
  socketPath?: string;
}

const NO_LISTENER_CODES: ReadonlySet<string> = new Set(["ECONNREFUSED", "ENOENT"]);

/** Sends one request and resolves with the parsed response, or null on timeout / error / malformed answer. */
export function requestHelper(socketPath: string, message: Parameters<typeof encodeMessage>[0], timeoutMs: number): Promise<{ response: EmbedResponse | null; errorCode: string | null }> {
  return new Promise((resolve) => {
    let settled = false;
    let buffer = "";
    const socket = connect(socketPath);
    const finish = (response: EmbedResponse | null, errorCode: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve({ response, errorCode });
    };
    const timer = setTimeout(() => finish(null, "ETIMEDOUT"), timeoutMs);
    timer.unref?.();
    socket.setNoDelay(true);
    socket.on("connect", () => {
      socket.write(encodeMessage(message));
    });
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      finish(parseResponse(buffer.slice(0, newline)), null);
    });
    socket.on("error", (error: NodeJS.ErrnoException) => finish(null, error.code ?? "EUNKNOWN"));
    socket.on("close", () => finish(null, "ECLOSED"));
  });
}

/** Top-k dense neighbours of `text` from the helper, or null when it did not answer within the budget. */
export async function queryDense(paths: EmbedPaths, options: QueryDenseOptions): Promise<DenseHits | null> {
  const socketPath = options.socketPath ?? paths.embedHelperSocket;
  const { response, errorCode } = await requestHelper(socketPath, { op: "topk", text: options.text, k: options.k }, options.timeoutMs ?? EMBED_CLIENT_TIMEOUT_MS);
  if (response === null) {
    if (errorCode !== null && NO_LISTENER_CODES.has(errorCode) && options.ensure !== false) {
      ensureHelper(paths, options.ensure ?? {});
    }
    return null;
  }
  if (!response.ok || response.ids === undefined) return null;
  const scores = response.scores ?? [];
  return { ids: response.ids, scores: response.ids.map((_, index) => scores[index] ?? 0) };
}

export interface DenseClientOptions {
  timeoutMs?: number;
  ensure?: EnsureHelperOptions | false;
  socketPath?: string;
}

/** `DenseClient` for `activateBeforeModel`, bound to a project's paths. */
export function createDenseClient(paths: EmbedPaths, options: DenseClientOptions = {}): DenseClient {
  return {
    topk: (text: string, k: number) =>
      queryDense(paths, { text, k, timeoutMs: options.timeoutMs, ensure: options.ensure, socketPath: options.socketPath }),
  };
}
