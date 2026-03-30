import { cpSync, mkdirSync } from "node:fs";
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
