/**
 * `hm doctor` on a healthy and a broken install (missing node path, stale lock, pending migration,
 * --fix, --host-debug) and `hm status` output shape against a seeded database, synthetic hooks.log and
 * worker.log lines.
 */

import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import type { DoctorReport } from "../src/cli/commands/doctor";
import type { StatusReport } from "../src/cli/commands/status";
import { readGitTrackedFiles } from "../src/cli/lib/diagnostics";
import type { InstallManifest } from "../src/cli/lib/manifest";
import { STATE_GITIGNORE_CONTENT } from "../src/cli/lib/paths";
import { listHarnessHooks } from "../src/cli/lib/settings";
import { createCliStore } from "../src/cli/lib/store";
import { loadConfig } from "../src/core/config";
import { LOCK_OWNER_FILE } from "../src/db/locks";
import { ExtractionRunRepository } from "../src/db/repositories/runs";
import { MemoryRepository } from "../src/memory/repository";
import { createCliProject, runHm, type CliProject } from "./helpers/cli-run";
import { LEGACY_FIXTURES } from "./helpers/create-test-db";
import { humanMemory, insertEpisode } from "./helpers/memory-fixtures";

const NOW = "2026-11-08T12:00:00.000Z";
const NOW_MS = Date.parse(NOW);

let project: CliProject;

beforeEach(() => {
  project = createCliProject();
});

afterEach(() => {
  project.cleanup();
});

async function install(): Promise<void> {
  const result = await runHm(project, ["install", "--host", "claude", "--skip-probe", "--skip-self-test"]);
  expect(result.code).toBe(0);
}

function checkOf(report: DoctorReport, id: string) {
  const check = report.checks.find((entry) => entry.id === id);
  if (check === undefined) throw new Error(`no check ${id} in ${report.checks.map((entry) => entry.id).join(", ")}`);
  return check;
}

async function seedDatabase(): Promise<void> {
  const store = createCliStore({ paths: project.paths, config: loadConfig(project.paths.config), clock: () => NOW });
  await store.withWriteLock("seed", 5_000, (db) => {
    const memories = new MemoryRepository(db, { clock: () => NOW });
    memories.create(humanMemory({ summary: "Run the seed before tests", status: "active", lifecycleTriggers: ["before_tool"], type: "pitfall", scopeGlob: "**/*" }));
    memories.create(humanMemory({ summary: "Prefer vitest", status: "active", lifecycleTriggers: ["session_start"], type: "decision" }));
    memories.create(humanMemory({ summary: "A candidate", status: "candidate", lifecycleTriggers: ["before_model"] }));
    const episode = insertEpisode(db, {}, NOW);
    const runs = new ExtractionRunRepository(db);
    runs.start({ id: "run-1", episodeId: episode.id, provider: "claude", extractorVersion: "v1", promptSha256: "a".repeat(64), inputChars: 100, startedAt: "2026-11-08T10:00:00.000Z" });
    runs.finish("run-1", { status: "ok", finishedAt: "2026-11-08T10:00:05.000Z", factsTotal: 1, factsAccepted: 1 });
    return { id: "seed:1", kind: "seed", noop: false, wrote: true };
  });
}

function writeHookLog(durations: readonly number[]): void {
  mkdirSync(project.paths.logsDir, { recursive: true });
  const lines = durations.map((dur, index) => `2026-11-08T11:00:${String(index).padStart(2, "0")}.000Z pre-tool tool=bash gen=1 activated=0 suppressed=0 decision=none delivery=none enforcement=- dur=${dur}ms ok`);
  lines.push("2026-11-08T11:30:00.000Z session-start tool=- gen=1 activated=0 suppressed=0 decision=none delivery=none enforcement=- dur=12ms ok");
  appendFileSync(project.paths.hooksLog, `${lines.join("\n")}\n`);
}

describe("hm status", () => {
  test("prints the one-line summary from the database, the hooks log and the worker log", async () => {
    await install();
    await seedDatabase();
    writeHookLog([10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
    mkdirSync(project.paths.logsDir, { recursive: true });
    appendFileSync(project.paths.workerLog, "2026-11-08T11:40:00.000Z extract lease loop=0 queued=1 inserted=1 fires=0 leased=0 skipped=0 waiting=not_logged_in\n");
    writeFileSync(join(project.paths.queueDir, "ep-x.json"), "{}");

    const text = await runHm(project, ["status"], { clock: () => NOW, seams: { nowMs: () => NOW_MS } });
    expect(text.code).toBe(0);
    expect(text.stdout.split("\n")[0]).toBe("active 2 (auto 0) | candidates 1 | proposals 0 | queue 1 (waiting: not_logged_in) | last extraction 1h ago ok | probe none | snapshot fresh | p95 100ms");

    const json = await runHm(project, ["status", "--json"], { clock: () => NOW, seams: { nowMs: () => NOW_MS } });
    expect(json.code).toBe(0);
    const report = json.json<StatusReport>();
    expect(report.counts).toEqual({ active: 2, auto_active: 0, candidates: 1, open_proposals: 0, expiring_7d: 0, queue: 1, unreachable: 0 });
    expect(report.last_extraction).toMatchObject({ run_id: "run-1", status: "ok", provider: "claude", ago: "1h ago" });
    expect(report.snapshot.state).toBe("fresh");
    expect(report.hooks).toEqual({ calls: 11, p95_ms: 100, p95_all_ms: 100 });
    expect(report.waiting).toBe("not_logged_in");
    expect(report.user_version).toBe(22);
    expect(report.problem).toBeNull();
  });

  test("reports a stale snapshot after the database file changed behind it", async () => {
    await install();
    appendFileSync(project.paths.db, Buffer.alloc(4096));
    const result = await runHm(project, ["status", "--json"]);
    expect(result.json<StatusReport>().snapshot.state).toBe("stale");
    expect(result.stdout).toContain('"line": "active 0 (auto 0) | candidates 0 | proposals 0 | queue 0 | last extraction never | probe none | snapshot stale | p95 -"');
  });

  test("explains a missing install and a pending migration", async () => {
    const missing = await runHm(project, ["status"]);
    expect(missing.code).toBe(1);
    expect(missing.stdout).toContain("not installed");

    mkdirSync(project.paths.dir, { recursive: true });
    copyFileSync(LEGACY_FIXTURES.v9, project.paths.db);
    const legacy = await runHm(project, ["status", "--json"]);
    expect(legacy.code).toBe(0);
    const report = legacy.json<StatusReport>();
    expect(report.migration_needed).toBe(true);
    expect(report.user_version).toBe(9);
    expect(report.counts).toBeNull();
    expect(report.line).toContain("migration pending");
  });
});

describe("hm doctor", () => {
  test("a fresh install has no failures and reports the install facts", async () => {
    await install();
    const result = await runHm(project, ["doctor", "--json"], { clock: () => NOW, seams: { nowMs: () => NOW_MS } });
    expect(result.code).toBe(0);
    const report = result.json<DoctorReport>();
    expect(report.ok).toBe(true);
    expect(report.summary.fail).toBe(0);
    expect(checkOf(report, "install.manifest").status).toBe("ok");
    expect(checkOf(report, "install.settings").status).toBe("ok");
    expect(checkOf(report, "install.node").status).toBe("ok");
    expect(checkOf(report, "install.hook_script").status).toBe("ok");
    expect(checkOf(report, "db.file").status).toBe("ok");
    expect(checkOf(report, "db.file").summary).toContain("v22");
    expect(checkOf(report, "snapshot.active").status).toBe("ok");
    expect(checkOf(report, "locks.db").status).toBe("ok");
    expect(checkOf(report, "locks.worker").status).toBe("ok");
    expect(checkOf(report, "hooks.calls").status).toBe("warn");
    expect(checkOf(report, "extraction.probe").status).toBe("info");
    expect(checkOf(report, "env.node").status).toBe("ok");

    const text = await runHm(project, ["doctor"]);
    expect(text.code).toBe(0);
    expect(text.stdout).toContain("OK    install.manifest");
    expect(text.stdout).toMatch(/\d+ ok, \d+ warnings, 0 failures/);
  });

  test("with embeddings enabled the embeddings check names the helper rendezvous point", async () => {
    await install();
    const config = JSON.parse(readFileSync(project.paths.config, "utf8")) as Record<string, unknown>;
    const embeddings = (config.embeddings ?? {}) as Record<string, unknown>;
    writeFileSync(project.paths.config, `${JSON.stringify({ ...config, embeddings: { ...embeddings, enabled: true } }, null, 2)}\n`);
    const result = await runHm(project, ["doctor", "--json"], { clock: () => NOW, seams: { nowMs: () => NOW_MS } });
    expect(result.code).toBe(0);
    const check = checkOf(result.json<DoctorReport>(), "embeddings");
    expect(check.status).toBe("info");
    expect(check.summary).toContain(`rendezvous ${project.paths.embedHelperSocket}`);
    expect(check.summary).toContain("helper not running");
  });

  test("flags a vanished node binary and a stale lock; --fix rewrites the hooks and rebuilds the snapshot", async () => {
    await install();
    const manifest = JSON.parse(readFileSync(project.paths.manifest, "utf8")) as InstallManifest;
    const goneNode = join(project.root, "gone", "node.exe");
    writeFileSync(project.paths.manifest, JSON.stringify({ ...manifest, node: goneNode }));
    const settingsFile = manifest.settings_file;
    const settings = JSON.parse(readFileSync(settingsFile, "utf8")) as { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> };
    for (const groups of Object.values(settings.hooks)) for (const group of groups) for (const hook of group.hooks) hook.command = goneNode;
    writeFileSync(settingsFile, JSON.stringify(settings));
    mkdirSync(project.paths.dbLock, { recursive: true });
    writeFileSync(join(project.paths.dbLock, LOCK_OWNER_FILE), JSON.stringify({ pid: 999_999, hostname: "elsewhere", purpose: "extract", started_at: "2026-11-08T00:00:00.000Z", heartbeat_at: "2026-11-08T00:00:00.000Z" }));
    writeHookLog([150, 160]);

    const broken = await runHm(project, ["doctor", "--json"], { clock: () => NOW, seams: { nowMs: () => NOW_MS } });
    expect(broken.code).toBe(1);
    const report = broken.json<DoctorReport>();
    expect(report.ok).toBe(false);
    expect(checkOf(report, "install.node").status).toBe("fail");
    expect(checkOf(report, "install.node").summary).toContain("--fix");
    expect(checkOf(report, "install.settings").status).toBe("ok");
    expect(checkOf(report, "locks.db").status).toBe("warn");
    expect(checkOf(report, "locks.db").summary).toContain("999999");
    expect(checkOf(report, "hooks.p95").status).toBe("warn");
    expect(checkOf(report, "hooks.calls").detail?.some((line) => line.startsWith("pre-tool"))).toBe(true);

    const fixed = await runHm(project, ["doctor", "--fix", "--json"], { clock: () => NOW, seams: { nowMs: () => NOW_MS } });
    expect(fixed.code).toBe(0);
    const fixedReport = fixed.json<DoctorReport>();
    expect(fixedReport.fixes.some((fix) => fix.startsWith("rewrote 9 hook entries"))).toBe(true);
    expect(fixedReport.fixes.some((fix) => fix.startsWith("rebuilt the snapshot"))).toBe(true);
    expect(checkOf(fixedReport, "install.node").status).toBe("ok");
    expect(checkOf(fixedReport, "locks.db").status).toBe("ok");
    const entries = listHarnessHooks(JSON.parse(readFileSync(settingsFile, "utf8")) as Record<string, unknown>);
    expect(entries.every((entry) => entry.node === process.execPath)).toBe(true);
    expect((JSON.parse(readFileSync(project.paths.manifest, "utf8")) as InstallManifest).node).toBe(process.execPath);
  });

  test("reports a pending migration, unreachable memories after a rebuild, and scans a host debug log", async () => {
    await install();
    copyFileSync(LEGACY_FIXTURES.v9, project.paths.db);
    const pending = await runHm(project, ["doctor", "--json"]);
    const pendingReport = pending.json<DoctorReport>();
    expect(checkOf(pendingReport, "db.file").status).toBe("warn");
    expect(checkOf(pendingReport, "db.file").summary).toContain("v9");
    expect(checkOf(pendingReport, "snapshot.active").status).toBe("warn");

    const debugLog = join(project.root, "claude-debug.log");
    writeFileSync(debugLog, ["hook PreToolUse finished with status 0", "hook Stop finished with status 0", "hook PreToolUse finished with status 1", "unrelated"].join("\n"));
    const fixed = await runHm(project, ["doctor", "--fix", "--host-debug", debugLog, "--json"]);
    const fixedReport = fixed.json<DoctorReport>();
    expect(fixedReport.fixes.some((fix) => fix.includes("migrated v9 → v22"))).toBe(true);
    expect(checkOf(fixedReport, "db.file").status).toBe("ok");
    expect(checkOf(fixedReport, "host.debug").status).toBe("warn");
    expect(checkOf(fixedReport, "host.debug").summary).toContain("status 0 ×2");
    expect(checkOf(fixedReport, "host.debug").summary).toContain("status 1 ×1");
    expect(existsSync(project.paths.dbBackup(9))).toBe(true);
  });

  test("checks the git footprint: .harness-memory/.gitignore, files git tracks there, the exclude line; --fix rewrites a missing .gitignore", async () => {
    await install();
    const healthy = (await runHm(project, ["doctor", "--json"], { seams: { gitTrackedFiles: () => [] } })).json<DoctorReport>();
    expect(checkOf(healthy, "install.state_ignore").status).toBe("ok");
    expect(checkOf(healthy, "install.state_ignore").summary).toContain("nothing tracked");
    expect(checkOf(healthy, "install.git_exclude").status).toBe("ok");
    expect(checkOf(healthy, "install.git_exclude").summary).toContain(join(project.root, ".git", "info", "exclude"));

    // Committed before the ignore file existed (a v0.5 install, say): the ignore file does not untrack them, so say so.
    const trackedFiles = [".harness-memory/memory.sqlite", ".harness-memory/ledger/claude-code-0123456789abcdef.jsonl"];
    const tracked = (await runHm(project, ["doctor", "--json"], { seams: { gitTrackedFiles: () => trackedFiles } })).json<DoctorReport>();
    expect(checkOf(tracked, "install.state_ignore").status).toBe("warn");
    expect(checkOf(tracked, "install.state_ignore").summary).toContain("2 files are tracked by git under .harness-memory/");
    expect(checkOf(tracked, "install.state_ignore").summary).toContain("git rm -r --cached .harness-memory");
    expect(checkOf(tracked, "install.state_ignore").detail).toEqual(trackedFiles);

    const gitignore = join(project.paths.dir, ".gitignore");
    rmSync(gitignore);
    writeFileSync(join(project.root, ".git", "info", "exclude"), "node_modules\n");
    const missing = (await runHm(project, ["doctor", "--json"], { seams: { gitTrackedFiles: () => null } })).json<DoctorReport>();
    expect(checkOf(missing, "install.state_ignore").status).toBe("warn");
    expect(checkOf(missing, "install.state_ignore").summary).toContain("--fix");
    expect(checkOf(missing, "install.git_exclude").status).toBe("warn");
    expect(checkOf(missing, "install.git_exclude").summary).toContain("re-run");

    const fixed = (await runHm(project, ["doctor", "--fix", "--json"], { seams: { gitTrackedFiles: () => null } })).json<DoctorReport>();
    expect(fixed.fixes.some((fix) => fix.startsWith(`wrote ${gitignore}`))).toBe(true);
    expect(readFileSync(gitignore, "utf8")).toBe(STATE_GITIGNORE_CONTENT);
    expect(checkOf(fixed, "install.state_ignore").status).toBe("ok");
    expect(checkOf(fixed, "install.state_ignore").summary).not.toContain("nothing tracked");
  });

  test("readGitTrackedFiles answers null outside a repository and lists tracked paths inside one", () => {
    // The temp project carries a bare `.git/info/` directory, which git does not accept as a repository.
    expect(readGitTrackedFiles(project.root, ".harness-memory")).toBeNull();
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const tracked = readGitTrackedFiles(repoRoot, "src/cli/lib");
    if (tracked !== null) expect(tracked).toContain("src/cli/lib/paths.ts");
  });

  test("without an install everything downstream fails clearly and --self-test uses the seam", async () => {
    const result = await runHm(project, ["doctor", "--self-test", "--json"], {
      seams: { selfTest: () => ({ ok: true, event: "session-start", exitCode: 0, signal: null, logEntry: null, stdout: "{}", stderr: "", error: null, durationMs: 7 }) },
    });
    expect(result.code).toBe(1);
    const report = result.json<DoctorReport>();
    expect(checkOf(report, "install.manifest").status).toBe("fail");
    expect(checkOf(report, "db.file").status).toBe("fail");
    expect(report.self_test?.ok).toBe(true);
  });
});
