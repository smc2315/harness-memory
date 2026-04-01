import { PolicyEngine, PolicyRuleRepository } from "../policy";
import { openSqlJsDatabase, saveSqlJsDatabase } from "../db/sqlite";
import { readBundledMigrationSql } from "../runtime/package-paths";

interface CliOptions {
  dbPath: string;
  json: boolean;
}

interface FixturePolicyRuleInput {
  id: string;
  ruleCode: string;
  severity: "info" | "warning";
  triggerKind: "session_start" | "before_model" | "before_tool" | "after_tool";
  scopeGlob: string;
  message: string;
  createdAt: string;
  updatedAt: string;
}

function parseArgs(argv: string[]): CliOptions {
  let dbPath = ".harness-memory/memory.sqlite";
  let json = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--db" && index + 1 < argv.length) {
      dbPath = argv[index + 1];
      index += 1;
      continue;
    }

    if (arg === "--json") {
      json = true;
    }
  }

  return { dbPath, json };
}

function ensureSchema(db: Parameters<typeof saveSqlJsDatabase>[0]): void {
  db.exec(readBundledMigrationSql());
  db.run("PRAGMA user_version = 1;");
}

function upsertFixturePolicyRule(
  db: Parameters<typeof saveSqlJsDatabase>[0],
  input: FixturePolicyRuleInput
): FixturePolicyRuleInput {
  const statement = db.prepare(
    "SELECT id FROM policy_rules WHERE id = ?"
  );
  statement.bind([input.id]);
  const exists = statement.step();
  statement.free();

  if (exists) {
    const updateStatement = db.prepare(
      `UPDATE policy_rules 
       SET rule_code = ?, severity = ?, trigger_kind = ?, scope_glob = ?, message = ?, updated_at = ?
       WHERE id = ?`
    );
    updateStatement.bind([
      input.ruleCode,
      input.severity,
      input.triggerKind,
      input.scopeGlob,
      input.message,
      input.updatedAt,
      input.id,
    ]);
    updateStatement.step();
    updateStatement.free();
  } else {
    const insertStatement = db.prepare(
      `INSERT INTO policy_rules (id, rule_code, severity, trigger_kind, scope_glob, message, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    insertStatement.bind([
      input.id,
      input.ruleCode,
      input.severity,
      input.triggerKind,
      input.scopeGlob,
      input.message,
      input.createdAt,
      input.updatedAt,
    ]);
    insertStatement.step();
    insertStatement.free();
  }

  return input;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const db = await openSqlJsDatabase(options.dbPath);

  try {
    ensureSchema(db);

    // Create QA-ready policy rules for testing
    const rule1 = upsertFixturePolicyRule(db, {
      id: "policy_rule_001",
      ruleCode: "EDIT_CORE_REPO",
      severity: "warning",
      triggerKind: "before_tool",
      scopeGlob: "src/core/**/*.ts",
      message: "Editing core repository files requires careful review of scope and impact",
      createdAt: "2026-03-29T00:00:00.000Z",
      updatedAt: "2026-03-29T00:00:00.000Z",
    });

    const rule2 = upsertFixturePolicyRule(db, {
      id: "policy_rule_002",
      ruleCode: "POLICY_ENGINE_CHANGES",
      severity: "warning",
      triggerKind: "before_tool",
      scopeGlob: "src/policy/**/*.ts",
      message: "Policy engine changes affect rule evaluation and must be tested thoroughly",
      createdAt: "2026-03-29T00:10:00.000Z",
      updatedAt: "2026-03-29T00:10:00.000Z",
    });

    const rule3 = upsertFixturePolicyRule(db, {
      id: "policy_rule_003",
      ruleCode: "DB_SCHEMA_CHANGES",
      severity: "warning",
      triggerKind: "before_tool",
      scopeGlob: "src/db/**/*.ts",
      message: "Database schema changes require migration planning and backward compatibility review",
      createdAt: "2026-03-29T00:20:00.000Z",
      updatedAt: "2026-03-29T00:20:00.000Z",
    });

    const rule4 = upsertFixturePolicyRule(db, {
      id: "policy_rule_004",
      ruleCode: "CLI_CHANGES_INFO",
      severity: "info",
      triggerKind: "before_tool",
      scopeGlob: "src/cli/**/*.ts",
      message: "CLI changes should maintain backward compatibility with existing scripts",
      createdAt: "2026-03-29T00:30:00.000Z",
      updatedAt: "2026-03-29T00:30:00.000Z",
    });

    saveSqlJsDatabase(db, options.dbPath);

    const repository = new PolicyRuleRepository(db);
    const engine = new PolicyEngine(repository);
    const evaluation = engine.evaluate({
      lifecycleTrigger: "before_tool",
      scopeRef: "src/core/repo.ts",
    });

    const output = {
      dbPath: options.dbPath,
      created: [rule1, rule2, rule3, rule4].map((rule) => ({
        id: rule.id,
        ruleCode: rule.ruleCode,
        severity: rule.severity,
        triggerKind: rule.triggerKind,
        scopeGlob: rule.scopeGlob,
      })),
      sampleEvaluation: {
        scopeRef: "src/core/repo.ts",
        lifecycleTrigger: "before_tool",
        warningCount: evaluation.warnings.length,
        warnings: evaluation.warnings.map((w) => ({
          ruleCode: w.ruleCode,
          severity: w.severity,
        })),
      },
    };

    if (options.json) {
      console.log(JSON.stringify(output, null, 2));
      return;
    }

    console.log(`dbPath\t${output.dbPath}`);
    console.log("created");
    for (const rule of output.created) {
      console.log(
        [
          rule.id,
          rule.ruleCode,
          rule.severity,
          rule.triggerKind,
          rule.scopeGlob,
        ].join("\t")
      );
    }
    console.log("sampleEvaluation");
    console.log(`scopeRef\t${output.sampleEvaluation.scopeRef}`);
    console.log(`trigger\t${output.sampleEvaluation.lifecycleTrigger}`);
    console.log(`warnings\t${output.sampleEvaluation.warningCount}`);
    for (const warning of output.sampleEvaluation.warnings) {
      console.log(`${warning.ruleCode}\t${warning.severity}`);
    }
  } finally {
    db.close();
  }
}

await main();
