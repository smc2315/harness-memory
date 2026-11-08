/**
 * Directory lock for DB writers (spec §9.2 step 1, §9.4 F1).
 *
 * `mkdirSync(lockDir)` is the atomic primitive (EEXIST = somebody holds it). The holder writes
 * `owner.json` `{pid, hostname, purpose, started_at, heartbeat_at}` and refreshes `heartbeat_at`
 * every 5 s on an unref'ed timer. A contender takes the lock over when the heartbeat is older than
 * `staleMs` (120 s, host-independent) or when the owner is on this host and its pid is dead.
 * Otherwise it waits with 25–250 ms jitter until `waitMs` and throws LockBusyError (CLI exit 75).
 */

import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { hostname as osHostname } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleepFor } from "node:timers/promises";

import { LockBusyError } from "../core/errors";
import { nowIso } from "../core/ids";
import { isProcessAlive } from "../core/process";

export const LOCK_OWNER_FILE = "owner.json";
export const LOCK_HEARTBEAT_MS = 5_000;
export const LOCK_STALE_MS = 120_000;
export const LOCK_WAIT_MIN_MS = 25;
export const LOCK_WAIT_MAX_MS = 250;

export interface LockOwner {
  pid: number;
  hostname: string;
  purpose: string;
  started_at: string;
  heartbeat_at: string;
}

export interface LockHandle {
  path: string;
  owner: LockOwner;
  /** True when a stale or dead owner was removed on the way to this acquisition. */
  takenOver: boolean;
  readonly released: boolean;
  /** Stops the heartbeat and removes the lock directory. Safe to call twice. */
  release(): void;
}

export interface AcquireDirLockOptions {
  purpose: string;
  /** How long to wait for a busy lock before throwing LockBusyError (0 = one attempt). */
  waitMs: number;
  staleMs?: number;
  /** Clock used for owner.json stamps and heartbeat staleness. */
  now?: () => string;
  heartbeatMs?: number;
  /** Test seams; production code leaves these unset. */
  pid?: number;
  hostname?: string;
  isAlive?: (pid: number) => boolean;
  sleep?: (ms: number) => Promise<void>;
}

export type LockState = "free" | "held" | "stale";

export interface LockInspection {
  state: LockState;
  owner: LockOwner | null;
  reason: string | null;
}

function isLockOwner(value: unknown): value is LockOwner {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.pid === "number" &&
    typeof record.hostname === "string" &&
    typeof record.purpose === "string" &&
    typeof record.started_at === "string" &&
    typeof record.heartbeat_at === "string"
  );
}

export function readLockOwner(lockDir: string): LockOwner | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(lockDir, LOCK_OWNER_FILE), "utf8"));
    return isLockOwner(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function writeLockOwner(lockDir: string, owner: LockOwner): void {
  const target = join(lockDir, LOCK_OWNER_FILE);
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, JSON.stringify(owner));
  renameSync(tmp, target);
}

interface InspectOptions {
  now: () => string;
  staleMs: number;
  hostname: string;
  pid: number;
  isAlive: (pid: number) => boolean;
}

/** Doctor/status helper and the takeover decision: what does the lock directory currently say? */
export function inspectDirLock(lockDir: string, options: Partial<InspectOptions> = {}): LockInspection {
  const now = options.now ?? nowIso;
  const staleMs = options.staleMs ?? LOCK_STALE_MS;
  const host = options.hostname ?? osHostname();
  const selfPid = options.pid ?? process.pid;
  const isAlive = options.isAlive ?? isProcessAlive;

  let dirStat;
  try {
    dirStat = statSync(lockDir);
  } catch {
    return { state: "free", owner: null, reason: null };
  }

  const owner = readLockOwner(lockDir);
  if (owner === null) {
    // Either a contender between mkdir and the owner write, or an orphan from a crash in that window.
    const ageMs = Date.now() - dirStat.mtimeMs;
    return ageMs > staleMs
      ? { state: "stale", owner: null, reason: "no owner.json and the directory is old" }
      : { state: "held", owner: null, reason: null };
  }

  const heartbeatMs = Date.parse(owner.heartbeat_at);
  const nowMs = Date.parse(now());
  if (!Number.isFinite(heartbeatMs) || nowMs - heartbeatMs > staleMs) {
    return { state: "stale", owner, reason: "heartbeat older than staleMs" };
  }
  if (owner.hostname === host && owner.pid !== selfPid && !isAlive(owner.pid)) {
    return { state: "stale", owner, reason: "owner process is dead" };
  }
  return { state: "held", owner, reason: null };
}

function tryMkdir(lockDir: string): boolean {
  try {
    mkdirSync(lockDir);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST" || code === "EPERM" || code === "EBUSY" || code === "ENOTEMPTY") {
      return false;
    }
    throw error;
  }
}

function jitter(remainingMs: number): number {
  const span = LOCK_WAIT_MAX_MS - LOCK_WAIT_MIN_MS + 1;
  return Math.max(1, Math.min(remainingMs, LOCK_WAIT_MIN_MS + Math.floor(Math.random() * span)));
}

export async function acquireDirLock(lockDir: string, options: AcquireDirLockOptions): Promise<LockHandle> {
  const now = options.now ?? nowIso;
  const staleMs = options.staleMs ?? LOCK_STALE_MS;
  const heartbeatMs = options.heartbeatMs ?? LOCK_HEARTBEAT_MS;
  const pid = options.pid ?? process.pid;
  const host = options.hostname ?? osHostname();
  const isAlive = options.isAlive ?? isProcessAlive;
  const sleep = options.sleep ?? ((ms: number) => sleepFor(ms));

  mkdirSync(dirname(lockDir), { recursive: true });
  const startedMs = Date.now();
  let takenOver = false;

  for (;;) {
    if (tryMkdir(lockDir)) {
      break;
    }

    const inspection = inspectDirLock(lockDir, { now, staleMs, hostname: host, pid, isAlive });
    if (inspection.state === "stale") {
      try {
        rmSync(lockDir, { recursive: true, force: true });
        takenOver = true;
        continue;
      } catch {
        // the holder may be releasing right now; fall through and wait
      }
    }

    const elapsed = Date.now() - startedMs;
    if (elapsed >= options.waitMs) {
      throw new LockBusyError(lockDir, inspection.owner);
    }
    await sleep(jitter(options.waitMs - elapsed));
  }

  const startedAt = now();
  const owner: LockOwner = { pid, hostname: host, purpose: options.purpose, started_at: startedAt, heartbeat_at: startedAt };
  writeLockOwner(lockDir, owner);

  let released = false;
  const timer = setInterval(() => {
    if (released) {
      return;
    }
    try {
      writeLockOwner(lockDir, { ...owner, heartbeat_at: now() });
    } catch {
      // a transient Windows sharing violation; the next tick retries
    }
  }, heartbeatMs);
  timer.unref();

  const handle: LockHandle = {
    path: lockDir,
    owner,
    takenOver,
    get released() {
      return released;
    },
    release() {
      if (released) {
        return;
      }
      released = true;
      clearInterval(timer);
      try {
        const current = readLockOwner(lockDir);
        const stillOurs = current === null || (current.pid === owner.pid && current.started_at === owner.started_at);
        if (stillOurs) {
          rmSync(lockDir, { recursive: true, force: true });
        }
      } catch {
        // nothing sensible to do on release failure; the lock is stale after 120 s anyway
      }
    },
  };

  return handle;
}
