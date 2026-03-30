import { openSqlJsDatabase } from "../db/sqlite";
import { DreamRepository } from "../dream";

interface CliOptions {
  dbPath: string;
  runId: string;
  json: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  let dbPath = ".harness-memory/memory.sqlite";
  let runId = "";
  let json = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--db" && index + 1 < argv.length) {
      dbPath = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--id" && index + 1 < argv.length) {
      runId = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--json") {
      json = true;
    }
  }

  if (runId.length === 0) {
    throw new Error("Missing required --id <dream-run-id> argument");
  }

  return { dbPath, runId, json };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const db = await openSqlJsDatabase(options.dbPath, { requireExists: true });

  try {
    const repository = new DreamRepository(db);
    const run = repository.getDreamRunById(options.runId);
    if (run === null) {
      throw new Error(`Dream run not found: ${options.runId}`);
    }

    const links = repository.listEvidenceLinksByRunId(options.runId);
    const evidence = repository.listLinkedEvidenceByRunId(options.runId);
    const output = { run, links, evidence };

    if (options.json) {
      console.log(JSON.stringify(output, null, 2));
      return;
    }

    console.log(`run\t${run.id}`);
    console.log(`trigger\t${run.trigger}`);
    console.log(`status\t${run.status}`);
    console.log(`summary\t${run.summary}`);
    console.log("links");
    for (const link of links) {
      console.log([link.memoryId, link.evidenceEventId, link.createdAt].join("\t"));
    }
    console.log("evidence");
    for (const item of evidence) {
      console.log([item.id, item.status, item.toolName, item.topicGuess, item.excerpt].join("\t"));
    }
  } finally {
    db.close();
  }
}

await main();
