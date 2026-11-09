/**
 * Spawns a headless CLI (claude / codex) with the prompt on stdin, collects stdout/stderr and kills
 * the whole child tree when the wall clock runs out (spec §5.4: 120 s → `timeout`). No shell is
 * involved: Node resolves `.exe` through PATHEXT on Windows (m0-facts #4).
 */

import { spawn } from "node:child_process";

import type { CommandRunInput, CommandRunResult, CommandRunner } from "./types";

const MAX_OUTPUT_CHARS = 4 * 1024 * 1024;

function appendCapped(current: string, chunk: string): string {
  if (current.length >= MAX_OUTPUT_CHARS) return current;
  const next = current + chunk;
  return next.length > MAX_OUTPUT_CHARS ? next.slice(0, MAX_OUTPUT_CHARS) : next;
}

/** Kills the child and its descendants: `taskkill /T /F` on Windows, the process group elsewhere. */
export function killProcessTree(pid: number): void {
  if (process.platform === "win32") {
    try {
      const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      killer.on("error", () => {
        // taskkill missing: fall through to a plain kill below
      });
    } catch {
      // ignore
    }
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
}

export const runCommand: CommandRunner = (input: CommandRunInput): Promise<CommandRunResult> =>
  new Promise<CommandRunResult>((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let timer: NodeJS.Timeout | null = null;

    const finish = (result: CommandRunResult): void => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      resolve(result);
    };

    let child;
    try {
      child = spawn(input.binary, [...input.args], {
        cwd: input.cwd,
        env: input.env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        // A process group of its own lets us kill the whole tree on POSIX; Windows uses taskkill /T.
        detached: process.platform !== "win32",
      });
    } catch (error) {
      finish({ stdout: "", stderr: "", exitCode: null, timedOut: false, spawnError: errorMessage(error) });
      return;
    }

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout = appendCapped(stdout, chunk);
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr = appendCapped(stderr, chunk);
    });
    child.on("error", (error) => {
      finish({ stdout, stderr, exitCode: null, timedOut, spawnError: errorMessage(error) });
    });
    child.on("close", (code) => {
      finish({ stdout, stderr, exitCode: code, timedOut, spawnError: null });
    });

    timer = setTimeout(() => {
      timedOut = true;
      if (child.pid !== undefined) killProcessTree(child.pid);
      // `close` may never fire when the pipes are held by grandchildren; settle after a grace period.
      setTimeout(() => finish({ stdout, stderr, exitCode: null, timedOut: true, spawnError: null }), 2_000).unref();
    }, Math.max(1, input.timeoutMs));

    try {
      child.stdin?.on("error", () => {
        // EPIPE when the child exits before reading the prompt; the close handler reports it.
      });
      child.stdin?.end(input.stdin, "utf8");
    } catch {
      // ignore: the close/error handlers settle the promise
    }
  });

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
