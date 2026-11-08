import { existsSync, readdirSync, readFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

const RUNTIME_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * Directory that holds `db/migrations` and `research/eval`. Bundles live at two depths: `dist/bin/*.js`,
 * `dist/<area>/index.js` and the source tree's `src/runtime/` resolve it as the parent directory, while the
 * runtime bundles at the dist root (`dist/worker.js`, `dist/hook-bundle.js`, `dist/index.js`) resolve it as
 * their own directory. The first candidate containing `db/migrations` wins; the parent stays the default.
 */
function findDistRoot(): string {
  const candidates = [resolve(RUNTIME_DIR, ".."), RUNTIME_DIR];
  for (const candidate of candidates) {
    if (existsSync(join(candidate, "db", "migrations"))) return candidate;
  }
  return candidates[0];
}

const DIST_ROOT = findDistRoot();

function getPackagePath(...segments: string[]): string {
  return join(DIST_ROOT, ...segments);
}

export function getBundledMigrationPath(): string {
  return getPackagePath("db", "migrations", "001_initial_schema.sql");
}

export function readBundledMigrationSql(): string {
  return readFileSync(getBundledMigrationPath(), "utf-8");
}

export function getBundledMigrationsDir(): string {
  return getPackagePath("db", "migrations");
}

export function readBundledMigrationFiles(): Array<{
  filename: string;
  sql: string;
}> {
  return readdirSync(getBundledMigrationsDir())
    .filter((filename) => filename.endsWith(".sql"))
    .sort((left, right) => left.localeCompare(right))
    .map((filename) => ({
      filename,
      sql: readFileSync(join(getBundledMigrationsDir(), filename), "utf-8"),
    }));
}

export function getBundledBaselineScorecardPath(): string {
  return getPackagePath("research", "eval", "baseline-scorecard.csv");
}

export function getBundledTaskCorpusPath(): string {
  return getPackagePath("research", "eval", "task-corpus.md");
}

export function resolveConsumerPath(...segments: string[]): string {
  return resolve(process.cwd(), ...segments);
}

export function resolveEvalOutputDir(outputDir?: string): string {
  return outputDir === undefined
    ? resolveConsumerPath("research", "eval", "output")
    : resolve(outputDir);
}

export function resolveBaselineOutputDir(outputDir?: string): string {
  return outputDir === undefined
    ? resolveConsumerPath("research", "eval", "output", "baseline")
    : resolve(outputDir);
}
