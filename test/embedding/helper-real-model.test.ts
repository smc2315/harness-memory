/**
 * Tier 2 — the v0.6 idle-exit embedding helper end to end with the real `Xenova/multilingual-e5-small`
 * model (run via `npm run test:embedding`, never part of `npm test`; `vitest.config.ts` excludes test/embedding).
 *
 *   1. six English memories are inserted into a real `memory.sqlite` through the CLI/worker Store and embedded
 *      through the worker's own pass (selectEmbeddingBacklog → embedBacklog with createCliEmbed's `passage:`
 *      embedder → applyEmbeddings under the write lock → the snapshot builder writes `snapshot/dense.v1.bin`);
 *   2. the helper is started in-process (startHelper, default lazy transformers embedder) on the production
 *      rendezvous path of its temp project, `paths.embedHelperSocket` — the named pipe / runtime-dir socket keyed
 *      by the temp root's repoHash, hence unique to this run — and queried through `requestHelper` / `createDenseClient`;
 *   3. a Korean query must rank the semantically matching English memory first (rank-based), and the primary
 *      Korean → English pair must score ≥ DENSE_HIT_THRESHOLD, the hook's injection condition. That is not optional:
 *      the model is pinned (quantized, no remote download), so a lower score is a regression (threshold raised,
 *      e5 prefix dropped, memory text changed), not tolerance;
 *   4. helper cold start (first topk = model load + inference) and warm topk latency are measured, and the warm
 *      distribution is gated against `before_model.dense_timeout_ms`: median within the budget, p95 within
 *      budget × SLOW_RUNNER_FACTOR;
 *   5. the real `prompt` hook core (`runHook`) must inject the English memory for the Korean prompt — first through
 *      an injected generous-budget DenseClient (is the injection right?), then through the production runtime
 *      (`createRuntime` with its default client on `paths.embedHelperSocket` and the unscaled 80 ms budget: is it
 *      fast enough for a real prompt?);
 *   6. idle exit with a short `idleMs` through the `exit` option;
 *   7. the hook's spawn-on-miss leg: `queryDense` against a project with no helper listening stamps
 *      `locks/embed-helper.spawn` and spawns `dist/embed-helper.js` detached through the real `spawnDetached`;
 *      that helper must come up on `paths.embedHelperSocket`, answer ping and a cold topk, log its listening line,
 *      and is then stopped by the pid it wrote to `locks/embed-helper.pid` — the only process this suite ever
 *      signals. `dist/embed-helper.js` must be newer than every source bundled into it (a stale bundle fails, it
 *      never silently tests old code); when it is missing the suite fails under CI (`CI` set) and otherwise skips
 *      only that test with a printed reason.
 *
 * The model must already be in the cache shared with the runtime helper (model-cache.ts: `embeddings.cache_dir`,
 * default `~/.harness-memory/models`; `HARNESS_MEMORY_HOME` moves it). When it is absent the suite fails fast
 * naming that directory instead of downloading or hanging; with the cache present no network is used.
 */

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { DENSE_HIT_THRESHOLD } from "../../src/activation/before-model";
import { createRuntime, runHook } from "../../src/adapters/hook-core";
import { normalizeClaudeCode } from "../../src/adapters/hosts/claude-code";
import { createCliStore } from "../../src/cli/lib/store";
import { createCliEmbed } from "../../src/cli/lib/worker-run";
import { DEFAULT_CONFIG, mergeConfig, type HarnessConfig } from "../../src/core/config";
import type { ClaudeCodeHookStdin } from "../../src/core/hook-types";
import { resolvePaths, stateDirectories, type HarnessPaths } from "../../src/core/paths";
import { isProcessAlive } from "../../src/core/process";
import type { Store } from "../../src/db/store";
import { applyEmbeddings, embedBacklog, selectEmbeddingBacklog } from "../../src/dream/consolidate";
import { createDenseClient, queryDense, requestHelper, spawnTouchFile } from "../../src/embed/client";
import { readDenseSnapshot } from "../../src/embed/dense-file";
import { probeHelper, startHelper, type HelperHandle } from "../../src/embed/helper";
import { MemoryRepository } from "../../src/memory/repository";
import { requireCachedModel } from "./model-cache";

const REPO_ROOT = resolve(__dirname, "..", "..");
const DIST_HELPER = join(REPO_ROOT, "dist", "embed-helper.js");
const distBuilt = existsSync(DIST_HELPER);
/** `CI` as GitHub Actions and the other hosted runners set it ("true"); "0" / "false" count as unset. */
const ciValue = (process.env.CI ?? "").trim().toLowerCase();
const inCI = ciValue !== "" && ciValue !== "0" && ciValue !== "false";
/**
 * Sources of dist/embed-helper.js used when the bundle carries no `// src/...` section comments (tsup/esbuild
 * emit them for an unminified build; `bundledSources` prefers those because they list exactly what was bundled).
 */
const HELPER_SOURCES_FALLBACK = [
  "src/embed-helper.ts",
  "src/embed/client.ts",
  "src/embed/dense-file.ts",
  "src/embed/helper.ts",
  "src/embed/protocol.ts",
  "src/core/config.ts",
  "src/core/paths.ts",
  "src/core/process.ts",
];

/** The English memories; `key` names them in the assertions. Text embedded = `summary\ndetails` (selectEmbeddingBacklog). */
const MEMORIES = [
  { key: "docker", summary: "Never run docker system prune on the shared build host", details: "It deletes images and volumes other pipelines still need; clean only your own containers." },
  { key: "sql", summary: "Use parameterized SQL queries instead of string concatenation", details: "Never concatenate user input into SQL strings; use $-prefixed placeholders." },
  { key: "tests", summary: "Run npm test before every commit", details: "The pre-commit hook does not run the suite, so run it yourself." },
  { key: "branches", summary: "Use feature/, fix/ and chore/ prefixes for git branch names", details: "Branches without a prefix are rejected by the CI naming check." },
  { key: "typescript", summary: "Always enable TypeScript strict mode with noImplicitAny and strictNullChecks", details: "Every package in the monorepo extends the strict base tsconfig." },
  { key: "keys", summary: "Rotate the API keys stored in the vault every ninety days", details: "Expired keys break the nightly deploy; set a calendar reminder." },
] as const;

type MemoryKey = (typeof MEMORIES)[number]["key"];

/** Korean queries and the English memory each must rank first. */
const QUERIES: ReadonlyArray<{ text: string; expected: MemoryKey }> = [
  { text: "공유 빌드 서버에서 도커 정리 좀 해줘", expected: "docker" },
  { text: "타입스크립트 엄격 모드 설정", expected: "typescript" },
  { text: "깃 브랜치 이름 규칙", expected: "branches" },
];
const PRIMARY_QUERY = QUERIES[0]!;

const WARM_REQUESTS = 20;
const GENEROUS_TIMEOUT_MS = 90_000;
/**
 * Warm topk is judged against `before_model.dense_timeout_ms` (80 ms): the median must fit the budget itself and
 * p95 the budget × this factor. The factor absorbs the hosted CI runners (shared 2–4 vCPU VMs whose timings swing
 * by tens of milliseconds; see the header of .github/workflows/ci.yml); a developer machine sits far below both
 * (median ≈ 6–8 ms, max ≈ 12 ms on Windows 11 / Node 24). The production-runtime hook test still holds one real
 * prompt to the unscaled budget: a miss there is exactly what a user's prompt would get (no dense leg).
 */
const SLOW_RUNNER_FACTOR = 3;

interface TempProject {
  root: string;
  paths: HarnessPaths;
}

const projects: TempProject[] = [];

function createProject(tag: string, config: HarnessConfig): TempProject {
  const root = mkdtempSync(join(tmpdir(), `hm-embed-${tag}-`));
  const paths = resolvePaths(root);
  for (const dir of stateDirectories(paths)) mkdirSync(dir, { recursive: true });
  writeFileSync(paths.config, JSON.stringify(config, null, 2), "utf8");
  const project = { root, paths };
  projects.push(project);
  return project;
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs: number, what: string): Promise<void> {
  const started = Date.now();
  while (!(await predicate())) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out after ${String(timeoutMs)} ms waiting for ${what}`);
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 50));
  }
}

/** Waits for a helper to answer `ping` on `socket`; a timeout reports the project's worker.log (the helper's only output). */
async function waitForHelper(socket: string, workerLog: string, timeoutMs: number): Promise<void> {
  try {
    await waitFor(() => probeHelper(socket, 500), timeoutMs, `a helper on ${socket}`);
  } catch (error) {
    const log = existsSync(workerLog) ? readFileSync(workerLog, "utf8") : "(no worker.log)";
    throw new Error(`${error instanceof Error ? error.message : String(error)}; worker.log: ${log}`);
  }
}

function percentile(values: readonly number[], p: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[rank]!;
}

function fmt(ms: number): string {
  return `${ms.toFixed(1)} ms`;
}

function describeRanking(ids: readonly string[], scores: readonly number[], idToKey: ReadonlyMap<string, string>): string {
  return ids.map((id, index) => `${idToKey.get(id) ?? id.slice(0, 8)}(${(scores[index] ?? 0).toFixed(3)})`).join(", ");
}

function readPidFile(file: string): number | null {
  try {
    const pid = Number(readFileSync(file, "utf8").trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/** The sources bundled into dist/embed-helper.js, read from its `// src/...` section comments, else the fallback list. */
function bundledSources(): string[] {
  const found = new Set<string>();
  for (const match of readFileSync(DIST_HELPER, "utf8").matchAll(/^\/\/ (src\/\S+\.ts)\s*$/gm)) found.add(match[1]!);
  return [...(found.size > 0 ? found : HELPER_SOURCES_FALLBACK)].map((source) => join(REPO_ROOT, source));
}

/** The newest of `files`; a file that no longer exists (renamed since the build) counts as infinitely new: the bundle is stale. */
function newestOf(files: readonly string[]): { file: string; mtimeMs: number } {
  let newest = { file: "(none)", mtimeMs: Number.NEGATIVE_INFINITY };
  for (const file of files) {
    let mtimeMs = Number.POSITIVE_INFINITY;
    try {
      mtimeMs = statSync(file).mtimeMs;
    } catch {
      // missing source: handled by the infinite mtime
    }
    if (mtimeMs > newest.mtimeMs) newest = { file, mtimeMs };
  }
  return newest;
}

function stamp(mtimeMs: number): string {
  return Number.isFinite(mtimeMs) ? new Date(mtimeMs).toISOString() : "missing";
}

/**
 * Stops the helper the spawn-on-miss test started detached for `project`: only the pid in that project's own
 * `locks/embed-helper.pid` (written by the helper itself, under a temp root this run created) is ever signalled —
 * SIGTERM on POSIX (the helper unlinks its socket and pid file), TerminateProcess on Windows. No-op when nothing
 * of ours is alive, so a successful run never waits here.
 */
async function stopDetachedHelper(project: TempProject | null): Promise<string> {
  if (project === null) return "no detached helper";
  const pid = readPidFile(project.paths.embedHelperPid);
  if (pid === null) return "no pid file";
  if (pid === process.pid || !isProcessAlive(pid)) return `pid ${String(pid)} already gone`;
  process.kill(pid);
  await waitFor(() => !isProcessAlive(pid), 10_000, `helper pid ${String(pid)} to exit`);
  return `stopped pid ${String(pid)}`;
}

describe("Tier 2: embedding helper with the real multilingual-e5-small model", () => {
  const config: HarnessConfig = mergeConfig(DEFAULT_CONFIG, { embeddings: { enabled: true, idle_exit_minutes: 1 } });
  const denseBudgetMs = config.before_model.dense_timeout_ms;

  let project: TempProject;
  let store: Store;
  let helper: HelperHandle | null = null;
  const idToKey = new Map<string, MemoryKey>();
  const keyToId = new Map<MemoryKey, string>();
  const measurements: Record<string, number> = {};
  let primaryTopScore = Number.NaN;

  let idleHelper: HelperHandle | null = null;
  /** The project whose helper the spawn-on-miss test starts detached; set to null once that test stopped it itself. */
  let spawnProject: TempProject | null = null;

  beforeAll(async () => {
    requireCachedModel({ model: config.embeddings.model, cacheDir: config.embeddings.cache_dir });
    if (!distBuilt) {
      const hint = `${DIST_HELPER} is missing: run \`npm run build\` before \`npm run test:embedding\``;
      if (inCI) throw new Error(`Tier-2 helper test: ${hint}; under CI the dist/embed-helper.js spawn test must run, not skip`);
      console.warn(`[helper] ${hint}; the dist/embed-helper.js spawn test is skipped`);
    }
    project = createProject("project", config);
    store = createCliStore({ paths: project.paths, config, clock: () => new Date().toISOString() });
    // No socketPath override: the helper binds the production rendezvous path for this temp root.
    helper = await startHelper({ paths: project.paths, config, idleMs: 10 * 60_000, signals: false, exit: (code) => {
      throw new Error(`the main helper called exit(${String(code)}) during the test`);
    }, log: (line) => console.log(`[helper main] ${line}`) });
  }, 120_000);

  afterAll(async () => {
    await helper?.close();
    await idleHelper?.close();
    console.log(`[helper] detached helper cleanup: ${await stopDetachedHelper(spawnProject)}`);
    for (const temp of projects) {
      try {
        rmSync(temp.root, { recursive: true, force: true });
      } catch {
        // a lingering handle on Windows: the temp dir is cleaned by the OS later
      }
    }
    console.log(`[helper] measurements ${JSON.stringify(measurements)}`);
  });

  test("the worker's embedding pass writes dense.v1.bin for six English memories (real passage embeddings)", async () => {
    await store.withWriteLock("seed", 5_000, (db, write) => {
      const repository = new MemoryRepository(db, { clock: () => write.now });
      for (const memory of MEMORIES) {
        // The state an extraction-born row has (reconcile: global scope → activation_class 'scoped'), so the
        // prompt hook reaches it through retrieval (lexical / dense) rather than as an always-on baseline row.
        const record = repository.create({
          type: "pitfall",
          summary: memory.summary,
          details: memory.details,
          scopeGlob: "**/*",
          activationClass: "scoped",
          lifecycleTriggers: ["before_model"],
          status: "active",
          authority: "auto",
          sourceKind: "extraction",
          knowledgeKind: "correction",
          sourceRef: "episode:tier2",
        });
        idToKey.set(record.id, memory.key);
        keyToId.set(memory.key, record.id);
      }
      return { id: `seed:${write.now}`, kind: "seed", noop: false, wrote: true };
    });
    expect(existsSync(project.paths.snapshotActive)).toBe(true);
    expect(existsSync(project.paths.snapshotDense)).toBe(false);

    // Same sequence as embedNewRows in src/dream/worker.ts: read the backlog, run the model without the lock, store under the lock.
    const embed = createCliEmbed(config);
    expect(embed).not.toBeNull();
    const items = await store.read((db) => selectEmbeddingBacklog(new MemoryRepository(db)));
    expect(items).toHaveLength(MEMORIES.length);
    const started = performance.now();
    const computed = await embedBacklog(embed!, items);
    measurements.passage_embed_pass_ms = performance.now() - started;
    expect(computed.errors).toEqual([]);
    expect(computed.vectors.size).toBe(MEMORIES.length);
    const write = await store.withWriteLock("embed", 5_000, (db) => {
      const embedded = applyEmbeddings(new MemoryRepository(db), items, computed.vectors);
      return { id: null, kind: "embed", noop: embedded === 0, wrote: embedded > 0 };
    });
    expect(write.saved).toBe(true);
    expect(write.snapshotBuilt).toBe(true);
    console.log(`[helper] worker embedding pass (model load + ${String(MEMORIES.length)} passages, test process): ${fmt(measurements.passage_embed_pass_ms)}`);

    const dense = readDenseSnapshot(project.paths.snapshotDense);
    expect(dense).not.toBeNull();
    expect(dense!.rows).toBe(MEMORIES.length);
    expect(dense!.dims).toBe(384);
    expect(dense!.header.model).toBe(config.embeddings.model);
    expect(new Set(dense!.header.ids)).toEqual(new Set(idToKey.keys()));
    for (let row = 0; row < dense!.rows; row += 1) expect(dense!.norms[row]).toBeCloseTo(1, 2);
  }, 120_000);

  test("the in-process helper listens on the production rendezvous path (paths.embedHelperSocket), wrote its pid file and answers ping with the row count", async () => {
    expect(helper).not.toBeNull();
    const socket = project.paths.embedHelperSocket;
    expect(helper!.socketPath).toBe(socket);
    // Keyed by repoHash, outside the repository (sun_path limit), a pipe on Windows and a socket file elsewhere.
    expect(socket.startsWith(project.root)).toBe(false);
    if (process.platform === "win32") expect(socket).toMatch(/^\\\\\.\\pipe\\harness-memory-embed-[0-9a-f]{16}$/);
    else expect(existsSync(socket)).toBe(true);
    expect(readFileSync(project.paths.embedHelperPid, "utf8").trim()).toBe(String(process.pid));
    expect(await probeHelper(socket, 2_000)).toBe(true);
    const ping = await requestHelper(socket, { op: "ping" }, 2_000);
    expect(ping.response).toMatchObject({ ok: true, model: config.embeddings.model, rows: MEMORIES.length, dims: 384 });
  });

  test("cold start: the first topk loads the model and ranks the Korean docker query (measured)", async () => {
    const started = performance.now();
    const { response, errorCode } = await requestHelper(project.paths.embedHelperSocket, { op: "topk", text: PRIMARY_QUERY.text, k: MEMORIES.length }, GENEROUS_TIMEOUT_MS);
    measurements.helper_cold_start_ms = performance.now() - started;
    console.log(`[helper] cold start (first topk: model load + inference, in-process helper): ${fmt(measurements.helper_cold_start_ms)}`);
    expect(errorCode).toBeNull();
    expect(response).not.toBeNull();
    expect(response!.ok).toBe(true);
    expect(response!.rows).toBe(MEMORIES.length);
    expect(response!.ids).toHaveLength(MEMORIES.length);
    expect(response!.model).toBe(config.embeddings.model);
    primaryTopScore = response!.scores![0]!;
    console.log(`[helper] "${PRIMARY_QUERY.text}" → ${describeRanking(response!.ids!, response!.scores!, idToKey)}`);
    expect(idToKey.get(response!.ids![0]!)).toBe(PRIMARY_QUERY.expected);
  }, 120_000);

  test("Korean queries rank the semantically matching English memory first (rank-based)", async () => {
    for (const query of QUERIES) {
      const hits = await requestHelper(project.paths.embedHelperSocket, { op: "topk", text: query.text, k: MEMORIES.length }, 10_000);
      expect(hits.response?.ok).toBe(true);
      const ids = hits.response!.ids!;
      const scores = hits.response!.scores!;
      console.log(`[helper] "${query.text}" → ${describeRanking(ids, scores, idToKey)}`);
      expect(idToKey.get(ids[0]!)).toBe(query.expected);
      // The scores are sorted and the winner is separated from the runner-up (not an exact value: model-dependent).
      expect(scores[0]!).toBeGreaterThan(scores[1]!);
    }
  }, 60_000);

  test("the primary Korean → English pair clears DENSE_HIT_THRESHOLD, the hook's injection condition (pinned model: lower is a regression)", () => {
    console.log(`[helper] primary query top score ${primaryTopScore.toFixed(4)} vs DENSE_HIT_THRESHOLD ${String(DENSE_HIT_THRESHOLD)} (margin ${(primaryTopScore - DENSE_HIT_THRESHOLD).toFixed(4)})`);
    expect(
      primaryTopScore,
      `"${PRIMARY_QUERY.text}" → ${PRIMARY_QUERY.expected} scored ${primaryTopScore.toFixed(4)}, under DENSE_HIT_THRESHOLD ${String(DENSE_HIT_THRESHOLD)}: before_model would suppress the row as retrieval_miss. ` +
        `The quantized model is pinned (0.8197 on every recorded run), so look for a raised threshold, a dropped e5 "query: " / "passage: " prefix or changed memory text.`
    ).toBeGreaterThanOrEqual(DENSE_HIT_THRESHOLD);
  });

  test("warm topk latency through the client fits the hook budget (median ≤ dense_timeout_ms, p95 ≤ budget × SLOW_RUNNER_FACTOR)", async () => {
    const client = createDenseClient(project.paths, { timeoutMs: 10_000, ensure: false });
    const latencies: number[] = [];
    for (let index = 0; index < WARM_REQUESTS; index += 1) {
      const query = QUERIES[index % QUERIES.length]!;
      const started = performance.now();
      const hits = await client.topk(query.text, 5);
      latencies.push(performance.now() - started);
      expect(hits).not.toBeNull();
      expect(hits!.ids).toHaveLength(5);
    }
    const median = percentile(latencies, 50);
    const p95 = percentile(latencies, 95);
    const max = Math.max(...latencies);
    measurements.warm_topk_median_ms = median;
    measurements.warm_topk_p95_ms = p95;
    measurements.warm_topk_max_ms = max;
    console.log(`[helper] warm topk ×${String(WARM_REQUESTS)}: median ${fmt(median)}, p95 ${fmt(p95)}, max ${fmt(max)}; hook budget before_model.dense_timeout_ms = ${String(denseBudgetMs)} ms (p95 bound ${String(denseBudgetMs * SLOW_RUNNER_FACTOR)} ms)`);
    expect(median, `warm topk median ${fmt(median)} is over the ${String(denseBudgetMs)} ms dense budget: most production prompts would lose the dense leg`).toBeLessThanOrEqual(denseBudgetMs);
    expect(p95, `warm topk p95 ${fmt(p95)} is over ${String(denseBudgetMs)} ms × ${String(SLOW_RUNNER_FACTOR)}`).toBeLessThanOrEqual(denseBudgetMs * SLOW_RUNNER_FACTOR);
  }, 60_000);

  test("the prompt hook core injects the English memory for the Korean prompt through the DenseClient (generous budget: is the injection right?)", async () => {
    const dense = createDenseClient(project.paths, { timeoutMs: 5_000, ensure: false });
    const runtime = createRuntime(project.paths, config, { clock: () => new Date().toISOString(), spawnWorker: null, dense });
    const stdin: ClaudeCodeHookStdin = { session_id: "tier2-helper", cwd: project.root, hook_event_name: "UserPromptSubmit", prompt: PRIMARY_QUERY.text, prompt_id: "tier2-p1" };
    const input = normalizeClaudeCode(stdin, "prompt");
    expect(input).not.toBeNull();
    const result = await runHook("prompt", input!, runtime);
    expect(result.status).toBe("ok");
    expect(result.detail.dense).toBe(true);
    expect(result.detail.lexical).toBe(true);
    const dockerId = keyToId.get("docker")!;
    expect(result.activated, `the docker memory was not injected; suppressed: ${JSON.stringify(result.detail.suppressed)}`).toContain(dockerId);
    expect(result.additionalContext).toContain(MEMORIES[0].summary);
    console.log(`[helper] prompt hook (injected client): dense hit ${primaryTopScore.toFixed(3)} ≥ ${String(DENSE_HIT_THRESHOLD)} → activated ${String(result.activated.length)}, additionalContext ${String(result.additionalContext?.length ?? 0)} chars`);
  }, 60_000);

  test("the production runtime (createRuntime's default client on paths.embedHelperSocket, the 80 ms budget) gets the dense hit and injects the memory", async () => {
    // Exactly what dist/hook.js builds: createDenseClient(paths, { timeoutMs: before_model.dense_timeout_ms }) on
    // the production path, spawn-on-miss enabled (a miss here is ETIMEDOUT, which never spawns, and the helper is up).
    const runtime = createRuntime(project.paths, config, { clock: () => new Date().toISOString(), spawnWorker: null });
    expect(runtime.dense).not.toBeNull();
    const stdin: ClaudeCodeHookStdin = { session_id: "tier2-helper-production", cwd: project.root, hook_event_name: "UserPromptSubmit", prompt: PRIMARY_QUERY.text, prompt_id: "tier2-p2" };
    const input = normalizeClaudeCode(stdin, "prompt");
    expect(input).not.toBeNull();
    const started = performance.now();
    const result = await runHook("prompt", input!, runtime);
    measurements.production_prompt_hook_ms = performance.now() - started;
    console.log(`[helper] prompt hook (production runtime, ${String(denseBudgetMs)} ms dense budget): dense=${String(result.detail.dense)} activated ${String(result.activated.length)} in ${fmt(measurements.production_prompt_hook_ms)}`);
    expect(result.status).toBe("ok");
    expect(result.detail.dense, `the warm helper did not answer within before_model.dense_timeout_ms = ${String(denseBudgetMs)} ms: a real prompt would silently lose the dense leg`).toBe(true);
    expect(result.activated).toContain(keyToId.get("docker")!);
    expect(result.additionalContext).toContain(MEMORIES[0].summary);
  }, 60_000);

  test("a helper with a short idleMs exits through the exit option, removes its pid file and releases its path", async () => {
    const idleProject = createProject("idle", config);
    const idleSocket = idleProject.paths.embedHelperSocket;
    expect(idleSocket).not.toBe(project.paths.embedHelperSocket);
    const exits: number[] = [];
    const logs: string[] = [];
    idleHelper = await startHelper({ paths: idleProject.paths, config, idleMs: 2_000, signals: false, exit: (code) => exits.push(code), log: (line) => logs.push(line) });
    expect(idleHelper.socketPath).toBe(idleSocket);
    expect(existsSync(idleProject.paths.embedHelperPid)).toBe(true);
    const ping = await requestHelper(idleSocket, { op: "ping" }, 2_000);
    expect(ping.response).toMatchObject({ ok: true, rows: 0 });
    const started = performance.now();
    await waitFor(() => exits.length > 0, 15_000, "the idle exit");
    measurements.idle_exit_after_ms = performance.now() - started;
    expect(exits).toEqual([0]);
    expect(idleHelper.closed).toBe(true);
    expect(existsSync(idleProject.paths.embedHelperPid)).toBe(false);
    expect(await probeHelper(idleSocket, 500)).toBe(false);
    if (process.platform !== "win32") expect(existsSync(idleSocket)).toBe(false);
    expect(logs.some((line) => line.includes("idle for 2000 ms; exiting"))).toBe(true);
    console.log(`[helper] idle exit fired ${fmt(measurements.idle_exit_after_ms)} after the last request (idleMs 2000)`);
  }, 30_000);

  test.skipIf(!distBuilt)("spawn-on-miss: queryDense with no helper listening stamps locks/embed-helper.spawn and spawns dist/embed-helper.js detached; it answers on paths.embedHelperSocket until stopped by the pid it wrote", async () => {
    // The bundle must be newer than every source bundled into it, or this test would exercise stale code.
    const distMtime = statSync(DIST_HELPER).mtimeMs;
    const newest = newestOf(bundledSources());
    expect(
      distMtime,
      `dist/embed-helper.js (${stamp(distMtime)}) is older than ${newest.file} (${stamp(newest.mtimeMs)}): run \`npm run build\` before \`npm run test:embedding\` so this test exercises the current sources`
    ).toBeGreaterThanOrEqual(newest.mtimeMs);

    const spawned = createProject("spawn", config);
    spawnProject = spawned;
    const socket = spawned.paths.embedHelperSocket;
    expect(socket).not.toBe(project.paths.embedHelperSocket);
    // Give it the dense file this run produced so its first topk measures a true cold start (node boot, bundle, model).
    copyFileSync(project.paths.snapshotDense, spawned.paths.snapshotDense);
    expect(await probeHelper(socket, 500)).toBe(false);
    expect(existsSync(spawnTouchFile(spawned.paths))).toBe(false);

    // The hook's own path (src/embed/client.ts queryDense → ensureHelper → core/process spawnDetached, cwd = root):
    // no listener (ENOENT) → the throttle file is stamped, the bundle is spawned detached, this call returns null
    // and the prompt goes on without a dense leg. Only the script path differs from production, where
    // `embedHelperScriptPath()` resolves embed-helper.js next to the hook bundle.
    const spawnedAt = performance.now();
    const miss = await queryDense(spawned.paths, { text: PRIMARY_QUERY.text, k: 3, timeoutMs: denseBudgetMs, ensure: { scriptPath: DIST_HELPER } });
    expect(miss).toBeNull();
    expect(existsSync(spawnTouchFile(spawned.paths))).toBe(true);

    await waitForHelper(socket, spawned.paths.workerLog, 30_000);
    measurements.spawned_ready_ms = performance.now() - spawnedAt;
    const pid = readPidFile(spawned.paths.embedHelperPid);
    expect(pid).not.toBeNull();
    expect(pid).not.toBe(process.pid);
    expect(isProcessAlive(pid!)).toBe(true);
    const ping = await requestHelper(socket, { op: "ping" }, 2_000);
    expect(ping.response).toMatchObject({ ok: true, model: config.embeddings.model, rows: MEMORIES.length, dims: 384 });
    expect(readFileSync(spawned.paths.workerLog, "utf8")).toContain(`embed-helper embedding helper listening on ${socket}`);

    const coldStarted = performance.now();
    const cold = await requestHelper(socket, { op: "topk", text: PRIMARY_QUERY.text, k: 3 }, GENEROUS_TIMEOUT_MS);
    measurements.spawned_cold_topk_ms = performance.now() - coldStarted;
    expect(cold.response?.ok).toBe(true);
    expect(idToKey.get(cold.response!.ids![0]!)).toBe(PRIMARY_QUERY.expected);
    // Warm, through the same client call the hook makes against the detached process (generous timeout, median gated).
    const client = createDenseClient(spawned.paths, { timeoutMs: 10_000, ensure: false });
    const warm: number[] = [];
    for (let index = 0; index < 10; index += 1) {
      const started = performance.now();
      const hits = await client.topk(PRIMARY_QUERY.text, 3);
      warm.push(performance.now() - started);
      expect(hits?.ids[0]).toBe(keyToId.get(PRIMARY_QUERY.expected));
    }
    measurements.spawned_warm_topk_median_ms = percentile(warm, 50);
    expect(measurements.spawned_warm_topk_median_ms).toBeLessThanOrEqual(denseBudgetMs);
    console.log(`[helper] detached dist/embed-helper.js (pid ${String(pid!)}): ready for ping ${fmt(measurements.spawned_ready_ms)} after the miss, cold topk ${fmt(measurements.spawned_cold_topk_ms)}, warm topk median ${fmt(measurements.spawned_warm_topk_median_ms)}`);

    // Stop it by the pid it wrote — the only process this suite signals — and check the rendezvous path is released.
    process.kill(pid!);
    await waitFor(() => !isProcessAlive(pid!), 10_000, `helper pid ${String(pid!)} to exit`);
    await waitFor(async () => !(await probeHelper(socket, 300)), 5_000, "the rendezvous path to be released");
    if (process.platform !== "win32") {
      // SIGTERM reaches the helper's shutdown: socket file and pid file unlinked, "stopped" logged (TerminateProcess
      // on Windows gives the helper no chance; the pipe is released by the OS and the pid file goes with the temp dir).
      expect(existsSync(socket)).toBe(false);
      expect(existsSync(spawned.paths.embedHelperPid)).toBe(false);
      expect(readFileSync(spawned.paths.workerLog, "utf8")).toContain("embed-helper embedding helper stopped");
    }
    spawnProject = null;
    console.log(`[helper] detached helper pid ${String(pid!)} stopped by the pid from ${spawned.paths.embedHelperPid}; path released`);
  }, 120_000);
});
