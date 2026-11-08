import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Database as SqlJsDatabase } from "sql.js";

import { runMigrationsOnDb } from "../../src/db/migrator";
import { runPostMigrate } from "../../src/db/post-migrate";
import { loadSqlJs } from "../../src/db/sqlite";

/** Fixed clock for post-migrate stamps so test databases are byte-stable. */
export const TEST_NOW = "2026-11-08T00:00:00.000Z";

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "legacy-db");

export const LEGACY_FIXTURES = {
  /** Real v0.5 install at user_version 9: 13 memories, 142 evidence rows, 75 dream events. */
  v9: join(FIXTURES_DIR, "v9-hm-test-project.sqlite"),
  /** Real v0.5 install at user_version 10: 1 candidate memory. */
  v10: join(FIXTURES_DIR, "v10-hm-fresh-test.sqlite"),
} as const;

export interface CreateTestDbOptions {
  /** Run `runPostMigrate` after the migrations (default true). */
  postMigrate?: boolean;
  now?: string;
}

/** Fresh in-memory database at the latest schema with foreign keys ON. */
export async function createTestDb(options: CreateTestDbOptions = {}): Promise<SqlJsDatabase> {
  const SQL = await loadSqlJs();
  const db = new SQL.Database();

  runMigrationsOnDb(db);
  db.run("PRAGMA foreign_keys = ON;");
  if (options.postMigrate !== false) {
    runPostMigrate(db, { now: options.now ?? TEST_NOW });
  }

  return db;
}

/** Fresh in-memory database migrated only up to `version` (legacy-shape fixtures for upgrade tests). */
export async function createTestDbAtVersion(version: number): Promise<SqlJsDatabase> {
  const SQL = await loadSqlJs();
  const db = new SQL.Database();

  runMigrationsOnDb(db, { target: version });
  db.run("PRAGMA foreign_keys = ON;");

  return db;
}

export interface CreateTestDbFromFixtureOptions extends CreateTestDbOptions {
  /** Apply pending migrations after loading (default true). */
  migrate?: boolean;
}

/** Load a database file (e.g. `LEGACY_FIXTURES.v9`) into memory, optionally upgrading it to the latest schema. */
export async function createTestDbFromFixture(
  fixturePath: string,
  options: CreateTestDbFromFixtureOptions = {}
): Promise<SqlJsDatabase> {
  const SQL = await loadSqlJs();
  const db = new SQL.Database(readFileSync(fixturePath));

  if (options.migrate !== false) {
    runMigrationsOnDb(db);
    db.run("PRAGMA foreign_keys = ON;");
    if (options.postMigrate !== false) {
      runPostMigrate(db, { now: options.now ?? TEST_NOW });
    }
  }

  return db;
}
