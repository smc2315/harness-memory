import { runMigrations } from "../db/migrator";

// Parse command line arguments
const args = process.argv.slice(2);
let dbPath = "memory.sqlite";

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--db" && i + 1 < args.length) {
    dbPath = args[i + 1];
  }
}

console.log(`Migrating database: ${dbPath}`);
try {
  await runMigrations(dbPath);
} catch (error) {
  console.error("Migration failed:", error);
  process.exit(1);
}
