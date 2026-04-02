import { afterEach, beforeEach, describe, expect, test } from "vitest";
import initSqlJs, { type Database as SqlJsDatabase } from "sql.js";

import { getCurrentVersion, getMigrationFiles } from "../src/db/migrator";
import { MemoryRepository } from "../src/memory";

let sqlJsPromise: ReturnType<typeof initSqlJs> | null = null;

function getSqlJs() {
  if (sqlJsPromise === null) {
    sqlJsPromise = initSqlJs();
  }

  return sqlJsPromise;
}

async function createDbAtVersion(targetVersion: number): Promise<SqlJsDatabase> {
  const SQL = await getSqlJs();
  const db = new SQL.Database();

  for (const migration of getMigrationFiles()) {
    if (migration.version > targetVersion) {
      break;
    }

    db.exec(migration.sql);
  }

  db.run("PRAGMA foreign_keys = ON;");
  db.run(`PRAGMA user_version = ${targetVersion};`);
  return db;
}

async function migrateToLatest(db: SqlJsDatabase): Promise<void> {
  const currentVersion = getCurrentVersion(db);

  for (const migration of getMigrationFiles()) {
    if (migration.version <= currentVersion) {
      continue;
    }

    db.exec(migration.sql);
    db.run(`PRAGMA user_version = ${migration.version};`);
  }
}

function readFirstValue(db: SqlJsDatabase, sql: string): unknown {
  const result = db.exec(sql);
  if (result.length === 0 || result[0].values.length === 0) {
    throw new Error(`No rows returned for SQL: ${sql}`);
  }

  return result[0].values[0][0];
}

function hasColumn(db: SqlJsDatabase, tableName: string, columnName: string): boolean {
  const info = db.exec(`PRAGMA table_info(${tableName});`);
  if (info.length === 0) {
    return false;
  }

  return info[0].values.some((row) => row[1] === columnName);
}

describe("migrator safety harness", () => {
  let db: SqlJsDatabase;

  beforeEach(async () => {
    db = await createDbAtVersion(0);
  });

  afterEach(() => {
    db.close();
  });

  test("builds a v10 schema and survives upgrade to latest", async () => {
    db.close();
    db = await createDbAtVersion(10);

    db.run(
      `
      INSERT INTO memories (
        id,
        content_hash,
        identity_key,
        type,
        summary,
        details,
        scope_glob,
        lifecycle_triggers,
        confidence,
        importance,
        status,
        supersedes_memory_id,
        created_at,
        updated_at,
        last_verified_at,
        activation_class,
        embedding
      )
      VALUES (
        'mem-v10-1',
        'hash-v10-1',
        'identity-v10-1',
        'policy',
        'Prefer explicit adapters',
        'Keep memory repository and adapter boundaries thin.',
        'src/**/*.ts',
        '["session_start","before_model"]',
        0.82,
        0.76,
        'active',
        NULL,
        '2026-03-30T10:00:00.000Z',
        '2026-03-30T10:00:00.000Z',
        NULL,
        'scoped',
        x'0000803f00000040'
      );
      `
    );

    db.run(
      `
      INSERT INTO evidence (
        id,
        memory_id,
        source_kind,
        source_ref,
        excerpt,
        created_at
      )
      VALUES (
        'ev-v10-1',
        'mem-v10-1',
        'task',
        'task:planner',
        'Observed repeated adapter churn in the ingestion layer.',
        '2026-03-30T10:01:00.000Z'
      );
      `
    );

    db.run(
      `
      INSERT INTO policy_rules (
        id,
        memory_id,
        rule_code,
        severity,
        trigger_kind,
        scope_glob,
        message,
        created_at,
        updated_at
      )
      VALUES (
        'rule-v10-1',
        'mem-v10-1',
        'RULE-EXPLICIT-ADAPTERS',
        'warning',
        'before_model',
        'src/**/*.ts',
        'Favor explicit adapters over hidden framework glue.',
        '2026-03-30T10:02:00.000Z',
        '2026-03-30T10:02:00.000Z'
      );
      `
    );

    db.run(
      `
      INSERT INTO activation_logs (
        id,
        session_id,
        lifecycle_trigger,
        scope_ref,
        activated_memory_ids,
        suppressed_memory_ids,
        reason,
        created_at
      )
      VALUES (
        'act-v10-1',
        'session-42',
        'before_model',
        'src/memory/repository.ts',
        '["mem-v10-1"]',
        '[]',
        'Memory is in scope and marked active.',
        '2026-03-30T10:03:00.000Z'
      );
      `
    );

    db.run(
      `
      INSERT INTO dream_runs (
        id,
        trigger,
        status,
        window_start,
        window_end,
        evidence_count,
        candidate_count,
        summary,
        created_at,
        completed_at
      )
      VALUES (
        'dream-run-v10-1',
        'manual',
        'completed',
        '2026-03-30T09:00:00.000Z',
        '2026-03-30T10:00:00.000Z',
        1,
        1,
        'Consolidated migration-related evidence into candidate memory.',
        '2026-03-30T10:04:00.000Z',
        '2026-03-30T10:05:00.000Z'
      );
      `
    );

    db.run(
      `
      INSERT INTO dream_evidence_events (
        id,
        session_id,
        call_id,
        tool_name,
        scope_ref,
        source_ref,
        title,
        excerpt,
        args_json,
        metadata_json,
        topic_guess,
        type_guess,
        salience,
        novelty,
        contradiction_signal,
        status,
        retry_count,
        next_review_at,
        last_reviewed_at,
        dream_run_id,
        created_at,
        consumed_at,
        discarded_at
      )
      VALUES (
        'dee-v10-1',
        'session-42',
        'call-abc',
        'bash',
        'src/db/migrations',
        'source:dee-v10-1',
        'Migration ordering validated',
        'Validated migration sequencing and baseline compatibility.',
        '{"command":"npm test"}',
        '{"exitCode":0}',
        'migration harness',
        'workflow',
        0.69,
        0.41,
        0,
        'consumed',
        0,
        NULL,
        '2026-03-30T10:04:30.000Z',
        'dream-run-v10-1',
        '2026-03-30T10:04:20.000Z',
        '2026-03-30T10:05:00.000Z',
        NULL
      );
      `
    );

    db.run(
      `
      INSERT INTO dream_memory_evidence_links (
        evidence_event_id,
        memory_id,
        dream_run_id,
        created_at
      )
      VALUES (
        'dee-v10-1',
        'mem-v10-1',
        'dream-run-v10-1',
        '2026-03-30T10:05:10.000Z'
      );
      `
    );

    db.run(
      `
      INSERT INTO audit_log (
        id,
        event_type,
        session_id,
        scope_ref,
        summary,
        details_json,
        created_at
      )
      VALUES (
        'audit-v10-1',
        'activation',
        'session-42',
        'src/memory/repository.ts',
        'Activated memory mem-v10-1',
        '{"memoryId":"mem-v10-1","rank":1}',
        '2026-03-30T10:06:00.000Z'
      );
      `
    );

    await migrateToLatest(db);

    expect(readFirstValue(db, "SELECT COUNT(*) FROM memories WHERE id = 'mem-v10-1';")).toBe(1);
    expect(readFirstValue(db, "SELECT COUNT(*) FROM evidence WHERE id = 'ev-v10-1';")).toBe(1);
    expect(readFirstValue(db, "SELECT COUNT(*) FROM policy_rules WHERE id = 'rule-v10-1';")).toBe(1);
    expect(readFirstValue(db, "SELECT COUNT(*) FROM activation_logs WHERE id = 'act-v10-1';")).toBe(1);
    expect(readFirstValue(db, "SELECT COUNT(*) FROM dream_runs WHERE id = 'dream-run-v10-1';")).toBe(1);
    expect(readFirstValue(db, "SELECT COUNT(*) FROM dream_evidence_events WHERE id = 'dee-v10-1';")).toBe(1);
    expect(
      readFirstValue(
        db,
        "SELECT COUNT(*) FROM dream_memory_evidence_links WHERE evidence_event_id = 'dee-v10-1' AND memory_id = 'mem-v10-1';"
      )
    ).toBe(1);
    expect(readFirstValue(db, "SELECT COUNT(*) FROM audit_log WHERE id = 'audit-v10-1';")).toBe(1);

    const latestVersion = getMigrationFiles()[getMigrationFiles().length - 1]?.version ?? 0;
    expect(getCurrentVersion(db)).toBe(latestVersion);

    if (hasColumn(db, "memories", "relevant_tools_json")) {
      expect(
        readFirstValue(
          db,
          "SELECT relevant_tools_json FROM memories WHERE id = 'mem-v10-1';"
        )
      ).toBeNull();
    }

    if (hasColumn(db, "dream_evidence_events", "salience_boost")) {
      expect(
        readFirstValue(
          db,
          "SELECT salience_boost FROM dream_evidence_events WHERE id = 'dee-v10-1';"
        )
      ).toBe(0);
    }

    const repository = new MemoryRepository(db);
    const created = repository.create({
      type: "workflow",
      summary: "Verify migrator harness CRUD after upgrade",
      details: "Repository remains usable after schema transitions.",
      scopeGlob: "test/**/*.ts",
      lifecycleTriggers: ["before_model"],
      status: "candidate",
      createdAt: "2026-03-30T11:00:00.000Z",
      updatedAt: "2026-03-30T11:00:00.000Z",
    });

    const loaded = repository.getById(created.id);
    expect(loaded?.summary).toBe("Verify migrator harness CRUD after upgrade");

    const updated = repository.update(created.id, {
      status: "active",
      updatedAt: "2026-03-30T11:05:00.000Z",
    });
    expect(updated?.status).toBe("active");
  });

  test("new nullable columns are present and readable after upgrade", async () => {
    db.close();
    db = await createDbAtVersion(10);

    db.run(
      `
      INSERT INTO memories (
        id,
        content_hash,
        identity_key,
        type,
        summary,
        details,
        scope_glob,
        lifecycle_triggers,
        confidence,
        importance,
        status,
        supersedes_memory_id,
        created_at,
        updated_at,
        last_verified_at,
        activation_class,
        embedding
      )
      VALUES (
        'mem-v10-2',
        'hash-v10-2',
        'identity-v10-2',
        'decision',
        'Use migration harness tests',
        'Exercise upgrade behavior with realistic seed rows.',
        'test/**/*.ts',
        '["session_start"]',
        0.7,
        0.6,
        'candidate',
        NULL,
        '2026-03-30T12:00:00.000Z',
        '2026-03-30T12:00:00.000Z',
        NULL,
        'scoped',
        NULL
      );
      `
    );

    db.run(
      `
      INSERT INTO dream_runs (
        id,
        trigger,
        status,
        window_start,
        window_end,
        evidence_count,
        candidate_count,
        summary,
        created_at,
        completed_at
      )
      VALUES (
        'dream-run-v10-2',
        'manual',
        'started',
        '2026-03-30T11:30:00.000Z',
        '2026-03-30T12:00:00.000Z',
        1,
        0,
        'Pending consolidation run',
        '2026-03-30T12:00:00.000Z',
        NULL
      );
      `
    );

    db.run(
      `
      INSERT INTO dream_evidence_events (
        id,
        session_id,
        call_id,
        tool_name,
        scope_ref,
        source_ref,
        title,
        excerpt,
        args_json,
        metadata_json,
        topic_guess,
        type_guess,
        salience,
        novelty,
        contradiction_signal,
        status,
        retry_count,
        next_review_at,
        last_reviewed_at,
        dream_run_id,
        created_at,
        consumed_at,
        discarded_at
      )
      VALUES (
        'dee-v10-2',
        'session-43',
        'call-def',
        'read',
        'src/db/migrator.ts',
        'source:dee-v10-2',
        'Detected migration helper update',
        'Create helper for target schema snapshots.',
        '{"file":"test/migrator.test.ts"}',
        NULL,
        'upgrade test',
        'workflow',
        0.5,
        0.55,
        0,
        'pending',
        1,
        '2026-03-30T13:00:00.000Z',
        NULL,
        'dream-run-v10-2',
        '2026-03-30T12:01:00.000Z',
        NULL,
        NULL
      );
      `
    );

    await migrateToLatest(db);

    const latestVersion = getMigrationFiles()[getMigrationFiles().length - 1]?.version ?? 0;

    if (latestVersion >= 11) {
      expect(hasColumn(db, "memories", "relevant_tools_json")).toBe(true);
      expect(
        readFirstValue(
          db,
          "SELECT relevant_tools_json FROM memories WHERE id = 'mem-v10-2';"
        )
      ).toBeNull();
    } else {
      expect(hasColumn(db, "memories", "relevant_tools_json")).toBe(false);
    }

    if (latestVersion >= 12) {
      expect(hasColumn(db, "dream_evidence_events", "salience_boost")).toBe(true);
      expect(
        readFirstValue(
          db,
          "SELECT salience_boost FROM dream_evidence_events WHERE id = 'dee-v10-2';"
        )
      ).toBe(0);
    } else {
      expect(hasColumn(db, "dream_evidence_events", "salience_boost")).toBe(false);
    }
  });

  test("full migration from empty database produces correct schema", async () => {
    db.close();
    db = await createDbAtVersion(0);

    for (const migration of getMigrationFiles()) {
      db.exec(migration.sql);
      db.run(`PRAGMA user_version = ${migration.version};`);
    }

    const expectedTables = [
      "memories",
      "evidence",
      "policy_rules",
      "activation_logs",
      "dream_runs",
      "dream_evidence_events",
      "dream_memory_evidence_links",
      "audit_log",
    ];

    for (const tableName of expectedTables) {
      expect(
        readFirstValue(
          db,
          `SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = '${tableName}';`
        )
      ).toBe(1);
    }

    expect(getCurrentVersion(db)).toBe(getMigrationFiles().length);
  });

  test("migrations are idempotent in ordering", async () => {
    const migrations = getMigrationFiles();
    const versions = migrations.map((migration) => migration.version);
    const sortedVersions = [...versions].sort((left, right) => left - right);

    expect(versions).toEqual(sortedVersions);
    expect(new Set(versions).size).toBe(versions.length);
  });
});
