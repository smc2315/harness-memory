/**
 * harness-memory install - plugin-only setup command.
 *
 * Creates DB, writes opencode.json plugin config, imports existing rules.
 * Designed to run via: bunx harness-memory install
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, resolve } from "path";
import { homedir } from "os";

import { runMigrations } from "../db/migrator";

interface InstallOptions {
  projectDir: string;
  json: boolean;
}

function parseArgs(argv: string[]): InstallOptions {
  let projectDir = ".";
  let json = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--project-dir" && index + 1 < argv.length) {
      projectDir = argv[index + 1];
      index += 1;
      continue;
    }

    if (arg === "--json") {
      json = true;
    }
  }

  return {
    projectDir,
    json,
  };
}

// ---------------------------------------------------------------------------
// OpenCode slash commands — let users do everything from inside OpenCode
// ---------------------------------------------------------------------------

function cmd(description: string, body: string): string {
  return [`---`, `description: ${description}`, `---`, ``, body, ``].join("\n");
}

function createSlashCommands(dbPath: string): Record<string, string> {
  const db = `--db ${dbPath}`;

  return {
    "harness-memory-add.md": cmd(
      "Add a new project memory",
      `Ask the user what they want to remember. Then run:\n\`\`\`bash\nnpx harness-memory memory:add ${db} --type <type> --summary "<summary>" --details "<details>"\n\`\`\`\n\nValid types: policy, workflow, pitfall, architecture_constraint, decision\nThe memory is created as a candidate. Promote it with /harness-memory-review.`,
    ),
    "harness-memory-list.md": cmd(
      "List all project memories",
      `Run \`npx harness-memory memory:list ${db}\` and present the results in a readable table format. Group by status (active/candidate/stale).`,
    ),
    "harness-memory-review.md": cmd(
      "Review and promote/reject candidate memories",
      `Run \`npx harness-memory memory:list ${db} --status candidate\` to show candidates.\n\nFor each candidate, ask the user to approve or reject:\n- Approve: \`npx harness-memory memory:promote ${db} --memory <id>\`\n- Reject: \`npx harness-memory memory:reject ${db} --memory <id>\``,
    ),
    "harness-memory-stats.md": cmd(
      "Show memory usage statistics",
      `Run \`npx harness-memory memory:stats ${db}\` and present the results clearly.`,
    ),
    "harness-memory-why.md": cmd(
      "Explain why memories activate for a scope",
      `Ask for a scope path and lifecycle trigger if not provided, then run:\n\`npx harness-memory memory:why ${db} --scope <scope> --trigger <trigger> --json\`\n\nSummarize activated, suppressed, and conflicting memories.`,
    ),
    "harness-memory-dream.md": cmd(
      "Run dream consolidation (heuristic)",
      `Run \`npx harness-memory dream:run ${db} --trigger manual --json\` and summarize created or refreshed candidate memories.`,
    ),
    "harness-memory-extract.md": cmd(
      "Extract memories from recent conversations (LLM-based)",
      `Run \`npx harness-memory dream:extract ${db} --skip-gates\` to analyze buffered conversations and extract memory-worthy facts.\n\nThis uses the LLM to identify preferences, decisions, and constraints from your recent conversations.\n\nAfter extraction, run /harness-memory-review to approve the candidates.`,
    ),
    "harness-memory-init.md": cmd(
      "Initialize harness-memory in this project",
      `Run \`npx harness-memory init ${db}\` in the current project root. If already initialized, summarize the current setup.`,
    ),
  };
}

function extractBullets(content: string): string[] {
  return content
    .split("\n")
    .filter((line) => line.startsWith("- ") || line.startsWith("* "))
    .map((line) => line.replace(/^[-*]\s+/, "").trim())
    .filter((line) => line.length >= 5);
}

async function importRuleBullets(
  dbPath: string,
  sourcePath: string
): Promise<number> {
  if (!existsSync(sourcePath)) {
    return 0;
  }

  try {
    const { openSqlJsDatabase, saveSqlJsDatabase } = await import("../db/index.js");
    const { MemoryRepository } = await import("../memory/index.js");

    const content = readFileSync(sourcePath, "utf-8");
    const bullets = extractBullets(content);

    if (bullets.length === 0) {
      return 0;
    }

    const db = await openSqlJsDatabase(dbPath);
    const repository = new MemoryRepository(db);
    let importedMemories = 0;

    for (const bullet of bullets) {
      const result = repository.createOrGet({
        type: "policy",
        summary: bullet.slice(0, 200),
        details: bullet.length > 200 ? bullet : "",
        scopeGlob: "**",
        lifecycleTriggers: ["before_model"],
        confidence: 0.8,
        importance: 0.8,
        status: "active",
        activationClass: "baseline",
      });

      if (result.isNew) {
        importedMemories += 1;
      }
    }

    saveSqlJsDatabase(db, dbPath);
    db.close();
    return importedMemories;
  } catch {
    return 0;
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const projectDir = resolve(options.projectDir);
  const dbDir = resolve(projectDir, ".harness-memory");
  const dbPath = resolve(dbDir, "memory.sqlite");
  const configPath = resolve(projectDir, "opencode.json");
  const createdFiles: string[] = [];

  mkdirSync(dbDir, { recursive: true });
  await runMigrations(dbPath, { log: () => {}, error: () => {} });
  createdFiles.push(dbPath);

  // Also create the global DB if it doesn't exist.
  const globalDbDir = resolve(homedir(), ".harness-memory");
  const globalDbPath = resolve(globalDbDir, "global.sqlite");

  mkdirSync(globalDbDir, { recursive: true });
  await runMigrations(globalDbPath, { log: () => {}, error: () => {} });

  const pluginEntry = "harness-memory/plugin";
  if (existsSync(configPath)) {
    try {
      const existing = JSON.parse(readFileSync(configPath, "utf-8")) as Record<
        string,
        unknown
      >;
      const plugins = Array.isArray(existing.plugin)
        ? (existing.plugin as string[])
        : [];

      if (!plugins.includes(pluginEntry)) {
        existing.plugin = [...plugins, pluginEntry];
        writeFileSync(configPath, JSON.stringify(existing, null, 2) + "\n", "utf-8");
        createdFiles.push(configPath);
      }
    } catch {
      // Keep existing invalid JSON untouched.
    }
  } else {
    writeFileSync(
      configPath,
      JSON.stringify({ plugin: [pluginEntry] }, null, 2) + "\n",
      "utf-8"
    );
    createdFiles.push(configPath);
  }

  const importedClaude = await importRuleBullets(
    dbPath,
    resolve(projectDir, "CLAUDE.md")
  );
  const importedCursor = await importRuleBullets(
    dbPath,
    resolve(projectDir, ".cursorrules")
  );
  const importedMemories = importedClaude + importedCursor;

  // Create OpenCode slash commands so users can do everything from inside OpenCode.
  const commandsDir = resolve(projectDir, ".opencode", "commands");
  const dbRelativePath = ".harness-memory/memory.sqlite";
  const commands = createSlashCommands(dbRelativePath);
  let commandsCreated = 0;

  mkdirSync(commandsDir, { recursive: true });

  for (const [fileName, content] of Object.entries(commands)) {
    const commandPath = resolve(commandsDir, fileName);
    writeFileSync(commandPath, content, "utf-8");
    createdFiles.push(commandPath);
    commandsCreated += 1;
  }

  const output = {
    projectDir,
    dbPath,
    configPath,
    createdFiles,
    importedMemories,
    commandsCreated,
  };

  if (options.json) {
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  console.log("[harness-memory] Installed successfully!");
  console.log(`  Database:  ${dbPath}`);
  console.log(`  Config:    ${configPath}`);
  console.log(`  Commands:  ${commandsCreated} OpenCode slash commands`);
  if (importedMemories > 0) {
    console.log(`  Imported:  ${importedMemories} memories from existing rules`);
  }
  console.log("");
  console.log("  Available commands inside OpenCode:");
  console.log("    /harness-memory-add       Add a memory");
  console.log("    /harness-memory-list      List memories");
  console.log("    /harness-memory-review    Review candidates");
  console.log("    /harness-memory-stats     Usage statistics");
  console.log("    /harness-memory-why       Explain activation");
  console.log("    /harness-memory-extract   LLM-based extraction");
  console.log("    /harness-memory-dream     Dream consolidation");
  console.log("");
  console.log("  Restart OpenCode to activate the plugin.");
}

await main();
