import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

function resolveCommand(command) {
  if (process.platform !== "win32") {
    return command;
  }

  if (command === "npm") {
    return "npm.cmd";
  }

  if (command === "npx") {
    return "npx.cmd";
  }

  return command;
}

function run(command, cwd) {
  const proc = spawnSync(resolveCommand(command[0]), command.slice(1), {
    cwd,
    encoding: "utf8",
    shell: process.platform === "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });

  const stdout = proc.stdout ?? "";
  const stderr = proc.stderr ?? "";

  if (proc.status !== 0) {
    throw new Error(
      [`Command failed: ${command.join(" ")}`, stdout, stderr]
        .filter(Boolean)
        .join("\n")
    );
  }

  return stdout;
}

function parsePackJson(output) {
  const match = output.match(/(\[\s*\{[\s\S]*\}\s*\])\s*$/);
  if (match === null) {
    throw new Error(`Could not find npm pack JSON in output:\n${output}`);
  }

  return JSON.parse(match[1]);
}

const repoRoot = process.cwd();
const packJson = parsePackJson(run(["npm", "pack", "--json"], repoRoot));
const tarballName = packJson[0]?.filename;

if (typeof tarballName !== "string") {
  throw new Error("Could not determine packed tarball name");
}

const tarballPath = resolve(repoRoot, tarballName);
const consumerDir = mkdtempSync(join(tmpdir(), "harness-memory-verify-"));

try {
  writeFileSync(
    join(consumerDir, "package.json"),
    JSON.stringify({ name: "pml-consumer", private: true, type: "module" }, null, 2)
  );
  writeFileSync(
    join(consumerDir, "verify-import.mjs"),
    [
      "import { MemoryRepository, ActivationEngine } from 'harness-memory';",
      "import { runBaselineEval } from 'harness-memory/eval';",
      "console.log(typeof MemoryRepository === 'function' && typeof ActivationEngine === 'function' && typeof runBaselineEval === 'function' ? 'IMPORT_OK' : 'IMPORT_FAIL');",
    ].join("\n")
  );

  run(["npm", "install", tarballPath], consumerDir);
  run(["node", "./verify-import.mjs"], consumerDir);

  const npmExec = ["npm", "exec", "--", "harness-memory"];

  run([...npmExec, "init", "--db", ".harness-memory/memory.sqlite", "--json"], consumerDir);
  run([...npmExec, "memory:list", "--db", "./.harness-memory/memory.sqlite", "--json"], consumerDir);
  run([...npmExec, "dream:run", "--db", "./.harness-memory/memory.sqlite", "--trigger", "manual", "--json"], consumerDir);
  run([...npmExec, "dream:evidence:list", "--db", "./.harness-memory/memory.sqlite", "--json"], consumerDir);
  run([...npmExec, "dream:runs:list", "--db", "./.harness-memory/memory.sqlite", "--json"], consumerDir);
  run([...npmExec, "memory:review", "--db", "./.harness-memory/memory.sqlite", "--json"], consumerDir);
  run(
    [...npmExec, "eval:baseline", "--output-dir", "./artifacts/baseline"],
    consumerDir
  );
  run(
    [
      ...npmExec,
      "eval:memory",
      "--scenario",
      "stale-conflict-suite",
      "--output-dir",
      "./artifacts/memory",
    ],
    consumerDir
  );

  if (!existsSync(join(consumerDir, "artifacts", "baseline", "baseline-summary.json"))) {
    throw new Error("Missing baseline summary after packed install verification");
  }

  if (!existsSync(join(consumerDir, "artifacts", "memory", "summary.json"))) {
    throw new Error("Missing memory summary after packed install verification");
  }

  if (!existsSync(join(consumerDir, ".opencode", "commands", "harness-memory-dream.md"))) {
    throw new Error("Missing generated OpenCode command wrapper after init");
  }

  console.log("OK packed install verified");
} finally {
  rmSync(consumerDir, { recursive: true, force: true });
  rmSync(tarballPath, { force: true });
}
