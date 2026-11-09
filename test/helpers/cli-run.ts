/**
 * In-process `hm` runner for the CLI tests: a temporary project (with `.git/info/` so install can write
 * the exclude file), a fake `dist/hook.js` that behaves like the real launcher for the self-test (reads
 * stdin, appends one hooks.log line, prints `{}`), and `runHm(argv)` capturing stdout/stderr/exit code.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CliSeams } from "../../src/cli/context";
import { runCli, type RunCliOptions } from "../../src/cli/main";
import { resolvePaths, type HarnessPaths } from "../../src/core/paths";

export interface CliProject {
  root: string;
  paths: HarnessPaths;
  /** Fake `dist/hook.js` (+ empty sibling bundles) under `<tmp>/pkg/dist`. */
  hookScript: string;
  packageDir: string;
  /** Separate HOME-like directory used as CLAUDE_CONFIG_DIR for `--user` tests. */
  configDir: string;
  env: NodeJS.ProcessEnv;
  cleanup(): void;
}

const FAKE_HOOK = `
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
let data = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { data += chunk; });
process.stdin.on("end", () => {
  let input = {};
  try { input = JSON.parse(data); } catch {}
  const root = typeof input.cwd === "string" ? input.cwd : process.cwd();
  const dir = join(root, ".harness-memory", "logs");
  mkdirSync(dir, { recursive: true });
  const event = process.argv[2] || "pre-tool";
  appendFileSync(join(dir, "hooks.log"), new Date().toISOString() + " " + event + " tool=- gen=- activated=0 suppressed=0 decision=none delivery=none enforcement=- dur=3ms ok\\n");
  process.stdout.write("{}\\n");
});
`;

export function createCliProject(options: { git?: boolean } = {}): CliProject {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "hm-cli-")));
  const root = join(base, "project");
  mkdirSync(root, { recursive: true });
  if (options.git !== false) mkdirSync(join(root, ".git", "info"), { recursive: true });
  const packageDir = join(base, "pkg");
  const dist = join(packageDir, "dist");
  mkdirSync(join(dist, "bin"), { recursive: true });
  // Same layout as the real package: ESM bundles under a package.json with "type": "module".
  writeFileSync(join(packageDir, "package.json"), JSON.stringify({ name: "harness-memory-fake", type: "module" }), "utf8");
  const hookScript = join(dist, "hook.js");
  writeFileSync(hookScript, FAKE_HOOK, "utf8");
  for (const name of ["hook-bundle.js", "worker.js", "embed-helper.js"]) writeFileSync(join(dist, name), "// stub\n", "utf8");
  const configDir = join(base, "claude-config");
  mkdirSync(configDir, { recursive: true });
  const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_CONFIG_DIR: configDir };
  delete env.HARNESS_MEMORY_DISABLE;
  delete env.HARNESS_MEMORY_DEBUG;
  return {
    root,
    paths: resolvePaths(root),
    hookScript,
    packageDir,
    configDir,
    env,
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}

export interface HmResult {
  code: number;
  stdout: string;
  stderr: string;
  json<T = unknown>(): T;
}

export interface RunHmOptions extends Omit<RunCliOptions, "streams" | "seams"> {
  seams?: CliSeams;
}

/** Runs the dispatcher in-process with `--root <project.root>` appended and the project's env. */
export async function runHm(project: CliProject, argv: readonly string[], options: RunHmOptions = {}): Promise<HmResult> {
  let stdout = "";
  let stderr = "";
  const seams: CliSeams = { hookScript: project.hookScript, detectClaudeVersion: () => "2.1.172", provider: null, ...options.seams };
  const code = await runCli([...argv, "--root", project.root], {
    cwd: project.root,
    env: project.env,
    isTTY: false,
    ...options,
    seams,
    streams: {
      stdout: (text) => {
        stdout += text;
      },
      stderr: (text) => {
        stderr += text;
      },
    },
  });
  return {
    code,
    stdout,
    stderr,
    json: <T>() => JSON.parse(stdout) as T,
  };
}
