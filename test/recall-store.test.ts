/**
 * Migration 022 (`episodes.summary`, `episodes.summary_kind`, user_version 22) and the EpisodeRepository
 * summary API the recall layer relies on: setSummary precedence is the caller's, storage normalizes to one
 * line ≤ 400 chars, listWithSummary orders newest first with `since` / `limit`, countWithSummary.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { Database as SqlJsDatabase } from "sql.js";

import { TARGET_USER_VERSION } from "../src/core/paths";
import { getCurrentVersion, runMigrationsOnDb } from "../src/db/migrator";
import { EPISODE_SUMMARY_MAX_CHARS, EpisodeRepository, normalizeEpisodeSummary } from "../src/db/repositories/episodes";
import { userVersion } from "../src/db/sql";
import { createTestDb, createTestDbAtVersion } from "./helpers/create-test-db";
import { T0, episodeDescriptor, insertEpisode, isoPlus } from "./helpers/memory-fixtures";

function columns(db: SqlJsDatabase, table: string): string[] {
  const info = db.exec(`PRAGMA table_info(${table});`);
  return info.length === 0 ? [] : info[0]!.values.map((row) => String(row[1]));
}

describe("migration 022: episode summaries", () => {
  test("a fresh database lands on user_version 22 with both columns and the partial index; re-running applies nothing", async () => {
    const db = await createTestDb();
    try {
      expect(TARGET_USER_VERSION).toBe(22);
      expect(userVersion(db)).toBe(22);
      expect(columns(db, "episodes")).toEqual(expect.arrayContaining(["summary", "summary_kind"]));
      const index = db.exec("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_episodes_recall'");
      expect(index[0]?.values).toEqual([["idx_episodes_recall"]]);
      expect(runMigrationsOnDb(db)).toEqual({ from: 22, to: 22, applied: [] });
    } finally {
      db.close();
    }
  });

  test("upgrades a v21 database with rows: the episode survives with summary NULL and the CHECK rejects unknown kinds", async () => {
    const db = await createTestDbAtVersion(21);
    try {
      expect(columns(db, "episodes")).not.toContain("summary");
      const descriptor = episodeDescriptor({ id: "ep-v21" });
      expect(new EpisodeRepository(db).insertIfAbsent(descriptor, T0)).toBe(true);
      const report = runMigrationsOnDb(db);
      expect(report).toEqual({ from: 21, to: 22, applied: ["022_episode_summaries.sql"] });
      expect(getCurrentVersion(db)).toBe(22);
      const record = new EpisodeRepository(db).getById("ep-v21");
      expect(record).toMatchObject({ id: "ep-v21", status: "queued", summary: null, summaryKind: null });
      expect(() => db.run("UPDATE episodes SET summary = 'x', summary_kind = 'guessed' WHERE id = 'ep-v21'")).toThrow(/CHECK/);
      expect(db.exec("PRAGMA integrity_check;")[0]!.values[0]![0]).toBe("ok");
    } finally {
      db.close();
    }
  });
});

describe("EpisodeRepository summaries", () => {
  let db: SqlJsDatabase;
  let episodes: EpisodeRepository;

  beforeEach(async () => {
    db = await createTestDb();
    episodes = new EpisodeRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  test("setSummary stores one line ≤ 400 chars with its kind, ignores empty text and unknown ids, and overwrites on request", () => {
    const descriptor = insertEpisode(db, { id: "ep-a" });
    expect(episodes.getById(descriptor.id)).toMatchObject({ summary: null, summaryKind: null });
    expect(episodes.setSummary("ep-a", "  derived\n\nsummary  ", "derived")).toBe(true);
    expect(episodes.getById("ep-a")).toMatchObject({ summary: "derived summary", summaryKind: "derived" });
    expect(episodes.setSummary("ep-a", "x".repeat(600), "extracted")).toBe(true);
    const stored = episodes.getById("ep-a")!;
    expect(stored.summary).toHaveLength(EPISODE_SUMMARY_MAX_CHARS);
    expect(stored.summaryKind).toBe("extracted");
    expect(episodes.setSummary("ep-a", "   ", "derived")).toBe(false);
    expect(episodes.getById("ep-a")!.summaryKind).toBe("extracted");
    expect(episodes.setSummary("ep-missing", "anything", "derived")).toBe(false);
  });

  test("setSummary strips ANSI and C0 / C1 control characters at the storage boundary and ends an over-long text with …", () => {
    insertEpisode(db, { id: "ep-ctl" });
    // An escape sequence, a BEL, a NUL and a tab inside the text: none of it may reach a terminal or a model.
    expect(episodes.setSummary("ep-ctl", "a\u001b[31mb\u001b[0m\u0007 c\u0000\td\u0085e", "extracted")).toBe(true);
    expect(episodes.getById("ep-ctl")!.summary).toBe("ab c de");
    // Text that is nothing but controls / whitespace stores nothing.
    expect(episodes.setSummary("ep-ctl", "\u001b[2J \u0007 ", "derived")).toBe(false);
    expect(episodes.getById("ep-ctl")!.summaryKind).toBe("extracted");
    const long = normalizeEpisodeSummary(`${"x".repeat(600)}\u001b[0m`);
    expect(long).toHaveLength(EPISODE_SUMMARY_MAX_CHARS);
    expect(long.endsWith("…")).toBe(true);
    expect(normalizeEpisodeSummary("  one\n\n  line\r\n ")).toBe("one line");
  });

  test("import episodes never carry a recall summary: setSummary refuses them and the recall list / count skip them", () => {
    insertEpisode(db, { id: "ep-session", closed_at: isoPlus(T0, { days: -1 }) });
    insertEpisode(db, { id: "ep-import", host: "import", session_id: "import:CLAUDE.md", close_reason: "import", ledger_ref: "import:CLAUDE.md#L1", closed_at: T0 });
    expect(episodes.setSummary("ep-session", '"run the tests" | tools bash×1', "derived")).toBe(true);
    expect(episodes.setSummary("ep-import", 'import: "Never run npm test here."', "derived")).toBe(false);
    expect(episodes.setSummary("ep-import", "Never run npm test here.", "extracted")).toBe(false);
    expect(episodes.getById("ep-import")).toMatchObject({ host: "import", summary: null, summaryKind: null });
    // A summary written to an import row by another build is still invisible to recall.
    db.run("UPDATE episodes SET summary = 'leaked', summary_kind = 'derived' WHERE id = 'ep-import'");
    expect(episodes.getById("ep-import")!.summary).toBe("leaked");
    expect(episodes.listWithSummary().map((record) => record.id)).toEqual(["ep-session"]);
    expect(episodes.listWithSummary({ limit: 1 }).map((record) => record.id)).toEqual(["ep-session"]);
    expect(episodes.countWithSummary()).toBe(1);
  });

  test("listWithSummary returns summarized episodes newest first, honours since and limit; countWithSummary counts them", () => {
    insertEpisode(db, { id: "ep-old", closed_at: isoPlus(T0, { days: -3 }) });
    insertEpisode(db, { id: "ep-mid", closed_at: isoPlus(T0, { days: -2 }) });
    insertEpisode(db, { id: "ep-new", closed_at: isoPlus(T0, { days: -1 }) });
    insertEpisode(db, { id: "ep-none", closed_at: T0 });
    episodes.setSummary("ep-old", "old", "derived");
    episodes.setSummary("ep-mid", "mid", "extracted");
    episodes.setSummary("ep-new", "new", "derived");

    expect(episodes.listWithSummary().map((record) => record.id)).toEqual(["ep-new", "ep-mid", "ep-old"]);
    expect(episodes.listWithSummary({ limit: 2 }).map((record) => record.id)).toEqual(["ep-new", "ep-mid"]);
    expect(episodes.listWithSummary({ since: isoPlus(T0, { days: -2 }) }).map((record) => record.id)).toEqual(["ep-new", "ep-mid"]);
    expect(episodes.listWithSummary({ limit: 0 })).toEqual([]);
    expect(episodes.countWithSummary()).toBe(3);
    expect(episodes.countByStatus().queued).toBe(4);
  });
});
