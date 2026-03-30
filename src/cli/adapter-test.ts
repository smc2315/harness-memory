import {
  ADAPTER_TEST_SCENARIOS,
  runAdapterTestScenario,
  type AdapterBeforeModelScenarioResult,
  type AdapterTestScenario,
  type AdapterTestScenarioResult,
  type AdapterToolCycleScenarioResult,
} from "../adapters/test-harness";

interface CliOptions {
  dbPath: string;
  scenario: AdapterTestScenario;
  json: boolean;
}

function isScenario(value: string): value is AdapterTestScenario {
  return ADAPTER_TEST_SCENARIOS.includes(value as AdapterTestScenario);
}

function parseArgs(argv: string[]): CliOptions {
  let dbPath = "memory.sqlite";
  let scenario: AdapterTestScenario = "before-model";
  let json = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--db" && index + 1 < argv.length) {
      dbPath = argv[index + 1];
      index += 1;
      continue;
    }

    if (arg === "--scenario" && index + 1 < argv.length) {
      const value = argv[index + 1];

      if (!isScenario(value)) {
        throw new Error(`Invalid scenario: ${value}`);
      }

      scenario = value;
      index += 1;
      continue;
    }

    if (arg === "--json") {
      json = true;
      continue;
    }
  }

  return { dbPath, scenario, json };
}

function renderBeforeModel(result: AdapterBeforeModelScenarioResult): void {
  console.log(`scenario\t${result.scenario}`);
  console.log(`db\t${result.dbPath}`);
  console.log(`session\t${result.sessionID}`);
  console.log(`scope\t${result.scopeRef}`);
  console.log(`model\t${result.model.providerID}/${result.model.modelID}`);
  console.log(
    `budget\t${result.injection.budget.usedMemories}/${result.injection.budget.maxMemories}\t${result.injection.budget.usedPayloadBytes}/${result.injection.budget.maxPayloadBytes}`
  );
  console.log("activated");

  for (const memory of result.injection.activated) {
    console.log(
      [
        memory.rank,
        memory.type,
        memory.id,
        memory.payloadBytes,
        memory.summary,
      ].join("\t")
    );
  }

  console.log("suppressed");
  for (const memory of result.injection.suppressed) {
    console.log(
      [memory.kind, memory.type, memory.id, memory.reason].join("\t")
    );
  }

  console.log("system");
  for (const systemText of result.injection.system) {
    console.log(systemText);
  }
}

function renderToolCycle(result: AdapterToolCycleScenarioResult): void {
  console.log(`scenario\t${result.scenario}`);
  console.log(`db\t${result.dbPath}`);
  console.log(`session\t${result.sessionID}`);
  console.log(`scope\t${result.scopeRef}`);
  console.log(`tool\t${result.tool}`);
  console.log("warnings");

  for (const warning of result.warning.warnings) {
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

  console.log("warningText");
  if (result.warning.warningText !== null) {
    console.log(result.warning.warningText);
  }

  console.log("evidence");
  for (const evidence of result.evidence.createdEvidence) {
    console.log(
      [
        evidence.memoryId,
        evidence.sourceKind,
        evidence.sourceRef,
        evidence.excerpt,
      ].join("\t")
    );
  }
}

function renderText(result: AdapterTestScenarioResult): void {
  if (result.scenario === "before-model") {
    renderBeforeModel(result);
    return;
  }

  renderToolCycle(result);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const result = await runAdapterTestScenario(options.dbPath, options.scenario);

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  renderText(result);
}

await main();
