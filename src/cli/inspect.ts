import initSqlJs, { Database as SqlJsDatabase } from "sql.js";
import { readFileSync, existsSync } from "fs";

async function inspectDatabase(dbPath: string): Promise<void> {
  const SQL = await initSqlJs();

  try {
    // Load database
    if (!existsSync(dbPath)) {
      console.error(`Database file not found: ${dbPath}`);
      process.exit(1);
    }

    const buffer = readFileSync(dbPath);
    const db = new SQL.Database(buffer);

    try {
      // Get schema version from metadata table
      let version = 0;
      const versionResult = db.exec("PRAGMA user_version;");
      if (versionResult.length > 0 && versionResult[0].values.length > 0) {
        const v = versionResult[0].values[0][0];
        version = v !== null ? (v as number) : 0;
      }
      console.log(`Schema Version: ${version}\n`);

      // Get all tables (excluding system tables)
      const tablesResult = db.exec(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name;"
      );

      const tables: string[] = [];
      if (tablesResult.length > 0) {
        for (const row of tablesResult[0].values) {
          tables.push(row[0] as string);
        }
      }

      console.log("Tables:");
      for (const table of tables) {
        console.log(`  - ${table}`);

        // Get column info for each table
        const columnsResult = db.exec(`PRAGMA table_info(${table});`);
        if (columnsResult.length > 0) {
          for (const row of columnsResult[0].values) {
            const colName = row[1];
            const colType = row[2];
            const notnull = row[3] === 1 ? "NOT NULL" : "";
            const pk = row[5] === 1 ? "PRIMARY KEY" : "";
            const constraints = [notnull, pk].filter((c) => c.length > 0);
            const constraintStr =
              constraints.length > 0 ? ` [${constraints.join(", ")}]` : "";
            console.log(`    - ${colName}: ${colType}${constraintStr}`);
          }
        }

        // Get row count
        const countResult = db.exec(`SELECT COUNT(*) as count FROM ${table};`);
        const count =
          countResult.length > 0 ? countResult[0].values[0][0] : 0;
        console.log(`    (${count} rows)\n`);
      }

      // Get indexes
      const indexesResult = db.exec(
        "SELECT name, tbl_name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY tbl_name, name;"
      );

      if (indexesResult.length > 0 && indexesResult[0].values.length > 0) {
        console.log("Indexes:");
        for (const row of indexesResult[0].values) {
          console.log(`  - ${row[0]} (on ${row[1]})`);
        }
      }
    } finally {
      db.close();
    }
  } catch (error) {
    console.error("Inspection failed:", error);
    process.exit(1);
  }
}

// Parse command line arguments
const args = process.argv.slice(2);
let dbPath = "memory.sqlite";

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--db" && i + 1 < args.length) {
    dbPath = args[i + 1];
  }
}

console.log(`Inspecting database: ${dbPath}\n`);
await inspectDatabase(dbPath);
