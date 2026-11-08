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
