import { runBaselineEval } from "../eval/baseline-runner";

interface CliOptions {
  json: boolean;
  outputDir?: string;
}

function parseArgs(argv: string[]): CliOptions {
  let json = false;
  let outputDir: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--json") {
      json = true;
      continue;
    }

    if (arg === "--output-dir" && index + 1 < argv.length) {
      outputDir = argv[index + 1];
      index += 1;
    }
  }

  return { json, outputDir };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const summary = runBaselineEval({ outputDir: options.outputDir });

  if (options.json) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  console.log(`condition\t${summary.condition}`);
  console.log(`output\t${summary.outputDir}`);
  console.log(`scenarios\t${summary.scenarioCount}`);
  console.log(`importantPolicyMisses\t${summary.importantPolicyMisses}`);
  console.log("scenarioFiles");
  for (const file of summary.scenarioFiles) {
    console.log(file);
  }
}

await main();
