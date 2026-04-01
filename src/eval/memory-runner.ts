import { mkdirSync, readdirSync, rmSync, writeFileSync } from "fs";
import { resolve } from "path";

import type { Database as SqlJsDatabase } from "sql.js";

import { ActivationEngine, type ActivationResult } from "../activation";
import { OpenCodeAdapter, type OpenCodeAdapterOptions } from "../adapters/opencode-adapter";
import { openSqlJsDatabase } from "../db/sqlite";
import type {
  LifecycleTrigger,
  MemoryStatus,
  MemoryType,
  PolicySeverity,
} from "../db/schema/types";
import { MemoryRepository } from "../memory";
import { PolicyEngine, PolicyRuleRepository, type PolicyWarning } from "../policy";
import {
  readBundledMigrationSql,
  resolveEvalOutputDir,
} from "../runtime/package-paths";

const DETERMINISTIC_MODEL = {
  providerID: "eval-provider",
  modelID: "eval-model",
} as const;

const SCENARIO_SELECTORS = ["all", "stale-conflict-suite"] as const;

export type MemoryEvalScenarioSelector =
  | (typeof SCENARIO_SELECTORS)[number]
  | MemoryEvalScenarioID;

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
  supersedesMemoryId?: string | null;
  createdAt: string;
  updatedAt: string;
  lastVerifiedAt?: string | null;
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

interface ToolContext {
  name: string;
  callID: string;
  target: string;
  args: {
    filePath: string;
    operation: string;
    bytes: number;
  };
  output: {
    title: string;
    output: string;
    metadata: {
      exitCode: number;
      linesChanged: number;
    };
  };
}

interface ScenarioExpectation {
  requiredActivatedMemoryIds?: readonly string[];
  requiredSuppressedMemoryIds?: readonly string[];
  minWarningCount?: number;
  requireConflictMarker?: boolean;
  requireStaleMarker?: boolean;
  requireBudgetSuppression?: boolean;
}

interface ScenarioDefinition {
  id: string;
  corpusScenarioNumber: number;
  title: string;
  taskPrompt: string;
  lifecycleTrigger: LifecycleTrigger;
  scopeRef: string;
  edgeSuite: boolean;
  tool: ToolContext | null;
  expectation: ScenarioExpectation;
}

interface ScenarioValidation {
  activated: boolean;
  suppressed: boolean;
  warnings: boolean;
  conflicts: boolean;
  stale: boolean;
  budget: boolean;
}

interface ActivatedMemoryLogEntry {
  id: string;
  type: MemoryType;
  summary: string;
  status: MemoryStatus;
  rank: number;
  score: number;
  payloadBytes: number;
}

interface SuppressedMemoryLogEntry {
  id: string;
  type: MemoryType;
  summary: string;
  status: MemoryStatus;
  kind: string;
  reason: string;
}

interface WarningLogEntry {
  ruleCode: string;
  severity: PolicySeverity;
  triggerKind: LifecycleTrigger;
  scopeGlob: string;
  scopeRef: string;
  message: string;
}

interface ConflictMarkerEntry {
  marker: "CONFLICT";
  kind: string;
  reason: string;
  rootId: string;
  memoryIds: string[];
}

interface StaleMarkerEntry {
  marker: "STALE";
  memoryId: string;
  status: "stale" | "superseded";
  reason: string;
}

interface ScenarioOutcome {
  taskOutcome: "memory-layer-behavior-aligned" | "memory-layer-behavior-miss";
  scenarioOutcome: "pass" | "fail";
  expected: ScenarioExpectation;
  validation: ScenarioValidation;
}

export interface MemoryEvalScenarioLog {
  condition: "md-plus-memory-layer";
  scenarioId: MemoryEvalScenarioID;
  corpusScenarioNumber: number;
  title: string;
  taskPrompt: string;
  lifecycleTrigger: LifecycleTrigger;
  scopeRef: string;
  tool: {
    name: string;
    callID: string;
    target: string;
  } | null;
  latency: {
    deterministicMs: number;
  };
  activated_memory_ids: string[];
  suppressed_memory_ids: string[];
  activated: ActivatedMemoryLogEntry[];
  suppressed: SuppressedMemoryLogEntry[];
  warning_count: number;
  warnings: WarningLogEntry[];
  conflict_markers: ConflictMarkerEntry[];
  stale_markers: StaleMarkerEntry[];
  outcome: ScenarioOutcome;
}

export interface MemoryEvalSummary {
  condition: "md-plus-memory-layer";
  scenarioSelector: MemoryEvalScenarioSelector;
  generatedAt: string;
  outputDir: string;
  scenarioCount: number;
  passedScenarios: number;
  failedScenarios: number;
  totals: {
    activated: number;
    suppressed: number;
    warnings: number;
    conflicts: number;
    staleMarkers: number;
    deterministicLatencyMs: number;
    averageDeterministicLatencyMs: number;
  };
  containsStaleOrConflictMarkers: boolean;
  scenarioFiles: string[];
  scenarios: Array<{
    scenarioId: MemoryEvalScenarioID;
    scenarioOutcome: "pass" | "fail";
    warning_count: number;
    activated_memory_ids: string[];
    suppressed_memory_ids: string[];
    conflict_marker_count: number;
    stale_marker_count: number;
    deterministic_latency_ms: number;
  }>;
}

export interface MemoryEvalOptions {
  dbPath?: string;
  outputDir?: string;
}

export const MEMORY_EVAL_SCENARIOS = [
  {
    id: "s01-session-start-forgotten-architecture",
    corpusScenarioNumber: 1,
    title: "Session Start - Forgotten Architecture Constraint",
    taskPrompt:
      "Add a new endpoint to fetch user preferences. The route should be in `src/routes/preferences.ts`.",
    lifecycleTrigger: "session_start",
    scopeRef: "src/routes/preferences.ts",
    edgeSuite: false,
    tool: null,
    expectation: {
      requiredActivatedMemoryIds: ["mem_arch_001"],
    },
  },
  {
    id: "s02-before-model-stale-workflow",
    corpusScenarioNumber: 2,
    title: "Before Model - Stale Workflow Preference",
    taskPrompt:
      "Write tests for the new validation utility in `src/utils/validation.ts`.",
    lifecycleTrigger: "before_model",
    scopeRef: "src/utils/validation.test.ts",
    edgeSuite: true,
    tool: null,
    expectation: {
      requiredActivatedMemoryIds: ["mem_workflow_vitest_001"],
      requiredSuppressedMemoryIds: ["mem_workflow_bun_001"],
      requireStaleMarker: true,
    },
  },
  {
    id: "s03-before-tool-policy-warning",
    corpusScenarioNumber: 3,
    title: "Before Tool - Policy Violation Warning",
    taskPrompt:
      "Create a local environment file with the database URL and API key for development.",
    lifecycleTrigger: "before_tool",
    scopeRef: ".env.local",
    edgeSuite: false,
    tool: {
      name: "write",
      callID: "tool-call-s03",
      target: ".env.local",
      args: {
        filePath: ".env.local",
        operation: "write",
        bytes: 84,
      },
      output: {
        title: "Environment file write",
        output: "Created .env.local with local placeholders.",
        metadata: {
          exitCode: 0,
          linesChanged: 4,
        },
      },
    },
    expectation: {
      minWarningCount: 1,
    },
  },
  {
    id: "s04-before-model-pitfall-recall",
    corpusScenarioNumber: 4,
    title: "Before Model - Pitfall Recall",
    taskPrompt:
      "Add a function to update user profile data in `src/services/user-service.ts`.",
    lifecycleTrigger: "before_model",
    scopeRef: "src/services/user-service.ts",
    edgeSuite: false,
    tool: null,
    expectation: {
      requiredActivatedMemoryIds: ["mem_pitfall_save_await_001"],
    },
  },
  {
    id: "s05-session-start-conflicting-decisions",
    corpusScenarioNumber: 5,
    title: "Session Start - Conflicting Decisions",
    taskPrompt:
      "Add input validation for the new API endpoint in `src/routes/api/v1/users.ts`.",
    lifecycleTrigger: "session_start",
    scopeRef: "src/routes/api/v1/users.ts",
    edgeSuite: true,
    tool: null,
    expectation: {
      requiredActivatedMemoryIds: ["mem_decision_zod_001", "mem_decision_valibot_001"],
      requireConflictMarker: true,
    },
  },
  {
    id: "s06-before-tool-scope-mismatch",
    corpusScenarioNumber: 6,
    title: "Before Tool - Scope Mismatch (No Activation)",
    taskPrompt: "Fix the date formatting bug in `src/utils/date-helpers.ts`.",
    lifecycleTrigger: "before_tool",
    scopeRef: "src/utils/date-helpers.ts",
    edgeSuite: false,
    tool: {
      name: "edit",
      callID: "tool-call-s06",
      target: "src/utils/date-helpers.ts",
      args: {
        filePath: "src/utils/date-helpers.ts",
        operation: "edit",
        bytes: 22,
      },
      output: {
        title: "Date helper patch",
        output: "Applied a focused format fix.",
        metadata: {
          exitCode: 0,
          linesChanged: 2,
        },
      },
    },
    expectation: {
      requiredSuppressedMemoryIds: ["mem_policy_migration_001"],
    },
  },
  {
    id: "s07-after-tool-evidence-capture",
    corpusScenarioNumber: 7,
    title: "After Tool - Evidence Capture for Future Promotion",
    taskPrompt: "Fix the JSON export error in the export service.",
    lifecycleTrigger: "after_tool",
    scopeRef: "src/services/export-service.ts",
    edgeSuite: false,
    tool: {
      name: "edit",
      callID: "tool-call-s07",
      target: "src/services/export-service.ts",
      args: {
        filePath: "src/services/export-service.ts",
        operation: "edit",
        bytes: 39,
      },
      output: {
        title: "Export service fix",
        output:
          "Replaced JSON.stringify(prismaModel) with explicit field projection.",
        metadata: {
          exitCode: 0,
          linesChanged: 6,
        },
      },
    },
    expectation: {},
  },
  {
    id: "s08-before-model-multi-trigger-policy",
    corpusScenarioNumber: 8,
    title: "Before Model - Multi-Trigger Policy",
    taskPrompt:
      "Add a background job to sync user data from the external CRM API in `src/jobs/sync-users.ts`.",
    lifecycleTrigger: "before_model",
    scopeRef: "src/jobs/sync-users.ts",
    edgeSuite: false,
    tool: null,
    expectation: {
      requiredActivatedMemoryIds: ["mem_policy_api_timeout_001"],
    },
  },
  {
    id: "s09-before-tool-stale-pitfall",
    corpusScenarioNumber: 9,
    title: "Before Tool - Stale Pitfall (Resolved)",
    taskPrompt: "Add a route to serve uploaded files from the filesystem.",
    lifecycleTrigger: "before_tool",
    scopeRef: "src/routes/files.ts",
    edgeSuite: true,
    tool: {
      name: "edit",
      callID: "tool-call-s09",
      target: "src/routes/files.ts",
      args: {
        filePath: "src/routes/files.ts",
        operation: "edit",
        bytes: 31,
      },
      output: {
        title: "Files route update",
        output: "Added async stream-based file response handling.",
        metadata: {
          exitCode: 0,
          linesChanged: 8,
        },
      },
    },
    expectation: {
      requiredSuppressedMemoryIds: ["mem_pitfall_readfilesync_001"],
      requireStaleMarker: true,
    },
  },
  {
    id: "s10-session-start-high-priority-policy",
    corpusScenarioNumber: 10,
    title: "Session Start - High-Priority Policy",
    taskPrompt:
      "Add a new admin endpoint to list all users with their details in `src/routes/admin/users.ts`.",
    lifecycleTrigger: "session_start",
    scopeRef: "src/routes/admin/users.ts",
    edgeSuite: false,
    tool: null,
    expectation: {
      requiredActivatedMemoryIds: ["mem_policy_gdpr_001"],
      minWarningCount: 1,
    },
  },
  {
    id: "s11-before-model-workflow-pitfall",
    corpusScenarioNumber: 11,
    title: "Before Model - Workflow + Pitfall Combination",
    taskPrompt:
      "Write a GitHub Actions workflow for automated deployment in `.github/workflows/deploy.yml`.",
    lifecycleTrigger: "before_model",
    scopeRef: ".github/workflows/deploy.yml",
    edgeSuite: false,
    tool: null,
    expectation: {
      requiredActivatedMemoryIds: [
        "mem_workflow_deploy_001",
        "mem_pitfall_deploy_branch_001",
      ],
    },
  },
  {
    id: "s12-before-tool-budget-overflow",
    corpusScenarioNumber: 12,
    title: "Before Tool - Budget Overflow (Activation Limit)",
    taskPrompt:
      "Add a new payment processing function in the payment service.",
    lifecycleTrigger: "before_tool",
    scopeRef: "src/services/payment-service.ts",
    edgeSuite: false,
    tool: {
      name: "edit",
      callID: "tool-call-s12",
      target: "src/services/payment-service.ts",
      args: {
        filePath: "src/services/payment-service.ts",
        operation: "edit",
        bytes: 64,
      },
      output: {
        title: "Payment service extension",
        output: "Inserted processPayment() and failure handling stubs.",
        metadata: {
          exitCode: 0,
          linesChanged: 15,
        },
      },
    },
    expectation: {
      requireBudgetSuppression: true,
    },
  },
] as const satisfies readonly ScenarioDefinition[];

export type MemoryEvalScenarioID = (typeof MEMORY_EVAL_SCENARIOS)[number]["id"];

const MEMORY_FIXTURES: readonly MemoryFixtureInput[] = [
  {
    id: "mem_arch_001",
    type: "architecture_constraint",
    summary:
      "All database access must go through repository pattern, never direct SQLite calls from routes",
    details:
      "Enforce repository boundaries for route handlers to avoid bypassing domain logic.",
    scopeGlob: "src/routes/**/*.ts",
    lifecycleTriggers: ["session_start", "before_model"],
    confidence: 0.96,
    importance: 0.94,
    status: "active",
    createdAt: "2026-03-26T10:00:00.000Z",
    updatedAt: "2026-03-26T10:00:00.000Z",
  },
  {
    id: "mem_workflow_bun_001",
    type: "workflow",
    summary: "Use bun test for test runs",
    details: "Legacy workflow preference retained for audit but no longer active.",
    scopeGlob: "src/**/*.test.ts",
    lifecycleTriggers: ["before_model"],
    confidence: 0.72,
    importance: 0.51,
    status: "stale",
    createdAt: "2026-03-23T09:00:00.000Z",
    updatedAt: "2026-03-27T09:00:00.000Z",
    lastVerifiedAt: "2026-03-27T09:00:00.000Z",
  },
  {
    id: "mem_workflow_vitest_001",
    type: "workflow",
    summary: "Use vitest for test runs",
    details: "Current workflow preference for tests in this repository.",
    scopeGlob: "src/**/*.test.ts",
    lifecycleTriggers: ["before_model"],
    confidence: 0.9,
    importance: 0.73,
    status: "active",
    supersedesMemoryId: "mem_workflow_bun_001",
    createdAt: "2026-03-27T10:00:00.000Z",
    updatedAt: "2026-03-27T10:00:00.000Z",
    lastVerifiedAt: "2026-03-27T10:00:00.000Z",
  },
  {
    id: "mem_pitfall_save_await_001",
    type: "pitfall",
    summary: "Always await .save() calls - missing await causes silent data loss",
    details:
      "Missing await on ORM save can silently drop updates under concurrent load.",
    scopeGlob: "src/services/**/*.ts",
    lifecycleTriggers: ["before_model"],
    confidence: 0.95,
    importance: 0.92,
    status: "active",
    createdAt: "2026-03-25T08:00:00.000Z",
    updatedAt: "2026-03-25T08:00:00.000Z",
  },
  {
    id: "mem_decision_zod_001",
    type: "decision",
    summary: "Use Zod for all validation",
    details: "Primary validation decision used across established endpoints.",
    scopeGlob: "src/routes/api/v1/**/*.ts",
    lifecycleTriggers: ["session_start"],
    confidence: 0.86,
    importance: 0.79,
    status: "active",
    createdAt: "2026-03-14T12:00:00.000Z",
    updatedAt: "2026-03-14T12:00:00.000Z",
  },
  {
    id: "mem_decision_valibot_001",
    type: "decision",
    summary: "Considering Valibot for hot paths",
    details: "Experimental note without explicit supersession resolution.",
    scopeGlob: "src/routes/api/v1/**/*.ts",
    lifecycleTriggers: ["session_start"],
    confidence: 0.8,
    importance: 0.62,
    status: "active",
    createdAt: "2026-03-21T12:00:00.000Z",
    updatedAt: "2026-03-21T12:00:00.000Z",
  },
  {
    id: "mem_policy_migration_001",
    type: "policy",
    summary: "Always use timestamped migration files, never edit existing migrations",
    details: "Migration policy applies only to SQL migration paths.",
    scopeGlob: "db/migrations/**/*.sql",
    lifecycleTriggers: ["before_tool"],
    confidence: 0.9,
    importance: 0.76,
    status: "active",
    createdAt: "2026-03-18T09:30:00.000Z",
    updatedAt: "2026-03-18T09:30:00.000Z",
  },
  {
    id: "mem_policy_api_timeout_001",
    type: "policy",
    summary: "All external API calls must include timeout and retry logic",
    details:
      "Applies to job and route integrations that call third-party services.",
    scopeGlob: "src/jobs/**/*.ts",
    lifecycleTriggers: ["before_model", "before_tool"],
    confidence: 0.93,
    importance: 0.9,
    status: "active",
    createdAt: "2026-03-19T11:00:00.000Z",
    updatedAt: "2026-03-19T11:00:00.000Z",
  },
  {
    id: "mem_pitfall_readfilesync_001",
    type: "pitfall",
    summary: "Avoid fs.readFileSync in route handlers",
    details: "Superseded after async refactor; retained as historical stale memory.",
    scopeGlob: "src/routes/**/*.ts",
    lifecycleTriggers: ["before_tool"],
    confidence: 0.84,
    importance: 0.57,
    status: "stale",
    createdAt: "2026-03-08T15:00:00.000Z",
    updatedAt: "2026-03-15T15:00:00.000Z",
    lastVerifiedAt: "2026-03-15T15:00:00.000Z",
  },
  {
    id: "mem_policy_gdpr_001",
    type: "policy",
    summary:
      "Never expose user email in API responses without consent flag check",
    details:
      "GDPR-critical policy for admin and public route output serialization.",
    scopeGlob: "src/routes/**/*.ts",
    lifecycleTriggers: ["session_start"],
    confidence: 0.99,
    importance: 0.98,
    status: "active",
    createdAt: "2026-03-10T10:30:00.000Z",
    updatedAt: "2026-03-10T10:30:00.000Z",
  },
  {
    id: "mem_workflow_deploy_001",
    type: "workflow",
    summary: "Deployment workflow: build && test:ci before deploy",
    details: "CI deploy flow must compile and pass tests before release step.",
    scopeGlob: ".github/workflows/**/*.yml",
    lifecycleTriggers: ["before_model"],
    confidence: 0.91,
    importance: 0.86,
    status: "active",
    createdAt: "2026-03-12T13:00:00.000Z",
    updatedAt: "2026-03-12T13:00:00.000Z",
  },
  {
    id: "mem_pitfall_deploy_branch_001",
    type: "pitfall",
    summary: "Only deploy from main branch",
    details:
      "Deployment on non-main branches previously caused production incidents.",
    scopeGlob: ".github/workflows/**/*.yml",
    lifecycleTriggers: ["before_model"],
    confidence: 0.9,
    importance: 0.9,
    status: "active",
    createdAt: "2026-03-12T13:10:00.000Z",
    updatedAt: "2026-03-12T13:10:00.000Z",
  },
  {
    id: "mem_budget_payment_001",
    type: "policy",
    summary: "Payment processing requires idempotency key verification",
    details: "Check idempotency tokens before charging.",
    scopeGlob: "src/services/payment-service.ts",
    lifecycleTriggers: ["before_tool"],
    confidence: 0.98,
    importance: 0.99,
    status: "active",
    createdAt: "2026-03-20T01:00:00.000Z",
    updatedAt: "2026-03-20T01:00:00.000Z",
  },
  {
    id: "mem_budget_payment_002",
    type: "policy",
    summary: "Payment retries must use exponential backoff",
    details: "Retry strategy should avoid burst retries.",
    scopeGlob: "src/services/payment-*.ts",
    lifecycleTriggers: ["before_tool"],
    confidence: 0.95,
    importance: 0.95,
    status: "active",
    createdAt: "2026-03-20T01:10:00.000Z",
    updatedAt: "2026-03-20T01:10:00.000Z",
  },
  {
    id: "mem_budget_payment_003",
    type: "pitfall",
    summary: "Never log full card payloads",
    details: "PII must be redacted before logs are written.",
    scopeGlob: "src/services/payment-*.ts",
    lifecycleTriggers: ["before_tool"],
    confidence: 0.97,
    importance: 0.94,
    status: "active",
    createdAt: "2026-03-20T01:20:00.000Z",
    updatedAt: "2026-03-20T01:20:00.000Z",
  },
  {
    id: "mem_budget_payment_004",
    type: "workflow",
    summary: "Record charge attempt audit event on every transition",
    details: "Audit stream should include pending, success, and failure states.",
    scopeGlob: "src/services/payment-service.ts",
    lifecycleTriggers: ["before_tool"],
    confidence: 0.93,
    importance: 0.92,
    status: "active",
    createdAt: "2026-03-20T01:30:00.000Z",
    updatedAt: "2026-03-20T01:30:00.000Z",
  },
  {
    id: "mem_budget_payment_005",
    type: "policy",
    summary: "Normalize currency to minor units before persistence",
    details: "Store cents to avoid floating-point drift.",
    scopeGlob: "src/**/payment-service.ts",
    lifecycleTriggers: ["before_tool"],
    confidence: 0.91,
    importance: 0.9,
    status: "active",
    createdAt: "2026-03-20T01:40:00.000Z",
    updatedAt: "2026-03-20T01:40:00.000Z",
  },
  {
    id: "mem_budget_payment_006",
    type: "decision",
    summary: "Use provider tokenization SDK wrapper",
    details: "Avoid direct provider SDK calls outside wrapper layer.",
    scopeGlob: "**/payment-service.ts",
    lifecycleTriggers: ["before_tool"],
    confidence: 0.9,
    importance: 0.88,
    status: "active",
    createdAt: "2026-03-20T01:50:00.000Z",
    updatedAt: "2026-03-20T01:50:00.000Z",
  },
  {
    id: "mem_budget_payment_007",
    type: "policy",
    summary: "Wrap provider calls with explicit timeout",
    details: "Any external payment call must define timeout budgets.",
    scopeGlob: "src/services/**/payment-service.ts",
    lifecycleTriggers: ["before_tool"],
    confidence: 0.89,
    importance: 0.87,
    status: "active",
    createdAt: "2026-03-20T02:00:00.000Z",
    updatedAt: "2026-03-20T02:00:00.000Z",
  },
  {
    id: "mem_budget_payment_008",
    type: "pitfall",
    summary: "Do not swallow declined-charge provider errors",
    details: "Provider decline reasons must propagate to error mapping.",
    scopeGlob: "src/**/services/payment-service.ts",
    lifecycleTriggers: ["before_tool"],
    confidence: 0.88,
    importance: 0.86,
    status: "active",
    createdAt: "2026-03-20T02:10:00.000Z",
    updatedAt: "2026-03-20T02:10:00.000Z",
  },
  {
    id: "mem_budget_payment_009",
    type: "workflow",
    summary: "Persist payment intent state before side effects",
    details: "Write local state before external webhook registration.",
    scopeGlob: "src/services/**/payment*.ts",
    lifecycleTriggers: ["before_tool"],
    confidence: 0.87,
    importance: 0.84,
    status: "active",
    createdAt: "2026-03-20T02:20:00.000Z",
    updatedAt: "2026-03-20T02:20:00.000Z",
  },
  {
    id: "mem_budget_payment_010",
    type: "policy",
    summary: "Round-trip provider response signature validation",
    details: "Validate signatures before accepting callback payloads.",
    scopeGlob: "src/services/payment-**.ts",
    lifecycleTriggers: ["before_tool"],
    confidence: 0.86,
    importance: 0.83,
    status: "active",
    createdAt: "2026-03-20T02:30:00.000Z",
    updatedAt: "2026-03-20T02:30:00.000Z",
  },
  {
    id: "mem_budget_payment_011",
    type: "decision",
    summary: "Prefer deterministic failure codes for retries",
    details: "Map provider response classes to stable retry policies.",
    scopeGlob: "src/services/payment-service.ts",
    lifecycleTriggers: ["before_tool"],
    confidence: 0.84,
    importance: 0.62,
    status: "active",
    createdAt: "2026-03-20T02:40:00.000Z",
    updatedAt: "2026-03-20T02:40:00.000Z",
  },
  {
    id: "mem_budget_payment_012",
    type: "workflow",
    summary: "Record retry metrics tags for every charge attempt",
    details: "Metrics should include provider and retry ordinal.",
    scopeGlob: "src/services/payment-service.ts",
    lifecycleTriggers: ["before_tool"],
    confidence: 0.81,
    importance: 0.58,
    status: "active",
    createdAt: "2026-03-20T02:50:00.000Z",
    updatedAt: "2026-03-20T02:50:00.000Z",
  },
  {
    id: "mem_budget_payment_013",
    type: "policy",
    summary: "Use deterministic order when applying payment middleware",
    details: "Middleware ordering affects signature and idempotency checks.",
    scopeGlob: "src/services/payment-service.ts",
    lifecycleTriggers: ["before_tool"],
    confidence: 0.8,
    importance: 0.56,
    status: "active",
    createdAt: "2026-03-20T03:00:00.000Z",
    updatedAt: "2026-03-20T03:00:00.000Z",
  },
  {
    id: "mem_budget_payment_014",
    type: "pitfall",
    summary: "Avoid inline currency conversion tables",
    details: "Use centralized conversion map to prevent divergence.",
    scopeGlob: "src/services/payment-service.ts",
    lifecycleTriggers: ["before_tool"],
    confidence: 0.79,
    importance: 0.55,
    status: "active",
    createdAt: "2026-03-20T03:10:00.000Z",
    updatedAt: "2026-03-20T03:10:00.000Z",
  },
  {
    id: "mem_budget_payment_015",
    type: "policy",
    summary: "Annotate charge records with reconciliation window",
    details: "Include settlement window metadata for later reconciliation.",
    scopeGlob: "src/services/payment-service.ts",
    lifecycleTriggers: ["before_tool"],
    confidence: 0.78,
    importance: 0.54,
    status: "active",
    createdAt: "2026-03-20T03:20:00.000Z",
    updatedAt: "2026-03-20T03:20:00.000Z",
  },
] as const;

const POLICY_RULE_FIXTURES: readonly PolicyRuleFixtureInput[] = [
  {
    id: "policy_sec_001",
    memoryId: null,
    ruleCode: "NO_COMMIT_SECRETS",
    severity: "warning",
    triggerKind: "before_tool",
    scopeGlob: "**/.env*",
    message:
      "Policy: Never commit .env files. Use .env.example with placeholder values instead.",
    createdAt: "2026-03-15T10:00:00.000Z",
    updatedAt: "2026-03-15T10:00:00.000Z",
  },
  {
    id: "policy_gdpr_001",
    memoryId: "mem_policy_gdpr_001",
    ruleCode: "NO_EMAIL_WITHOUT_CONSENT",
    severity: "warning",
    triggerKind: "session_start",
    scopeGlob: "src/routes/**/*.ts",
    message:
      "Never expose user email in API responses without consent flag check (GDPR).",
    createdAt: "2026-03-10T10:35:00.000Z",
    updatedAt: "2026-03-10T10:35:00.000Z",
  },
  {
    id: "policy_api_001",
    memoryId: "mem_policy_api_timeout_001",
    ruleCode: "REQUIRE_TIMEOUT_RETRY",
    severity: "warning",
    triggerKind: "before_model",
    scopeGlob: "src/jobs/**/*.ts",
    message: "All external API calls must include timeout and retry logic.",
    createdAt: "2026-03-19T11:05:00.000Z",
    updatedAt: "2026-03-19T11:05:00.000Z",
  },
];

interface MemoryEvalHarness {
  activationEngine: ActivationEngine;
  policyEngine: PolicyEngine;
  adapter: OpenCodeAdapter;
}

function ensureSchema(db: SqlJsDatabase): void {
  db.exec(readBundledMigrationSql());
  db.run("PRAGMA foreign_keys = ON;");
  db.run("PRAGMA user_version = 1;");
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

function prepareMemoryEvalHarness(db: SqlJsDatabase): MemoryEvalHarness {
  ensureSchema(db);

  const memoryRepository = new MemoryRepository(db);
  for (const memory of MEMORY_FIXTURES) {
    memoryRepository.create(memory);
  }

  for (const rule of POLICY_RULE_FIXTURES) {
    insertPolicyRule(db, rule);
  }

  const activationEngine = new ActivationEngine(memoryRepository);
  const policyEngine = new PolicyEngine(new PolicyRuleRepository(db));
  const adapterOptions: OpenCodeAdapterOptions = {
    activationEngine,
    policyEngine,
    defaultScopeRef: ".",
    evidenceExcerptMaxChars: 200,
  };

  return {
    activationEngine,
    policyEngine,
    adapter: new OpenCodeAdapter(adapterOptions),
  };
}

function estimateDeterministicLatencyMs(
  trigger: LifecycleTrigger,
  activation: ActivationResult,
  warningCount: number
): number {
  const triggerWeight: Record<LifecycleTrigger, number> = {
    session_start: 8,
    before_model: 10,
    before_tool: 9,
    after_tool: 11,
  };

  return (
    triggerWeight[trigger] +
    activation.activated.length * 3 +
    activation.suppressed.length * 2 +
    activation.conflicts.length * 4 +
    warningCount * 3
  );
}

function summarizeWarnings(warnings: readonly PolicyWarning[]): WarningLogEntry[] {
  return warnings.map((warning) => ({
    ruleCode: warning.ruleCode,
    severity: warning.severity,
    triggerKind: warning.triggerKind,
    scopeGlob: warning.scopeGlob,
    scopeRef: warning.scopeRef,
    message: warning.message,
  }));
}

function containsAll(ids: readonly string[], required: readonly string[]): boolean {
  const idSet = new Set(ids);
  return required.every((id) => idSet.has(id));
}

function selectScenarios(
  scenarioSelector: MemoryEvalScenarioSelector
): readonly ScenarioDefinition[] {
  if (scenarioSelector === "all") {
    return MEMORY_EVAL_SCENARIOS;
  }

  if (scenarioSelector === "stale-conflict-suite") {
    return MEMORY_EVAL_SCENARIOS.filter((scenario) => scenario.edgeSuite);
  }

  return MEMORY_EVAL_SCENARIOS.filter((scenario) => scenario.id === scenarioSelector);
}

function validateScenarioLog(
  log: Omit<MemoryEvalScenarioLog, "outcome">,
  expectation: ScenarioExpectation
): ScenarioOutcome {
  const validation: ScenarioValidation = {
    activated:
      expectation.requiredActivatedMemoryIds === undefined
        ? true
        : containsAll(log.activated_memory_ids, expectation.requiredActivatedMemoryIds),
    suppressed:
      expectation.requiredSuppressedMemoryIds === undefined
        ? true
        : containsAll(log.suppressed_memory_ids, expectation.requiredSuppressedMemoryIds),
    warnings:
      expectation.minWarningCount === undefined
        ? true
        : log.warning_count >= expectation.minWarningCount,
    conflicts:
      expectation.requireConflictMarker === undefined
        ? true
        : expectation.requireConflictMarker
          ? log.conflict_markers.length > 0
          : log.conflict_markers.length === 0,
    stale:
      expectation.requireStaleMarker === undefined
        ? true
        : expectation.requireStaleMarker
          ? log.stale_markers.length > 0
          : log.stale_markers.length === 0,
    budget:
      expectation.requireBudgetSuppression === undefined
        ? true
        : expectation.requireBudgetSuppression
          ? log.suppressed.some((entry) => entry.kind === "budget_limit")
          : !log.suppressed.some((entry) => entry.kind === "budget_limit"),
  };

  const scenarioOutcome: "pass" | "fail" = Object.values(validation).every(Boolean)
    ? "pass"
    : "fail";

  return {
    taskOutcome:
      scenarioOutcome === "pass"
        ? "memory-layer-behavior-aligned"
        : "memory-layer-behavior-miss",
    scenarioOutcome,
    expected: expectation,
    validation,
  };
}

async function runScenario(
  definition: ScenarioDefinition,
  dbPath: string
): Promise<MemoryEvalScenarioLog> {
  const db = await openSqlJsDatabase(dbPath);

  try {
    const harness = prepareMemoryEvalHarness(db);
    const sessionID = `eval-${definition.id}`;
    harness.adapter.initializeSession({
      sessionID,
      agent: "eval:memory",
      messageID: `msg-${definition.id}`,
      variant: "deterministic-memory-eval",
    });

    let activation: ActivationResult;
    let warnings: PolicyWarning[] = [];

    if (definition.lifecycleTrigger === "session_start") {
      activation = await harness.activationEngine.activate({
        lifecycleTrigger: "session_start",
        scopeRef: definition.scopeRef,
      });
      warnings = harness.policyEngine.evaluate({
        lifecycleTrigger: "session_start",
        scopeRef: definition.scopeRef,
      }).warnings;
    } else if (definition.lifecycleTrigger === "before_model") {
      const beforeModel = await harness.adapter.beforeModel({
        sessionID,
        model: DETERMINISTIC_MODEL,
        scopeRef: definition.scopeRef,
      });
      activation = beforeModel.activation;
      warnings = harness.policyEngine.evaluate({
        lifecycleTrigger: "before_model",
        scopeRef: definition.scopeRef,
      }).warnings;
    } else if (definition.lifecycleTrigger === "before_tool") {
      const tool = definition.tool;

      if (tool === null) {
        throw new Error(`Scenario ${definition.id} requires tool context`);
      }

      const beforeTool = harness.adapter.beforeTool({
        sessionID,
        tool: tool.name,
        callID: tool.callID,
        scopeRef: definition.scopeRef,
      });
      activation = await harness.activationEngine.activate({
        lifecycleTrigger: "before_tool",
        scopeRef: definition.scopeRef,
      });
      warnings = beforeTool.warnings;
    } else {
      const tool = definition.tool;

      if (tool === null) {
        throw new Error(`Scenario ${definition.id} requires tool context`);
      }

      const afterTool = await harness.adapter.afterTool(
        {
          sessionID,
          tool: tool.name,
          callID: tool.callID,
          scopeRef: definition.scopeRef,
          args: tool.args,
        },
        tool.output
      );
      activation = afterTool.activation;
      warnings = harness.policyEngine.evaluate({
        lifecycleTrigger: "after_tool",
        scopeRef: definition.scopeRef,
      }).warnings;
    }

    const activated = activation.activated.map((memory) => ({
      id: memory.id,
      type: memory.type,
      summary: memory.summary,
      status: memory.status,
      rank: memory.rank,
      score: memory.score,
      payloadBytes: memory.payloadBytes,
    }));

    const suppressed = activation.suppressed.map((entry) => ({
      id: entry.memory.id,
      type: entry.memory.type,
      summary: entry.memory.summary,
      status: entry.memory.status,
      kind: entry.kind,
      reason: entry.reason,
    }));

    const conflictMarkers: ConflictMarkerEntry[] = activation.conflicts.map((conflict) => ({
      marker: "CONFLICT",
      kind: conflict.kind,
      reason: conflict.reason,
      rootId: conflict.root.id,
      memoryIds: conflict.memories.map((memory) => memory.id),
    }));

    const staleMarkers: StaleMarkerEntry[] = activation.suppressed
      .filter(
        (entry) =>
          (entry.memory.status === "stale" || entry.memory.status === "superseded") &&
          entry.kind === "status_inactive"
      )
      .map((entry) => ({
        marker: "STALE",
        memoryId: entry.memory.id,
        status: entry.memory.status === "stale" ? "stale" : "superseded",
        reason: entry.reason,
      }));

    const warningLogs = summarizeWarnings(warnings);

    const baseLog: Omit<MemoryEvalScenarioLog, "outcome"> = {
      condition: "md-plus-memory-layer",
      scenarioId: definition.id as MemoryEvalScenarioID,
      corpusScenarioNumber: definition.corpusScenarioNumber,
      title: definition.title,
      taskPrompt: definition.taskPrompt,
      lifecycleTrigger: definition.lifecycleTrigger,
      scopeRef: definition.scopeRef,
      tool:
        definition.tool === null
          ? null
          : {
              name: definition.tool.name,
              callID: definition.tool.callID,
              target: definition.tool.target,
            },
      latency: {
        deterministicMs: estimateDeterministicLatencyMs(
          definition.lifecycleTrigger,
          activation,
          warningLogs.length
        ),
      },
      activated_memory_ids: activated.map((entry) => entry.id),
      suppressed_memory_ids: suppressed.map((entry) => entry.id),
      activated,
      suppressed,
      warning_count: warningLogs.length,
      warnings: warningLogs,
      conflict_markers: conflictMarkers,
      stale_markers: staleMarkers,
    };

    return {
      ...baseLog,
      outcome: validateScenarioLog(baseLog, definition.expectation),
    };
  } finally {
    db.close();
  }
}

function resetOutputDirectory(outputDir: string): void {
  mkdirSync(outputDir, { recursive: true });

  for (const fileName of readdirSync(outputDir)) {
    if (fileName.endsWith(".json")) {
      rmSync(resolve(outputDir, fileName), { force: true });
    }
  }
}

function writeScenarioLogs(
  logs: readonly MemoryEvalScenarioLog[],
  outputDir: string
): string[] {
  const files: string[] = [];
  const outputLabel = outputDir.replaceAll("\\", "/");

  for (const log of logs) {
    const fileName = `${log.scenarioId}.json`;
    const filePath = resolve(outputDir, fileName);
    writeFileSync(filePath, `${JSON.stringify(log, null, 2)}\n`, "utf-8");
    files.push(`${outputLabel}/${fileName}`);
  }

  return files;
}

function buildSummary(
  logs: readonly MemoryEvalScenarioLog[],
  scenarioSelector: MemoryEvalScenarioSelector,
  scenarioFiles: readonly string[],
  outputDir: string
): MemoryEvalSummary {
  const totals = {
    activated: logs.reduce((acc, log) => acc + log.activated.length, 0),
    suppressed: logs.reduce((acc, log) => acc + log.suppressed.length, 0),
    warnings: logs.reduce((acc, log) => acc + log.warning_count, 0),
    conflicts: logs.reduce((acc, log) => acc + log.conflict_markers.length, 0),
    staleMarkers: logs.reduce((acc, log) => acc + log.stale_markers.length, 0),
    deterministicLatencyMs: logs.reduce(
      (acc, log) => acc + log.latency.deterministicMs,
      0
    ),
    averageDeterministicLatencyMs:
      logs.length === 0
        ? 0
        : Number(
            (
              logs.reduce((acc, log) => acc + log.latency.deterministicMs, 0) /
              logs.length
            ).toFixed(2)
          ),
  };

  const passedScenarios = logs.filter(
    (log) => log.outcome.scenarioOutcome === "pass"
  ).length;

  return {
    condition: "md-plus-memory-layer",
    scenarioSelector,
    generatedAt: new Date().toISOString(),
    outputDir: outputDir.replaceAll("\\", "/"),
    scenarioCount: logs.length,
    passedScenarios,
    failedScenarios: logs.length - passedScenarios,
    totals,
    containsStaleOrConflictMarkers: logs.some(
      (log) => log.stale_markers.length > 0 || log.conflict_markers.length > 0
    ),
    scenarioFiles: [...scenarioFiles],
    scenarios: logs.map((log) => ({
      scenarioId: log.scenarioId,
      scenarioOutcome: log.outcome.scenarioOutcome,
      warning_count: log.warning_count,
      activated_memory_ids: log.activated_memory_ids,
      suppressed_memory_ids: log.suppressed_memory_ids,
      conflict_marker_count: log.conflict_markers.length,
      stale_marker_count: log.stale_markers.length,
      deterministic_latency_ms: log.latency.deterministicMs,
    })),
  };
}

function writeSummary(summary: MemoryEvalSummary): void {
  const summaryPath = resolve(summary.outputDir, "summary.json");
  writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf-8");
}

function isScenarioID(value: string): value is MemoryEvalScenarioID {
  return MEMORY_EVAL_SCENARIOS.some((scenario) => scenario.id === value);
}

export function isMemoryEvalScenarioSelector(
  value: string
): value is MemoryEvalScenarioSelector {
  return SCENARIO_SELECTORS.includes(value as (typeof SCENARIO_SELECTORS)[number]) ||
    isScenarioID(value);
}

export async function runMemoryEval(
  scenarioSelector: MemoryEvalScenarioSelector = "all",
  options: MemoryEvalOptions = {}
): Promise<MemoryEvalSummary> {
  const scenarios = selectScenarios(scenarioSelector);
  if (scenarios.length === 0) {
    throw new Error(`No scenarios matched selector: ${scenarioSelector}`);
  }

  const outputDir = resolveEvalOutputDir(options.outputDir);
  const dbPath =
    options.dbPath === undefined
      ? resolve(outputDir, ".memory-eval.tmp.sqlite")
      : resolve(options.dbPath);

  resetOutputDirectory(outputDir);

  const logs: MemoryEvalScenarioLog[] = [];
  for (const scenario of scenarios) {
    const log = await runScenario(scenario, dbPath);
    logs.push(log);
  }

  const scenarioFiles = writeScenarioLogs(logs, outputDir);
  const summary = buildSummary(logs, scenarioSelector, scenarioFiles, outputDir);
  writeSummary(summary);
  return summary;
}
