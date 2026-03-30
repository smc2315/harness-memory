import initSqlJs, {
  type Database as SqlJsDatabase,
  type SqlJsStatic,
} from "sql.js";
import { dirname, resolve } from "path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";

let sqlJsPromise: Promise<SqlJsStatic> | null = null;

function getSqlJs(): Promise<SqlJsStatic> {
  if (sqlJsPromise === null) {
    sqlJsPromise = initSqlJs();
  }

  return sqlJsPromise;
}

export interface OpenSqlJsDatabaseOptions {
  requireExists?: boolean;
}

export async function openSqlJsDatabase(
  dbPath: string,
  options: OpenSqlJsDatabaseOptions = {}
): Promise<SqlJsDatabase> {
  const SQL = await getSqlJs();
  const resolvedPath = resolve(dbPath);

  if (existsSync(resolvedPath)) {
    return new SQL.Database(readFileSync(resolvedPath));
  }

  if (options.requireExists) {
    throw new Error(`Database file not found: ${resolvedPath}`);
  }

  return new SQL.Database();
}

export function saveSqlJsDatabase(db: SqlJsDatabase, dbPath: string): void {
  const resolvedPath = resolve(dbPath);

  mkdirSync(dirname(resolvedPath), { recursive: true });
  writeFileSync(resolvedPath, Buffer.from(db.export()));
}
