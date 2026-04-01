import { openSqlJsDatabase } from "../db/sqlite";

interface CliOptions {
  dbPath: string;
}

function parseArgs(argv: string[]): CliOptions {
  let dbPath = ".harness-memory/memory.sqlite";

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--db" && index + 1 < argv.length) {
      dbPath = argv[index + 1];
      index += 1;
    }
  }

  return { dbPath };
}

function escapeSqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function formatSqlValue(value: unknown): string {
  if (value === null) {
    return "NULL";
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : "NULL";
  }

  if (typeof value === "string") {
    return escapeSqlString(value);
  }

  if (typeof value === "boolean") {
    return value ? "1" : "0";
  }

  if (value instanceof Uint8Array) {
    return `X'${Buffer.from(value).toString("hex")}'`;
  }

  return escapeSqlString(String(value));
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const db = await openSqlJsDatabase(options.dbPath, { requireExists: true });

  try {
    const tablesResult = db.exec(
      "SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    );
    const lines: string[] = ["BEGIN TRANSACTION;"];

    if (tablesResult.length > 0) {
      for (const row of tablesResult[0].values) {
        const tableName = row[0];
        const createSql = row[1];

        if (typeof tableName !== "string" || typeof createSql !== "string") {
          continue;
        }

        lines.push(`${createSql};`);

        const rowResult = db.exec(`SELECT * FROM ${tableName}`);
        if (rowResult.length === 0) {
          continue;
        }

        const [result] = rowResult;
        for (const values of result.values) {
          const formattedValues = values.map((value) => formatSqlValue(value)).join(", ");
          lines.push(`INSERT INTO ${tableName} VALUES (${formattedValues});`);
        }
      }
    }

    const versionResult = db.exec("PRAGMA user_version;");
    if (versionResult.length > 0 && versionResult[0]?.values[0]?.[0] !== undefined) {
      lines.push(`PRAGMA user_version = ${versionResult[0].values[0][0]};`);
    }

    lines.push("COMMIT;");
    console.log(lines.join("\n"));
  } finally {
    db.close();
  }
}

await main();
