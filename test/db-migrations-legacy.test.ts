import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { Database as SqlJsDatabase } from "sql.js";

import { DatabaseNewerThanCodeError } from "../src/core/errors";
import { semanticKey } from "../src/core/ids";
import { TARGET_USER_VERSION } from "../src/core/paths";
import { silentLogger, verifySqliteHeader } from "../src/db/db-file";
import { getMeta } from "../src/db/meta";
import { getCurrentVersion, getMigrationFiles, runMigrations, runMigrationsOnDb } from "../src/db/migrator";
import {
  MERGE_PROPOSAL_DAYS,
  runPostMigrate,
  SEMANTIC_KEY_BACKFILL_META_KEY,
  TEMPLATE_CANDIDATE_REASON,
} from "../src/db/post-migrate";
import { selectAll, selectCount, selectValue } from "../src/db/sql";
import { loadSqlJs } from "../src/db/sqlite";
import { createTestDb, createTestDbAtVersion, createTestDbFromFixture, LEGACY_FIXTURES } from "./helpers/create-test-db";

const NOW = "2026-11-08T12:00:00.000Z";

function expectHealthy(db: SqlJsDatabase): void {
  expect(getCurrentVersion(db)).toBe(TARGET_USER_VERSION);
  expect(selectValue(db, "PRAGMA integrity_check")).toBe("ok");
  expect(selectAll(db, "PRAGMA foreign_key_check")).toEqual([]);
  expect(selectValue(db, "PRAGMA foreign_keys")).toBe(1);
}

function insertMemory(
  db: SqlJsDatabase,
  input: { id: string; summary: string; details: string; createdAt: string; status?: string; type?: string; scopeGlob?: string }
): void {
  db.run(
    `INSERT INTO memories (id, content_hash, identity_key, type, summary, details, scope_glob, lifecycle_triggers,
                           confidence, importance, status, created_at, updated_at, authority, source_kind)
     VALUES (?, ?, ?, ?, ?, ?, ?, '["before_model"]', 0.8, 0.5, ?, ?, ?, 'human', 'manual')`,
    [
      input.id,
      `hash-${input.id}`,
      `identity-${input.id}`,
      input.type ?? "pitfall",
      input.summary,
      input.details,
      input.scopeGlob ?? "src/**",
      input.status ?? "active",
      input.createdAt,
      input.createdAt,
    ]
  );
}

describe("migrations: fresh database", () => {
  test("reaches user_version 21 with a clean integrity and foreign-key check", async () => {
    const db = await createTestDb({ postMigrate: false });
    try {
      expectHealthy(db);
      expect(getMigrationFiles().length).toBe(TARGET_USER_VERSION);
      for (const table of [
        "memories",
        "evidence",
        "policy_rules",
        "activation_logs",
        "audit_log",
        "session_summaries",
        "episodes",
        "extraction_runs",
        "write_ops",
        "meta",
        "proposals",
        "proposal_support",
        "memory_provenance",
        "memory_transitions",
        "legacy_dream_evidence_events",
        "legacy_dream_runs",
        "legacy_dream_memory_evidence_links",
      ]) {
        expect(selectCount(db, "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?", [table]), table).toBe(1);
      }
      expect(selectCount(db, "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'topic_summaries'")).toBe(0);
      expect(selectValue(db, "SELECT value FROM meta WHERE key = 'db_generation'")).toBe("0");

      const again = runMigrationsOnDb(db);
      expect(again).toEqual({ from: TARGET_USER_VERSION, to: TARGET_USER_VERSION, applied: [] });
    } finally {
      db.close();
    }
  });

  test("runMigrationsOnDb reports what it applied and honours target", async () => {
    const db = await createTestDbAtVersion(16);
    try {
      expect(getCurrentVersion(db)).toBe(16);
      const report = runMigrationsOnDb(db, { logger: silentLogger });
      expect(report.from).toBe(16);
      expect(report.to).toBe(TARGET_USER_VERSION);
      expect(report.applied).toEqual([
        "017_memories_authority.sql",
        "018_episodes_runs.sql",
        "019_proposals_provenance.sql",
        "020_policy_rules_v2.sql",
        "021_legacy_archive.sql",
      ]);
      expectHealthy(db);
    } finally {
      db.close();
    }
  });

  test("throws DatabaseNewerThanCodeError for user_version 99 without touching the schema", async () => {
    const SQL = await loadSqlJs();
    const db = new SQL.Database();
    try {
      db.run("PRAGMA user_version = 99");
      expect(() => runMigrationsOnDb(db)).toThrow(DatabaseNewerThanCodeError);
      try {
        runMigrationsOnDb(db);
      } catch (error) {
        expect(error).toMatchObject({ userVersion: 99, supported: TARGET_USER_VERSION });
      }
      expect(getCurrentVersion(db)).toBe(99);
      expect(selectCount(db, "SELECT COUNT(*) FROM sqlite_master")).toBe(0);
    } finally {
      db.close();
    }
  });
});

describe("migrations: legacy v9 fixture (real v0.5 install)", () => {
  let db: SqlJsDatabase;

  beforeEach(async () => {
    db = await createTestDbFromFixture(LEGACY_FIXTURES.v9, { migrate: false });
  });

  afterEach(() => {
    db.close();
  });

  test("upgrades 9 → 21 with every row preserved", () => {
    const before = {
      memories: selectCount(db, "SELECT COUNT(*) FROM memories"),
      evidence: selectCount(db, "SELECT COUNT(*) FROM evidence"),
      events: selectCount(db, "SELECT COUNT(*) FROM dream_evidence_events"),
      runs: selectCount(db, "SELECT COUNT(*) FROM dream_runs"),
    };
    expect(before).toEqual({ memories: 13, evidence: 142, events: 75, runs: 1 });

    const report = runMigrationsOnDb(db);
    db.run("PRAGMA foreign_keys = ON");

    expect(report.from).toBe(9);
    expect(report.to).toBe(TARGET_USER_VERSION);
    expect(report.applied.length).toBe(12);
    expectHealthy(db);
    expect(selectCount(db, "SELECT COUNT(*) FROM memories")).toBe(13);
    expect(selectCount(db, "SELECT COUNT(*) FROM evidence")).toBe(142);
    expect(selectCount(db, "SELECT COUNT(*) FROM legacy_dream_evidence_events")).toBe(75);
    expect(selectCount(db, "SELECT COUNT(*) FROM legacy_dream_runs")).toBe(1);
    expect(selectCount(db, "SELECT COUNT(*) FROM legacy_dream_evidence_events WHERE status = 'discarded'")).toBe(74);
    expect(selectCount(db, "SELECT COUNT(*) FROM legacy_dream_evidence_events WHERE status = 'consumed'")).toBe(1);
  });

  test("needs_scope rows equal fix_scope proposals and the authority CASE holds", () => {
    runMigrationsOnDb(db);

    const needsScope = selectCount(db, "SELECT COUNT(*) FROM memories WHERE needs_scope = 1");
    expect(needsScope).toBe(2);
    expect(selectCount(db, "SELECT COUNT(*) FROM proposals WHERE kind = 'fix_scope' AND status = 'open' AND created_by = 'migration'")).toBe(
      needsScope
    );
    expect(
      selectCount(
        db,
        `SELECT COUNT(*) FROM proposals p JOIN memories m ON m.id = p.target_memory_id
          WHERE p.kind = 'fix_scope' AND m.needs_scope = 1 AND m.source_kind = 'legacy'`
      )
    ).toBe(needsScope);

    expect(selectCount(db, "SELECT COUNT(*) FROM memories WHERE authority = 'human' AND status = 'active'")).toBe(12);
    expect(selectCount(db, "SELECT COUNT(*) FROM memories WHERE authority = 'auto' AND status = 'candidate'")).toBe(1);
    expect(selectCount(db, "SELECT COUNT(*) FROM memories WHERE authority NOT IN ('human', 'auto')")).toBe(0);
    // install.ts bullets: global baseline policies become confirmed imports
    expect(
      selectCount(
        db,
        `SELECT COUNT(*) FROM memories
          WHERE source_kind = 'import' AND source_ref = 'import:legacy' AND knowledge_kind = 'import'
            AND type = 'policy' AND scope_glob = '**' AND activation_class = 'baseline'`
      )
    ).toBe(2);
    expect(selectCount(db, "SELECT COUNT(*) FROM memories WHERE enforcement = 'advise'")).toBe(13);
    expect(selectCount(db, "SELECT COUNT(*) FROM memories WHERE signature_key = '' AND semantic_key IS NULL")).toBe(13);
  });

  test("post-migrate backfills semantic keys once and is idempotent", () => {
    runMigrationsOnDb(db);

    const first = runPostMigrate(db, { now: NOW });
    expect(first).toEqual({
      semanticKeysBackfilled: 13,
      mergeProposalsOpened: 0,
      templateCandidatesRejected: 0,
      alreadyApplied: false,
    });
    expect(getMeta(db, SEMANTIC_KEY_BACKFILL_META_KEY)).toBe("1");
    expect(selectCount(db, "SELECT COUNT(*) FROM memories WHERE semantic_key IS NULL")).toBe(0);
    const row = selectAll(db, "SELECT id, type, scope_glob, signature_key, summary, semantic_key FROM memories LIMIT 1")[0];
    expect(row.semantic_key).toBe(semanticKey(String(row.type), String(row.scope_glob), String(row.signature_key), String(row.summary)));

    const second = runPostMigrate(db, { now: NOW });
    expect(second).toEqual({
      semanticKeysBackfilled: 0,
      mergeProposalsOpened: 0,
      templateCandidatesRejected: 0,
      alreadyApplied: true,
    });
    expect(selectCount(db, "SELECT COUNT(*) FROM proposals")).toBe(2);
    expectHealthy(db);
  });
});

describe("migrations: legacy v10 fixture", () => {
  test("upgrades 10 → 21, keeps its memory, flags the R2 victim and backfills", async () => {
    const db = await createTestDbFromFixture(LEGACY_FIXTURES.v10, { migrate: false });
    try {
      expect(selectCount(db, "SELECT COUNT(*) FROM memories")).toBe(1);

      const report = runMigrationsOnDb(db);
      db.run("PRAGMA foreign_keys = ON");
      expect(report).toMatchObject({ from: 10, to: TARGET_USER_VERSION });
      expect(report.applied.length).toBe(11);
      expectHealthy(db);

      expect(selectCount(db, "SELECT COUNT(*) FROM memories")).toBe(1);
      expect(selectCount(db, "SELECT COUNT(*) FROM memories WHERE needs_scope = 1")).toBe(1);
      expect(selectCount(db, "SELECT COUNT(*) FROM proposals WHERE kind = 'fix_scope'")).toBe(1);
      expect(selectCount(db, "SELECT COUNT(*) FROM memories WHERE authority = 'auto' AND status = 'candidate' AND source_kind = 'legacy'")).toBe(1);

      const report2 = runPostMigrate(db, { now: NOW });
      expect(report2).toMatchObject({ semanticKeysBackfilled: 1, mergeProposalsOpened: 0, templateCandidatesRejected: 0 });
      expect(selectCount(db, "SELECT COUNT(*) FROM memories WHERE semantic_key IS NULL")).toBe(0);
    } finally {
      db.close();
    }
  });

  test("createTestDbFromFixture migrates and post-migrates by default", async () => {
    const db = await createTestDbFromFixture(LEGACY_FIXTURES.v10);
    try {
      expectHealthy(db);
      expect(getMeta(db, SEMANTIC_KEY_BACKFILL_META_KEY)).toBe("1");
    } finally {
      db.close();
    }
  });
});

describe("post-migrate: collisions and template candidates", () => {
  let db: SqlJsDatabase;

  beforeEach(async () => {
    db = await createTestDb({ postMigrate: false });
  });

  afterEach(() => {
    db.close();
  });

  test("the oldest row keeps the key, the newer one gets a merge proposal, templates are rejected", () => {
    insertMemory(db, { id: "old", summary: "Run the tests before committing", details: "details A", createdAt: "2026-01-01T00:00:00.000Z" });
    insertMemory(db, { id: "new", summary: "Run the tests before committing.", details: "details B", createdAt: "2026-02-01T00:00:00.000Z" });
    insertMemory(db, { id: "stale-twin", summary: "run the tests  before committing", details: "details C", createdAt: "2026-03-01T00:00:00.000Z", status: "stale" });
    insertMemory(db, { id: "terminal", summary: "Run the tests before committing", details: "details D", createdAt: "2025-12-01T00:00:00.000Z", status: "rejected" });
    insertMemory(db, { id: "template", summary: "Observed repeated pattern in session", details: "template", createdAt: "2026-04-01T00:00:00.000Z", status: "candidate" });
    insertMemory(db, { id: "other-candidate", summary: "Unrelated candidate", details: "x", createdAt: "2026-04-02T00:00:00.000Z", status: "candidate" });

    db.run("PRAGMA foreign_keys = OFF");
    db.run(
      `INSERT INTO legacy_dream_memory_evidence_links (evidence_event_id, memory_id, dream_run_id, created_at)
       VALUES ('dee-1', 'template', 'run-1', '2026-04-01T00:00:00.000Z')`
    );
    db.run("PRAGMA foreign_keys = ON");

    const report = runPostMigrate(db, { now: NOW });

    // live rows keyed: old, other-candidate; new + stale-twin collide with old; template was rejected first
    expect(report).toEqual({
      semanticKeysBackfilled: 2,
      mergeProposalsOpened: 2,
      templateCandidatesRejected: 1,
      alreadyApplied: false,
    });

    const expectedKey = semanticKey("pitfall", "src/**", "", "Run the tests before committing");
    expect(selectValue(db, "SELECT semantic_key FROM memories WHERE id = 'old'")).toBe(expectedKey);
    expect(selectValue(db, "SELECT semantic_key FROM memories WHERE id = 'new'")).toBeNull();
    expect(selectValue(db, "SELECT semantic_key FROM memories WHERE id = 'stale-twin'")).toBeNull();
    expect(selectValue(db, "SELECT semantic_key FROM memories WHERE id = 'terminal'")).toBeNull();
    expect(selectValue(db, "SELECT semantic_key FROM memories WHERE id = 'other-candidate'")).not.toBeNull();

    const merges = selectAll(
      db,
      `SELECT target_memory_id, candidate_memory_id, created_by, status, confidence, created_at, expires_at, support_count
         FROM proposals WHERE kind = 'merge' ORDER BY candidate_memory_id`
    );
    expect(merges).toEqual([
      {
        target_memory_id: "old",
        candidate_memory_id: "new",
        created_by: "migration",
        status: "open",
        confidence: 0.5,
        created_at: NOW,
        expires_at: new Date(Date.parse(NOW) + MERGE_PROPOSAL_DAYS * 86_400_000).toISOString(),
        support_count: 0,
      },
      {
        target_memory_id: "old",
        candidate_memory_id: "stale-twin",
        created_by: "migration",
        status: "open",
        confidence: 0.5,
        created_at: NOW,
        expires_at: new Date(Date.parse(NOW) + MERGE_PROPOSAL_DAYS * 86_400_000).toISOString(),
        support_count: 0,
      },
    ]);

    expect(selectAll(db, "SELECT status, status_reason, updated_at, semantic_key FROM memories WHERE id = 'template'")).toEqual([
      { status: "rejected", status_reason: "migration", updated_at: NOW, semantic_key: null },
    ]);
    expect(
      selectAll(
        db,
        "SELECT memory_id, from_status, to_status, actor, proposal_id, extraction_run_id, reason, created_at FROM memory_transitions"
      )
    ).toEqual([
      {
        memory_id: "template",
        from_status: "candidate",
        to_status: "rejected",
        actor: "migration",
        proposal_id: null,
        extraction_run_id: null,
        reason: TEMPLATE_CANDIDATE_REASON,
        created_at: NOW,
      },
    ]);
    expect(selectValue(db, "SELECT status FROM memories WHERE id = 'other-candidate'")).toBe("candidate");
    // the synthetic link row has no legacy parent rows, so only integrity (not foreign_key_check) is asserted here
    expect(selectValue(db, "PRAGMA integrity_check")).toBe("ok");

    // a second run changes nothing
    expect(runPostMigrate(db, { now: "2026-12-01T00:00:00.000Z" }).alreadyApplied).toBe(true);
    expect(selectCount(db, "SELECT COUNT(*) FROM proposals WHERE kind = 'merge'")).toBe(2);
    expect(selectCount(db, "SELECT COUNT(*) FROM memory_transitions")).toBe(1);
  });

  test("runs inside an open transaction and rolls back its own work on failure", () => {
    insertMemory(db, { id: "a", summary: "Alpha", details: "a", createdAt: "2026-01-01T00:00:00.000Z" });
    db.run("DROP TABLE memory_transitions");
    insertMemory(db, { id: "template", summary: "Template", details: "t", createdAt: "2026-01-02T00:00:00.000Z", status: "candidate" });
    db.run("PRAGMA foreign_keys = OFF");
    db.run(
      `INSERT INTO legacy_dream_memory_evidence_links (evidence_event_id, memory_id, dream_run_id, created_at)
       VALUES ('dee-1', 'template', 'run-1', '2026-01-02T00:00:00.000Z')`
    );

    db.run("BEGIN");
    expect(() => runPostMigrate(db, { now: NOW })).toThrow();
    db.run("COMMIT");

    expect(selectValue(db, "SELECT status FROM memories WHERE id = 'template'")).toBe("candidate");
    expect(selectValue(db, "SELECT semantic_key FROM memories WHERE id = 'a'")).toBeNull();
    expect(getMeta(db, SEMANTIC_KEY_BACKFILL_META_KEY)).toBeNull();
  });
});

describe("runMigrations(dbPath): CLI path with backup and atomic save", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hm-migrate-"));
    dbPath = join(dir, "memory.sqlite");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("backs up the v9 file as .bak-v9, upgrades, post-migrates and saves", async () => {
    copyFileSync(LEGACY_FIXTURES.v9, dbPath);
    const original = readFileSync(dbPath);

    const result = await runMigrations(dbPath, { logger: silentLogger, now: NOW });

    expect(result).toMatchObject({ from: 9, to: TARGET_USER_VERSION, dbPath, saved: true, backupPath: `${dbPath}.bak-v9` });
    expect(result.postMigrate).toMatchObject({ semanticKeysBackfilled: 13, alreadyApplied: false });
    expect(Buffer.compare(readFileSync(`${dbPath}.bak-v9`), original)).toBe(0);
    expect(Buffer.compare(readFileSync(`${dbPath}.prev`), original)).toBe(0);
    expect(existsSync(`${dbPath}.tmp-${process.pid}`)).toBe(false);

    const saved = readFileSync(dbPath);
    expect(verifySqliteHeader(saved)).toBe(true);
    const SQL = await loadSqlJs();
    const db = new SQL.Database(saved);
    try {
      expectHealthyAfterReopen(db);
      expect(selectCount(db, "SELECT COUNT(*) FROM memories")).toBe(13);
      expect(selectCount(db, "SELECT COUNT(*) FROM evidence")).toBe(142);
      expect(getMeta(db, SEMANTIC_KEY_BACKFILL_META_KEY)).toBe("1");
    } finally {
      db.close();
    }

    const again = await runMigrations(dbPath, { logger: silentLogger, now: NOW });
    expect(again).toMatchObject({ from: TARGET_USER_VERSION, to: TARGET_USER_VERSION, applied: [], saved: false, backupPath: null });
    expect(again.postMigrate?.alreadyApplied).toBe(true);
    expect(existsSync(`${dbPath}.bak-v${TARGET_USER_VERSION}`)).toBe(false);
  });

  test("creates a fresh database file when none exists and accepts the legacy console-style logger", async () => {
    const lines: string[] = [];
    const result = await runMigrations(dbPath, { log: (message: string) => void lines.push(message), error: () => {} });

    expect(result).toMatchObject({ from: 0, to: TARGET_USER_VERSION, saved: true, backupPath: null });
    expect(result.applied.length).toBe(TARGET_USER_VERSION);
    expect(lines.some((line) => line.includes("Running migration 21"))).toBe(true);
    expect(verifySqliteHeader(readFileSync(dbPath))).toBe(true);
  });
});

function expectHealthyAfterReopen(db: SqlJsDatabase): void {
  expect(getCurrentVersion(db)).toBe(TARGET_USER_VERSION);
  expect(selectValue(db, "PRAGMA integrity_check")).toBe("ok");
  expect(selectAll(db, "PRAGMA foreign_key_check")).toEqual([]);
}
