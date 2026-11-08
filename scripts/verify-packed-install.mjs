// `npm run package:verify`: pack the package, install the tarball into a throwaway consumer project and
// exercise the v0.6 surface end to end — library import, `hm install --host claude` (hooks registered,
// database migrated, snapshot built, self-test line in hooks.log), `node dist/hook.js session-start` from a
// synthetic Claude Code stdin, `hm status`, `hm doctor`, `hm snapshot:rebuild`, `hm uninstall --purge`.
// Needs network access for `npm install` (sql.js, minisearch, minimatch come from the registry).
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const isWindows = process.platform === "win32";

function run(command, cwd, options = {}) {
  const [binary, ...args] = command;
  // npm/npx are .cmd shims on Windows and need a shell; hand the shell one quoted command string so Node
  // does not warn about shell + args (DEP0190).
  const useShell = isWindows && /^(npm|npx)$/.test(binary);
  const file = useShell ? [`${binary}.cmd`, ...args].map((part) => (/\s/.test(part) ? `"${part}"` : part)).join(" ") : binary;
  const proc = spawnSync(file, useShell ? [] : args, {
    cwd,
    encoding: "utf8",
    shell: useShell,
    input: options.input,
    env: { ...process.env, ...(options.env ?? {}) },
    stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    timeout: options.timeoutMs ?? 10 * 60_000,
  });
  const stdout = proc.stdout ?? "";
  const stderr = proc.stderr ?? "";
  const expected = options.expectStatus ?? 0;
  if (proc.status !== expected) {
    throw new Error([`Command failed (exit ${proc.status}, expected ${expected}): ${command.join(" ")}`, stdout, stderr].filter(Boolean).join("\n"));
  }
  return stdout;
}

function parsePackJson(output) {
  const match = output.match(/(\[\s*\{[\s\S]*\}\s*\])\s*$/);
  if (match === null) throw new Error(`Could not find npm pack JSON in output:\n${output}`);
  return JSON.parse(match[1]);
}

const repoRoot = process.cwd();
const packJson = parsePackJson(run(["npm", "pack", "--json"], repoRoot));
const tarballName = packJson[0]?.filename;
if (typeof tarballName !== "string") throw new Error("Could not determine packed tarball name");

const tarballPath = resolve(repoRoot, tarballName);
const consumerDir = mkdtempSync(join(tmpdir(), "harness-memory-verify-"));

try {
  writeFileSync(join(consumerDir, "package.json"), JSON.stringify({ name: "hm-consumer", private: true, type: "module" }, null, 2));
  mkdirSync(join(consumerDir, ".git", "info"), { recursive: true });
  writeFileSync(
    join(consumerDir, "verify-import.mjs"),
    [
      "import { MemoryRepository, ActivationEngine } from 'harness-memory';",
      "import { Store } from 'harness-memory/db';",
      "console.log(typeof MemoryRepository === 'function' && typeof ActivationEngine === 'function' && typeof Store === 'function' ? 'IMPORT_OK' : 'IMPORT_FAIL');",
    ].join("\n")
  );

  run(["npm", "install", tarballPath], consumerDir);
  const imported = run(["node", "./verify-import.mjs"], consumerDir);
  if (!imported.includes("IMPORT_OK")) throw new Error(`library import check failed: ${imported}`);

  const packageDir = join(consumerDir, "node_modules", "harness-memory");
  const hookScript = join(packageDir, "dist", "hook.js");
  const hm = join(packageDir, "dist", "bin", "harness-memory.js");
  for (const file of [hookScript, join(packageDir, "dist", "hook-bundle.js"), join(packageDir, "dist", "worker.js"), join(packageDir, "dist", "embed-helper.js"), hm]) {
    if (!existsSync(file)) throw new Error(`packed install lacks ${file}`);
  }

  // install: hooks + DB + snapshot + self-test (probe skipped: no provider assumptions in CI)
  const install = JSON.parse(run(["node", hm, "install", "--host", "claude", "--skip-probe", "--json"], consumerDir));
  if (install.ok !== true) throw new Error(`install reported problems: ${JSON.stringify(install, null, 2)}`);
  const settings = JSON.parse(readFileSync(join(consumerDir, ".claude", "settings.local.json"), "utf8"));
  const events = Object.keys(settings.hooks ?? {});
  for (const event of ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure", "Stop", "StopFailure", "PreCompact", "SessionEnd"]) {
    if (!events.includes(event)) throw new Error(`settings.local.json lacks ${event}`);
  }
  if (!readFileSync(join(consumerDir, ".git", "info", "exclude"), "utf8").includes(".claude/settings.local.json")) throw new Error("exclude line missing");
  if (!existsSync(join(consumerDir, ".harness-memory", "install-manifest.json"))) throw new Error("manifest missing");
  if (!existsSync(join(consumerDir, ".harness-memory", "snapshot", "active.v1.json"))) throw new Error("snapshot missing");

  // the hook itself, as Claude Code would spawn it
  const hooksLog = join(consumerDir, ".harness-memory", "logs", "hooks.log");
  const before = existsSync(hooksLog) ? readFileSync(hooksLog, "utf8").split("\n").length : 0;
  const stdin = JSON.stringify({ session_id: "verify", cwd: consumerDir, hook_event_name: "SessionStart", source: "startup" });
  const hookOut = run(["node", hookScript, "session-start"], consumerDir, { input: stdin, env: { HARNESS_MEMORY_DISABLE: "" } });
  JSON.parse(hookOut.trim().length === 0 ? "{}" : hookOut);
  const after = readFileSync(hooksLog, "utf8").split("\n");
  if (after.length <= before || !after.slice(before - 1).some((line) => line.includes(" session-start "))) throw new Error(`no session-start line in hooks.log:\n${after.join("\n")}`);

  const status = run(["node", hm, "status"], consumerDir);
  if (!/active \d+ \(auto \d+\) \| candidates \d+ \| proposals \d+/.test(status)) throw new Error(`unexpected status line: ${status}`);
  run(["node", hm, "doctor", "--json"], consumerDir);
  run(["node", hm, "snapshot:rebuild"], consumerDir);
  run(["node", hm, "db:migrate", "--json"], consumerDir);
  run(["node", hm, "memory:list"], consumerDir, { expectStatus: 2 });
  run(["node", hm, "uninstall", "--purge", "--json"], consumerDir);
  if (existsSync(join(consumerDir, ".harness-memory", "memory.sqlite"))) throw new Error("purge left memory.sqlite");
  // install created the settings file, so uninstall deletes it once our entries are gone; a pre-existing
  // file would instead survive without a `hooks` key.
  const settingsFile = join(consumerDir, ".claude", "settings.local.json");
  if (existsSync(settingsFile) && JSON.parse(readFileSync(settingsFile, "utf8")).hooks !== undefined) throw new Error("uninstall left hooks registered");

  console.log(`OK packed install verified (${status.trim()})`);
} finally {
  rmSync(consumerDir, { recursive: true, force: true });
  rmSync(tarballPath, { force: true });
}
