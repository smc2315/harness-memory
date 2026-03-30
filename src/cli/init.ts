import { existsSync, mkdirSync, writeFileSync } from "fs";
import { dirname, resolve } from "path";

import { runMigrations } from "../db/migrator";

interface CliOptions {
  projectDir: string;
  dbPath: string;
  force: boolean;
  writeReadme: boolean;
  writeOpencodeCommands: boolean;
  json: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  let projectDir = ".";
  let dbPath = ".harness-memory/memory.sqlite";
  let force = false;
  let writeReadme = true;
  let writeOpencodeCommands = true;
  let json = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--project-dir" && index + 1 < argv.length) {
      projectDir = argv[index + 1];
      index += 1;
      continue;
    }

    if (arg === "--db" && index + 1 < argv.length) {
      dbPath = argv[index + 1];
      index += 1;
      continue;
    }

    if (arg === "--force") {
      force = true;
      continue;
    }

    if (arg === "--no-readme") {
      writeReadme = false;
      continue;
    }

    if (arg === "--no-opencode-commands") {
      writeOpencodeCommands = false;
      continue;
    }

    if (arg === "--json") {
      json = true;
    }
  }

  return { projectDir, dbPath, force, writeReadme, writeOpencodeCommands, json };
}

function ensureParent(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
}

function writeFileMaybe(path: string, content: string, force: boolean): boolean {
  if (existsSync(path) && !force) {
    return false;
  }

  ensureParent(path);
  writeFileSync(path, content, "utf-8");
  return true;
}

function createOpencodeCommand(description: string, body: string): string {
  return [`---`, `description: ${description}`, `---`, ``, body, ``].join("\n");
}

function createOpencodeCommands(dbRelativePath: string): Record<string, string> {
  return {
    "harness-memory-init.md": createOpencodeCommand(
      "Initialize harness-memory in this project",
      `Run \`npx harness-memory init --db ${dbRelativePath}\` in the current project root. If the project is already initialized, inspect and summarize the current setup instead of overwriting files.`
    ),
    "harness-memory-dream.md": createOpencodeCommand(
      "Run a manual harness-memory dream consolidation",
      `Run \`npx harness-memory dream:run --db ${dbRelativePath} --trigger manual --json\` and summarize created or refreshed candidate memories.`
    ),
    "harness-memory-why.md": createOpencodeCommand(
      "Explain why memories activate for a scope and trigger",
      `Ask for a scope path and lifecycle trigger if not already provided, then run \`npx harness-memory memory:why --db ${dbRelativePath} --scope <scope> --trigger <trigger> --json\` and summarize activated, suppressed, and conflicting memories.`
    ),
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const projectDir = resolve(options.projectDir);
  const dbPath = resolve(projectDir, options.dbPath);
  const createdFiles: string[] = [];

  mkdirSync(dirname(dbPath), { recursive: true });
  await runMigrations(dbPath, { log: () => {}, error: () => {} });

  if (options.writeReadme) {
    const readmePath = resolve(projectDir, ".harness-memory", "README.md");
    const content = [
      "# harness-memory Project Setup",
      "",
      "This project is initialized for local harness-memory usage.",
      "",
      "## Database",
      "",
      `- SQLite path: \`${options.dbPath}\``,
      "",
      "## Recommended next steps",
      "",
      `1. Add a project memory with \`npx harness-memory memory:add --db ${options.dbPath} ...\`.`,
      `2. Run \`npx harness-memory dream:run --db ${options.dbPath} --trigger manual\` after meaningful work.`,
      `3. Use \`npx harness-memory memory:why --db ${options.dbPath} --scope src/file.ts --trigger before_model\` to inspect retrieval decisions.`,
    ].join("\n");

    if (writeFileMaybe(readmePath, content, options.force)) {
      createdFiles.push(readmePath);
    }
  }

  if (options.writeOpencodeCommands) {
    const commandsDir = resolve(projectDir, ".opencode", "commands");
    for (const [fileName, content] of Object.entries(createOpencodeCommands(options.dbPath))) {
      const commandPath = resolve(commandsDir, fileName);
      if (writeFileMaybe(commandPath, content, options.force)) {
        createdFiles.push(commandPath);
      }
    }
  }

  const output = {
    projectDir,
    dbPath,
    createdFiles,
  };

  if (options.json) {
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  console.log(`project\t${projectDir}`);
  console.log(`db\t${dbPath}`);
  console.log("created");
  for (const file of createdFiles) {
    console.log(file);
  }
}

await main();
