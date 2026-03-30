import type { Database as SqlJsDatabase } from "sql.js";

import { ActivationEngine, type RankedMemory, type SuppressedMemory } from "../activation";
import { openSqlJsDatabase, saveSqlJsDatabase } from "../db/sqlite";
import { DreamRepository } from "../dream";
import type {
  LifecycleTrigger,
  MemoryStatus,
  MemoryType,
  PolicySeverity,
} from "../db/schema/types";
import { MemoryRepository, type EvidenceRecord } from "../memory";
import { PolicyEngine, PolicyRuleRepository, type PolicyWarning } from "../policy";
import { readBundledMigrationSql } from "../runtime/package-paths";

import { OpenCodeAdapter } from "./opencode-adapter";
import type { AdapterModelRef } from "./types";

export const ADAPTER_TEST_SCENARIOS = ["before-model", "tool-cycle"] as const;

export type AdapterTestScenario = (typeof ADAPTER_TEST_SCENARIOS)[number];

interface MemoryFixtureInput {
  id: string;
  type: MemoryType;
  summary: string;
  details: string;
  scopeGlob: string;
  lifecycleTriggers: readonly LifecycleTrigger[];
  confidence: number;
  importance: number;
  status: MemoryStatus;
  createdAt: string;
  updatedAt: string;
}

interface PolicyRuleFixtureInput {
  id: string;
  memoryId: string | null;
  ruleCode: string;
  severity: PolicySeverity;
  triggerKind: LifecycleTrigger;
  scopeGlob: string;
  message: string;
  createdAt: string;
  updatedAt: string;
}

interface AdapterHarnessFixtures {
  sessionID: string;
  scopeRef: string;
  model: AdapterModelRef;
  toolName: string;
  callID: string;
  sourceRef: string;
  toolArgs: {
    filePath: string;
    operation: string;
    bytes: number;
  };
  toolOutput: {
    title: string;
    output: string;
    metadata: {
      exitCode: number;
      linesChanged: number;
    };
  };
  beforeModelBudget: {
    maxMemories: number;
    maxPayloadBytes: number;
  };
  memoryIds: {
    injected: string;
    suppressed: string;
    evidence: string;
  };
  ruleCode: string;
}

interface AdapterHarness {
  adapter: OpenCodeAdapter;
  dreamRepository: DreamRepository;
  memoryRepository: MemoryRepository;
  policyRepository: PolicyRuleRepository;
  fixtures: AdapterHarnessFixtures;
}

interface ActivatedMemorySummary {
  id: string;
  type: MemoryType;
  summary: string;
  rank: number;
  score: number;
  payloadBytes: number;
}

interface SuppressedMemorySummary {
  id: string;
  type: MemoryType;
  summary: string;
  kind: SuppressedMemory["kind"];
  reason: string;
}

interface WarningSummary {
  ruleCode: string;
  severity: PolicySeverity;
  scopeGlob: string;
  scopeRef: string;
  triggerKind: LifecycleTrigger;
  message: string;
}

interface EvidenceSummary {
  memoryId: string;
  sourceKind: EvidenceRecord["sourceKind"];
  sourceRef: string;
  excerpt: string;
}

export interface AdapterBeforeModelScenarioResult {
  scenario: "before-model";
  dbPath: string;
  sessionID: string;
  scopeRef: string;
  model: AdapterModelRef;
  injection: {
    advisoryText: string | null;
    system: string[];
    activated: ActivatedMemorySummary[];
    suppressed: SuppressedMemorySummary[];
    budget: {
      maxMemories: number;
      maxPayloadBytes: number;
      usedMemories: number;
      usedPayloadBytes: number;
    };
  };
}

export interface AdapterToolCycleScenarioResult {
  scenario: "tool-cycle";
  dbPath: string;
  sessionID: string;
  scopeRef: string;
  tool: string;
  warning: {
    blocked: false;
    warningText: string | null;
    warnings: WarningSummary[];
  };
  evidence: {
    excerpt: string;
    relatedMemoryIds: string[];
    createdEvidence: EvidenceSummary[];
  };
}

export type AdapterTestScenarioResult =
  | AdapterBeforeModelScenarioResult
  | AdapterToolCycleScenarioResult;

type AdapterBeforeModelScenarioPayload = Omit<
  AdapterBeforeModelScenarioResult,
  "dbPath"
>;
type AdapterToolCycleScenarioPayload = Omit<
  AdapterToolCycleScenarioResult,
  "dbPath"
>;
type AdapterTestScenarioPayload =
  | AdapterBeforeModelScenarioPayload
  | AdapterToolCycleScenarioPayload;

const FIXTURE_SCOPE_REF = "src/adapters/opencode-adapter.ts";
const FIXTURE_SESSION_ID = "adapter-session-001";
const FIXTURE_TOOL_NAME = "write";
const FIXTURE_CALL_ID = "tool-call-001";
const FIXTURE_SOURCE_REF = `${FIXTURE_SESSION_ID}:${FIXTURE_CALL_ID}:${FIXTURE_TOOL_NAME}`;
const FIXTURE_MODEL: AdapterModelRef = {
  providerID: "test-provider",
  modelID: "test-model",
};
const BEFORE_MODEL_BUDGET = {
  maxMemories: 1,
  maxPayloadBytes: 420,
};
const EVIDENCE_EXCERPT_MAX_CHARS = 160;
const MEMORY_FIXTURES: readonly MemoryFixtureInput[] = [
  {
    id: "mem_adapter_policy_001",
    type: "policy",
    summary: "Inject adapter memory before model calls",
    details:
      "Use adapter.beforeModel to surface a compact memory block for adapter-scoped work.",
    scopeGlob: "src/adapters/**/*.ts",
    lifecycleTriggers: ["before_model", "after_tool"],
    confidence: 0.98,
    importance: 0.95,
    status: "active",
    createdAt: "2026-03-29T11:00:00.000Z",
    updatedAt: "2026-03-29T11:00:00.000Z",
  },
  {
    id: "mem_adapter_workflow_001",
    type: "workflow",
    summary: "Keep adapter harness runs deterministic",
    details:
      "Use fixed identifiers and bounded activation budgets so local adapter checks are repeatable.",
    scopeGlob: "src/adapters/**/*.ts",
    lifecycleTriggers: ["before_model"],
    confidence: 0.81,
    importance: 0.74,
    status: "active",
    createdAt: "2026-03-29T11:05:00.000Z",
    updatedAt: "2026-03-29T11:05:00.000Z",
  },
] as const;

const POLICY_RULE_FIXTURES: readonly PolicyRuleFixtureInput[] = [
  {
    id: "policy_adapter_warning_001",
    memoryId: "mem_adapter_policy_001",
    ruleCode: "ADAPTER_TOOL_REVIEW",
    severity: "warning",
    triggerKind: "before_tool",
    scopeGlob: "src/adapters/**/*.ts",
    message: "Adapter tool runs must preserve warning and evidence surfaces.",
    createdAt: "2026-03-29T11:10:00.000Z",
    updatedAt: "2026-03-29T11:10:00.000Z",
  },
] as const;

function ensureSchema(db: SqlJsDatabase): void {
  db.exec(readBundledMigrationSql());
  db.run("PRAGMA foreign_keys = ON;");
  db.run("PRAGMA user_version = 1;");
}

function resetFixtureRows(db: SqlJsDatabase): void {
  db.run("DELETE FROM evidence WHERE source_ref = $sourceRef", {
    $sourceRef: FIXTURE_SOURCE_REF,
  });

  for (const rule of POLICY_RULE_FIXTURES) {
    db.run("DELETE FROM policy_rules WHERE id = $id", { $id: rule.id });
  }

  for (const memory of MEMORY_FIXTURES) {
    db.run("DELETE FROM evidence WHERE memory_id = $memoryId", {
      $memoryId: memory.id,
    });
  }

  for (const memory of MEMORY_FIXTURES) {
    db.run("DELETE FROM memories WHERE id = $id", { $id: memory.id });
  }
}

function insertPolicyRule(db: SqlJsDatabase, input: PolicyRuleFixtureInput): void {
  db.run(
    `INSERT INTO policy_rules (
      id,
      memory_id,
      rule_code,
      severity,
      trigger_kind,
      scope_glob,
      message,
      created_at,
      updated_at
    ) VALUES (
      $id,
      $memoryId,
      $ruleCode,
      $severity,
      $triggerKind,
      $scopeGlob,
      $message,
      $createdAt,
      $updatedAt
    )`,
    {
      $id: input.id,
      $memoryId: input.memoryId,
      $ruleCode: input.ruleCode,
      $severity: input.severity,
      $triggerKind: input.triggerKind,
      $scopeGlob: input.scopeGlob,
      $message: input.message,
      $createdAt: input.createdAt,
      $updatedAt: input.updatedAt,
    }
  );
}

function summarizeActivated(memory: RankedMemory): ActivatedMemorySummary {
  return {
    id: memory.id,
    type: memory.type,
    summary: memory.summary,
    rank: memory.rank,
    score: memory.score,
    payloadBytes: memory.payloadBytes,
  };
}

function summarizeSuppressed(entry: SuppressedMemory): SuppressedMemorySummary {
  return {
    id: entry.memory.id,
    type: entry.memory.type,
    summary: entry.memory.summary,
    kind: entry.kind,
    reason: entry.reason,
  };
}

function summarizeWarning(warning: PolicyWarning): WarningSummary {
  return {
    ruleCode: warning.ruleCode,
    severity: warning.severity,
    scopeGlob: warning.scopeGlob,
    scopeRef: warning.scopeRef,
    triggerKind: warning.triggerKind,
    message: warning.message,
  };
}

function summarizeEvidence(record: EvidenceRecord): EvidenceSummary {
  return {
    memoryId: record.memoryId,
    sourceKind: record.sourceKind,
    sourceRef: record.sourceRef,
    excerpt: record.excerpt,
  };
}

export function prepareAdapterHarnessDb(db: SqlJsDatabase): AdapterHarness {
  ensureSchema(db);
  resetFixtureRows(db);

  const memoryRepository = new MemoryRepository(db);

  for (const memory of MEMORY_FIXTURES) {
    memoryRepository.create(memory);
  }

  for (const rule of POLICY_RULE_FIXTURES) {
    insertPolicyRule(db, rule);
  }

  const activationEngine = new ActivationEngine(memoryRepository);
  const dreamRepository = new DreamRepository(db);
  const policyRepository = new PolicyRuleRepository(db);
  const policyEngine = new PolicyEngine(policyRepository);
  const adapter = new OpenCodeAdapter({
    activationEngine,
    policyEngine,
    dreamRepository,
    defaultScopeRef: FIXTURE_SCOPE_REF,
    evidenceExcerptMaxChars: EVIDENCE_EXCERPT_MAX_CHARS,
  });

  return {
    adapter,
    dreamRepository,
    memoryRepository,
    policyRepository,
    fixtures: {
      sessionID: FIXTURE_SESSION_ID,
      scopeRef: FIXTURE_SCOPE_REF,
      model: FIXTURE_MODEL,
      toolName: FIXTURE_TOOL_NAME,
      callID: FIXTURE_CALL_ID,
      sourceRef: FIXTURE_SOURCE_REF,
      toolArgs: {
        filePath: FIXTURE_SCOPE_REF,
        operation: "append",
        bytes: 42,
      },
      toolOutput: {
        title: "Adapter harness evidence",
        output:
          "Updated the adapter verification surface with deterministic harness output.",
        metadata: {
          exitCode: 0,
          linesChanged: 2,
        },
      },
      beforeModelBudget: BEFORE_MODEL_BUDGET,
      memoryIds: {
        injected: MEMORY_FIXTURES[0].id,
        suppressed: MEMORY_FIXTURES[1].id,
        evidence: MEMORY_FIXTURES[0].id,
      },
      ruleCode: POLICY_RULE_FIXTURES[0].ruleCode,
    },
  };
}

export function runAdapterTestScenarioWithDb(
  db: SqlJsDatabase,
  scenario: AdapterTestScenario
): AdapterTestScenarioPayload {
  const harness = prepareAdapterHarnessDb(db);
  const { adapter, fixtures } = harness;

  adapter.initializeSession({
    sessionID: fixtures.sessionID,
    agent: "adapter-test",
    messageID: "message-001",
    variant: "local-harness",
  });

  if (scenario === "before-model") {
    const result = adapter.beforeModel({
      sessionID: fixtures.sessionID,
      model: fixtures.model,
      scopeRef: fixtures.scopeRef,
      maxMemories: fixtures.beforeModelBudget.maxMemories,
      maxPayloadBytes: fixtures.beforeModelBudget.maxPayloadBytes,
    });

    const payload: AdapterBeforeModelScenarioPayload = {
      scenario,
      sessionID: fixtures.sessionID,
      scopeRef: fixtures.scopeRef,
      model: fixtures.model,
      injection: {
        advisoryText: result.advisoryText,
        system: result.system,
        activated: result.activation.activated.map(summarizeActivated),
        suppressed: result.activation.suppressed.map(summarizeSuppressed),
        budget: result.activation.budget,
      },
    };

    return payload;
  }

  const warningResult = adapter.beforeTool({
    sessionID: fixtures.sessionID,
    tool: fixtures.toolName,
    callID: fixtures.callID,
    scopeRef: fixtures.scopeRef,
  });
  const evidenceResult = adapter.afterTool(
    {
      sessionID: fixtures.sessionID,
      tool: fixtures.toolName,
      callID: fixtures.callID,
      scopeRef: fixtures.scopeRef,
      args: fixtures.toolArgs,
    },
    fixtures.toolOutput
  );

  const payload: AdapterToolCycleScenarioPayload = {
    scenario,
    sessionID: fixtures.sessionID,
    scopeRef: fixtures.scopeRef,
    tool: fixtures.toolName,
    warning: {
      blocked: warningResult.blocked,
      warningText: warningResult.warningText,
      warnings: warningResult.warnings.map(summarizeWarning),
    },
    evidence: {
      excerpt: evidenceResult.excerpt,
      relatedMemoryIds: evidenceResult.relatedMemoryIds,
      createdEvidence: evidenceResult.createdEvidence.map(summarizeEvidence),
    },
  };

  return payload;
}

export async function runAdapterTestScenario(
  dbPath: string,
  scenario: AdapterTestScenario
): Promise<AdapterTestScenarioResult> {
  const db = await openSqlJsDatabase(dbPath);

  try {
    const result = runAdapterTestScenarioWithDb(db, scenario);
    saveSqlJsDatabase(db, dbPath);

    if (result.scenario === "before-model") {
      return {
        ...result,
        dbPath,
      };
    }

    return {
      ...result,
      dbPath,
    };
  } finally {
    db.close();
  }
}
