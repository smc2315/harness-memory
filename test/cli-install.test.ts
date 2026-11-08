/**
 * `hm install` / `hm uninstall` into a temp project: settings merge (idempotent, foreign hooks kept),
 * .git/info/exclude (plain checkout, worktree pointer, unresolvable pointer), `.harness-memory/.gitignore`,
 * install-manifest.json, config.json, migrated database + snapshot, the real hook self-test against a fake
 * dist/hook.js, --user scope, --with-embeddings via the npm seam (and the shell-free npm spawn plan), shell
 * form for an old host, probe guidance; uninstall strips exactly our entries, --purge keeps the backups.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { bundledNpmCli, planNpmSpawn, type InstallReport } from "../src/cli/commands/install";
import type { UninstallReport } from "../src/cli/commands/uninstall";
import { canonicalDirectory, projectSlug } from "../src/cli/lib/auto-memory";
import { probeGuidance } from "../src/cli/lib/diagnostics";
import type { InstallManifest } from "../src/cli/lib/manifest";
import { GIT_EXCLUDE_LINE, STATE_GITIGNORE_CONTENT } from "../src/cli/lib/paths";
import { listHarnessHooks } from "../src/cli/lib/settings";
import { TARGET_USER_VERSION } from "../src/core/paths";
import type { ProbeResult } from "../src/core/vocabulary";
import { getMeta } from "../src/db/meta";
import { loadSqlJs } from "../src/db/sqlite";
import type { ExtractionProvider } from "../src/dream/extract/providers";
import { createCliProject, runHm, type CliProject } from "./helpers/cli-run";

let project: CliProject;

beforeEach(() => {
  project = createCliProject();
});

afterEach(() => {
  project.cleanup();
});

function readJson<T = Record<string, unknown>>(file: string): T {
  return JSON.parse(readFileSync(file, "utf8")) as T;
}

async function readUserVersion(file: string): Promise<{ version: number; installed: string | null }> {
  const SQL = await loadSqlJs();
  const db = new SQL.Database(readFileSync(file));
  try {
    const version = Number(db.exec("PRAGMA user_version")[0]!.values[0]![0]);
    return { version, installed: getMeta(db, "installed_version") };
  } finally {
    db.close();
  }
}

describe("hm install --host claude", () => {
  test("registers exec-form hooks, migrates, builds the snapshot, excludes the settings file and passes the self-test", async () => {
    const result = await runHm(project, ["install", "--host", "claude", "--json"]);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    const report = result.json<InstallReport>();
    expect(report.ok).toBe(true);
    expect(report.hook_form).toBe("exec");
    expect(report.events).toHaveLength(9);
    expect(report.database.user_version).toBe(TARGET_USER_VERSION);
    expect(report.database.migrated_from).toBe(0);
    expect(report.database.snapshot_built).toBe(true);
    expect(report.snapshot_counts).toEqual({ active: 0, candidates: 0, unreachable: 0 });
    expect(report.git_exclude).toEqual({ path: join(project.root, ".git", "info", "exclude"), added: true, already: false });
    expect(report.git_ignore).toEqual({ path: join(project.paths.dir, ".gitignore"), created: true });
    expect(report.probe.skipped).toBe(false);
    expect(report.probe.provider).toBeNull();
    expect("skipped" in report.self_test).toBe(false);
    if (!("skipped" in report.self_test)) {
      expect(report.self_test.ok).toBe(true);
      expect(report.self_test.logEntry?.event).toBe("session-start");
    }

    const settingsFile = join(project.root, ".claude", "settings.local.json");
    const settings = readJson<{ hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string; args: string[]; timeout: number }> }>> }>(settingsFile);
    expect(Object.keys(settings.hooks).sort()).toEqual(["PostToolUse", "PostToolUseFailure", "PreCompact", "PreToolUse", "SessionEnd", "SessionStart", "Stop", "StopFailure", "UserPromptSubmit"]);
    const preTool = settings.hooks.PreToolUse![0]!;
    expect(preTool.matcher).toBe("Bash|PowerShell|Edit|MultiEdit|Write|NotebookEdit|WebFetch|mcp__.*");
    expect(preTool.hooks[0]).toEqual({ type: "command", command: process.execPath, args: [project.hookScript, "pre-tool"], timeout: 5 });
    expect(settings.hooks.SessionEnd![0]!.hooks[0]!.timeout).toBe(1);
    expect(settings.hooks.SessionStart![0]!.matcher).toBeUndefined();

    expect(readFileSync(join(project.root, ".git", "info", "exclude"), "utf8")).toBe(".claude/settings.local.json\n");
    // Ledgers, memory.sqlite, raw provider output and logs live here: ignored from inside the directory so no `git add -A` can publish them.
    expect(readFileSync(join(project.paths.dir, ".gitignore"), "utf8")).toBe(STATE_GITIGNORE_CONTENT);
    expect(STATE_GITIGNORE_CONTENT.split("\n")).toContain("*");
    expect(existsSync(project.paths.snapshotActive)).toBe(true);
    expect(existsSync(project.paths.snapshotLexical)).toBe(true);
    expect(readJson(project.paths.config).schema).toBe("config.v1");
    const db = await readUserVersion(project.paths.db);
    expect(db.version).toBe(TARGET_USER_VERSION);
    expect(db.installed).toMatch(/^\d+\.\d+\.\d+/);
    expect(readFileSync(project.paths.hooksLog, "utf8")).toMatch(/ session-start /);

    const manifest = readJson<InstallManifest>(project.paths.manifest);
    expect(manifest.schema).toBe("install-manifest.v1");
    expect(manifest.node).toBe(process.execPath);
    expect(manifest.hook_script).toBe(project.hookScript);
    expect(manifest.settings_file).toBe(settingsFile);
    expect(manifest.scope).toBe("project");
    expect(manifest.claude_version).toBe("2.1.172");
    expect(manifest.files.map((file) => file.role).sort()).toEqual(["config", "git_exclude", "git_ignore", "hook_script", "settings", "worker_script"]);
    expect(manifest.files.find((file) => file.role === "git_ignore")).toMatchObject({ path: join(project.paths.dir, ".gitignore"), created: true });
    expect(manifest.files.find((file) => file.role === "settings")!.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.files.find((file) => file.role === "settings")!.created).toBe(true);
  });

  test("is idempotent and keeps foreign hooks while replacing an earlier install's entries", async () => {
    const settingsFile = join(project.root, ".claude", "settings.local.json");
    mkdirSync(join(project.root, ".claude"), { recursive: true });
    const foreign = { type: "command", command: "echo hi", timeout: 3 };
    const old = { type: "command", command: "/old/node", args: ["/old/harness-memory/dist/hook.js", "pre-tool"], timeout: 5 };
    writeFileSync(settingsFile, JSON.stringify({ permissions: { allow: ["Bash(ls)"] }, hooks: { PreToolUse: [{ matcher: "Bash", hooks: [foreign, old] }] } }, null, 2));
    writeFileSync(join(project.root, ".git", "info", "exclude"), "node_modules\n.claude/settings.local.json\n");
    mkdirSync(project.paths.dir, { recursive: true });
    writeFileSync(join(project.paths.dir, ".gitignore"), "*\n!skills/\n");

    const first = await runHm(project, ["install", "--host", "claude", "--skip-probe", "--skip-self-test", "--json"]);
    expect(first.code).toBe(0);
    expect(first.json<InstallReport>().replaced_entries).toBe(1);
    expect(first.json<InstallReport>().git_exclude).toEqual({ path: join(project.root, ".git", "info", "exclude"), added: false, already: true });
    expect(first.json<InstallReport>().git_ignore).toEqual({ path: join(project.paths.dir, ".gitignore"), created: false });
    expect(readFileSync(join(project.paths.dir, ".gitignore"), "utf8")).toBe("*\n!skills/\n");
    const afterFirst = readFileSync(settingsFile, "utf8");
    const parsed = JSON.parse(afterFirst) as { permissions: unknown; hooks: Record<string, Array<{ matcher?: string; hooks: unknown[] }>> };
    expect(parsed.permissions).toEqual({ allow: ["Bash(ls)"] });
    expect(parsed.hooks.PreToolUse).toHaveLength(2);
    expect(parsed.hooks.PreToolUse![0]).toEqual({ matcher: "Bash", hooks: [foreign] });
    expect(listHarnessHooks(parsed)).toHaveLength(9);

    const second = await runHm(project, ["install", "--host", "claude", "--skip-probe", "--skip-self-test", "--json"]);
    expect(second.code).toBe(0);
    expect(second.json<InstallReport>().replaced_entries).toBe(9);
    expect(second.json<InstallReport>().database.migrated_from).toBeNull();
    expect(readFileSync(settingsFile, "utf8")).toBe(afterFirst);
    expect(readFileSync(join(project.root, ".git", "info", "exclude"), "utf8")).toBe("node_modules\n.claude/settings.local.json\n");
    expect(readJson<InstallManifest>(project.paths.manifest).files.find((file) => file.role === "settings")!.created).toBe(false);
  });

  test("--user writes ~/.claude/settings.json (CLAUDE_CONFIG_DIR) and skips the git exclude", async () => {
    const result = await runHm(project, ["install", "--host", "claude", "--user", "--skip-probe", "--skip-self-test", "--json"]);
    expect(result.code).toBe(0);
    const report = result.json<InstallReport>();
    expect(report.scope).toBe("user");
    expect(report.settings_file).toBe(join(project.configDir, "settings.json"));
    expect(report.git_exclude).toBeNull();
    expect(report.warnings.filter((warning) => warning.includes(GIT_EXCLUDE_LINE))).toEqual([]);
    expect(existsSync(join(project.root, ".claude", "settings.local.json"))).toBe(false);
    expect(listHarnessHooks(readJson(join(project.configDir, "settings.json")))).toHaveLength(9);
    expect(existsSync(join(project.root, ".git", "info", "exclude"))).toBe(false);
    // The state directory is still created in the project, so its .gitignore is written regardless of scope.
    expect(report.git_ignore.created).toBe(true);
    expect(readFileSync(join(project.paths.dir, ".gitignore"), "utf8")).toBe(STATE_GITIGNORE_CONTENT);
    expect(readJson<InstallManifest>(project.paths.manifest).scope).toBe("user");
  });

  test("follows a worktree's .git pointer to the repository's info/exclude, which uninstall then cleans", async () => {
    const main = join(project.root, "..", "main");
    const worktreeGitDir = join(main, ".git", "worktrees", "project");
    mkdirSync(join(main, ".git", "info"), { recursive: true });
    mkdirSync(worktreeGitDir, { recursive: true });
    writeFileSync(join(worktreeGitDir, "commondir"), "../..\n");
    rmSync(join(project.root, ".git"), { recursive: true, force: true });
    writeFileSync(join(project.root, ".git"), `gitdir: ${worktreeGitDir}\n`);
    const sharedExclude = join(main, ".git", "info", "exclude");

    const result = await runHm(project, ["install", "--host", "claude", "--skip-probe", "--skip-self-test", "--json"]);
    expect(result.code).toBe(0);
    const report = result.json<InstallReport>();
    expect(report.warnings.filter((warning) => warning.includes(GIT_EXCLUDE_LINE))).toEqual([]);
    expect(report.git_exclude).toEqual({ path: sharedExclude, added: true, already: false });
    expect(readFileSync(sharedExclude, "utf8")).toBe(`${GIT_EXCLUDE_LINE}\n`);
    expect(readJson<InstallManifest>(project.paths.manifest).git_exclude).toEqual({ path: sharedExclude, line: GIT_EXCLUDE_LINE, added: true });

    const uninstall = await runHm(project, ["uninstall", "--json"]);
    expect(uninstall.code).toBe(0);
    expect(uninstall.json<UninstallReport>().git_exclude_removed).toBe(true);
    expect(readFileSync(sharedExclude, "utf8")).toBe("\n");
  });

  test("warns instead of silently skipping the exclude when the .git pointer cannot be resolved", async () => {
    rmSync(join(project.root, ".git"), { recursive: true, force: true });
    writeFileSync(join(project.root, ".git"), "gitdir: ../gone/.git/worktrees/project\n");

    const result = await runHm(project, ["install", "--host", "claude", "--skip-probe", "--skip-self-test", "--json"]);
    expect(result.code).toBe(0);
    const report = result.json<InstallReport>();
    expect(report.git_exclude).toBeNull();
    const excludeWarnings = report.warnings.filter((warning) => warning.includes(GIT_EXCLUDE_LINE));
    expect(excludeWarnings).toHaveLength(1);
    expect(excludeWarnings[0]).toContain("could not be resolved");
    expect(existsSync(join(project.root, ".claude", "settings.local.json"))).toBe(true);
    expect(readJson<InstallManifest>(project.paths.manifest).git_exclude).toBeNull();
  });

  test("writes shell form with powershell when the host is older than the exec-form minimum and Git Bash is absent", async () => {
    const result = await runHm(project, ["install", "--host", "claude", "--skip-probe", "--skip-self-test", "--json"], {
      platform: "win32",
      seams: { detectClaudeVersion: () => "2.1.100", findGitBash: () => null },
    });
    expect(result.code).toBe(0);
    const report = result.json<InstallReport>();
    expect(report.hook_form).toBe("shell");
    expect(report.shell).toBe("powershell");
    expect(report.warnings.some((warning) => warning.includes("Git Bash"))).toBe(true);
    const entries = listHarnessHooks(readJson(report.settings_file));
    expect(entries).toHaveLength(9);
    expect(entries[0]!.command.args).toBeUndefined();
    expect(entries[0]!.command.command).toBe(`"${process.execPath}" "${project.hookScript}" ${entries[0]!.event}`);
    expect(entries[0]!.command.shell).toBe("powershell");
  });

  test("--with-embeddings runs npm through the seam and enables embeddings only on success", async () => {
    const calls: Array<{ args: readonly string[]; cwd: string }> = [];
    const ok = await runHm(project, ["install", "--host", "claude", "--with-embeddings", "--skip-probe", "--skip-self-test", "--json"], {
      seams: {
        runNpm: (args, cwd) => {
          calls.push({ args, cwd });
          return { ok: true, output: "added 1 package" };
        },
      },
    });
    expect(ok.code).toBe(0);
    expect(calls).toEqual([{ args: ["install", "@xenova/transformers"], cwd: expect.any(String) }]);
    expect(ok.json<InstallReport>().config.embeddings_enabled).toBe(true);
    expect(readJson<{ embeddings: { enabled: boolean } }>(project.paths.config).embeddings.enabled).toBe(true);

    const failing = createCliProject();
    try {
      const bad = await runHm(failing, ["install", "--host", "claude", "--with-embeddings", "--skip-probe", "--skip-self-test", "--json"], {
        seams: { runNpm: () => ({ ok: false, output: "npm ERR! network" }) },
      });
      expect(bad.code).toBe(1);
      const report = bad.json<InstallReport>();
      expect(report.ok).toBe(false);
      expect(report.config.embeddings_enabled).toBe(false);
      expect(report.warnings.some((warning) => warning.startsWith("npm install"))).toBe(true);
    } finally {
      failing.cleanup();
    }
  });

  test("--with-embeddings never runs npm in the project when the package directory is unknown", async () => {
    const result = await runHm(project, ["install", "--host", "claude", "--with-embeddings", "--skip-probe", "--skip-self-test", "--json"], {
      packageRoot: null,
      seams: {
        runNpm: () => {
          throw new Error("npm must not run without a package root");
        },
      },
    });
    expect(result.code).toBe(1);
    const report = result.json<InstallReport>();
    expect(report.ok).toBe(false);
    expect(report.embeddings).toEqual({ requested: true, installed: false, output: null });
    expect(report.config.embeddings_enabled).toBe(false);
    expect(report.warnings.some((warning) => warning.startsWith("npm install @xenova/transformers skipped"))).toBe(true);
    expect(existsSync(project.paths.manifest)).toBe(true);
  });

  test("probes the provider, caches the result in meta and prints the not_logged_in guidance", async () => {
    const provider: ExtractionProvider = {
      name: "claude",
      probe: async () => "not_logged_in" as ProbeResult,
      extract: async () => ({ status: "no_provider", raw: "" }),
    };
    const result = await runHm(project, ["install", "--host", "claude", "--skip-self-test"], { seams: { provider } });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("probe not_logged_in");
    expect(result.stdout).toContain("/login");
    // Login-optional messaging (phase F A′ §4), pinned verbatim so a reword cannot drift back to a claim the pipeline
    // does not keep: imported rules (verbatim until the extractor types them) and hand-added rules fire without the
    // login; learning from sessions — remember turns included — starts after `claude auth login`.
    const guidance =
      "the hooks enforce rules without the login — rules you import (`hm import`, verbatim until the extractor types them) and add (`hm memory:add`) fire as soon as they exist; learning from sessions, including what you ask it to remember, starts after `claude auth login` in a terminal (older CLIs: `claude`, then `/login`); the worker re-probes within ten minutes, or run `hm install --host claude` to re-probe now; nothing is lost meanwhile";
    expect(probeGuidance("not_logged_in")).toBe(guidance);
    const providerLine = result.stdout.split("\n").find((line) => line.trim().startsWith("provider")) ?? "";
    expect(providerLine.trim()).toBe(`provider    claude — probe not_logged_in; ${guidance}`);
    expect(probeGuidance("ok")).toBeNull();
    const SQL = await loadSqlJs();
    const db = new SQL.Database(readFileSync(project.paths.db));
    try {
      expect(getMeta(db, "last_probe_result")).toBe("not_logged_in");
      expect(getMeta(db, "last_probe_at")).toMatch(/^\d{4}-/);
    } finally {
      db.close();
    }
    const snapshot = readJson<{ last_probe: { result: string } | null }>(project.paths.snapshotActive);
    expect(snapshot.last_probe?.result).toBe("not_logged_in");
  });

  test("names Claude Code's auto-memory feedback notes of this project as an import source", async () => {
    const without = await runHm(project, ["install", "--host", "claude", "--skip-probe", "--skip-self-test", "--json"]);
    expect(without.code).toBe(0);
    expect(without.json<InstallReport>().auto_memory).toBeNull();

    const memoryDir = join(project.configDir, "projects", projectSlug(project.root), "memory");
    mkdirSync(memoryDir, { recursive: true });
    writeFileSync(join(memoryDir, "MEMORY.md"), "- [Terminals](no-terminating-terminals.md) — never close terminals without asking\n", "utf8");
    writeFileSync(join(memoryDir, "no-terminating-terminals.md"), "---\nname: no-terminating-terminals\ndescription: \"Never close terminals without asking\"\nmetadata:\n  type: feedback\n---\n\nAsk before closing any terminal tab or stopping a process you did not start.\n", "utf8");
    writeFileSync(join(memoryDir, "user-profile.md"), "---\nname: user-profile\nmetadata:\n  type: user\n---\n\nWrites in Korean.\n", "utf8");

    const result = await runHm(project, ["install", "--host", "claude", "--skip-probe", "--skip-self-test", "--json"]);
    expect(result.code).toBe(0);
    expect(result.json<InstallReport>().auto_memory).toEqual({ dir: canonicalDirectory(memoryDir), notes: 1 });
    const text = await runHm(project, ["install", "--host", "claude", "--skip-probe", "--skip-self-test"]);
    expect(text.code).toBe(0);
    expect(text.stdout).toContain("`hm import --from auto-memory` turns Claude Code's 1 auto-memory feedback note into human memories");
    expect(text.stdout).toContain(canonicalDirectory(memoryDir));
    // The lookup is read-only: nothing under the config directory changes.
    expect(readFileSync(join(memoryDir, "MEMORY.md"), "utf8")).toContain("never close terminals");
  });

  test("refuses unknown hosts and a missing hook script", async () => {
    const codex = await runHm(project, ["install", "--host", "codex"]);
    expect(codex.code).toBe(2);
    expect(codex.stderr).toContain("not in this build");
    const missing = await runHm(project, ["install", "--host", "claude", "--hook-script", join(project.root, "nope", "hook.js")]);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("hook script not found");
    expect(existsSync(project.paths.manifest)).toBe(false);
  });

  test("reports a failing self-test as exit 1 but leaves the install in place", async () => {
    const result = await runHm(project, ["install", "--host", "claude", "--skip-probe", "--json"], {
      seams: { selfTest: () => ({ ok: false, event: "session-start", exitCode: 1, signal: null, logEntry: null, stdout: "", stderr: "boom", error: "hook exited with code 1", durationMs: 5 }) },
    });
    expect(result.code).toBe(1);
    const report = result.json<InstallReport>();
    expect(report.ok).toBe(false);
    expect(existsSync(project.paths.manifest)).toBe(true);
  });
});

describe("hm uninstall", () => {
  test("removes our hooks, the exclude line and the manifest; keeps foreign hooks and the data", async () => {
    const settingsFile = join(project.root, ".claude", "settings.local.json");
    mkdirSync(join(project.root, ".claude"), { recursive: true });
    const foreign = { type: "command", command: "echo hi", timeout: 3 };
    writeFileSync(settingsFile, JSON.stringify({ hooks: { Stop: [{ hooks: [foreign] }] } }));
    expect((await runHm(project, ["install", "--host", "claude", "--skip-probe", "--skip-self-test"])).code).toBe(0);

    const result = await runHm(project, ["uninstall", "--json"]);
    expect(result.code).toBe(0);
    const report = result.json<UninstallReport>();
    expect(report.manifest_found).toBe(true);
    expect(report.settings[0]).toEqual({ file: settingsFile, removed: 9, deleted_file: false, error: null });
    expect(report.git_exclude_removed).toBe(true);
    expect(report.manifest_removed).toBe(true);
    expect(readJson(settingsFile)).toEqual({ hooks: { Stop: [{ hooks: [foreign] }] } });
    expect(readFileSync(join(project.root, ".git", "info", "exclude"), "utf8")).toBe("\n");
    expect(existsSync(project.paths.manifest)).toBe(false);
    expect(existsSync(project.paths.db)).toBe(true);
  });

  test("deletes a settings file it created once it is empty, and --purge keeps only the .bak-v<N> backups", async () => {
    expect((await runHm(project, ["install", "--host", "claude", "--skip-probe", "--skip-self-test"])).code).toBe(0);
    writeFileSync(project.paths.dbBackup(9), "backup bytes");
    writeFileSync(join(project.paths.dir, ".conversation-buffer.json"), "{}");

    const result = await runHm(project, ["uninstall", "--purge", "--json"]);
    expect(result.code).toBe(0);
    const report = result.json<UninstallReport>();
    expect(report.settings[0]!.deleted_file).toBe(true);
    expect(existsSync(join(project.root, ".claude", "settings.local.json"))).toBe(false);
    expect(report.purged).toBe(true);
    // The backup is a full database, so the .gitignore that keeps the directory out of git stays with it.
    expect([...report.kept].sort()).toEqual([join(project.paths.dir, ".gitignore"), project.paths.dbBackup(9)].sort());
    expect(existsSync(project.paths.db)).toBe(false);
    expect(existsSync(project.paths.snapshotDir)).toBe(false);
    expect(existsSync(join(project.paths.dir, ".conversation-buffer.json"))).toBe(false);
    expect(readFileSync(project.paths.dbBackup(9), "utf8")).toBe("backup bytes");
    expect(readFileSync(join(project.paths.dir, ".gitignore"), "utf8")).toBe(STATE_GITIGNORE_CONTENT);
  });

  test("--purge without backups removes the whole directory, .gitignore included", async () => {
    expect((await runHm(project, ["install", "--host", "claude", "--skip-probe", "--skip-self-test"])).code).toBe(0);
    const result = await runHm(project, ["uninstall", "--purge", "--json"]);
    expect(result.code).toBe(0);
    const report = result.json<UninstallReport>();
    expect(report.kept).toEqual([]);
    expect(report.removed_paths).toContain(project.paths.dir);
    expect(existsSync(project.paths.dir)).toBe(false);
  });

  test("without a manifest it still strips the project settings file", async () => {
    const settingsFile = join(project.root, ".claude", "settings.local.json");
    mkdirSync(join(project.root, ".claude"), { recursive: true });
    writeFileSync(settingsFile, JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "/x/node", args: ["/x/dist/hook.js", "pre-tool"] }] }] } }));
    const result = await runHm(project, ["uninstall", "--json"]);
    expect(result.code).toBe(0);
    const report = result.json<UninstallReport>();
    expect(report.manifest_found).toBe(false);
    expect(report.settings[0]!.removed).toBe(1);
    expect(readJson(settingsFile)).toEqual({});
  });
});

describe("npm spawn plan (--with-embeddings)", () => {
  let base: string;

  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), "hm-npm-")));
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  test("prefers the npm-cli.js bundled with the running node, through node itself and without a shell", () => {
    const nodeDir = join(base, "node dir");
    const npmCli = join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js");
    mkdirSync(join(nodeDir, "node_modules", "npm", "bin"), { recursive: true });
    writeFileSync(npmCli, "// npm\n");
    const execPath = join(nodeDir, "node.exe");
    expect(bundledNpmCli(execPath)).toBe(npmCli);
    expect(planNpmSpawn(["install", "@xenova/transformers"], { execPath, platform: "win32" })).toEqual({ file: execPath, args: [npmCli, "install", "@xenova/transformers"], shell: false });

    const posixPrefix = join(base, "usr local");
    const posixCli = join(posixPrefix, "lib", "node_modules", "npm", "bin", "npm-cli.js");
    mkdirSync(join(posixPrefix, "bin"), { recursive: true });
    mkdirSync(join(posixPrefix, "lib", "node_modules", "npm", "bin"), { recursive: true });
    writeFileSync(posixCli, "// npm\n");
    expect(bundledNpmCli(join(posixPrefix, "bin", "node"))).toBe(posixCli);

    const here = bundledNpmCli();
    if (here !== null) expect(existsSync(here)).toBe(true);
  });

  test("without a bundled npm, Windows gets PATH's npm.cmd as one quoted command string (never a bare name cmd.exe would look up in the cwd)", () => {
    const bareNode = join(base, "bare", "node.exe");
    mkdirSync(join(base, "bare"), { recursive: true });
    const shimDir = join(base, "Program Files", "nodejs");
    mkdirSync(shimDir, { recursive: true });
    writeFileSync(join(shimDir, "npm.cmd"), "@echo off\n");
    const env = { PATH: [join(base, "elsewhere"), shimDir].join(delimiter) };

    expect(planNpmSpawn(["install", "@xenova/transformers"], { execPath: bareNode, platform: "win32", env })).toEqual({
      file: `"${join(shimDir, "npm.cmd")}" install @xenova/transformers`,
      args: [],
      shell: true,
    });
    expect(planNpmSpawn(["install", "@xenova/transformers"], { execPath: bareNode, platform: "win32", env: { PATH: join(base, "elsewhere") } })).toBeNull();
    expect(planNpmSpawn(["install", "@xenova/transformers"], { execPath: bareNode, platform: "linux", env })).toEqual({ file: "npm", args: ["install", "@xenova/transformers"], shell: false });
  });
});
