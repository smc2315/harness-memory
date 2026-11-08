import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
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

    handle.release();
    handle.release();
    expect(handle.released).toBe(true);
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
    handle.release();
    expect(existsSync(lockDir)).toBe(false);
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
});
