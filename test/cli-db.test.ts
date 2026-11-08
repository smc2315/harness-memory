/**
 * `hm db:migrate` (legacy v9 fixture → v21 with a .bak-v9), `hm db:rollback` (restores the backup after
 * confirmation), `hm snapshot:rebuild`, and the dispatcher itself (help, version, unknown command,
 * not-in-this-build commands, unknown options, --db resolution).
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import type { MigrateReport } from "../src/cli/commands/db-migrate";
import type { RollbackReport } from "../src/cli/commands/db-rollback";
import type { SnapshotRebuildReport } from "../src/cli/commands/snapshot-rebuild";
import { runCli } from "../src/cli/main";
import { COMMANDS, implementedCommands } from "../src/cli/registry";
import { TARGET_USER_VERSION } from "../src/core/paths";
import { loadSqlJs } from "../src/db/sqlite";
import { createCliProject, runHm, type CliProject } from "./helpers/cli-run";
import { LEGACY_FIXTURES } from "./helpers/create-test-db";

let project: CliProject;

beforeEach(() => {
  project = createCliProject();
});

afterEach(() => {
  project.cleanup();
});

async function userVersionOf(file: string): Promise<number> {
  const SQL = await loadSqlJs();
  const db = new SQL.Database(readFileSync(file));
  try {
    return Number(db.exec("PRAGMA user_version")[0]!.values[0]![0]);
  } finally {
    db.close();
  }
}

describe("hm db:migrate", () => {
  test("upgrades a real v0.5 database, keeps a .bak-v9 copy and builds the snapshot; a second run is a no-op", async () => {
    mkdirSync(project.paths.dir, { recursive: true });
    copyFileSync(LEGACY_FIXTURES.v9, project.paths.db);

    const first = await runHm(project, ["db:migrate", "--json"]);
    expect(first.code).toBe(0);
    const report = first.json<MigrateReport>();
    expect(report.from).toBe(9);
    expect(report.to).toBe(TARGET_USER_VERSION);
    expect(report.applied.length).toBeGreaterThan(5);
    expect(report.backup).toBe(project.paths.dbBackup(9));
    expect(report.snapshot_built).toBe(true);
    expect(readFileSync(project.paths.dbBackup(9)).equals(readFileSync(LEGACY_FIXTURES.v9))).toBe(true);
    expect(await userVersionOf(project.paths.db)).toBe(TARGET_USER_VERSION);
    expect(existsSync(project.paths.snapshotActive)).toBe(true);

    const second = await runHm(project, ["db:migrate"]);
    expect(second.code).toBe(0);
    expect(second.stdout).toContain("nothing to migrate");
  });

  test("creates a fresh database when none exists", async () => {
    const result = await runHm(project, ["db:migrate", "--json"]);
    expect(result.code).toBe(0);
    expect(result.json<MigrateReport>().from).toBe(0);
    expect(await userVersionOf(project.paths.db)).toBe(TARGET_USER_VERSION);
  });
});

describe("hm db:rollback", () => {
  test("needs --yes without a terminal, refuses unknown versions and restores the chosen backup", async () => {
    mkdirSync(project.paths.dir, { recursive: true });
    copyFileSync(LEGACY_FIXTURES.v9, project.paths.db);
    expect((await runHm(project, ["db:migrate"])).code).toBe(0);
    const migratedBytes = readFileSync(project.paths.db);

    const noConfirm = await runHm(project, ["db:rollback"]);
    expect(noConfirm.code).toBe(2);
    expect(noConfirm.stderr).toContain("--yes");
    expect(await userVersionOf(project.paths.db)).toBe(TARGET_USER_VERSION);

    const declined = await runHm(project, ["db:rollback"], { isTTY: true, confirm: async () => false });
    expect(declined.code).toBe(1);
    expect(await userVersionOf(project.paths.db)).toBe(TARGET_USER_VERSION);

    const unknown = await runHm(project, ["db:rollback", "--to", "77", "--yes"]);
    expect(unknown.code).toBe(2);

    const restored = await runHm(project, ["db:rollback", "--yes", "--json"]);
    expect(restored.code).toBe(0);
    const report = restored.json<RollbackReport>();
    expect(report.backup_version).toBe(9);
    expect(report.restored_from).toBe(project.paths.dbBackup(9));
    expect(readFileSync(project.paths.db).equals(readFileSync(LEGACY_FIXTURES.v9))).toBe(true);
    expect(await userVersionOf(project.paths.db)).toBe(9);
    expect(report.previous_copy).not.toBeNull();
    expect(readFileSync(report.previous_copy!).equals(migratedBytes)).toBe(true);
    expect(existsSync(project.paths.snapshotActive)).toBe(false);
    expect(existsSync(project.paths.dbPrev)).toBe(false);
    expect(existsSync(project.paths.dbBackup(9))).toBe(true);
    expect(existsSync(project.paths.dbLock)).toBe(false);
  });

  test("reports when there is nothing to roll back to", async () => {
    const result = await runHm(project, ["db:rollback", "--yes"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("no memory.sqlite.bak-v<N> backup");
  });
});

describe("hm snapshot:rebuild", () => {
  test("writes the snapshot files and reports counts", async () => {
    expect((await runHm(project, ["db:migrate"])).code).toBe(0);
    for (const name of readdirSync(project.paths.snapshotDir)) expect(name).toMatch(/\.v1\.(json|bin)$/);
    const result = await runHm(project, ["snapshot:rebuild", "--json"]);
    expect(result.code).toBe(0);
    const report = result.json<SnapshotRebuildReport>();
    expect(report.built).toBe(true);
    expect(report.counts).toMatchObject({ active: 0, candidates: 0, queue: 0 });
    expect(report.files.map((file) => file.path).sort()).toEqual([project.paths.snapshotActive, project.paths.snapshotLexical].sort());
    const text = await runHm(project, ["snapshot:rebuild"]);
    expect(text.stdout).toContain("snapshot rebuilt");
  });
});

describe("hm dispatcher", () => {
  test("registers the 33 commands of spec §11; only eval:live (a later release) is not in this build", async () => {
    expect(COMMANDS).toHaveLength(33);
    expect(new Set(COMMANDS.map((command) => command.name)).size).toBe(33);
    const notInBuild = COMMANDS.filter((command) => command.run === undefined).map((command) => command.name);
    expect(notInBuild).toEqual(["eval:live"]);
    expect(implementedCommands()).toHaveLength(32);
    const help = await runHm(project, ["--help"]);
    expect(help.code).toBe(0);
    for (const command of COMMANDS) expect(help.stdout).toContain(command.name);
    expect(help.stdout).toContain("(not in this build)");

    const stub = await runHm(project, ["eval:live"]);
    expect(stub.code).toBe(2);
    expect(stub.stderr).toContain("not in this build");

    const unknown = await runHm(project, ["frobnicate"]);
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toContain("unknown command");

    const badOption = await runHm(project, ["status", "--bogus"]);
    expect(badOption.code).toBe(2);
    expect(badOption.stderr).toContain("unknown option --bogus");

    const commandHelp = await runHm(project, ["install", "--help"]);
    expect(commandHelp.code).toBe(0);
    expect(commandHelp.stdout).toContain("--with-embeddings");

    const version = await runHm(project, ["--version"]);
    expect(version.code).toBe(0);
    expect(version.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  test("--db inside a .harness-memory directory selects that project; elsewhere it only moves the database file", async () => {
    const other = join(project.root, "elsewhere");
    mkdirSync(join(other, ".harness-memory"), { recursive: true });
    let stdout = "";
    const code = await runCli(["db:migrate", "--db", join(other, ".harness-memory", "memory.sqlite"), "--json"], {
      cwd: project.root,
      env: project.env,
      isTTY: false,
      streams: { stdout: (text) => (stdout += text), stderr: () => undefined },
    });
    expect(code).toBe(0);
    expect(JSON.parse(stdout).db).toBe(join(other, ".harness-memory", "memory.sqlite"));
    expect(existsSync(join(other, ".harness-memory", "snapshot", "active.v1.json"))).toBe(true);
    expect(existsSync(project.paths.db)).toBe(false);

    const loose = join(project.root, "loose.sqlite");
    stdout = "";
    const looseCode = await runCli(["db:migrate", "--db", loose, "--json"], {
      cwd: project.root,
      env: project.env,
      isTTY: false,
      streams: { stdout: (text) => (stdout += text), stderr: () => undefined },
    });
    expect(looseCode).toBe(0);
    expect(JSON.parse(stdout).db).toBe(loose);
    expect(existsSync(loose)).toBe(true);
    expect(existsSync(project.paths.snapshotActive)).toBe(true);
  });
});
