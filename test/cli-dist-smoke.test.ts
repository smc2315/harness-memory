/**
 * Smoke test against the built bundles (skipped until `npm run build` has produced dist/): from a temp
 * project, `hm install --host claude` through dist/bin/harness-memory.js writes .claude/settings.local.json,
 * `node dist/hook.js session-start < synthetic-stdin` exits 0 and appends a hooks.log line, and `hm status`
 * prints the one-line summary.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const DIST = resolve(__dirname, "..", "dist");
const HOOK = join(DIST, "hook.js");
const HM = join(DIST, "bin", "harness-memory.js");
const built = existsSync(HOOK) && existsSync(HM) && existsSync(join(DIST, "hook-bundle.js")) && existsSync(join(DIST, "worker.js"));

function run(args: readonly string[], cwd: string, input?: string) {
  const env = { ...process.env };
  delete env.HARNESS_MEMORY_DISABLE;
  return spawnSync(process.execPath, [...args], { cwd, encoding: "utf8", input, env, timeout: 60_000, windowsHide: true });
}

describe.skipIf(!built)("dist smoke (requires npm run build)", () => {
  let root: string;

  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "hm-dist-")));
    mkdirSync(join(root, ".git", "info"), { recursive: true });
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("hm install --host claude writes .claude/settings.local.json and passes its own self-test", () => {
    const result = run([HM, "install", "--host", "claude", "--skip-probe", "--json"], root);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout) as { ok: boolean; hook_script: string; self_test: { ok?: boolean } };
    expect(report.ok).toBe(true);
    expect(report.hook_script).toBe(HOOK);
    expect(report.self_test.ok).toBe(true);
    const settings = JSON.parse(readFileSync(join(root, ".claude", "settings.local.json"), "utf8")) as { hooks: Record<string, Array<{ hooks: Array<{ command: string; args: string[] }> }>> };
    expect(settings.hooks.PreToolUse![0]!.hooks[0]!.args).toEqual([HOOK, "pre-tool"]);
    expect(settings.hooks.PreToolUse![0]!.hooks[0]!.command).toBe(process.execPath);
  });

  test("node dist/hook.js session-start exits 0 and appends a hooks.log line", () => {
    const log = join(root, ".harness-memory", "logs", "hooks.log");
    const before = existsSync(log) ? readFileSync(log, "utf8").split("\n").length : 0;
    const stdin = JSON.stringify({ session_id: "smoke", cwd: root, hook_event_name: "SessionStart", source: "startup" });
    const result = run([HOOK, "session-start"], root, stdin);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(() => JSON.parse(result.stdout)).not.toThrow();
    const lines = readFileSync(log, "utf8").trimEnd().split("\n");
    expect(lines.length).toBeGreaterThan(before - 1);
    expect(lines[lines.length - 1]).toMatch(/^\d{4}-\d{2}-\d{2}T[^ ]+ session-start tool=- gen=\d+ activated=\d+ suppressed=\d+ decision=none delivery=none enforcement=- dur=\d+ms ok$/);
  });

  test("hm status prints the one-line summary", () => {
    const result = run([HM, "status"], root);
    expect(result.status).toBe(0);
    expect(result.stdout.split("\n")[0]).toMatch(/^active \d+ \(auto \d+\) \| candidates \d+ \| proposals \d+ \| queue \d+ \| last extraction \S+ .*\| probe \S+ \| snapshot (fresh|stale) \| p95 .+$/);
  });
});
