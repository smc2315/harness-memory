import initSqlJs, { Database as SqlJsDatabase } from "sql.js";
import { existsSync, readFileSync, writeFileSync } from "fs";

import { readBundledMigrationFiles } from "../runtime/package-paths";

export interface MigrationFile {
  version: number;
  filename: string;
  sql: string;
}

function parseMigrationVersion(filename: string): number {
  const match = filename.match(/^(\d+)_/);
  if (match === null) {
    throw new Error(`Invalid migration filename: ${filename}`);
  }

  return Number(match[1]);
}

export function getMigrationFiles(): MigrationFile[] {
  return readBundledMigrationFiles()
    .map((entry) => ({
      version: parseMigrationVersion(entry.filename),
      filename: entry.filename,
      sql: entry.sql,
    }))
    .sort((left, right) => left.version - right.version);
}

export function getCurrentVersion(db: SqlJsDatabase): number {
  const result = db.exec("PRAGMA user_version;");
  if (result.length > 0 && result[0].values.length > 0) {
    const version = result[0].values[0][0];
    return version !== null ? (version as number) : 0;
  }

  return 0;
}

export async function runMigrations(
  dbPath: string,
  logger: Pick<Console, "log" | "error"> = console
): Promise<void> {
  const SQL = await initSqlJs();

  let db: SqlJsDatabase;
  if (existsSync(dbPath)) {
    db = new SQL.Database(readFileSync(dbPath));
  } else {
    db = new SQL.Database();
  }

  try {
    const currentVersion = getCurrentVersion(db);
    logger.log(`Current schema version: ${currentVersion}`);

    const migrations = getMigrationFiles();
    logger.log(`Found ${migrations.length} migrations`);

    for (const migration of migrations) {
      if (migration.version <= currentVersion) {
        continue;
      }

      logger.log(`Running migration ${migration.version}: ${migration.filename}`);
      db.exec(migration.sql);
      db.run(`PRAGMA user_version = ${migration.version}`);
      logger.log(`OK Migration ${migration.version} completed`);
    }

    writeFileSync(dbPath, Buffer.from(db.export()));
    logger.log("OK All migrations completed successfully");
  } finally {
    db.close();
  }
}
