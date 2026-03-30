import initSqlJs, { type Database as SqlJsDatabase } from "sql.js";

import { getMigrationFiles } from "../../src/db/migrator";

let sqlJsPromise: ReturnType<typeof initSqlJs> | null = null;

function getSqlJs() {
  if (sqlJsPromise === null) {
    sqlJsPromise = initSqlJs();
  }

  return sqlJsPromise;
}

export async function createTestDb(): Promise<SqlJsDatabase> {
  const SQL = await getSqlJs();
  const db = new SQL.Database();

  for (const migration of getMigrationFiles()) {
    db.exec(migration.sql);
  }
  db.run("PRAGMA foreign_keys = ON;");
  const migrations = getMigrationFiles();
  const latestVersion = migrations[migrations.length - 1]?.version ?? 0;
  db.run(`PRAGMA user_version = ${latestVersion};`);

  return db;
}
