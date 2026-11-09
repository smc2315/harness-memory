import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { Database as SqlJsDatabase } from "sql.js";

import { DatabaseNewerThanCodeError, LockBusyError } from "../src/core/errors";
import { resolvePaths, TARGET_USER_VERSION, type HarnessPaths } from "../src/core/paths";
import { cleanOrphanTmp, DatabaseMissingError, verifySqliteHeader } from "../src/db/db-file";
import { LOCK_OWNER_FILE } from "../src/db/locks";
import { getDbGeneration, getMeta, hasWriteOp } from "../src/db/meta";
import { SEMANTIC_KEY_BACKFILL_META_KEY } from "../src/db/post-migrate";
import { selectCount, selectValue } from "../src/db/sql";
import { loadSqlJs } from "../src/db/sqlite";
import { noopOp, Store, type StoreHooks, type StoreLogger, type WriteOp } from "../src/db/store";
import { LEGACY_FIXTURES } from "./helpers/create-test-db";

const NOW = "2026-11-08T12:00:00.000Z";

function writeMeta(db: SqlJsDatabase, key: string, value: string): void {
  db.run("INSERT INTO meta (key, value) VALUES (?, ?)", [key, value]);
}

function op(id: string | null, kind = "test"): WriteOp {
  return { id, kind, noop: false, wrote: true };
}

function captureLogger(): StoreLogger & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    log: (message) => void lines.push(`log ${message}`),
    warn: (message) => void lines.push(`warn ${message}`),
    error: (message) => void lines.push(`error ${message}`),
  };
}

describe("Store.withWriteLock", () => {
  let root: string;
  let paths: HarnessPaths;
  let calls: string[];
  let hooks: StoreHooks;
  let logger: ReturnType<typeof captureLogger>;
  let store: Store;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "hm-store-"));
    paths = resolvePaths(root);
    calls = [];
    hooks = {
      postMigrate: () => void calls.push("postMigrate"),
      deriveRules: () => void calls.push("deriveRules"),
      buildSnapshot: (_db, ctx) => void calls.push(`buildSnapshot:${ctx.generation}`),
    };
    logger = captureLogger();
    store = new Store({ paths, hooks, logger, clock: () => NOW });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("first write creates and migrates the database and calls hooks in order", async () => {
    const result = await store.withWriteLock("test", 0, (db, ctx) => {
      calls.push("fn");
      expect(ctx.userVersion).toBe(TARGET_USER_VERSION);
      expect(ctx.generation).toBe(1);
      expect(ctx.now).toBe(NOW);
      expect(ctx.alreadyApplied("run-1")).toBe(false);
      writeMeta(db, "test:1", "a");
      return op("run-1", "extract");
    });

    expect(calls).toEqual(["postMigrate", "fn", "deriveRules", "buildSnapshot:1"]);
    expect(result).toMatchObject({
      saved: true,
      generation: 1,
      userVersion: TARGET_USER_VERSION,
      recovered: false,
      alreadyApplied: false,
      snapshotBuilt: true,
      snapshotError: null,
      lockTakenOver: false,
      backupPath: null,
    });
    expect(result.migrated).toMatchObject({ from: 0, to: TARGET_USER_VERSION });
    expect(existsSync(paths.db)).toBe(true);
    expect(existsSync(paths.dbPrev)).toBe(false);
    expect(verifySqliteHeader(readFileSync(paths.db))).toBe(true);
    expect(existsSync(paths.dbLock)).toBe(false);

    await store.read((db, ctx) => {
      expect(ctx.userVersion).toBe(TARGET_USER_VERSION);
      expect(ctx.generation).toBe(1);
      expect(ctx.migrationNeeded).toBe(false);
      expect(getDbGeneration(db)).toBe(1);
      expect(hasWriteOp(db, "run-1")).toBe(true);
      expect(getMeta(db, "test:1")).toBe("a");
      expect(selectValue(db, "SELECT kind FROM write_ops WHERE id = 'run-1'")).toBe("extract");
      expect(selectValue(db, "SELECT applied_at FROM write_ops WHERE id = 'run-1'")).toBe(NOW);
      expect(selectValue(db, "PRAGMA foreign_keys")).toBe(1);
    });
  });

  test("noop without writes rolls back, skips the save and leaves the file untouched", async () => {
    await store.withWriteLock("seed", 0, (db) => {
      writeMeta(db, "test:1", "a");
      return op("run-1");
    });
    const before = readFileSync(paths.db);
    const mtimeBefore = statSync(paths.db).mtimeMs;
    calls = [];

    const result = await store.withWriteLock("noop", 0, (db) => {
      writeMeta(db, "test:2", "rolled back");
      return noopOp("noop");
    });

    expect(result.saved).toBe(false);
    expect(result.generation).toBe(1);
    expect(result.snapshotBuilt).toBe(false);
    expect(calls).toEqual([]);
    expect(statSync(paths.db).mtimeMs).toBe(mtimeBefore);
    expect(Buffer.compare(readFileSync(paths.db), before)).toBe(0);
    await store.read((db) => {
      expect(getMeta(db, "test:2")).toBeNull();
      expect(getDbGeneration(db)).toBe(1);
    });
  });

  test("noop with writes commits without bumping the generation", async () => {
    await store.withWriteLock("seed", 0, (db) => {
      writeMeta(db, "test:1", "a");
      return op("run-1");
    });
    calls = [];

    const result = await store.withWriteLock("mark", 0, (db) => {
      writeMeta(db, "test:marker", "kept");
      return { id: "run-1", kind: "extract", noop: true, wrote: true };
    });

    expect(result.saved).toBe(true);
    expect(result.generation).toBe(1);
    expect(calls).toEqual(["buildSnapshot:1"]);
    await store.read((db) => {
      expect(getMeta(db, "test:marker")).toBe("kept");
      expect(getDbGeneration(db)).toBe(1);
      expect(selectCount(db, "SELECT COUNT(*) FROM write_ops")).toBe(1);
    });
  });

  test("generation increments once per write and the same op id is applied once", async () => {
    const first = await store.withWriteLock("w1", 0, (db) => {
      writeMeta(db, "test:1", "a");
      return op("run-1");
    });
    const second = await store.withWriteLock("w2", 0, (db) => {
      writeMeta(db, "test:2", "b");
      return op("run-2");
    });
    expect(first.generation).toBe(1);
    expect(second.generation).toBe(2);
    expect(existsSync(paths.dbPrev)).toBe(true);

    let sawApplied = false;
    const replay = await store.withWriteLock("w2-again", 0, (db, ctx) => {
      sawApplied = ctx.alreadyApplied("run-2");
      writeMeta(db, "test:3", "must be rolled back");
      return op("run-2");
    });

    expect(sawApplied).toBe(true);
    expect(replay.alreadyApplied).toBe(true);
    expect(replay.op.noop).toBe(true);
    expect(replay.saved).toBe(false);
    expect(replay.generation).toBe(2);
    await store.read((db) => {
      expect(getDbGeneration(db)).toBe(2);
      expect(getMeta(db, "test:3")).toBeNull();
      expect(selectCount(db, "SELECT COUNT(*) FROM write_ops")).toBe(2);
      expect(selectValue(db, "SELECT generation FROM write_ops WHERE id = 'run-2'")).toBe(2);
    });
  });

  test("an exception in the callback rolls back and keeps the file as it was", async () => {
    await store.withWriteLock("seed", 0, (db) => {
      writeMeta(db, "test:1", "a");
      return op("run-1");
    });
    const before = readFileSync(paths.db);

    await expect(
      store.withWriteLock("boom", 0, (db) => {
        writeMeta(db, "test:2", "b");
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");

    expect(Buffer.compare(readFileSync(paths.db), before)).toBe(0);
    expect(existsSync(paths.dbLock)).toBe(false);
    await store.read((db) => {
      expect(getMeta(db, "test:2")).toBeNull();
      expect(getDbGeneration(db)).toBe(1);
    });
  });

  test("a callback that does not return a WriteOp is rejected", async () => {
    await expect(
      store.withWriteLock("bad", 0, (() => ({ kind: "x" })) as unknown as () => WriteOp)
    ).rejects.toBeInstanceOf(TypeError);
  });

  test("restores .prev when the main file header is garbage and keeps the damaged file", async () => {
    await store.withWriteLock("w1", 0, (db) => {
      writeMeta(db, "test:1", "a");
      return op("run-1");
    });
    await store.withWriteLock("w2", 0, (db) => {
      writeMeta(db, "test:2", "b");
      return op("run-2");
    });
    const garbage = Buffer.from("this is not a database".repeat(20));
    writeFileSync(paths.db, garbage);

    const result = await store.withWriteLock("w3", 0, (db) => {
      writeMeta(db, "test:3", "c");
      return op("run-3");
    });

    expect(result.recovered).toBe(true);
    expect(result.corruptPath).not.toBeNull();
    expect(result.corruptPath!.startsWith(`${paths.db}.corrupt-`)).toBe(true);
    expect(Buffer.compare(readFileSync(result.corruptPath!), garbage)).toBe(0);
    // .prev held generation 1 (the state before w2), so w3 produces generation 2 again
    expect(result.generation).toBe(2);
    expect(logger.lines.some((line) => line.startsWith("warn header check failed"))).toBe(true);
    await store.read((db) => {
      expect(getMeta(db, "test:1")).toBe("a");
      expect(getMeta(db, "test:2")).toBeNull();
      expect(getMeta(db, "test:3")).toBe("c");
      expect(hasWriteOp(db, "run-2")).toBe(false);
      expect(hasWriteOp(db, "run-3")).toBe(true);
    });
  });

  test("removes orphan tmp files older than ten minutes in db, snapshot, queue, state and raw; keeps fresh ones and real files", async () => {
    await store.withWriteLock("seed", 0, () => op("run-1"));
    mkdirSync(paths.snapshotDir, { recursive: true });
    const oldDbTmp = `${paths.db}.tmp-4242`;
    const oldSnapshotTmp = join(paths.snapshotDir, "active.v1.json.tmp-4242");
    // hook writeJsonAtomic / worker import / idle sweep / notify / provider cache leftovers (killed between write and rename)
    const oldQueueTmp = join(paths.queueDir, "ep-0123456789abcdef.json.tmp-4242");
    const oldStateTmp = join(paths.stateDir, "claude-code-0123456789abcdef.json.tmp-4242");
    const oldNotifyTmp = join(paths.stateDir, "claude-code-0123456789abcdef.notify.json.tmp-4242");
    const oldRawTmp = join(paths.rawDir, "run-1.json.tmp-4242");
    const freshTmp = `${paths.db}.tmp-777`;
    const freshQueueTmp = join(paths.queueDir, "ep-fresh.json.tmp-777");
    const realQueueFile = join(paths.queueDir, "ep-real.json");
    const realStateFile = join(paths.stateDir, "claude-code-real.json");
    const oldOnes = [oldDbTmp, oldSnapshotTmp, oldQueueTmp, oldStateTmp, oldNotifyTmp, oldRawTmp];
    for (const file of [...oldOnes, freshTmp, freshQueueTmp, realQueueFile, realStateFile]) {
      writeFileSync(file, "x");
    }
    const oneHourAgo = new Date(Date.parse(NOW) - 3_600_000);
    for (const file of [...oldOnes, realQueueFile, realStateFile]) {
      utimesSync(file, oneHourAgo, oneHourAgo);
    }
    const now = new Date(Date.parse(NOW));
    utimesSync(freshTmp, now, now);
    utimesSync(freshQueueTmp, now, now);

    const result = await store.withWriteLock("sweep", 0, () => noopOp("sweep"));

    expect(result.orphansRemoved.sort()).toEqual([...oldOnes].sort());
    for (const file of oldOnes) {
      expect(existsSync(file)).toBe(false);
    }
    expect(existsSync(freshTmp)).toBe(true);
    expect(existsSync(freshQueueTmp)).toBe(true);
    expect(existsSync(realQueueFile)).toBe(true);
    expect(existsSync(realStateFile)).toBe(true);
    expect(existsSync(paths.db)).toBe(true);

    // direct helper call with an explicit clock removes the remaining ones once they are old enough
    expect(cleanOrphanTmp(paths, 600_000, Date.parse(NOW) + 601_000).sort()).toEqual([freshTmp, freshQueueTmp].sort());
    expect(existsSync(realQueueFile)).toBe(true);
  });

  test("a lock lost to another writer during the callback is detected before the save: nothing is written", async () => {
    await store.withWriteLock("seed", 0, (db) => {
      writeMeta(db, "test:1", "a");
      return op("run-1");
    });
    const before = readFileSync(paths.db);
    const intruder = { pid: process.pid + 1, hostname: hostname(), purpose: "intruder", started_at: NOW, heartbeat_at: NOW };
    calls = [];

    let called = false;
    const attempt = store.withWriteLock("fenced", 0, (db) => {
      called = true;
      writeMeta(db, "test:2", "lost");
      // another writer took db.lock over while fn was running (our heartbeat looked stale to it)
      writeFileSync(join(paths.dbLock, LOCK_OWNER_FILE), JSON.stringify(intruder));
      return op("run-2");
    });
    await expect(attempt).rejects.toBeInstanceOf(LockBusyError);
    await expect(attempt).rejects.toMatchObject({ lockPath: paths.dbLock, holder: { purpose: "intruder" } });

    expect(called).toBe(true);
    expect(Buffer.compare(readFileSync(paths.db), before)).toBe(0);
    // deriveRules ran inside the (in-memory) transaction; the fence fired before the save, so no snapshot was built
    expect(calls).toEqual(["deriveRules"]);
    expect(logger.lines.some((line) => line.startsWith("warn db.lock was taken over by intruder"))).toBe(true);
    // the new owner's lock is left alone by our release
    expect(existsSync(paths.dbLock)).toBe(true);
    expect(JSON.parse(readFileSync(join(paths.dbLock, LOCK_OWNER_FILE), "utf8"))).toEqual(intruder);
    await store.read((db) => {
      expect(getMeta(db, "test:2")).toBeNull();
      expect(hasWriteOp(db, "run-2")).toBe(false);
      expect(getDbGeneration(db)).toBe(1);
    });
  });

  test("migrates a legacy v9 file with a backup even when the callback is a noop", async () => {
    mkdirSync(paths.dir, { recursive: true });
    copyFileSync(LEGACY_FIXTURES.v9, paths.db);
    const original = readFileSync(paths.db);
    const plainStore = new Store({ paths, logger, clock: () => NOW });

    await plainStore.read((db, ctx) => {
      expect(ctx.userVersion).toBe(9);
      expect(ctx.migrationNeeded).toBe(true);
      expect(ctx.generation).toBe(0);
      expect(selectCount(db, "SELECT COUNT(*) FROM memories")).toBe(13);
    });
    expect(Buffer.compare(readFileSync(paths.db), original)).toBe(0);

    const result = await plainStore.withWriteLock("migrate", 0, () => noopOp("migrate"));

    expect(result.migrated).toMatchObject({ from: 9, to: TARGET_USER_VERSION });
    expect(result.saved).toBe(true);
    expect(result.generation).toBe(0);
    expect(result.backupPath).toBe(paths.dbBackup(9));
    expect(Buffer.compare(readFileSync(paths.dbBackup(9)), original)).toBe(0);
    expect(Buffer.compare(readFileSync(paths.dbPrev), original)).toBe(0);

    await plainStore.read((db, ctx) => {
      expect(ctx.userVersion).toBe(TARGET_USER_VERSION);
      expect(ctx.migrationNeeded).toBe(false);
      expect(selectCount(db, "SELECT COUNT(*) FROM memories")).toBe(13);
      expect(selectCount(db, "SELECT COUNT(*) FROM evidence")).toBe(142);
      // the default post-migrate hook ran
      expect(getMeta(db, SEMANTIC_KEY_BACKFILL_META_KEY)).toBe("1");
      expect(selectCount(db, "SELECT COUNT(*) FROM memories WHERE semantic_key IS NULL")).toBe(0);
    });

    // second call: nothing to migrate, noop → no save, no second backup
    const again = await plainStore.withWriteLock("again", 0, () => noopOp("again"));
    expect(again.migrated).toBeNull();
    expect(again.saved).toBe(false);
    expect(existsSync(paths.dbBackup(TARGET_USER_VERSION))).toBe(false);
  });

  test("a custom postMigrate hook replaces the default and receives the migrate context", async () => {
    mkdirSync(paths.dir, { recursive: true });
    copyFileSync(LEGACY_FIXTURES.v10, paths.db);
    const seen: unknown[] = [];
    const customStore = new Store({
      paths,
      logger,
      clock: () => NOW,
      hooks: { postMigrate: (_db, ctx) => void seen.push({ from: ctx.from, to: ctx.to, backupPath: ctx.backupPath, now: ctx.now }) },
    });

    await customStore.withWriteLock("migrate", 0, () => noopOp("migrate"));
    expect(seen).toEqual([{ from: 10, to: TARGET_USER_VERSION, backupPath: paths.dbBackup(10), now: NOW }]);
    await customStore.read((db) => {
      expect(getMeta(db, SEMANTIC_KEY_BACKFILL_META_KEY)).toBeNull();
    });
  });

  test("postMigrate: null skips the fix-ups entirely", async () => {
    mkdirSync(paths.dir, { recursive: true });
    copyFileSync(LEGACY_FIXTURES.v10, paths.db);
    const nullStore = new Store({ paths, logger, clock: () => NOW, hooks: { postMigrate: null } });

    const result = await nullStore.withWriteLock("migrate", 0, () => noopOp("migrate"));

    expect(result.migrated).toMatchObject({ from: 10, to: TARGET_USER_VERSION });
    await nullStore.read((db) => {
      expect(getMeta(db, SEMANTIC_KEY_BACKFILL_META_KEY)).toBeNull();
      expect(selectCount(db, "SELECT COUNT(*) FROM memories WHERE semantic_key IS NULL")).toBe(1);
    });
  });

  test("refuses a database written by a newer build", async () => {
    const SQL = await loadSqlJs();
    const db = new SQL.Database();
    db.run("CREATE TABLE t (x)");
    db.run("PRAGMA user_version = 99");
    mkdirSync(paths.dir, { recursive: true });
    writeFileSync(paths.db, Buffer.from(db.export()));
    db.close();
    const before = readFileSync(paths.db);

    let called = false;
    await expect(
      store.withWriteLock("newer", 0, () => {
        called = true;
        return op("x");
      })
    ).rejects.toBeInstanceOf(DatabaseNewerThanCodeError);
    expect(called).toBe(false);
    expect(Buffer.compare(readFileSync(paths.db), before)).toBe(0);
    expect(existsSync(paths.dbLock)).toBe(false);

    await store.read((_db, ctx) => {
      expect(ctx.userVersion).toBe(99);
      expect(ctx.newerThanCode).toBe(true);
    });
  });

  test("a live lock held by someone else yields LockBusyError without touching the database", async () => {
    await store.withWriteLock("seed", 0, () => op("run-1"));
    mkdirSync(paths.dbLock, { recursive: true });
    writeFileSync(
      join(paths.dbLock, LOCK_OWNER_FILE),
      JSON.stringify({ pid: process.pid, hostname: hostname(), purpose: "other", started_at: NOW, heartbeat_at: NOW })
    );
    const before = readFileSync(paths.db);

    let called = false;
    await expect(
      store.withWriteLock("blocked", 60, () => {
        called = true;
        return op("run-2");
      })
    ).rejects.toBeInstanceOf(LockBusyError);
    expect(called).toBe(false);
    expect(Buffer.compare(readFileSync(paths.db), before)).toBe(0);
    expect(existsSync(paths.dbLock)).toBe(true);
  });

  test("rebuildSnapshot builds without saving; a failing snapshot hook does not undo the commit", async () => {
    await store.withWriteLock("seed", 0, () => op("run-1"));
    calls = [];

    const rebuilt = await store.rebuildSnapshot(0);
    expect(rebuilt.saved).toBe(false);
    expect(rebuilt.snapshotBuilt).toBe(true);
    expect(calls).toEqual(["buildSnapshot:1"]);

    const failing = new Store({
      paths,
      logger,
      clock: () => NOW,
      hooks: {
        buildSnapshot: () => {
          throw new Error("disk full");
        },
      },
    });
    const result = await failing.withWriteLock("w2", 0, (db) => {
      writeMeta(db, "test:2", "b");
      return op("run-2");
    });
    expect(result.saved).toBe(true);
    expect(result.snapshotBuilt).toBe(false);
    expect(result.snapshotError).toBeInstanceOf(Error);
    expect(logger.lines.some((line) => line.startsWith("error snapshot build failed"))).toBe(true);
    await store.read((db) => expect(getMeta(db, "test:2")).toBe("b"));
  });

  test("read on a missing database throws DatabaseMissingError", async () => {
    expect(store.exists()).toBe(false);
    await expect(store.read(() => "unreachable")).rejects.toBeInstanceOf(DatabaseMissingError);
  });

  test("read falls back to .prev in memory without changing files", async () => {
    await store.withWriteLock("w1", 0, (db) => {
      writeMeta(db, "test:1", "a");
      return op("run-1");
    });
    await store.withWriteLock("w2", 0, (db) => {
      writeMeta(db, "test:2", "b");
      return op("run-2");
    });
    const garbage = Buffer.from("garbage".repeat(50));
    writeFileSync(paths.db, garbage);

    const value = await store.read((db) => getMeta(db, "test:2"));

    expect(value).toBeNull();
    expect(Buffer.compare(readFileSync(paths.db), garbage)).toBe(0);
    expect(existsSync(`${paths.db}.corrupt-${NOW.replace(/[:.]/g, "-")}`)).toBe(false);
  });
});
