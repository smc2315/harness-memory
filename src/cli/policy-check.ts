import { PolicyEngine, PolicyRuleRepository } from "../policy";
import { openSqlJsDatabase } from "../db/sqlite";
import type { LifecycleTrigger } from "../db/schema/types";

interface CliOptions {
  dbPath: string;
  scopeRef: string;
  lifecycleTrigger: LifecycleTrigger;
  tool?: string;
  json: boolean;
}

const VALID_TRIGGERS: readonly LifecycleTrigger[] = [
  "session_start",
  "before_model",
  "before_tool",
  "after_tool",
];

function parseTrigger(value: string): LifecycleTrigger {
  if (VALID_TRIGGERS.includes(value as LifecycleTrigger)) {
    return value as LifecycleTrigger;
  }

  throw new Error(`Invalid lifecycle trigger: ${value}`);
}

function parseArgs(argv: string[]): CliOptions {
  let dbPath = ".harness-memory/memory.sqlite";
  let scopeRef = ".";
  let lifecycleTrigger: LifecycleTrigger = "before_tool";
  let tool: string | undefined;
  let json = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--db" && index + 1 < argv.length) {
      dbPath = argv[index + 1];
      index += 1;
      continue;
    }

    if (arg === "--scope" && index + 1 < argv.length) {
      scopeRef = argv[index + 1];
      index += 1;
      continue;
    }

    if (arg === "--trigger" && index + 1 < argv.length) {
      lifecycleTrigger = parseTrigger(argv[index + 1]);
      index += 1;
      continue;
    }

    if (arg === "--tool" && index + 1 < argv.length) {
      tool = argv[index + 1];
      index += 1;
      continue;
    }

    if (arg === "--json") {
      json = true;
    }
  }

  return {
    dbPath,
    scopeRef,
    lifecycleTrigger,
    tool,
    json,
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const db = await openSqlJsDatabase(options.dbPath, { requireExists: true });

  try {
    const repository = new PolicyRuleRepository(db);
    const engine = new PolicyEngine(repository);
    const result = engine.evaluate({
      lifecycleTrigger: options.lifecycleTrigger,
      scopeRef: options.scopeRef,
    });

    const output = {
      scopeRef: options.scopeRef,
      lifecycleTrigger: options.lifecycleTrigger,
      tool: options.tool,
      warnings: result.warnings.map((warning) => ({
        ruleCode: warning.ruleCode,
        severity: warning.severity,
        scopeGlob: warning.scopeGlob,
        scopeRef: warning.scopeRef,
        triggerKind: warning.triggerKind,
        message: warning.message,
      })),
      evaluatedAt: result.evaluatedAt,
    };

    if (options.json) {
      console.log(JSON.stringify(output, null, 2));
      process.exit(0);
    }

    console.log(`scope\t${output.scopeRef}`);
    console.log(`trigger\t${output.lifecycleTrigger}`);
    if (output.tool) {
      console.log(`tool\t${output.tool}`);
    }
    console.log("warnings");
    for (const warning of output.warnings) {
      console.log(
        [
          warning.ruleCode,
          warning.severity,
          warning.triggerKind,
          warning.scopeGlob,
          warning.message,
        ].join("\t")
      );
    }
    process.exit(0);
  } finally {
    db.close();
  }
}

await main();
