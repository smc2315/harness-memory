// Post-build assets (run by `npm run build` after tsup):
//   - src/db/migrations/*.sql → dist/db/migrations (readBundledMigrationFiles reads them next to the bundles)
//   - research/eval fixtures used by the eval entry
// Then a sanity check that every runtime bundle the hooks and the CLI rely on exists (dist/hook.js loads
// ./hook-bundle.js, the hooks spawn ./worker.js and ./embed-helper.js, the bin runs the dispatcher).
import { cpSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";

const repoRoot = process.cwd();

function copyFile(relativeSource, relativeTarget) {
  const sourcePath = resolve(repoRoot, relativeSource);
  const targetPath = resolve(repoRoot, relativeTarget);
  mkdirSync(dirname(targetPath), { recursive: true });
  cpSync(sourcePath, targetPath);
}

mkdirSync(resolve(repoRoot, "dist", "db"), { recursive: true });
cpSync(resolve(repoRoot, "src", "db", "migrations"), resolve(repoRoot, "dist", "db", "migrations"), { recursive: true });
copyFile("research/eval/baseline-scorecard.csv", "dist/research/eval/baseline-scorecard.csv");
copyFile("research/eval/task-corpus.md", "dist/research/eval/task-corpus.md");

const required = ["dist/hook.js", "dist/hook-bundle.js", "dist/worker.js", "dist/embed-helper.js", "dist/bin/harness-memory.js", "dist/index.js", "dist/db/migrations/021_legacy_archive.sql"];
const missing = required.filter((file) => !existsSync(resolve(repoRoot, file)));
if (missing.length > 0) {
  console.error(`copy-assets: build output incomplete, missing ${missing.join(", ")}`);
  process.exit(1);
}

const sizes = ["dist/hook.js", "dist/hook-bundle.js", "dist/worker.js", "dist/embed-helper.js", "dist/bin/harness-memory.js"]
  .map((file) => `${file} ${(statSync(resolve(repoRoot, file)).size / 1024).toFixed(1)} KB`)
  .join(", ");
console.log(`copy-assets: migrations + eval fixtures copied; runtime bundles: ${sizes}`);
