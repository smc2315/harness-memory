/**
 * Embedding helper: dense file codec, a real socket / named-pipe round trip with an injected fake
 * embedder, idle exit, and the client's fallback + throttled spawn when no helper is listening.
 */

import { existsSync, readFileSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { embedHelperSocketPath, repoHash, resolvePaths, unixSocketPathMaxBytes, unixSocketPathTooLong } from "../src/core/paths";
import { createDenseClient, ensureHelper, queryDense, requestHelper, spawnTouchFile } from "../src/embed/client";
import { decodeDenseSnapshot, denseTopK, encodeDenseSnapshot, readDenseSnapshot } from "../src/embed/dense-file";
import { probeHelper, startHelper, type Embedder, type HelperHandle } from "../src/embed/helper";
import { encodeMessage, parseRequest, parseResponse } from "../src/embed/protocol";
import { createHarnessFixture, fixtureMemory, type HarnessFixture } from "./helpers/snapshot-fixture";

const VECTORS: Record<string, number[]> = {
  "m-alpha": [1, 0, 0, 0],
  "m-beta": [0, 1, 0, 0],
  "m-gamma": [0.7, 0.7, 0, 0],
};

const fakeEmbedder: Embedder = {
  model: "fake-4d",
  async embedQuery(text: string): Promise<Float32Array> {
    if (text.includes("alpha")) return new Float32Array([1, 0, 0, 0]);
    if (text.includes("beta")) return new Float32Array([0, 1, 0, 0]);
    return new Float32Array([0.6, 0.6, 0.1, 0]);
  },
};

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("dense.v1.bin codec", () => {
  test("round-trips header and matrix and ranks by cosine similarity", () => {
    const header = { schema: "dense.v1" as const, built_at: "2026-11-08T00:00:00.000Z", db_generation: 3, model: "fake-4d", dims: 4, dtype: "float32" as const, ids: Object.keys(VECTORS) };
    const buffer = encodeDenseSnapshot(header, Object.values(VECTORS));
    const decoded = decodeDenseSnapshot(buffer)!;
    expect(decoded.header).toEqual(header);
    expect(decoded.rows).toBe(3);
    expect(decoded.dims).toBe(4);
    expect(Array.from(decoded.data.subarray(0, 4))).toEqual([1, 0, 0, 0]);
    expect(decoded.norms[2]).toBeCloseTo(Math.hypot(0.7, 0.7), 5);

    const top = denseTopK(decoded, [1, 0, 0, 0], 2);
    expect(top.ids).toEqual(["m-alpha", "m-gamma"]);
    expect(top.scores[0]).toBeCloseTo(1, 6);
    expect(top.scores[1]).toBeCloseTo(Math.SQRT1_2, 5);
    expect(denseTopK(decoded, [1, 0, 0], 2)).toEqual({ ids: [], scores: [] });
    expect(denseTopK(decoded, [0, 0, 0, 0], 2)).toEqual({ ids: [], scores: [] });

    expect(decodeDenseSnapshot(Buffer.alloc(2))).toBeNull();
    expect(decodeDenseSnapshot(buffer.subarray(0, buffer.length - 8))).toBeNull();
    expect(() => encodeDenseSnapshot(header, [[1, 0, 0, 0]])).toThrow(/vectors/);
  });

  test("protocol helpers clamp and validate", () => {
    expect(parseRequest('{"op":"topk","text":"x","k":999}')).toEqual({ op: "topk", text: "x", k: 50 });
    expect(parseRequest('{"op":"nope"}')).toBeNull();
    expect(parseRequest("garbage")).toBeNull();
    expect(parseResponse('{"ok":true,"ids":["a",1],"scores":[0.5,"x"]}')).toEqual({ ok: true, ids: ["a"], scores: [0.5] });
    expect(parseResponse('{"nope":1}')).toBeNull();
    expect(encodeMessage({ op: "ping" })).toBe('{"op":"ping"}\n');
  });
});

describe("embedding helper over a real socket", () => {
  let fixture: HarnessFixture | null = null;
  let handle: HelperHandle | null = null;

  afterEach(async () => {
    await handle?.close();
    handle = null;
    fixture?.cleanup();
    fixture = null;
  });

  test("answers ping / topk / embed through queryDense and reloads the dense file when it changes", async () => {
    fixture = createHarnessFixture({
      memories: Object.keys(VECTORS).map((id) => fixtureMemory({ id, lifecycle_triggers: ["before_model"] })),
      dense: { dims: 4, model: "fake-4d", vectors: VECTORS },
    });
    const exits: number[] = [];
    handle = await startHelper({ paths: fixture.paths, config: fixture.config, embedder: fakeEmbedder, idleMs: 60_000, exit: (code) => exits.push(code), signals: false });
    expect(existsSync(fixture.paths.embedHelperPid)).toBe(true);
    expect(readFileSync(fixture.paths.embedHelperPid, "utf8").trim()).toBe(String(process.pid));
    expect(await probeHelper(handle.socketPath)).toBe(true);

    const hits = await queryDense(fixture.paths, { text: "alpha please", k: 2, timeoutMs: 2_000 });
    expect(hits).toEqual({ ids: ["m-alpha", "m-gamma"], scores: [expect.closeTo(1, 5), expect.closeTo(Math.SQRT1_2, 5)] });

    const client = createDenseClient(fixture.paths, { timeoutMs: 2_000 });
    const beta = await client.topk("beta", 1);
    expect(beta?.ids).toEqual(["m-beta"]);

    const embed = await requestHelper(handle.socketPath, { op: "embed", text: "alpha" }, 2_000);
    expect(embed.response).toMatchObject({ ok: true, vector: [1, 0, 0, 0], model: "fake-4d", dims: 4 });

    const bad = await requestHelper(handle.socketPath, { op: "topk" }, 2_000);
    expect(bad.response).toMatchObject({ ok: false, error: "missing_text" });

    // Reload: swap the dense file for a single-row matrix with a newer mtime.
    const header = { schema: "dense.v1" as const, built_at: "x", db_generation: 9, model: "fake-4d", dims: 4, dtype: "float32" as const, ids: ["m-beta"] };
    const { writeFileSync } = await import("node:fs");
    writeFileSync(fixture.paths.snapshotDense, encodeDenseSnapshot(header, [[0, 1, 0, 0]]));
    const future = new Date(Date.now() + 5_000);
    utimesSync(fixture.paths.snapshotDense, future, future);
    const reloaded = await queryDense(fixture.paths, { text: "alpha", k: 3, timeoutMs: 2_000 });
    expect(reloaded?.ids).toEqual(["m-beta"]);
    expect(handle.requests).toBeGreaterThanOrEqual(5);
    expect(exits).toEqual([]);
  });

  test("exits after the idle timeout and removes its pid file", async () => {
    fixture = createHarnessFixture({ memories: [] });
    const exits: number[] = [];
    handle = await startHelper({ paths: fixture.paths, config: fixture.config, embedder: fakeEmbedder, idleMs: 150, exit: (code) => exits.push(code), signals: false });
    const ping = await requestHelper(handle.socketPath, { op: "ping" }, 2_000);
    expect(ping.response).toMatchObject({ ok: true, rows: 0 });
    await waitFor(() => exits.length > 0, 5_000);
    expect(exits).toEqual([0]);
    expect(handle.closed).toBe(true);
    expect(existsSync(fixture.paths.embedHelperPid)).toBe(false);
    expect(await probeHelper(handle.socketPath, 300)).toBe(false);
  });

  test("a second helper on the same socket exits 0 instead of fighting the first", async () => {
    fixture = createHarnessFixture({ memories: [] });
    const exits: number[] = [];
    handle = await startHelper({ paths: fixture.paths, config: fixture.config, embedder: fakeEmbedder, idleMs: 60_000, exit: (code) => exits.push(code), signals: false });
    const second = await startHelper({ paths: fixture.paths, config: fixture.config, embedder: fakeEmbedder, idleMs: 60_000, exit: (code) => exits.push(code), signals: false });
    expect(second.closed).toBe(true);
    expect(exits).toEqual([0]);
    expect(await probeHelper(handle.socketPath)).toBe(true);
  });
});

describe("client fallback without a helper", () => {
  let fixture: HarnessFixture | null = null;

  afterEach(() => {
    fixture?.cleanup();
    fixture = null;
  });

  test("queryDense returns null, spawns the helper once per minute and never throws", async () => {
    fixture = createHarnessFixture({ memories: [] });
    const spawns: Array<{ script: string; args: readonly string[] }> = [];
    const spawn = (script: string, args: readonly string[]): number => {
      spawns.push({ script, args });
      return 77;
    };
    const nowMs = Date.parse("2026-11-08T12:00:00.000Z");
    const first = await queryDense(fixture.paths, { text: "alpha", k: 3, timeoutMs: 500, ensure: { spawn, scriptPath: "/dist/embed-helper.js", nowMs } });
    expect(first).toBeNull();
    expect(spawns).toEqual([{ script: "/dist/embed-helper.js", args: [fixture.root] }]);
    expect(existsSync(spawnTouchFile(fixture.paths))).toBe(true);

    const second = await queryDense(fixture.paths, { text: "alpha", k: 3, timeoutMs: 500, ensure: { spawn, scriptPath: "/dist/embed-helper.js", nowMs: nowMs + 10_000 } });
    expect(second).toBeNull();
    expect(spawns).toHaveLength(1);

    const old = new Date(nowMs - 120_000);
    utimesSync(spawnTouchFile(fixture.paths), old, old);
    expect(ensureHelper(fixture.paths, { spawn, scriptPath: "/dist/embed-helper.js", nowMs })).toBe(true);
    expect(spawns).toHaveLength(2);
    expect(statSync(spawnTouchFile(fixture.paths)).mtimeMs).toBeGreaterThan(old.getTime());

    const disabled = createDenseClient(fixture.paths, { timeoutMs: 200, ensure: false });
    expect(await disabled.topk("alpha", 1)).toBeNull();
    expect(spawns).toHaveLength(2);
  });

  test("readDenseSnapshot tolerates a missing file", () => {
    fixture = createHarnessFixture({ memories: [] });
    expect(readDenseSnapshot(fixture.paths.snapshotDense)).toBeNull();
  });
});

describe("socket location stays under the unix socket path limit", () => {
  // 74 bytes of ASCII root (the macOS example from the review) and a Hangul root that is short in
  // characters but long in UTF-8 bytes: both would overflow sun_path if the socket sat under the repo.
  const deepAsciiRoot = "/Users/firstname.lastname/Developer/company-org/service-repository-name";
  const deepHangulRoot = "/Users/사용자이름/개발/회사조직/서비스저장소이름/하위패키지/아주깊은디렉터리";
  const macTmp = "/var/folders/zz/zyxvpxvq6csfxvn_n0000000000000/T";

  test("Windows keeps the named pipe keyed by repoHash", () => {
    const hash = repoHash(deepAsciiRoot);
    expect(embedHelperSocketPath(hash, { platform: "win32", env: { XDG_RUNTIME_DIR: "/run/user/1000" } })).toBe(`\\\\.\\pipe\\harness-memory-embed-${hash}`);
  });

  test("POSIX uses $XDG_RUNTIME_DIR, else the temp dir, never a path under the repository", () => {
    const hash = repoHash(deepAsciiRoot);
    expect(embedHelperSocketPath(hash, { platform: "linux", env: { XDG_RUNTIME_DIR: "/run/user/1000" }, tmpDir: "/tmp" })).toBe(`/run/user/1000/harness-memory-embed-${hash}.sock`);
    expect(embedHelperSocketPath(hash, { platform: "linux", env: { XDG_RUNTIME_DIR: "" }, tmpDir: "/tmp" })).toBe(`/tmp/harness-memory-embed-${hash}.sock`);
    expect(embedHelperSocketPath(hash, { platform: "darwin", env: {}, tmpDir: macTmp })).toBe(`${macTmp}/harness-memory-embed-${hash}.sock`);
    expect(embedHelperSocketPath(hash, { platform: "darwin", env: {}, tmpDir: macTmp })).not.toContain(deepAsciiRoot);
  });

  test("the socket path length does not depend on the repository path", () => {
    for (const platform of ["linux", "darwin"] as const) {
      const tmpDir = platform === "darwin" ? macTmp : "/tmp";
      const shallow = embedHelperSocketPath(repoHash("/srv/app"), { platform, env: {}, tmpDir });
      const ascii = embedHelperSocketPath(repoHash(deepAsciiRoot), { platform, env: {}, tmpDir });
      const hangul = embedHelperSocketPath(repoHash(deepHangulRoot), { platform, env: {}, tmpDir });
      for (const socketPath of [shallow, ascii, hangul]) {
        expect(Buffer.byteLength(socketPath, "utf8")).toBe(Buffer.byteLength(shallow, "utf8"));
        expect(unixSocketPathTooLong(socketPath, platform)).toBe(false);
      }
      expect(new Set([shallow, ascii, hangul]).size).toBe(3);
    }
  });

  test("unixSocketPathTooLong counts UTF-8 bytes against sizeof(sun_path) - 1 per platform", () => {
    expect(unixSocketPathMaxBytes("linux")).toBe(107);
    expect(unixSocketPathMaxBytes("darwin")).toBe(103);
    expect(unixSocketPathTooLong("/" + "x".repeat(106), "linux")).toBe(false);
    expect(unixSocketPathTooLong("/" + "x".repeat(107), "linux")).toBe(true);
    expect(unixSocketPathTooLong("/" + "x".repeat(102), "darwin")).toBe(false);
    expect(unixSocketPathTooLong("/" + "x".repeat(103), "darwin")).toBe(true);
    // 35 Hangul syllables are 105 bytes: too long on macOS although far under 103 characters.
    const hangul = "/" + "가".repeat(35);
    expect(hangul.length).toBeLessThan(103);
    expect(unixSocketPathTooLong(hangul, "darwin")).toBe(true);
    expect(unixSocketPathTooLong(hangul, "linux")).toBe(false);
    // The old location would have overflowed for the review's example repository.
    expect(unixSocketPathTooLong(`${deepAsciiRoot}/.harness-memory/locks/embed-helper.sock`, "darwin")).toBe(true);
  });

  test("resolvePaths gives a deep checkout a usable rendezvous point on this platform", () => {
    const root = join(tmpdir(), "hm-deep", "a".repeat(60), "b".repeat(60), "c".repeat(60), "service-repository-name");
    const paths = resolvePaths(root);
    expect(paths.embedHelperSocket.startsWith(paths.root)).toBe(false);
    expect(paths.embedHelperSocket).toContain(`harness-memory-embed-${repoHash(root)}`);
    if (process.platform === "win32") {
      expect(paths.embedHelperSocket).toMatch(/^\\\\\.\\pipe\\harness-memory-embed-[0-9a-f]{16}$/);
    } else {
      expect(unixSocketPathTooLong(paths.embedHelperSocket)).toBe(false);
      expect(paths.embedHelperSocket.startsWith(process.env.XDG_RUNTIME_DIR || tmpdir())).toBe(true);
    }
  });

  test("the helper refuses an over-long socket path loudly instead of binding to a truncated name", async () => {
    const fixture = createHarnessFixture({ memories: [] });
    try {
      const exits: number[] = [];
      const logs: string[] = [];
      const socketPath = "/" + "x".repeat(120);
      const handle = await startHelper({ paths: fixture.paths, config: fixture.config, embedder: fakeEmbedder, idleMs: 60_000, exit: (code) => exits.push(code), log: (line) => logs.push(line), signals: false, socketPath });
      expect(exits).toEqual([1]);
      expect(handle.closed).toBe(true);
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatch(/socket path is 121 bytes, over the \d+-byte unix socket limit/);
      expect(logs[0]).toContain(socketPath);
      expect(existsSync(fixture.paths.embedHelperPid)).toBe(false);
      await handle.close();
    } finally {
      fixture.cleanup();
    }
  });
});
