/**
 * Process helpers shared by hooks (spawning the worker / embedding helper) and the worker
 * (spawning the headless extraction CLI). Spec §3.1, §5.4, §9.4 F5; facts in docs/redesign/m0-facts.md.
 */

import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { delimiter, join } from "node:path";

/** Exact variable names forwarded to child processes. Everything else — notably CLAUDECODE, CLAUDE_CODE_*, CODEX* — is dropped. */
const ENV_ALLOWLIST = new Set<string>([
  "PATH",
  "Path",
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "TEMP",
  "TMP",
  "TMPDIR",
  "SystemRoot",
  "SYSTEMROOT",
  "windir",
  "ComSpec",
  "PATHEXT",
  "HOMEDRIVE",
  "HOMEPATH",
  "ProgramData",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "ProgramW6432",
  "CommonProgramFiles",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
  "OS",
  "USERNAME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TERM",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "CODEX_HOME",
  "HARNESS_MEMORY_HOME",
  "HARNESS_MEMORY_DEBUG",
  "HARNESS_MEMORY_CLAUDE_BIN",
  "HARNESS_MEMORY_CODEX_BIN",
  "HARNESS_MEMORY_PROVIDER",
]);

const ENV_PREFIX_ALLOWLIST = ["ANTHROPIC_", "OPENAI_", "XDG_"];

/**
 * Allowlisted environment for every child we spawn. `HARNESS_MEMORY_DISABLE=1` is always set so
 * that hooks fired inside a nested `claude -p` exit before reading anything (recursion guard 1).
 */
export function providerEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (ENV_ALLOWLIST.has(key) || ENV_PREFIX_ALLOWLIST.some((prefix) => key.startsWith(prefix))) {
      env[key] = value;
    }
  }
  env.HARNESS_MEMORY_DISABLE = "1";
  return { ...env, ...extra };
}

export interface SpawnDetachedOptions {
  cwd?: string;
  env?: Record<string, string>;
  /** Defaults to process.execPath (never a bare `node`, which may not be on PATH). */
  execPath?: string;
  /**
   * Called for a spawn failure that Node reports asynchronously (EAGAIN/EMFILE/ENFILE/ENOENT/EACCES arrive
   * as an `error` event after `spawn` has returned, so the try/catch below never sees them). Default: ignore.
   */
  onError?: (error: Error) => void;
}

/** Fire-and-forget child that survives this process (verified on Windows/Node, m0-facts #1). Returns the pid or null. */
export function spawnDetached(scriptPath: string, args: readonly string[], options: SpawnDetachedOptions = {}): number | null {
  try {
    const child = spawn(options.execPath ?? process.execPath, [scriptPath, ...args], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      cwd: options.cwd,
      env: options.env ?? providerEnv(),
    });
    // Without a listener a deferred spawn error is an uncaught exception that fires after the hook's own
    // try/catch has returned: Node exits 1 and the host shows a hook error (spec §8.6: exit is always 0).
    child.on("error", (error) => {
      try {
        options.onError?.(error);
      } catch {
        // the callback must not become the uncaught exception this listener exists to prevent
      }
    });
    child.unref();
    return child.pid ?? null;
  } catch {
    return null;
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // EPERM means the process exists but belongs to someone else.
    return code === "EPERM";
  }
}

function searchPath(names: readonly string[]): string | null {
  const pathValue = process.env.PATH ?? process.env.Path ?? "";
  for (const dir of pathValue.split(delimiter)) {
    if (dir.length === 0) continue;
    for (const name of names) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function wingetClaude(): string | null {
  const local = process.env.LOCALAPPDATA;
  if (local === undefined) return null;
  const packages = join(local, "Microsoft", "WinGet", "Packages");
  if (!existsSync(packages)) return null;
  try {
    for (const entry of readdirSync(packages)) {
      if (!entry.startsWith("Anthropic.ClaudeCode_")) continue;
      const candidate = join(packages, entry, "claude.exe");
      if (existsSync(candidate)) return candidate;
    }
  } catch {
    // ignore unreadable package directories
  }
  return null;
}

/**
 * Resolution order (m0-facts #6): explicit override → the running Claude Code binary advertised to
 * hooks → PATH lookup → winget package directory. Returns null when nothing is found (`no_provider`).
 */
export function resolveClaudeBinary(): string | null {
  const override = process.env.HARNESS_MEMORY_CLAUDE_BIN;
  if (override !== undefined && override.length > 0 && existsSync(override)) return override;
  const advertised = process.env.CLAUDE_CODE_EXECPATH;
  if (advertised !== undefined && advertised.length > 0 && existsSync(advertised)) return advertised;
  const names = process.platform === "win32" ? ["claude.exe", "claude.cmd", "claude"] : ["claude"];
  return searchPath(names) ?? wingetClaude();
}

export function resolveCodexBinary(): string | null {
  const override = process.env.HARNESS_MEMORY_CODEX_BIN;
  if (override !== undefined && override.length > 0 && existsSync(override)) return override;
  const names = process.platform === "win32" ? ["codex.exe", "codex.cmd", "codex"] : ["codex"];
  return searchPath(names);
}
