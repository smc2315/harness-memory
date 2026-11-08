/**
 * Idle-exit embedding helper (implementation plan §1 deviation, §4 B2): a detached process that
 * listens on `paths.embedHelperSocket` (Windows named pipe / POSIX socket), lazily loads
 * `@xenova/transformers` with the configured model, keeps `snapshot/dense.v1.bin` in memory (reloaded
 * when its mtime changes) and answers `ping` / `topk` / `embed` requests as JSON lines. It exits after
 * `embeddings.idle_exit_minutes` without a request, on SIGTERM/SIGINT, or when another helper already
 * owns the socket. No installed service, no fixed port (spec §1.2 re-read).
 */

import { existsSync, mkdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";

import type { HarnessConfig } from "../core/config";
import { modelsDir, type HarnessPaths } from "../core/paths";
import { requestHelper } from "./client";
import { denseTopK, readDenseSnapshot, type DenseMatrix } from "./dense-file";
import { encodeMessage, parseRequest, type EmbedRequest, type EmbedResponse } from "./protocol";

export interface Embedder {
  readonly model: string;
  /** Query-side embedding (e5 `query: ` prefix). */
  embedQuery(text: string): Promise<Float32Array>;
  /** Document-side embedding (e5 `passage: ` prefix); callers fall back to `embedQuery` when absent. */
  embedPassage?(text: string): Promise<Float32Array>;
}

export type EmbedderFactory = () => Promise<Embedder>;

export interface StartHelperOptions {
  paths: HarnessPaths;
  config: HarnessConfig;
  /** Injected embedder (tests) or factory; defaults to the lazy transformers loader. */
  embedder?: Embedder | EmbedderFactory;
  /** Defaults to `config.embeddings.idle_exit_minutes` in milliseconds. */
  idleMs?: number;
  /** Process exit hook; tests record the call instead of exiting. */
  exit?: (code: number) => void;
  log?: (line: string) => void;
  socketPath?: string;
  /** Install SIGTERM / SIGINT handlers (default true). */
  signals?: boolean;
}

export interface HelperHandle {
  socketPath: string;
  readonly requests: number;
  readonly closed: boolean;
  /** Stops the server without calling `exit`. */
  close(): Promise<void>;
}

const PROBE_TIMEOUT_MS = 200;

/** True when something answers a `ping` on the socket (another helper is alive). */
export async function probeHelper(socketPath: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<boolean> {
  const { response } = await requestHelper(socketPath, { op: "ping" }, timeoutMs);
  return response?.ok === true;
}

function modelPresent(cacheDir: string, model: string): boolean {
  return existsSync(join(cacheDir, ...model.split("/")));
}

/** Lazy `@xenova/transformers` loader; `allowRemoteModels` only when the model is not cached yet. */
export function createTransformersEmbedder(config: Pick<HarnessConfig, "embeddings">): EmbedderFactory {
  return async () => {
    const transformers = await import("@xenova/transformers");
    const cacheDir = config.embeddings.cache_dir ?? modelsDir();
    mkdirSync(cacheDir, { recursive: true });
    transformers.env.cacheDir = cacheDir;
    transformers.env.allowLocalModels = true;
    transformers.env.allowRemoteModels = !modelPresent(cacheDir, config.embeddings.model);
    const pipe = await transformers.pipeline("feature-extraction", config.embeddings.model, { quantized: true });
    return {
      model: config.embeddings.model,
      async embedQuery(text: string): Promise<Float32Array> {
        const output = (await pipe(`query: ${text}`, { pooling: "mean", normalize: true })) as { data: ArrayLike<number> };
        return new Float32Array(output.data);
      },
      async embedPassage(text: string): Promise<Float32Array> {
        const output = (await pipe(`passage: ${text}`, { pooling: "mean", normalize: true })) as { data: ArrayLike<number> };
        return new Float32Array(output.data);
      },
    };
  };
}

export async function startHelper(options: StartHelperOptions): Promise<HelperHandle> {
  const { paths, config } = options;
  const socketPath = options.socketPath ?? paths.embedHelperSocket;
  const idleMs = options.idleMs ?? Math.max(1_000, config.embeddings.idle_exit_minutes * 60_000);
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const log = options.log ?? (() => undefined);
  const isPipe = socketPath.startsWith("\\\\.\\pipe\\") || socketPath.startsWith("\\\\?\\pipe\\");

  mkdirSync(paths.locksDir, { recursive: true });
  if (!isPipe && existsSync(socketPath)) {
    if (await probeHelper(socketPath)) {
      log("another embedding helper is alive; exiting");
      exit(0);
      return { socketPath, requests: 0, closed: true, close: async () => undefined };
    }
    try {
      unlinkSync(socketPath);
    } catch {
      // stale socket we cannot remove: listen() reports the real error below
    }
  }

  let embedderPromise: Promise<Embedder> | null = null;
  const getEmbedder = (): Promise<Embedder> => {
    if (embedderPromise === null) {
      const source = options.embedder ?? createTransformersEmbedder(config);
      embedderPromise = typeof source === "function" ? source() : Promise.resolve(source);
      embedderPromise.catch(() => {
        embedderPromise = null;
      });
    }
    return embedderPromise;
  };

  let matrix: DenseMatrix | null = null;
  const loadMatrix = (): DenseMatrix | null => {
    let mtimeMs: number;
    try {
      mtimeMs = statSync(paths.snapshotDense).mtimeMs;
    } catch {
      matrix = null;
      return null;
    }
    if (matrix !== null && matrix.mtimeMs === mtimeMs) return matrix;
    matrix = readDenseSnapshot(paths.snapshotDense);
    return matrix;
  };

  const handle = async (request: EmbedRequest): Promise<EmbedResponse> => {
    switch (request.op) {
      case "ping": {
        const current = loadMatrix();
        return { ok: true, model: config.embeddings.model, rows: current?.rows ?? 0, dims: current?.dims };
      }
      case "embed": {
        if (request.text === undefined) return { ok: false, error: "missing_text" };
        const embedder = await getEmbedder();
        const vector = await embedder.embedQuery(request.text);
        return { ok: true, vector: Array.from(vector), model: embedder.model, dims: vector.length };
      }
      case "topk": {
        if (request.text === undefined) return { ok: false, error: "missing_text" };
        const current = loadMatrix();
        if (current === null) return { ok: true, ids: [], scores: [], rows: 0 };
        const embedder = await getEmbedder();
        const vector = await embedder.embedQuery(request.text);
        if (vector.length !== current.dims) return { ok: false, error: `dims_mismatch:${vector.length}!=${current.dims}` };
        const top = denseTopK(current, vector, request.k ?? 10);
        return { ok: true, ids: top.ids, scores: top.scores, model: embedder.model, rows: current.rows, dims: current.dims };
      }
    }
  };

  const sockets = new Set<Socket>();
  let requests = 0;
  let closed = false;
  let idleTimer: NodeJS.Timeout | null = null;
  let server: Server | null = null;

  const shutdown = async (exitAfter: boolean): Promise<void> => {
    if (closed) return;
    closed = true;
    if (idleTimer !== null) clearTimeout(idleTimer);
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    if (server !== null) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    }
    try {
      unlinkSync(paths.embedHelperPid);
    } catch {
      // already gone
    }
    if (!isPipe) {
      try {
        unlinkSync(socketPath);
      } catch {
        // already gone
      }
    }
    log("embedding helper stopped");
    if (exitAfter) exit(0);
  };

  const resetIdle = (): void => {
    if (idleTimer !== null) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      log(`idle for ${idleMs} ms; exiting`);
      void shutdown(true);
    }, idleMs);
  };

  const onLine = async (socket: Socket, line: string): Promise<void> => {
    requests += 1;
    resetIdle();
    const request = parseRequest(line);
    let response: EmbedResponse;
    if (request === null) {
      response = { ok: false, error: "bad_request" };
    } else {
      try {
        response = await handle(request);
      } catch (error) {
        response = { ok: false, error: error instanceof Error ? error.message.slice(0, 300) : String(error) };
      }
    }
    if (!socket.destroyed) socket.write(encodeMessage(response));
  };

  server = createServer((socket) => {
    sockets.add(socket);
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.trim().length > 0) void onLine(socket, line);
        newline = buffer.indexOf("\n");
      }
    });
    socket.on("error", () => undefined);
    socket.on("close", () => sockets.delete(socket));
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server!.once("error", reject);
      server!.listen(socketPath, () => {
        server!.off("error", reject);
        resolve();
      });
    });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    log(`listen failed (${code ?? "unknown"}); exiting`);
    closed = true;
    exit(code === "EADDRINUSE" ? 0 : 1);
    return { socketPath, requests: 0, closed: true, close: async () => undefined };
  }

  try {
    writeFileSync(paths.embedHelperPid, `${process.pid}\n`, "utf8");
  } catch {
    // the pid file is informational (doctor)
  }
  resetIdle();
  if (options.signals !== false) {
    process.once("SIGTERM", () => void shutdown(true));
    process.once("SIGINT", () => void shutdown(true));
  }
  log(`embedding helper listening on ${socketPath}`);

  return {
    socketPath,
    get requests() {
      return requests;
    },
    get closed() {
      return closed;
    },
    close: () => shutdown(false),
  };
}
