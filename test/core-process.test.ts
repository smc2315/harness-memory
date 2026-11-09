/**
 * spawnDetached against the real `node:child_process`: Node reports EAGAIN/EMFILE/ENFILE/ENOENT/EACCES
 * asynchronously as an `error` event on the ChildProcess, after `spawn` (and the caller's try/catch) has
 * returned. Without a listener that event is an uncaught exception: the hook process exits 1 and the host
 * shows a hook error (spec §8.6 / §6.2 step 10: exit is always 0). The ops suite mocks `spawn`; this test
 * runs the real thing in a child node process so the exit code is observable.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { afterAll, describe, expect, test } from "vitest";

const [major, minor] = process.versions.node.split(".").map(Number) as [number, number];
/** The probe imports src/core/process.ts directly: type stripping is on by default from Node 23.6, flagged on 22.6+. */
const stripTypeFlags: string[] | null =
  major > 23 || (major === 23 && minor >= 6) ? [] : major === 22 && minor >= 6 ? ["--experimental-strip-types"] : null;
const realSpawnTest = stripTypeFlags === null ? test.skip : test;

const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe("spawnDetached and deferred spawn failures (real child_process)", () => {
  realSpawnTest("a missing cwd makes spawn emit `error` after it returned; the process still exits 0 and onError sees ENOENT", () => {
    const dir = mkdtempSync(join(tmpdir(), "hm-spawn-"));
    tempDirs.push(dir);
    const missingCwd = join(dir, "does-not-exist");
    const probe = join(dir, "probe.mjs");
    const processModule = pathToFileURL(resolve(__dirname, "..", "src", "core", "process.ts")).href;
    writeFileSync(
      probe,
      [
        `import { spawnDetached } from ${JSON.stringify(processModule)};`,
        "const errors = [];",
        `spawnDetached("nope.js", [], { cwd: ${JSON.stringify(missingCwd)}, onError: (error) => errors.push(error.code ?? error.message) });`,
        "// the deferred `error` event fires on nextTick; wait a little before reporting",
        "await new Promise((done) => setTimeout(done, 100));",
        "process.stdout.write(JSON.stringify({ errors }));",
        "",
      ].join("\n"),
    );

    const result = spawnSync(process.execPath, [...stripTypeFlags!, probe], { encoding: "utf8", windowsHide: true, timeout: 30_000 });

    expect(result.stderr, result.stderr).not.toContain("Unhandled 'error' event");
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout) as { errors: string[] }).toEqual({ errors: ["ENOENT"] });
  });
});

describe("providerEnv", () => {
  test("forwards the extraction CLI's auth and routing variables and drops the host markers", async () => {
    const { providerEnv } = await import("../src/core/process");
    const saved = { ...process.env };
    const forwarded: Record<string, string> = {
      CLAUDE_CONFIG_DIR: "/home/me/.claude-work",
      CLAUDE_CODE_OAUTH_TOKEN: "headless-login",
      CLAUDE_CODE_USE_BEDROCK: "1",
      AWS_PROFILE: "work",
      AWS_REGION: "us-east-1",
      GOOGLE_APPLICATION_CREDENTIALS: "/home/me/sa.json",
      NODE_EXTRA_CA_CERTS: "/etc/ssl/corp.pem",
      ANTHROPIC_VERTEX_PROJECT_ID: "proj",
    };
    const dropped: Record<string, string> = {
      CLAUDECODE: "1",
      CLAUDE_CODE_ENTRYPOINT: "cli",
      CLAUDE_CODE_EXECPATH: "C:\\x\\claude.exe",
      CLAUDE_CODE_SSE_PORT: "1234",
      RANDOM_UNRELATED_VAR: "x",
    };
    Object.assign(process.env, forwarded, dropped);
    try {
      const env = providerEnv({ CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" });
      for (const [key, value] of Object.entries(forwarded)) expect(env[key]).toBe(value);
      for (const key of Object.keys(dropped)) expect(env[key]).toBeUndefined();
      expect(env.HARNESS_MEMORY_DISABLE).toBe("1");
      expect(env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe("1");
    } finally {
      for (const key of [...Object.keys(forwarded), ...Object.keys(dropped)]) {
        if (key in saved) process.env[key] = saved[key];
        else delete process.env[key];
      }
    }
  });
});
