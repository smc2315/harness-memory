import {
  isMemoryEvalScenarioSelector,
  runMemoryEval,
  type MemoryEvalScenarioSelector,
} from "../eval/memory-runner";

interface CliOptions {
  dbPath?: string;
  outputDir?: string;
  scenario: MemoryEvalScenarioSelector;
  json: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  let dbPath: string | undefined;
  let outputDir: string | undefined;
  let scenario: MemoryEvalScenarioSelector = "all";
  let json = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--scenario" && index + 1 < argv.length) {
      const value = argv[index + 1];
      if (!isMemoryEvalScenarioSelector(value)) {
        throw new Error(`Invalid scenario selector: ${value}`);
      }
      scenario = value;
      index += 1;
      continue;
    }

    if (arg === "--db" && index + 1 < argv.length) {
      dbPath = argv[index + 1];
      index += 1;
      continue;
    }

    if (arg === "--output-dir" && index + 1 < argv.length) {
      outputDir = argv[index + 1];
      index += 1;
      continue;
    }

    if (arg === "--json") {
      json = true;
      continue;
    }
  }

  return {
    dbPath,
    outputDir,
    scenario,
    json,
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const summary = await runMemoryEval(options.scenario, {
    dbPath: options.dbPath,
    outputDir: options.outputDir,
  });

  if (options.json) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  console.log(`condition\t${summary.condition}`);
  console.log(`selector\t${summary.scenarioSelector}`);
  console.log(`output\t${summary.outputDir}`);
  console.log(`scenarios\t${summary.scenarioCount}`);
  console.log(`passed\t${summary.passedScenarios}`);
  console.log(`failed\t${summary.failedScenarios}`);
  console.log(`warnings\t${summary.totals.warnings}`);
  console.log(`conflicts\t${summary.totals.conflicts}`);
  console.log(`staleMarkers\t${summary.totals.staleMarkers}`);
  console.log(`hasEdgeMarkers\t${summary.containsStaleOrConflictMarkers}`);
  console.log("scenarioFiles");
  for (const file of summary.scenarioFiles) {
    console.log(file);
  }
}

await main();
