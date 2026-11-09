/**
 * Operations suite (spec §13.4): twenty hook processes appending to one session ledger while a CLI-style
 * promote loop rewrites the database and the snapshot under them — zero lost lines, zero torn lines, zero
 * deadlocks (every process exits 0 inside the timeout) — and `exit 75` when the database lock is busy.
 * The process variant uses the built `dist/hook.js` (skipped until `npm run build`); an in-process variant
 * drives `main()` twenty times concurrently and runs on every machine.
 */

import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { runCli } from "../src/cli/main";
import { describeFailure } from "../src/cli/lib/store";
import { DEFAULT_CONFIG, type HarnessConfig } from "../src/core/config";
import { LockBusyError } from "../src/core/errors";
import { ledgerFile, resolvePaths, sessionKey, stateDirectories, type HarnessPaths } from "../src/core/paths";
import { acquireDirLock } from "../src/db/locks";
import { getDbGeneration } from "../src/db/meta";
import { parseLedger } from "../src/dream/ledger";
import { composeStore, silentWorkerLogger } from "../src/dream/worker";
import { main } from "../src/hook";
import { MemoryRepository } from "../src/memory/repository";
import { derivedRulesConsistent } from "../src/policy/derive";
import { transitionMemory } from "../src/promotion/transitions";
import { autoMemory, humanMemory } from "./helpers/memory-fixtures";

const DIST = resolve(__dirname, "..", "dist");
const built = existsSync(join(DIST, "hook.js")) && existsSync(join(DIST, "hook-bundle.js"));
const HOOKS = 20;
const PROMOTES = 8;
const NOW = "2026-11-08T12:00:00.000Z";

let base: string;
let root: string;
let paths: HarnessPaths;
let config: HarnessConfig;
let hookCopy: string;

function clock(): string {
  return new Date().toISOString();
}

async function seedProject(): Promise<void> {
  for (const dir of stateDirectories(paths)) mkdirSync(dir, { recursive: true });
  config = structuredClone(DEFAULT_CONFIG);
  writeFileSync(paths.config, JSON.stringify(config), "utf8");
  const store = composeStore({ paths, config, logger: silentWorkerLogger, clock });
  await store.withWriteLock("seed", 5_000, (db) => {
    const memories = new MemoryRepository(db);
    memories.create(humanMemory({ type: "policy", summary: "Never commit .env files", scopeGlob: "**/*", lifecycleTriggers: ["before_tool"], enforcement: "confirm", policySubtype: "hard", triggerSignature: { tool: "write|edit", target: "path", pattern_kind: "glob", pattern: "**/.env*" } }));
    for (let index = 0; index < 10; index += 1) {
      memories.create(autoMemory({ status: "active", summary: `Seeded pitfall ${String(index)} about scripts`, triggerSignature: { tool: "bash", target: "command", pattern_kind: "cmd", pattern: `npm run script-${String(index)}` }, signatureKey: `bash|command|cmd|pm script-${String(index)}` }));
    }
    return { id: null, kind: "seed", noop: false, wrote: true };
  });
}

/** A copy of the launcher + bundle whose sibling worker.js is missing: a stale-snapshot reindex spawn dies at once instead of running a real worker. */
function copyHookLauncher(): string {
  const pkg = join(base, "pkg", "dist");
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(base, "pkg", "package.json"), JSON.stringify({ name: "harness-memory-copy", type: "module" }), "utf8");
  copyFileSync(join(DIST, "hook.js"), join(pkg, "hook.js"));
  copyFileSync(join(DIST, "hook-bundle.js"), join(pkg, "hook-bundle.js"));
  return join(pkg, "hook.js");
}

/** The promote loop a CLI user would run: create a candidate and promote it, each in its own lock session. */
async function promoteLoop(count: number, waitMs: number): Promise<string[]> {
  const store = composeStore({ paths, config, logger: silentWorkerLogger, clock });
  const promoted: string[] = [];
  for (let index = 0; index < count; index += 1) {
    await store.withWriteLock("promote", waitMs, (db, ctx) => {
      const memories = new MemoryRepository(db, { clock: () => ctx.now });
      const candidate = memories.create(autoMemory({ summary: `Promoted during the parallel run ${String(index)}`, triggerSignature: { tool: "bash", target: "command", pattern_kind: "cmd", pattern: `npm run promote-${String(index)}` } }));
      transitionMemory(db, { memoryId: candidate.id, to: "active", actor: "human", reason: "ops test promote loop", now: ctx.now });
      promoted.push(candidate.id);
      return { id: `promote:${String(index)}`, kind: "promote", noop: false, wrote: true };
    });
  }
  return promoted;
}

function postToolStdin(index: number): string {
  return JSON.stringify({
    session_id: "parallel",
    cwd: root,
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_input: { command: `echo ${String(index)}`, description: "parallel" },
    tool_use_id: `par-${String(index)}`,
    tool_response: `ok ${String(index)}`,
  });
}

function runHookProcess(script: string, event: string, stdin: string): Promise<{ code: number | null; stdout: string; stderr: string; ms: number }> {
  return new Promise((resolveRun) => {
    const started = Date.now();
    const env = { ...process.env };
    delete env.HARNESS_MEMORY_DISABLE;
    delete env.HARNESS_MEMORY_DEBUG;
    const child = spawn(process.execPath, [script, event], { cwd: root, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    const timer = setTimeout(() => child.kill(), 30_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolveRun({ code, stdout, stderr, ms: Date.now() - started });
    });
    child.stdin.end(stdin);
  });
}

function ledgerToolUseIds(): { ids: string[]; badLines: number } {
  const file = ledgerFile(paths, "claude-code", sessionKey("claude-code", "parallel"));
  const parsed = parseLedger(readFileSync(file));
  return { ids: parsed.lines.filter((line) => line.kind === "tool_ok").map((line) => (line.kind === "tool_ok" ? String(line.tool_use_id) : "")), badLines: parsed.badLines };
}

beforeEach(async () => {
  base = mkdtempSync(join(tmpdir(), "hm-ops-par-"));
  root = join(base, "project");
  mkdirSync(root, { recursive: true });
  paths = resolvePaths(root);
  await seedProject();
  hookCopy = built ? copyHookLauncher() : "";
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe.skipIf(!built)("20 parallel hook processes + promote loop (dist/hook.js)", () => {
  test(
    "every tool_ok line lands intact, every process exits 0, the promote loop completes",
    async () => {
      const processes = Array.from({ length: HOOKS }, (_unused, index) => runHookProcess(hookCopy, "post-tool", postToolStdin(index)));
      const preTool = runHookProcess(hookCopy, "pre-tool", JSON.stringify({ session_id: "parallel", cwd: root, hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: join(root, ".env"), content: "x" }, tool_use_id: "par-pre" }));
      const promoted = await promoteLoop(PROMOTES, 30_000);
      const results = await Promise.all([...processes, preTool]);

      const exits = results.map((result) => result.code);
      expect(exits, results.map((result) => `${String(result.code)}:${result.stderr.slice(0, 200)}`).join("\n")).toEqual(Array(HOOKS + 1).fill(0));
      for (const result of results) expect(() => JSON.parse(result.stdout)).not.toThrow();
      expect(Math.max(...results.map((result) => result.ms))).toBeLessThan(30_000);

      const ledger = ledgerToolUseIds();
      expect(ledger.badLines).toBe(0);
      expect([...ledger.ids].sort()).toEqual(Array.from({ length: HOOKS }, (_unused, index) => `par-${String(index)}`).sort());

      const log = readFileSync(paths.hooksLog, "utf8").trimEnd().split("\n");
      const postToolLines = log.filter((line) => line.includes(" post-tool "));
      expect(postToolLines).toHaveLength(HOOKS);
      expect(log.filter((line) => / error:/.test(line))).toEqual([]);
      expect(log.filter((line) => line.includes(" pre-tool ") && line.includes("decision=ask"))).toHaveLength(1);

      expect(promoted).toHaveLength(PROMOTES);
      const store = composeStore({ paths, config, logger: silentWorkerLogger, clock });
      await store.read((db) => {
        const memories = new MemoryRepository(db);
        expect(promoted.every((id) => memories.getById(id)?.status === "active")).toBe(true);
        expect(derivedRulesConsistent(db)).toBe(true);
        expect(getDbGeneration(db)).toBe(1 + PROMOTES);
      });
      const snapshot = JSON.parse(readFileSync(paths.snapshotActive, "utf8")) as { db_generation: number; memories: unknown[] };
      expect(snapshot.db_generation).toBe(1 + PROMOTES);
      expect(snapshot.memories).toHaveLength(11 + PROMOTES);
      expect(existsSync(paths.dbLock)).toBe(false);
    },
    120_000
  );
});

describe("20 concurrent in-process hook runs + promote loop", () => {
  test(
    "no line is lost or torn and no hook errors while the database and snapshot are rewritten",
    async () => {
      const io = (stdin: string) => ({
        readStdin: async () => stdin,
        writeStdout: () => undefined,
        env: {},
        cwd: () => root,
        clock,
        spawnWorker: null,
        dense: null,
      });
      const hooks = Array.from({ length: HOOKS }, (_unused, index) => main(["post-tool"], io(postToolStdin(index))));
      const promoted = await promoteLoop(4, 30_000);
      const outcomes = await Promise.all(hooks);
      expect(outcomes.map((outcome) => outcome.result?.status)).toEqual(Array(HOOKS).fill("ok"));
      const ledger = ledgerToolUseIds();
      expect(ledger.badLines).toBe(0);
      expect([...ledger.ids].sort()).toEqual(Array.from({ length: HOOKS }, (_unused, index) => `par-${String(index)}`).sort());
      expect(promoted).toHaveLength(4);
    },
    60_000
  );
});

describe("database lock busy", () => {
  test(
    "a writer meeting a held db.lock gets LockBusyError → exit 75; the CLI reports it the same way",
    async () => {
      const held = await acquireDirLock(paths.dbLock, { purpose: "ops-test", waitMs: 0, now: clock });
      try {
        const store = composeStore({ paths, config, logger: silentWorkerLogger, clock });
        const error = await store.withWriteLock("promote", 300, () => ({ id: null, kind: "promote", noop: false, wrote: true })).catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(LockBusyError);
        const failure = describeFailure(error);
        expect(failure.exitCode).toBe(75);
        expect(failure.message).toContain("ops-test");

        let stderr = "";
        const code = await runCli(["snapshot:rebuild", "--root", root], { cwd: root, env: {}, isTTY: false, streams: { stdout: () => undefined, stderr: (text) => (stderr += text) } });
        expect(code).toBe(75);
        expect(stderr).toContain("database lock is busy");
      } finally {
        held.release();
      }
      // Released: the same write goes through.
      const store = composeStore({ paths, config, logger: silentWorkerLogger, clock });
      const result = await store.withWriteLock("promote", 300, () => ({ id: null, kind: "promote", noop: false, wrote: true }));
      expect(result.saved).toBe(true);
    },
    30_000
  );
});
