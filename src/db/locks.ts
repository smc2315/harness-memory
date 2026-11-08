/**
 * Directory lock for DB writers (spec §9.2 step 1, §9.4 F1).
 *
 * `mkdirSync(lockDir)` is the atomic primitive (EEXIST = somebody holds it). The holder publishes
 * `owner.json` `{pid, hostname, purpose, started_at, heartbeat_at}` and refreshes `heartbeat_at`
 * every 5 s on an unref'ed timer. A contender takes the lock over when the heartbeat is older than
 * `staleMs` (120 s, host-independent) or when the owner is on this host and its pid is dead.
 * Otherwise it waits with 25–250 ms jitter until `waitMs` and throws LockBusyError (CLI exit 75).
 *
 * The takeover never removes or renames the lock directory (two contenders that both saw the stale owner
 * would otherwise delete each other's fresh directory and both "hold" the lock). It is a compare-and-swap
 * on `owner.json` inside the directory: `renameSync(owner.json → owner.json.stale-<pid>-<ms>-<n>)` claims
 * the stale record (only one rename can win), the moved record must equal the one the stale verdict was
 * based on (otherwise it is moved back: the holder refreshed it or a faster contender already took over),
 * and the new owner then publishes its own `owner.json` with an exclusive create (`wx`). Since the
 * directory stays on the path throughout, nobody can `mkdir` it while another process believes it is the
 * holder. Holders check `stillHeld()` before persisting anything (fencing) and the heartbeat never
 * re-stamps an `owner.json` that carries another identity.
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

let staleClaimSequence = 0;

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
  /** True when this contender replaced a stale or dead owner's record on the way to this acquisition. */
  takenOver: boolean;
  readonly released: boolean;
  /**
   * Fencing check: does `owner.json` at the lock path still carry this handle's identity? Writers call
   * it right before persisting; false means another writer took the lock over. Always false once released.
   */
  stillHeld(): boolean;
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

function readOwnerFile(path: string): LockOwner | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isLockOwner(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function readLockOwner(lockDir: string): LockOwner | null {
  return readOwnerFile(join(lockDir, LOCK_OWNER_FILE));
}

/** Heartbeat refresh of our own record: tmp + rename, an atomic replace (readers never see a torn file). */
function replaceLockOwner(lockDir: string, owner: LockOwner): void {
  const target = join(lockDir, LOCK_OWNER_FILE);
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, JSON.stringify(owner));
  renameSync(tmp, target);
}

type PublishOutcome = "published" | "exists" | "gone";

/**
 * Exclusive create of `owner.json` (`wx`): the atomic claim of a directory that has no owner record — our
 * fresh mkdir, or a stale record we have just moved away. "exists": somebody published first (or a
 * transient sharing violation; look again later). "gone": the directory itself vanished under us.
 */
function publishLockOwner(lockDir: string, owner: LockOwner): PublishOutcome {
  try {
    writeFileSync(join(lockDir, LOCK_OWNER_FILE), JSON.stringify(owner), { flag: "wx" });
    return "published";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return "gone";
    }
    if (code === "EEXIST" || code === "EPERM" || code === "EBUSY" || code === "EACCES") {
      return "exists";
    }
    throw error;
  }
}

/** Same acquisition: pid + host + started_at (heartbeat_at changes every tick, purpose is informational). */
function sameIdentity(a: LockOwner, b: LockOwner): boolean {
  return a.pid === b.pid && a.hostname === b.hostname && a.started_at === b.started_at;
}

/** The very record the stale verdict was based on, heartbeat included (null = missing or unparsable). */
function sameRecord(a: LockOwner | null, b: LockOwner | null): boolean {
  if (a === null || b === null) {
    return a === b;
  }
  return sameIdentity(a, b) && a.purpose === b.purpose && a.heartbeat_at === b.heartbeat_at;
}

function rmQuietly(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {
    // a transient sharing violation; a leftover inside the lock directory disappears with it on release
  }
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
    // Either a contender between mkdir and the owner write (or mid-takeover: moving a record away bumps
    // the directory mtime), or an orphan from a crash in that window.
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

type TakeoverOutcome = { outcome: "acquired"; owner: LockOwner } | { outcome: "gone" } | { outcome: "held" };

/**
 * Compare-and-swap takeover of a stale owner record. Only the record the stale verdict was based on may
 * be replaced: the rename claims it exclusively, the moved copy is compared with `inspected`, and a
 * mismatch (the holder woke up and refreshed its heartbeat, or a faster contender already took over) is
 * moved back and reported as held. The lock directory itself is never removed or renamed here.
 */
function takeOverStaleOwner(lockDir: string, inspected: LockOwner | null, owner: LockOwner): TakeoverOutcome {
  const ownerPath = join(lockDir, LOCK_OWNER_FILE);
  staleClaimSequence += 1;
  const claimed = `${ownerPath}.stale-${owner.pid}-${Date.now()}-${staleClaimSequence}`;

  let moved = false;
  try {
    renameSync(ownerPath, claimed);
    moved = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      return { outcome: "held" }; // somebody is busy with the record right now; look again later
    }
  }

  if (moved) {
    if (!sameRecord(readOwnerFile(claimed), inspected)) {
      try {
        renameSync(claimed, ownerPath);
      } catch {
        rmQuietly(claimed);
      }
      return { outcome: "held" };
    }
    rmQuietly(claimed);
  } else if (inspected !== null) {
    // the stale record vanished since the inspection: its holder released or a faster contender is
    // mid-takeover; compete again from the top
    return { outcome: "gone" };
  }

  switch (publishLockOwner(lockDir, owner)) {
    case "published":
      return { outcome: "acquired", owner };
    case "gone":
      return { outcome: "gone" };
    default:
      return { outcome: "held" };
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
  const newOwner = (): LockOwner => {
    const startedAt = now();
    return { pid, hostname: host, purpose: options.purpose, started_at: startedAt, heartbeat_at: startedAt };
  };

  mkdirSync(dirname(lockDir), { recursive: true });
  const startedMs = Date.now();
  let takenOver = false;
  let owner: LockOwner;

  for (;;) {
    let holder: LockOwner | null = null;
    if (tryMkdir(lockDir)) {
      const candidate = newOwner();
      if (publishLockOwner(lockDir, candidate) === "published") {
        owner = candidate;
        break;
      }
      // our fresh directory was claimed or removed under us (e.g. an old-build contender's rmSync); compete again
    } else {
      const inspection = inspectDirLock(lockDir, { now, staleMs, hostname: host, pid, isAlive });
      holder = inspection.owner;
      if (inspection.state === "stale") {
        const takeover = takeOverStaleOwner(lockDir, inspection.owner, newOwner());
        if (takeover.outcome === "acquired") {
          owner = takeover.owner;
          takenOver = true;
          break;
        }
        if (takeover.outcome === "gone") {
          continue;
        }
      }
    }

    const elapsed = Date.now() - startedMs;
    if (elapsed >= options.waitMs) {
      throw new LockBusyError(lockDir, holder);
    }
    await sleep(jitter(options.waitMs - elapsed));
  }

  const identity = owner;
  let released = false;
  const timer = setInterval(() => {
    if (released) {
      return;
    }
    try {
      const current = readLockOwner(lockDir);
      if (current !== null && !sameIdentity(current, identity)) {
        // another writer took the lock over: never re-stamp its owner.json as ours
        return;
      }
      replaceLockOwner(lockDir, { ...identity, heartbeat_at: now() });
    } catch {
      // a transient Windows sharing violation; the next tick retries
    }
  }, heartbeatMs);
  timer.unref();

  const handle: LockHandle = {
    path: lockDir,
    owner: identity,
    takenOver,
    get released() {
      return released;
    },
    stillHeld() {
      if (released) {
        return false;
      }
      const current = readLockOwner(lockDir);
      return current !== null && sameIdentity(current, identity);
    },
    release() {
      if (released) {
        return;
      }
      released = true;
      clearInterval(timer);
      try {
        const current = readLockOwner(lockDir);
        const stillOurs = current === null || sameIdentity(current, identity);
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
