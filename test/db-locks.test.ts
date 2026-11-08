import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { LockBusyError } from "../src/core/errors";
import { acquireDirLock, inspectDirLock, LOCK_OWNER_FILE, readLockOwner, type LockOwner } from "../src/db/locks";

const T0 = "2026-11-08T10:00:00.000Z";

function isoPlus(ms: number): string {
  return new Date(Date.parse(T0) + ms).toISOString();
}

function writeOwner(lockDir: string, owner: LockOwner): void {
  mkdirSync(lockDir, { recursive: true });
  writeFileSync(join(lockDir, LOCK_OWNER_FILE), JSON.stringify(owner));
}

describe("acquireDirLock", () => {
  let root: string;
  let lockDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "hm-locks-"));
    lockDir = join(root, "locks", "db.lock");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("acquires a free lock, writes owner.json and releases idempotently", async () => {
    const handle = await acquireDirLock(lockDir, { purpose: "test", waitMs: 0, now: () => T0 });

    expect(handle.takenOver).toBe(false);
    expect(handle.released).toBe(false);
    const owner = JSON.parse(readFileSync(join(lockDir, LOCK_OWNER_FILE), "utf8")) as LockOwner;
    expect(owner).toEqual({
      pid: process.pid,
      hostname: hostname(),
      purpose: "test",
      started_at: T0,
      heartbeat_at: T0,
    });
    expect(inspectDirLock(lockDir, { now: () => T0 }).state).toBe("held");
    expect(handle.stillHeld()).toBe(true);

    handle.release();
    handle.release();
    expect(handle.released).toBe(true);
    expect(handle.stillHeld()).toBe(false);
    expect(existsSync(lockDir)).toBe(false);
    expect(inspectDirLock(lockDir).state).toBe("free");
  });

  test("a busy lock throws LockBusyError once waitMs has elapsed", async () => {
    const first = await acquireDirLock(lockDir, { purpose: "first", waitMs: 0, now: () => T0 });
    const started = Date.now();

    const attempt = acquireDirLock(lockDir, { purpose: "second", waitMs: 120, now: () => isoPlus(1_000) });
    await expect(attempt).rejects.toBeInstanceOf(LockBusyError);
    expect(Date.now() - started).toBeGreaterThanOrEqual(100);
    await expect(attempt).rejects.toMatchObject({ lockPath: lockDir, holder: { purpose: "first" } });

    // waitMs = 0 is a single attempt without sleeping
    await expect(acquireDirLock(lockDir, { purpose: "third", waitMs: 0, now: () => isoPlus(1_000) })).rejects.toBeInstanceOf(
      LockBusyError
    );

    first.release();
    const after = await acquireDirLock(lockDir, { purpose: "after", waitMs: 0, now: () => isoPlus(2_000) });
    expect(after.takenOver).toBe(false);
    after.release();
  });

  test("takes over a lock whose heartbeat is older than staleMs even if the pid is alive", async () => {
    writeOwner(lockDir, { pid: process.pid, hostname: hostname(), purpose: "crashed", started_at: T0, heartbeat_at: T0 });

    const handle = await acquireDirLock(lockDir, {
      purpose: "takeover",
      waitMs: 0,
      now: () => isoPlus(121_000),
      staleMs: 120_000,
    });

    expect(handle.takenOver).toBe(true);
    expect(readLockOwner(lockDir)).toMatchObject({ purpose: "takeover", started_at: isoPlus(121_000) });
    // the stale record was moved aside, verified and deleted; the directory itself was never touched
    expect(readdirSync(join(root, "locks"))).toEqual([basename(lockDir)]);
    expect(readdirSync(lockDir)).toEqual([LOCK_OWNER_FILE]);
    handle.release();
    expect(existsSync(lockDir)).toBe(false);
  });

  test("a stale verdict never removes the lock a faster contender has already taken over", async () => {
    // Contender B reads the dead owner and decides "stale"; before B acts, contender A completes its own
    // takeover (rm + mkdir + owner.json). The isAlive seam runs A's actions inside B's inspection, i.e. in the
    // exact inspect → remove window. B must back off: the old rmSync on the live path deleted A's fresh lock.
    const dead: LockOwner = { pid: 987_654, hostname: hostname(), purpose: "crashed", started_at: T0, heartbeat_at: T0 };
    const fast: LockOwner = { pid: 424_242, hostname: hostname(), purpose: "fast", started_at: isoPlus(1_000), heartbeat_at: isoPlus(1_000) };
    writeOwner(lockDir, dead);
    let simulated = false;
    const isAlive = (pid: number): boolean => {
      if (pid === dead.pid && !simulated) {
        simulated = true;
        rmSync(lockDir, { recursive: true, force: true });
        writeOwner(lockDir, fast);
        return false;
      }
      return pid !== dead.pid;
    };

    const attempt = acquireDirLock(lockDir, { purpose: "slow", waitMs: 80, now: () => isoPlus(1_000), isAlive });
    await expect(attempt).rejects.toBeInstanceOf(LockBusyError);
    await expect(attempt).rejects.toMatchObject({ holder: { purpose: "fast" } });

    expect(simulated).toBe(true);
    expect(readLockOwner(lockDir)).toEqual(fast);
    expect(readdirSync(join(root, "locks"))).toEqual(["db.lock"]);
    expect(readdirSync(lockDir)).toEqual([LOCK_OWNER_FILE]);
  });

  test("a holder that refreshes its heartbeat right after the stale verdict keeps the lock", async () => {
    // e.g. a writer that was suspended for > staleMs and wakes up between our inspection and our removal
    const holder: LockOwner = { pid: 1, hostname: "other-host", purpose: "paused", started_at: T0, heartbeat_at: T0 };
    const refreshed: LockOwner = { ...holder, heartbeat_at: isoPlus(121_000) };
    writeOwner(lockDir, holder);
    let woke = false;
    const now = (): string => {
      if (!woke) {
        woke = true;
        writeFileSync(join(lockDir, LOCK_OWNER_FILE), JSON.stringify(refreshed));
      }
      return isoPlus(121_000);
    };

    await expect(acquireDirLock(lockDir, { purpose: "me", waitMs: 60, now, staleMs: 120_000 })).rejects.toBeInstanceOf(LockBusyError);

    expect(readLockOwner(lockDir)).toEqual(refreshed);
    expect(readdirSync(join(root, "locks"))).toEqual(["db.lock"]);
    expect(readdirSync(lockDir)).toEqual([LOCK_OWNER_FILE]);
  });

  test("losing the fresh directory between mkdir and the owner write makes the contender compete again", async () => {
    let calls = 0;
    const now = (): string => {
      calls += 1;
      if (calls === 1) {
        // a contender that inspected the previous incarnation removes our directory right after our mkdir
        rmSync(lockDir, { recursive: true, force: true });
      }
      return T0;
    };

    const handle = await acquireDirLock(lockDir, { purpose: "retry", waitMs: 500, now });

    expect(handle.takenOver).toBe(false);
    expect(readLockOwner(lockDir)).toMatchObject({ purpose: "retry", pid: process.pid });
    handle.release();
  });

  test("does not take over a fresh heartbeat (just under staleMs)", async () => {
    writeOwner(lockDir, { pid: 1, hostname: "other-host", purpose: "remote", started_at: T0, heartbeat_at: T0 });

    await expect(
      acquireDirLock(lockDir, { purpose: "me", waitMs: 40, now: () => isoPlus(119_000), staleMs: 120_000 })
    ).rejects.toBeInstanceOf(LockBusyError);
    expect(readLockOwner(lockDir)?.purpose).toBe("remote");
  });

  test("takes over when the owner process on this host is dead", async () => {
    writeOwner(lockDir, { pid: 987_654, hostname: hostname(), purpose: "dead", started_at: T0, heartbeat_at: T0 });

    const handle = await acquireDirLock(lockDir, {
      purpose: "survivor",
      waitMs: 0,
      now: () => isoPlus(1_000),
      isAlive: (pid) => pid !== 987_654,
    });

    expect(handle.takenOver).toBe(true);
    expect(readLockOwner(lockDir)?.purpose).toBe("survivor");
    handle.release();
  });

  test("a dead pid on another host is not inspected; the heartbeat decides", async () => {
    writeOwner(lockDir, { pid: 987_654, hostname: "elsewhere", purpose: "remote", started_at: T0, heartbeat_at: T0 });

    await expect(
      acquireDirLock(lockDir, { purpose: "me", waitMs: 30, now: () => isoPlus(1_000), isAlive: () => false })
    ).rejects.toBeInstanceOf(LockBusyError);
  });

  test("an orphan directory without owner.json is taken over only once it is old", async () => {
    mkdirSync(lockDir, { recursive: true });
    expect(inspectDirLock(lockDir, { staleMs: 60_000 }).state).toBe("held");
    expect(inspectDirLock(lockDir, { staleMs: -1 }).state).toBe("stale");

    const handle = await acquireDirLock(lockDir, { purpose: "me", waitMs: 0, now: () => T0, staleMs: -1 });
    expect(handle.takenOver).toBe(true);
    handle.release();

    // a crash in the middle of the exclusive owner.json write leaves an unparsable record: same rule
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(join(lockDir, LOCK_OWNER_FILE), '{"pid": 12');
    expect(inspectDirLock(lockDir, { staleMs: 60_000 }).state).toBe("held");
    const again = await acquireDirLock(lockDir, { purpose: "me", waitMs: 0, now: () => T0, staleMs: -1 });
    expect(again.takenOver).toBe(true);
    expect(readLockOwner(lockDir)?.purpose).toBe("me");
    expect(readdirSync(lockDir)).toEqual([LOCK_OWNER_FILE]);
    again.release();
  });

  test("heartbeat refreshes heartbeat_at while held", async () => {
    let offset = 0;
    const handle = await acquireDirLock(lockDir, {
      purpose: "beat",
      waitMs: 0,
      now: () => isoPlus(offset),
      heartbeatMs: 15,
    });

    offset = 5_000;
    await sleep(120);
    expect(readLockOwner(lockDir)?.heartbeat_at).toBe(isoPlus(5_000));
    expect(readLockOwner(lockDir)?.started_at).toBe(T0);

    handle.release();
    offset = 10_000;
    await sleep(60);
    expect(existsSync(lockDir)).toBe(false);
  });

  test("release leaves a lock alone when another owner took it over", async () => {
    const handle = await acquireDirLock(lockDir, { purpose: "slow", waitMs: 0, now: () => T0 });
    const intruder: LockOwner = {
      pid: process.pid + 1,
      hostname: hostname(),
      purpose: "intruder",
      started_at: isoPlus(200_000),
      heartbeat_at: isoPlus(200_000),
    };
    writeFileSync(join(lockDir, LOCK_OWNER_FILE), JSON.stringify(intruder));

    handle.release();

    expect(existsSync(lockDir)).toBe(true);
    expect(readLockOwner(lockDir)?.purpose).toBe("intruder");
  });

  test("the heartbeat never re-stamps owner.json after another owner took the lock over", async () => {
    const handle = await acquireDirLock(lockDir, { purpose: "slow", waitMs: 0, now: () => T0, heartbeatMs: 15 });
    const intruder: LockOwner = {
      pid: process.pid + 1,
      hostname: hostname(),
      purpose: "intruder",
      started_at: isoPlus(200_000),
      heartbeat_at: isoPlus(200_000),
    };
    writeFileSync(join(lockDir, LOCK_OWNER_FILE), JSON.stringify(intruder));

    await sleep(90); // several heartbeat ticks
    expect(readLockOwner(lockDir)).toEqual(intruder);
    expect(handle.stillHeld()).toBe(false);

    handle.release();
    expect(readLockOwner(lockDir)).toEqual(intruder);
  });
});
