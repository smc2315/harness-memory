import type { Database as SqlJsDatabase } from "sql.js";
import { afterAll, describe, expect, test } from "vitest";

import { ActivationEngine } from "../../src/activation";
import {
  type EmbeddingService,
  EMBEDDING_DIMENSIONS,
} from "../../src/activation/embeddings";
import type { SignalTag } from "../../src/db/schema/types";
import { MemoryRepository, type CreateMemoryInput } from "../../src/memory";
import { DreamRepository } from "../../src/dream/repository";
import type { CreateDreamEvidenceEventInput } from "../../src/dream/types";
import { DreamWorker } from "../../src/dream/worker";
import { createTestDb } from "../helpers/create-test-db";
import {
  MockEmbeddingService,
  precisionAtK,
  printBenchmarkReport,
  recallAtK,
  reciprocalRank,
} from "./benchmark-helpers";

type WeightedProfile = ReadonlyArray<readonly [number, number]>;

interface StressMemoryDef {
  tag: string;
  topic: string;
  profile: WeightedProfile;
  input: CreateMemoryInput;
}

interface StressQueryDef {
  tag: string;
  text: string;
  relevantTags: string[];
  profile: WeightedProfile;
  expectedTopic?: string;
}

interface StressActivationFixture {
  db: SqlJsDatabase;
  repository: MemoryRepository;
  engine: ActivationEngine;
  idToTag: Map<string, string>;
}

interface TopicConfig {
  topic: string;
  prefix: string;
  profile: WeightedProfile;
  items: ReadonlyArray<{
    summary: string;
    details: string;
  }>;
}

interface DisambiguationQueryDef extends StressQueryDef {
  correctTag: string;
  wrongTag: string;
}

interface NoiseCase {
  label: string;
  kind: "noise" | "signal";
  input: CreateDreamEvidenceEventInput;
}

interface TagEdgeCase {
  label: string;
  excerpt: string;
  args: unknown;
  expectedTags: readonly SignalTag[];
}

interface ScaleTopicConfig {
  topic: string;
  prefix: string;
  label: string;
  profile: WeightedProfile;
  queryProfile: WeightedProfile;
  keywords: readonly string[];
  relevantItems: ReadonlyArray<{
    summary: string;
    details: string;
  }>;
  queries: readonly string[];
}

const MEMORY_TYPE_CYCLE = [
  "policy",
  "workflow",
  "pitfall",
  "architecture_constraint",
  "decision",
] as const;

const CONCEPTS = {
  AUTH: 0,
  DATABASE: 1,
  TESTING: 2,
  DEPLOYMENT: 3,
  UI: 4,
  LOGGING: 5,
  VALIDATION: 6,
  PIPELINE: 7,
  ERROR: 8,
  TOKENS: 9,
  MIGRATION: 10,
  FORMS: 11,
  CACHE: 12,
  SESSIONS: 13,
  COMMIT: 14,
  LINT: 15,
  IMPORTS: 16,
  DYNAMIC: 17,
  USERS: 18,
  ESM: 19,
} as const;

const DIMS_PER_CONCEPT = Math.floor(
  EMBEDDING_DIMENSIONS / Object.keys(CONCEPTS).length,
);

const TOPIC_PROFILES = {
  auth: profile(
    [CONCEPTS.AUTH, 0.35],
    [CONCEPTS.TOKENS, 0.2],
    [CONCEPTS.VALIDATION, 0.25],
    [CONCEPTS.ERROR, 0.2],
  ),
  database: profile(
    [CONCEPTS.DATABASE, 0.35],
    [CONCEPTS.MIGRATION, 0.3],
    [CONCEPTS.PIPELINE, 0.15],
    [CONCEPTS.VALIDATION, 0.2],
  ),
  testing: profile(
    [CONCEPTS.TESTING, 0.35],
    [CONCEPTS.PIPELINE, 0.25],
    [CONCEPTS.ERROR, 0.25],
    [CONCEPTS.VALIDATION, 0.15],
  ),
  deployment: profile(
    [CONCEPTS.DEPLOYMENT, 0.35],
    [CONCEPTS.PIPELINE, 0.25],
    [CONCEPTS.MIGRATION, 0.2],
    [CONCEPTS.ERROR, 0.2],
  ),
  ui: profile(
    [CONCEPTS.UI, 0.35],
    [CONCEPTS.FORMS, 0.2],
    [CONCEPTS.VALIDATION, 0.3],
    [CONCEPTS.ERROR, 0.15],
  ),
  logging: profile(
    [CONCEPTS.LOGGING, 0.35],
    [CONCEPTS.ERROR, 0.35],
    [CONCEPTS.PIPELINE, 0.15],
    [CONCEPTS.AUTH, 0.15],
  ),
} as const;

const QUERY_PROFILES = {
  auth: profile(
    [CONCEPTS.AUTH, 0.3],
    [CONCEPTS.TOKENS, 0.2],
    [CONCEPTS.VALIDATION, 0.25],
    [CONCEPTS.ERROR, 0.25],
  ),
  database: profile(
    [CONCEPTS.DATABASE, 0.3],
    [CONCEPTS.MIGRATION, 0.3],
    [CONCEPTS.PIPELINE, 0.2],
    [CONCEPTS.VALIDATION, 0.2],
  ),
  testing: profile(
    [CONCEPTS.TESTING, 0.35],
    [CONCEPTS.PIPELINE, 0.25],
    [CONCEPTS.ERROR, 0.25],
    [CONCEPTS.VALIDATION, 0.15],
  ),
  deployment: profile(
    [CONCEPTS.DEPLOYMENT, 0.3],
    [CONCEPTS.PIPELINE, 0.3],
    [CONCEPTS.TESTING, 0.2],
    [CONCEPTS.ERROR, 0.2],
  ),
  ui: profile(
    [CONCEPTS.UI, 0.3],
    [CONCEPTS.FORMS, 0.25],
    [CONCEPTS.VALIDATION, 0.25],
    [CONCEPTS.AUTH, 0.2],
  ),
  logging: profile(
    [CONCEPTS.LOGGING, 0.3],
    [CONCEPTS.ERROR, 0.35],
    [CONCEPTS.TESTING, 0.2],
    [CONCEPTS.AUTH, 0.15],
  ),
} as const;

const SIGNAL_PATTERNS: ReadonlyArray<{
  tag: SignalTag;
  pattern: RegExp;
  field: "excerpt" | "args";
}> = [
  {
    tag: "failure_signal",
    pattern: /error|failed|exception|timeout|refused/i,
    field: "excerpt",
  },
  {
    tag: "success_signal",
    pattern: /passed|resolved|fixed|completed|migrated|created|updated/i,
    field: "excerpt",
  },
  {
    tag: "decision_signal",
    pattern: /decided|chose|switched|replaced|deprecated|changed\s.*\sto/i,
    field: "excerpt",
  },
  {
    tag: "convention_signal",
    pattern: /always|never|convention|must|should|standard|rule/i,
    field: "excerpt",
  },
  {
    tag: "architecture_signal",
    pattern: /architecture|boundary|layer|component|module|structure/i,
    field: "excerpt",
  },
  {
    tag: "temporal_cue",
    pattern: /before|after|previously|used to|switched from/i,
    field: "excerpt",
  },
  {
    tag: "explicit_marker",
    pattern: /do not|always use|fixed by|known error/i,
    field: "excerpt",
  },
  { tag: "has_file_context", pattern: /path|file|src\//i, field: "args" },
];

const consolidatedSummary: Record<
  | "falsePositiveRate"
  | "falsePositivePrecision"
  | "signalToNoiseRatio"
  | "noiseRejectionRate"
  | "signalRetentionRate"
  | "disambiguationAccuracy"
  | "tagAccuracy"
  | "scalePrecisionAt5"
  | "scaleRecallAt5"
  | "scaleMrr",
  number | null
> = {
  falsePositiveRate: null,
  falsePositivePrecision: null,
  signalToNoiseRatio: null,
  noiseRejectionRate: null,
  signalRetentionRate: null,
  disambiguationAccuracy: null,
  tagAccuracy: null,
  scalePrecisionAt5: null,
  scaleRecallAt5: null,
  scaleMrr: null,
};

function profile(...entries: Array<readonly [number, number]>): WeightedProfile {
  return entries;
}

function scaleProfile(input: WeightedProfile, factor: number): WeightedProfile {
  return input.map(([concept, weight]) => [concept, weight * factor] as const);
}

function mergeProfiles(
  primary: WeightedProfile,
  secondary: WeightedProfile,
  primaryFactor: number,
  secondaryFactor: number,
): WeightedProfile {
  return [
    ...scaleProfile(primary, primaryFactor),
    ...scaleProfile(secondary, secondaryFactor),
  ];
}

function tokenize(text: string): string[] {
  return text
    .split(/[\s\p{P}]+/u)
    .filter((token) => token.length > 2 || /[\u3131-\u318e\uac00-\ud7a3]/u.test(token));
}

function normalizeQueryText(text: string): string {
  return tokenize(text).join(" ");
}

function ts(offsetMinutes: number): string {
  return new Date(Date.UTC(2026, 3, 1, 0, offsetMinutes, 0)).toISOString();
}

function mean(values: readonly number[]): number {
  if (values.length === 0) {
    return 0;
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function reportValue(value: number | null): number | string {
  return value ?? "n/a";
}

function basisVector(conceptId: number): Float32Array {
  const vec = new Float32Array(EMBEDDING_DIMENSIONS);
  const start = conceptId * DIMS_PER_CONCEPT;

  for (let i = start; i < start + DIMS_PER_CONCEPT; i += 1) {
    vec[i] = 1;
  }

  const norm = Math.sqrt(DIMS_PER_CONCEPT);
  for (let i = 0; i < vec.length; i += 1) {
    vec[i] /= norm;
  }

  return vec;
}

function blendProfile(profileDef: WeightedProfile): Float32Array {
  const blended = new Float32Array(EMBEDDING_DIMENSIONS);

  for (const [concept, weight] of profileDef) {
    const basis = basisVector(concept);
    for (let i = 0; i < basis.length; i += 1) {
      blended[i] += basis[i] * weight;
    }
  }

  let norm = 0;
  for (let i = 0; i < blended.length; i += 1) {
    norm += blended[i] * blended[i];
  }

  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < blended.length; i += 1) {
      blended[i] /= norm;
    }
  }

  return blended;
}

function addNoise(vec: Float32Array, seed: number, magnitude: number = 0.05): Float32Array {
  const noisy = new Float32Array(vec.length);

  for (let i = 0; i < vec.length; i += 1) {
    const hash = Math.sin(seed * 9301 + i * 49297 + 233280) * 0.5 + 0.5;
    noisy[i] = vec[i] + (hash - 0.5) * magnitude;
  }

  let norm = 0;
  for (let i = 0; i < noisy.length; i += 1) {
    norm += noisy[i] * noisy[i];
  }

  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < noisy.length; i += 1) {
      noisy[i] /= norm;
    }
  }

  return noisy;
}

function rankOf(retrieved: readonly string[], tag: string): number {
  const index = retrieved.indexOf(tag);
  return index === -1 ? Number.POSITIVE_INFINITY : index + 1;
}

function pushIndexedValue(index: Map<string, string[]>, key: string, value: string): void {
  const existing = index.get(key);
  if (existing === undefined) {
    index.set(key, [value]);
    return;
  }

  existing.push(value);
}

function getRequiredTags(index: Map<string, string[]>, key: string): string[] {
  const value = index.get(key);
  if (value === undefined) {
    throw new Error(`Missing tag index for ${key}`);
  }

  return [...value];
}

function setsEqual<T>(left: Set<T>, right: Set<T>): boolean {
  if (left.size !== right.size) {
    return false;
  }

  for (const value of left) {
    if (!right.has(value)) {
      return false;
    }
  }

  return true;
}

function extractSignalTagsUsingWorkerPatterns(
  excerpt: string,
  args: unknown,
): SignalTag[] {
  const tags = new Set<SignalTag>();
  const argsText = JSON.stringify(args).toLowerCase();

  for (const { tag, pattern, field } of SIGNAL_PATTERNS) {
    const text = field === "excerpt" ? excerpt : argsText;
    if (pattern.test(text)) {
      tags.add(tag);
    }
  }

  return [...tags].sort();
}

function makeStressMemory(args: {
  tag: string;
  topic: string;
  summary: string;
  details: string;
  profile: WeightedProfile;
  offsetMinutes: number;
  type?: CreateMemoryInput["type"];
  confidence?: number;
  importance?: number;
}): StressMemoryDef {
  return {
    tag: args.tag,
    topic: args.topic,
    profile: args.profile,
    input: {
      type: args.type ?? MEMORY_TYPE_CYCLE[args.offsetMinutes % MEMORY_TYPE_CYCLE.length],
      summary: args.summary,
      details: args.details,
      scopeGlob: "**/*",
      lifecycleTriggers: ["before_model"],
      activationClass: "scoped",
      confidence: args.confidence ?? 0.8,
      importance: args.importance ?? 0.78,
      status: "active",
      createdAt: ts(args.offsetMinutes),
      updatedAt: ts(args.offsetMinutes),
    },
  };
}

function buildEmbeddingLookup(
  memoryDefs: readonly StressMemoryDef[],
  queries: readonly StressQueryDef[],
): Map<string, Float32Array> {
  const lookup = new Map<string, Float32Array>();

  for (let i = 0; i < memoryDefs.length; i += 1) {
    const memory = memoryDefs[i]!;
    const passageText = `passage: ${memory.input.summary} ${memory.input.details}`;
    lookup.set(passageText, addNoise(blendProfile(memory.profile), i, 0.045));
  }

  for (let i = 0; i < queries.length; i += 1) {
    const query = queries[i]!;
    const queryText = `query: ${normalizeQueryText(query.text)}`;
    lookup.set(queryText, addNoise(blendProfile(query.profile), 1_000 + i, 0.045));
  }

  return lookup;
}

async function createActivationFixture(
  memoryDefs: readonly StressMemoryDef[],
  queries: readonly StressQueryDef[],
): Promise<StressActivationFixture> {
  const db = await createTestDb();
  const repository = new MemoryRepository(db);
  const mockEmbedding = new MockEmbeddingService(buildEmbeddingLookup(memoryDefs, queries));
  const engine = new ActivationEngine(
    repository,
    mockEmbedding as unknown as EmbeddingService,
  );
  const idToTag = new Map<string, string>();

  for (const def of memoryDefs) {
    const memory = repository.create(def.input);
    idToTag.set(memory.id, def.tag);
    const embedding = await mockEmbedding.embedPassage(
      `${def.input.summary} ${def.input.details}`,
    );
    repository.updateEmbedding(memory.id, embedding);
  }

  return { db, repository, engine, idToTag };
}

async function activateQuery(
  fixture: StressActivationFixture,
  query: StressQueryDef,
  maxMemories: number = 5,
): Promise<string[]> {
  const result = await fixture.engine.activate({
    lifecycleTrigger: "before_model",
    scopeRef: ".",
    queryTokens: tokenize(query.text),
    maxMemories,
    maxPayloadBytes: 65_536,
  });

  return result.activated.map((memory) => fixture.idToTag.get(memory.id) ?? memory.id);
}

const FALSE_POSITIVE_TOPICS: readonly TopicConfig[] = [
  {
    topic: "auth",
    prefix: "AUTH",
    profile: TOPIC_PROFILES.auth,
    items: [
      {
        summary: "JWT refresh token rotation",
        details:
          "Refresh token family validation happens in auth middleware before issuing a new access token.",
      },
      {
        summary: "Token validation gateway rules",
        details:
          "Validate JWT claims, refresh windows, and session revocation before auth succeeds.",
      },
      {
        summary: "Auth retry error handling",
        details:
          "Auth service logs token refresh failures and validation mismatches as 401 responses.",
      },
      {
        summary: "Session refresh endpoint",
        details:
          "The auth refresh endpoint exchanges short lived tokens and validates device session state.",
      },
      {
        summary: "OAuth callback rules",
        details:
          "Login callback validation signs tokens after auth completes and the refresh cookie is set.",
      },
    ],
  },
  {
    topic: "database",
    prefix: "DB",
    profile: TOPIC_PROFILES.database,
    items: [
      {
        summary: "Database migration strategy",
        details:
          "Schema migration pipeline runs forward only SQL migrations with rollback notes for each release.",
      },
      {
        summary: "Migration rollback checklist",
        details:
          "Database migrations validate schema drift before applying release steps and rollback markers.",
      },
      {
        summary: "Validation migration pipeline",
        details:
          "Each database change flows through a migration pipeline and validation review before merge.",
      },
      {
        summary: "Seed data after migrations",
        details:
          "Database bootstrap applies migration history before inserting reference data into staging.",
      },
      {
        summary: "Deploy migration dry run",
        details:
          "Run database migration validation against staging before deploy and before rollback tests.",
      },
    ],
  },
  {
    topic: "testing",
    prefix: "TEST",
    profile: TOPIC_PROFILES.testing,
    items: [
      {
        summary: "Integration token validation tests",
        details:
          "Integration tests validate auth token refresh behavior with seeded fixtures and error snapshots.",
      },
      {
        summary: "Error logging assertions",
        details:
          "Testing pipeline checks 401 error logging, validation failures, and integration traces.",
      },
      {
        summary: "CI pipeline integration tests",
        details:
          "Run integration tests against disposable services in the test pipeline before merge.",
      },
      {
        summary: "Migration smoke test suite",
        details:
          "Testing gate runs validation and smoke checks before commit and before CI merge.",
      },
      {
        summary: "Failure triage in integration tests",
        details:
          "Capture error snapshots, flaky test diagnostics, and pipeline traces for review.",
      },
    ],
  },
  {
    topic: "deployment",
    prefix: "DEP",
    profile: TOPIC_PROFILES.deployment,
    items: [
      {
        summary: "Migration pipeline stages",
        details:
          "Deployment pipeline builds, migrates, validates, and releases the main branch through CI CD stages.",
      },
      {
        summary: "CI rollback strategy",
        details:
          "Deployment rollback runs after failed migrations or failed health validation checks.",
      },
      {
        summary: "CI pipeline validation checklist",
        details:
          "CI pipeline validates environment secrets before deploy and before traffic shift.",
      },
      {
        summary: "Integration deploy gate",
        details:
          "Deployment pipeline includes integration checks and a database migration job before traffic cutover.",
      },
      {
        summary: "Post deploy error logs",
        details:
          "Deployment logs validation failures and rollback triggers after release.",
      },
    ],
  },
  {
    topic: "ui",
    prefix: "UI",
    profile: TOPIC_PROFILES.ui,
    items: [
      {
        summary: "Form token validation rules",
        details:
          "Signup form validation checks token like invite codes and required inputs before submit.",
      },
      {
        summary: "Inline error validation states",
        details:
          "UI validation shows field level errors before submit and before auth retry.",
      },
      {
        summary: "Auth form token handling",
        details:
          "Login form validation masks token fields and resets the error state on change.",
      },
      {
        summary: "Client validation schema",
        details:
          "Shared UI validation schema powers onboarding and settings forms with accessible feedback.",
      },
      {
        summary: "Accessible error feedback",
        details:
          "Form validation announces errors and success states to assistive technology.",
      },
    ],
  },
  {
    topic: "logging",
    prefix: "LOG",
    profile: TOPIC_PROFILES.logging,
    items: [
      {
        summary: "Error logging pipeline",
        details:
          "Log application errors through the central logger with request ids and trace metadata.",
      },
      {
        summary: "Token refresh audit logs",
        details:
          "Token refresh errors and auth denials are written to structured logs for review.",
      },
      {
        summary: "Database migration logs",
        details:
          "Database failures and migration output emit error logs with query metadata and timing context.",
      },
      {
        summary: "CI error log routing",
        details:
          "Testing and deployment error logs are collected in the same pipeline sink.",
      },
      {
        summary: "Validation error telemetry",
        details:
          "Client side validation errors are sampled before they hit alerting.",
      },
    ],
  },
];

function buildFalsePositiveMemories(): StressMemoryDef[] {
  let offset = 0;
  const memories: StressMemoryDef[] = [];

  for (const config of FALSE_POSITIVE_TOPICS) {
    config.items.forEach((item, index) => {
      memories.push(
        makeStressMemory({
          tag: `${config.prefix}-${index + 1}`,
          topic: config.topic,
          summary: item.summary,
          details: item.details,
          profile: config.profile,
          offsetMinutes: offset,
          type: MEMORY_TYPE_CYCLE[index],
          confidence: 0.78 + (index % 3) * 0.03,
          importance: 0.76 + ((index + 1) % 3) * 0.03,
        }),
      );
      offset += 1;
    });
  }

  return memories;
}

function buildFalsePositiveQueries(
  topicIndex: Map<string, string[]>,
): StressQueryDef[] {
  return [
    {
      tag: "FP-Q1",
      text: "how do we handle JWT token refresh?",
      expectedTopic: "auth",
      relevantTags: getRequiredTags(topicIndex, "auth"),
      profile: QUERY_PROFILES.auth,
    },
    {
      tag: "FP-Q2",
      text: "what's our database migration strategy?",
      expectedTopic: "database",
      relevantTags: getRequiredTags(topicIndex, "database"),
      profile: QUERY_PROFILES.database,
    },
    {
      tag: "FP-Q3",
      text: "how do we run integration tests?",
      expectedTopic: "testing",
      relevantTags: getRequiredTags(topicIndex, "testing"),
      profile: QUERY_PROFILES.testing,
    },
    {
      tag: "FP-Q4",
      text: "what's our CI/CD pipeline?",
      expectedTopic: "deployment",
      relevantTags: getRequiredTags(topicIndex, "deployment"),
      profile: QUERY_PROFILES.deployment,
    },
    {
      tag: "FP-Q5",
      text: "how do we handle form validation?",
      expectedTopic: "ui",
      relevantTags: getRequiredTags(topicIndex, "ui"),
      profile: QUERY_PROFILES.ui,
    },
    {
      tag: "FP-Q6",
      text: "where do we log errors?",
      expectedTopic: "logging",
      relevantTags: getRequiredTags(topicIndex, "logging"),
      profile: QUERY_PROFILES.logging,
    },
  ];
}

function buildDisambiguationMemories(): StressMemoryDef[] {
  return [
    makeStressMemory({
      tag: "PAIR-DB-POSTGRES",
      topic: "database.postgres",
      summary: "Use PostgreSQL for user data",
      details:
        "Primary user records live in PostgreSQL tables and should not move into the session cache.",
      profile: profile([CONCEPTS.DATABASE, 0.4], [CONCEPTS.USERS, 0.35], [CONCEPTS.AUTH, 0.25]),
      offsetMinutes: 200,
      confidence: 0.8,
      importance: 0.79,
    }),
    makeStressMemory({
      tag: "PAIR-DB-REDIS",
      topic: "database.redis",
      summary: "Use Redis for session cache",
      details:
        "Session cache and token nonce storage live in Redis for fast expiry and refresh lookups.",
      profile: profile([CONCEPTS.DATABASE, 0.25], [CONCEPTS.SESSIONS, 0.35], [CONCEPTS.CACHE, 0.4]),
      offsetMinutes: 201,
      confidence: 0.88,
      importance: 0.88,
    }),
    makeStressMemory({
      tag: "PAIR-VALIDATE-JWT",
      topic: "validation.jwt",
      summary: "Always validate JWT tokens",
      details: "Middleware validates bearer tokens, expiry, issuer, and audience claims.",
      profile: profile([CONCEPTS.AUTH, 0.35], [CONCEPTS.TOKENS, 0.3], [CONCEPTS.VALIDATION, 0.35]),
      offsetMinutes: 202,
      confidence: 0.79,
      importance: 0.78,
    }),
    makeStressMemory({
      tag: "PAIR-VALIDATE-FORM",
      topic: "validation.form",
      summary: "Always validate form inputs",
      details: "Client forms validate required fields, email shape, and input length before submit.",
      profile: profile([CONCEPTS.UI, 0.3], [CONCEPTS.FORMS, 0.3], [CONCEPTS.VALIDATION, 0.4]),
      offsetMinutes: 203,
      confidence: 0.89,
      importance: 0.87,
    }),
    makeStressMemory({
      tag: "PAIR-COMMIT-TEST",
      topic: "workflow.tests",
      summary: "Run tests before commit",
      details: "Run the integration suite and unit suite before every commit.",
      profile: profile([CONCEPTS.TESTING, 0.45], [CONCEPTS.COMMIT, 0.35], [CONCEPTS.PIPELINE, 0.2]),
      offsetMinutes: 204,
      confidence: 0.77,
      importance: 0.76,
    }),
    makeStressMemory({
      tag: "PAIR-COMMIT-LINT",
      topic: "workflow.lint",
      summary: "Run linter before commit",
      details: "Run style and lint checks before every commit to keep diffs clean.",
      profile: profile([CONCEPTS.LINT, 0.45], [CONCEPTS.COMMIT, 0.35], [CONCEPTS.VALIDATION, 0.2]),
      offsetMinutes: 205,
      confidence: 0.92,
      importance: 0.9,
    }),
    makeStressMemory({
      tag: "PAIR-IMPORT-ESM",
      topic: "imports.esm",
      summary: "Use ESM imports",
      details: "Prefer static ESM imports for server modules and shared runtime code.",
      profile: profile([CONCEPTS.ESM, 0.4], [CONCEPTS.IMPORTS, 0.4], [CONCEPTS.DEPLOYMENT, 0.2]),
      offsetMinutes: 206,
      confidence: 0.76,
      importance: 0.75,
    }),
    makeStressMemory({
      tag: "PAIR-IMPORT-DYNAMIC",
      topic: "imports.dynamic",
      summary: "Use dynamic imports for code splitting",
      details: "Load heavy client bundles with dynamic imports when the route needs code splitting.",
      profile: profile([CONCEPTS.DYNAMIC, 0.45], [CONCEPTS.IMPORTS, 0.35], [CONCEPTS.UI, 0.2]),
      offsetMinutes: 207,
      confidence: 0.91,
      importance: 0.89,
    }),
  ];
}

function buildDisambiguationQueries(): DisambiguationQueryDef[] {
  return [
    {
      tag: "DIS-Q1",
      text: "what do we use for persistent user data?",
      relevantTags: ["PAIR-DB-POSTGRES"],
      correctTag: "PAIR-DB-POSTGRES",
      wrongTag: "PAIR-DB-REDIS",
      profile: profile([CONCEPTS.DATABASE, 0.35], [CONCEPTS.USERS, 0.45], [CONCEPTS.AUTH, 0.2]),
    },
    {
      tag: "DIS-Q2",
      text: "what do we use for the session cache?",
      relevantTags: ["PAIR-DB-REDIS"],
      correctTag: "PAIR-DB-REDIS",
      wrongTag: "PAIR-DB-POSTGRES",
      profile: profile([CONCEPTS.DATABASE, 0.25], [CONCEPTS.SESSIONS, 0.4], [CONCEPTS.CACHE, 0.35]),
    },
    {
      tag: "DIS-Q3",
      text: "should middleware validate JWT tokens?",
      relevantTags: ["PAIR-VALIDATE-JWT"],
      correctTag: "PAIR-VALIDATE-JWT",
      wrongTag: "PAIR-VALIDATE-FORM",
      profile: profile([CONCEPTS.AUTH, 0.35], [CONCEPTS.TOKENS, 0.3], [CONCEPTS.VALIDATION, 0.35]),
    },
    {
      tag: "DIS-Q4",
      text: "how do we validate signup forms?",
      relevantTags: ["PAIR-VALIDATE-FORM"],
      correctTag: "PAIR-VALIDATE-FORM",
      wrongTag: "PAIR-VALIDATE-JWT",
      profile: profile([CONCEPTS.UI, 0.3], [CONCEPTS.FORMS, 0.35], [CONCEPTS.VALIDATION, 0.35]),
    },
    {
      tag: "DIS-Q5",
      text: "what must run before commit for test coverage?",
      relevantTags: ["PAIR-COMMIT-TEST"],
      correctTag: "PAIR-COMMIT-TEST",
      wrongTag: "PAIR-COMMIT-LINT",
      profile: profile([CONCEPTS.TESTING, 0.4], [CONCEPTS.COMMIT, 0.4], [CONCEPTS.PIPELINE, 0.2]),
    },
    {
      tag: "DIS-Q6",
      text: "what must run before commit for style checks?",
      relevantTags: ["PAIR-COMMIT-LINT"],
      correctTag: "PAIR-COMMIT-LINT",
      wrongTag: "PAIR-COMMIT-TEST",
      profile: profile([CONCEPTS.LINT, 0.45], [CONCEPTS.COMMIT, 0.4], [CONCEPTS.VALIDATION, 0.15]),
    },
    {
      tag: "DIS-Q7",
      text: "which import style do we use in ESM modules?",
      relevantTags: ["PAIR-IMPORT-ESM"],
      correctTag: "PAIR-IMPORT-ESM",
      wrongTag: "PAIR-IMPORT-DYNAMIC",
      profile: profile([CONCEPTS.ESM, 0.45], [CONCEPTS.IMPORTS, 0.4], [CONCEPTS.DEPLOYMENT, 0.15]),
    },
    {
      tag: "DIS-Q8",
      text: "when do we use imports for code splitting?",
      relevantTags: ["PAIR-IMPORT-DYNAMIC"],
      correctTag: "PAIR-IMPORT-DYNAMIC",
      wrongTag: "PAIR-IMPORT-ESM",
      profile: profile([CONCEPTS.DYNAMIC, 0.45], [CONCEPTS.IMPORTS, 0.35], [CONCEPTS.UI, 0.2]),
    },
  ];
}

function buildNoiseAndSignalCases(): readonly NoiseCase[] {
  return [
    {
      label: "500-line stack trace",
      kind: "noise",
      input: {
        sessionId: "stress-noise-1",
        callId: "call-1",
        toolName: "bash",
        scopeRef: "src/runtime/worker.ts",
        sourceRef: "bash:node",
        title: "node stack trace",
        excerpt:
          "TypeError: Cannot read properties of undefined\n    at render\n    at execute\n    at pipeline\n    at runtime\n    repeated frame x500",
        args: { command: "node scripts/run.js", stderrLines: 500 },
        topicGuess: "runtime-errors",
        typeGuess: "pitfall",
        salience: 0.32,
        novelty: 0.1,
        createdAt: ts(300),
      },
    },
    {
      label: "minified CSS diff",
      kind: "noise",
      input: {
        sessionId: "stress-noise-2",
        callId: "call-2",
        toolName: "git",
        scopeRef: "web/styles/app.css",
        sourceRef: "git:diff",
        title: "css diff",
        excerpt:
          ".btn{margin:0;padding:0}.card{display:grid}.x{color:red}.y{color:blue}.z{display:flex} repeated x200",
        args: { lines: 200, format: "minified-css" },
        topicGuess: "styling-noise",
        typeGuess: "workflow",
        salience: 0.12,
        novelty: 0.05,
        createdAt: ts(301),
      },
    },
    {
      label: "npm install output",
      kind: "noise",
      input: {
        sessionId: "stress-noise-3",
        callId: "call-3",
        toolName: "bash",
        scopeRef: "package.json",
        sourceRef: "npm:install",
        title: "dependency install",
        excerpt: "added 50 packages, audited 51 packages in 3s, 0 vulnerabilities",
        args: { packageCount: 50, command: "npm install" },
        topicGuess: "dependency-noise",
        typeGuess: "workflow",
        salience: 0.18,
        novelty: 0.06,
        createdAt: ts(302),
      },
    },
    {
      label: "repeated build warning",
      kind: "noise",
      input: {
        sessionId: "stress-noise-4",
        callId: "call-4",
        toolName: "bash",
        scopeRef: "src/build/index.ts",
        sourceRef: "vite:build",
        title: "build warnings",
        excerpt:
          "warning: unused variable x\nwarning: unused variable x\nwarning: unused variable x\nrepeated x20",
        args: { warningCount: 20 },
        topicGuess: "build-noise",
        typeGuess: "workflow",
        salience: 0.16,
        novelty: 0.05,
        createdAt: ts(303),
      },
    },
    {
      label: "whitespace-only formatting edit",
      kind: "noise",
      input: {
        sessionId: "stress-noise-5",
        callId: "call-5",
        toolName: "edit",
        scopeRef: "src/ui/form.tsx",
        sourceRef: "edit:format",
        title: "format pass",
        excerpt: "prettier normalized indentation and line wrapping with no semantic changes",
        args: { path: "src/ui/form.tsx", changeKind: "whitespace-only" },
        topicGuess: "format-noise",
        typeGuess: "workflow",
        salience: 0.14,
        novelty: 0.04,
        createdAt: ts(304),
      },
    },
    {
      label: "architecture decision hidden in noise",
      kind: "signal",
      input: {
        sessionId: "stress-signal-1",
        callId: "call-6",
        toolName: "bash",
        scopeRef: "src/architecture/router.ts",
        sourceRef: "build:report",
        title: "mixed architecture log",
        excerpt:
          "notice: cleaning temp files\nnotice: bundling assets\nmodule boundary stays between adapters and services so auth checks live at the router edge\nnotice: cache warmed",
        args: { lines: 10, source: "build-log" },
        topicGuess: "router-boundary",
        typeGuess: "architecture_constraint",
        salience: 0.74,
        novelty: 0.52,
        createdAt: ts(305),
      },
    },
    {
      label: "explicit workflow rule",
      kind: "signal",
      input: {
        sessionId: "stress-signal-2",
        callId: "call-7",
        toolName: "bash",
        scopeRef: "ops/deploy/runbook.md",
        sourceRef: "bash:deploy",
        title: "deploy reminder",
        excerpt: "Always run migration smoke tests before deploy.",
        args: { command: "npm run smoke:migrations" },
        topicGuess: "deploy-smoke-tests",
        typeGuess: "workflow",
        salience: 0.81,
        novelty: 0.61,
        createdAt: ts(306),
      },
    },
    {
      label: "subtle repository wrapper note",
      kind: "signal",
      input: {
        sessionId: "stress-signal-3",
        callId: "call-8",
        toolName: "edit",
        scopeRef: "src/db/service.ts",
        sourceRef: "edit:note",
        title: "service write flow",
        excerpt: "Route writes through RepositoryWrapper to keep SQL out of handlers.",
        args: { note: "adapter cleanup" },
        topicGuess: "repository-wrapper",
        typeGuess: "architecture_constraint",
        salience: 0.79,
        novelty: 0.57,
        createdAt: ts(307),
      },
    },
    {
      label: "cache choice decision",
      kind: "signal",
      input: {
        sessionId: "stress-signal-4",
        callId: "call-9",
        toolName: "bash",
        scopeRef: "src/session/cache.ts",
        sourceRef: "bash:notes",
        title: "cache decision",
        excerpt: "We chose Redis for session cache after latency regressions.",
        args: { candidate: "redis" },
        topicGuess: "session-cache",
        typeGuess: "decision",
        salience: 0.83,
        novelty: 0.63,
        createdAt: ts(308),
      },
    },
  ];
}

const TAG_EDGE_CASES: readonly TagEdgeCase[] = [
  {
    label: "negated error",
    excerpt: "The error was not actually an error",
    args: {},
    expectedTags: [],
  },
  {
    label: "undecided decision",
    excerpt: "We decided not to decide yet",
    args: {},
    expectedTags: [],
  },
  {
    label: "temporal convention",
    excerpt: "Previously we never used this pattern",
    args: {},
    expectedTags: ["convention_signal", "temporal_cue"],
  },
  {
    label: "path shaped text in args",
    excerpt: "Nothing to see here",
    args: { note: "This file path/to/something has nothing to do with files" },
    expectedTags: [],
  },
];

const SCALE_TOPIC_CONFIGS: readonly ScaleTopicConfig[] = [
  {
    topic: "auth",
    prefix: "S-AUTH",
    label: "Auth",
    profile: TOPIC_PROFILES.auth,
    queryProfile: QUERY_PROFILES.auth,
    keywords: ["jwt", "token", "refresh", "validation", "auth"],
    relevantItems: [
      {
        summary: "JWT refresh token rotation",
        details: "Rotate refresh tokens and revoke the old family when auth succeeds.",
      },
      {
        summary: "Refresh endpoint session validation",
        details: "Refresh flow validates session state before issuing a new access token.",
      },
    ],
    queries: [
      "how do we handle JWT token refresh?",
      "what is our refresh token rotation flow?",
    ],
  },
  {
    topic: "database",
    prefix: "S-DB",
    label: "Database",
    profile: TOPIC_PROFILES.database,
    queryProfile: QUERY_PROFILES.database,
    keywords: ["database", "migration", "strategy", "pipeline", "schema"],
    relevantItems: [
      {
        summary: "Database migration strategy",
        details: "Use forward only schema migrations with validation in staging.",
      },
      {
        summary: "Rollback notes for migrations",
        details: "Every database migration keeps rollback notes beside the release plan.",
      },
    ],
    queries: [
      "what's our database migration strategy?",
      "how do we plan schema migration rollouts?",
    ],
  },
  {
    topic: "testing",
    prefix: "S-TEST",
    label: "Testing",
    profile: TOPIC_PROFILES.testing,
    queryProfile: QUERY_PROFILES.testing,
    keywords: ["integration", "tests", "pipeline", "error", "validation"],
    relevantItems: [
      {
        summary: "Integration test harness",
        details: "Run integration tests against seeded services and capture error snapshots.",
      },
      {
        summary: "Pre merge test suite",
        details: "Testing pipeline runs integration suites before merge and before release.",
      },
    ],
    queries: [
      "how do we run integration tests?",
      "what is the pre merge testing flow?",
    ],
  },
  {
    topic: "deployment",
    prefix: "S-DEP",
    label: "Deployment",
    profile: TOPIC_PROFILES.deployment,
    queryProfile: QUERY_PROFILES.deployment,
    keywords: ["ci", "cd", "pipeline", "deploy", "rollback"],
    relevantItems: [
      {
        summary: "CI CD pipeline stages",
        details: "Build, validate, migrate, and deploy the main branch through staged environments.",
      },
      {
        summary: "Release rollback checks",
        details: "Deployment rollback triggers after failed health checks or failed migrations.",
      },
    ],
    queries: [
      "what's our CI/CD pipeline?",
      "how do we handle deployment rollback?",
    ],
  },
  {
    topic: "ui",
    prefix: "S-UI",
    label: "UI",
    profile: TOPIC_PROFILES.ui,
    queryProfile: QUERY_PROFILES.ui,
    keywords: ["form", "validation", "input", "error", "client"],
    relevantItems: [
      {
        summary: "Form validation schema",
        details: "Shared UI validation schema powers signup, settings, and invite flows.",
      },
      {
        summary: "Client side validation errors",
        details: "Form errors show inline before submit and reset as users edit inputs.",
      },
    ],
    queries: [
      "how do we handle form validation?",
      "how are client input errors shown in the UI?",
    ],
  },
];

function buildScaleDataset(): {
  memories: StressMemoryDef[];
  queries: StressQueryDef[];
} {
  let offset = 400;
  const memories: StressMemoryDef[] = [];
  const relevantTagsByTopic = new Map<string, string[]>();

  SCALE_TOPIC_CONFIGS.forEach((config) => {
    config.relevantItems.forEach((item, index) => {
      const tag = `${config.prefix}-R${index + 1}`;
      memories.push(
        makeStressMemory({
          tag,
          topic: config.topic,
          summary: item.summary,
          details: item.details,
          profile: config.profile,
          offsetMinutes: offset,
          type: MEMORY_TYPE_CYCLE[index],
          confidence: 0.79 + index * 0.02,
          importance: 0.77 + index * 0.02,
        }),
      );
      pushIndexedValue(relevantTagsByTopic, config.topic, tag);
      offset += 1;
    });
  });

  SCALE_TOPIC_CONFIGS.forEach((targetConfig, targetIndex) => {
    for (let confuserIndex = 0; confuserIndex < 8; confuserIndex += 1) {
      const sourceConfig =
        SCALE_TOPIC_CONFIGS[(targetIndex + confuserIndex + 1) % SCALE_TOPIC_CONFIGS.length]!;
      const sharedKeywords = [
        targetConfig.keywords[confuserIndex % targetConfig.keywords.length]!,
        targetConfig.keywords[(confuserIndex + 1) % targetConfig.keywords.length]!,
        targetConfig.keywords[(confuserIndex + 2) % targetConfig.keywords.length]!,
      ];

      memories.push(
        makeStressMemory({
          tag: `${targetConfig.prefix}-C${confuserIndex + 1}`,
          topic: `${sourceConfig.topic}.confuser`,
          summary: `${sourceConfig.label} ${sharedKeywords[0]} guide ${confuserIndex + 1}`,
          details:
            `This ${sourceConfig.label.toLowerCase()} note mentions ${sharedKeywords.join(", ")} ` +
            `but mainly covers ${sourceConfig.keywords[0]}, ${sourceConfig.keywords[1]}, and ${sourceConfig.keywords[2]}.`,
          profile: mergeProfiles(sourceConfig.profile, targetConfig.queryProfile, 0.7, 0.3),
          offsetMinutes: offset,
          type: MEMORY_TYPE_CYCLE[(confuserIndex + 2) % MEMORY_TYPE_CYCLE.length],
          confidence: 0.82 + (confuserIndex % 3) * 0.03,
          importance: 0.81 + ((confuserIndex + 1) % 3) * 0.03,
        }),
      );
      offset += 1;
    }
  });

  const queries: StressQueryDef[] = [];
  SCALE_TOPIC_CONFIGS.forEach((config, index) => {
    const relevantTags = getRequiredTags(relevantTagsByTopic, config.topic);
    config.queries.forEach((text, queryIndex) => {
      queries.push({
        tag: `SCALE-Q${index + 1}-${queryIndex + 1}`,
        text,
        relevantTags,
        profile: config.queryProfile,
        expectedTopic: config.topic,
      });
    });
  });

  return { memories, queries };
}

describe("HM-StressBench", () => {
  test("Section 1: False Positive Detection (오탐 테스트)", async () => {
    const memories = buildFalsePositiveMemories();
    const topicIndex = new Map<string, string[]>();

    for (const memory of memories) {
      pushIndexedValue(topicIndex, memory.topic, memory.tag);
    }

    const queries = buildFalsePositiveQueries(topicIndex);
    const fixture = await createActivationFixture(memories, queries);

    try {
      const falsePositiveRates: number[] = [];
      const precisionScores: number[] = [];
      const hitRates: number[] = [];

      for (const query of queries) {
        const retrieved = await activateQuery(fixture, query, 10);
        const topFive = retrieved.slice(0, 5);
        const relevant = new Set(query.relevantTags);
        const relevantHits = retrieved.filter((tag) => relevant.has(tag)).length;
        const irrelevantTopFive = topFive.filter((tag) => !relevant.has(tag)).length;

        falsePositiveRates.push(
          retrieved.length === 0 ? 0 : irrelevantTopFive / retrieved.length,
        );
        precisionScores.push(
          retrieved.length === 0 ? 0 : relevantHits / retrieved.length,
        );
        hitRates.push(relevantHits > 0 ? 1 : 0);
      }

      const meanFalsePositiveRate = mean(falsePositiveRates);
      const meanPrecision = mean(precisionScores);
      const topicHitRate = mean(hitRates);

      consolidatedSummary.falsePositiveRate = meanFalsePositiveRate;
      consolidatedSummary.falsePositivePrecision = meanPrecision;

      printBenchmarkReport("HM-StressBench False Positives", {
        "Memory Count": memories.length,
        "Query Count": queries.length,
        "False Positive Rate": meanFalsePositiveRate,
        "Precision per topic": meanPrecision,
        "Topic hit rate": topicHitRate,
      });

      expect(meanFalsePositiveRate).toBeLessThan(0.8);
      expect(meanPrecision).toBeGreaterThanOrEqual(0.2);
      expect(topicHitRate).toBeGreaterThanOrEqual(0.5);
    } finally {
      fixture.db.close();
    }
  });

  test("Section 2: Noisy Evidence Pipeline (지저분한 evidence)", async () => {
    const db = await createTestDb();
    const memoryRepository = new MemoryRepository(db);
    const dreamRepository = new DreamRepository(db);
    const worker = new DreamWorker(dreamRepository, memoryRepository);
    const cases = buildNoiseAndSignalCases();

    try {
      const noiseIds = new Set<string>();
      const signalIds = new Set<string>();

      for (const item of cases) {
        const event = dreamRepository.createEvidenceEvent(item.input);
        if (item.kind === "noise") {
          noiseIds.add(event.id);
        } else {
          signalIds.add(event.id);
        }
      }

      const result = worker.run({
        trigger: "manual",
        createdAfter: ts(299),
        now: ts(360),
      });

      const latentOrDiscarded = new Set([
        ...result.latentEvidenceIds,
        ...result.discardedEvidenceIds,
      ]);
      const materialized = new Set(result.materializedEvidenceIds);

      const meaningfulSuggestions = result.suggestions.filter((suggestion) =>
        suggestion.evidenceEventIds.some((id) => signalIds.has(id)),
      ).length;
      const noisyRejected = [...noiseIds].filter((id) => latentOrDiscarded.has(id)).length;
      const meaningfulMaterialized = [...signalIds].filter((id) => materialized.has(id)).length;

      const signalToNoiseRatio = meaningfulSuggestions / cases.length;
      const noiseRejectionRate = noisyRejected / noiseIds.size;
      const signalRetentionRate = meaningfulMaterialized / signalIds.size;

      consolidatedSummary.signalToNoiseRatio = signalToNoiseRatio;
      consolidatedSummary.noiseRejectionRate = noiseRejectionRate;
      consolidatedSummary.signalRetentionRate = signalRetentionRate;

      printBenchmarkReport("HM-StressBench Noisy Evidence", {
        "Evidence events": cases.length,
        "Meaningful candidates created": meaningfulSuggestions,
        "Signal to Noise Ratio": signalToNoiseRatio,
        "Noise Rejection Rate": noiseRejectionRate,
        "Signal Retention Rate": signalRetentionRate,
      });

      expect(signalToNoiseRatio).toBeGreaterThanOrEqual(0.2);
      expect(noiseRejectionRate).toBeGreaterThanOrEqual(0.2);
      expect(signalRetentionRate).toBeGreaterThanOrEqual(0.5);
    } finally {
      db.close();
    }
  });

  test("Section 3: Confuser Memory Pool (혼동 테스트)", async () => {
    const memories = buildDisambiguationMemories();
    const queries = buildDisambiguationQueries();
    const fixture = await createActivationFixture(memories, queries);

    try {
      const wins: number[] = [];
      const reciprocalMargins: number[] = [];

      for (const query of queries) {
        const retrieved = await activateQuery(fixture, query, 4);
        const correctRank = rankOf(retrieved, query.correctTag);
        const wrongRank = rankOf(retrieved, query.wrongTag);
        const correctWins = correctRank < wrongRank ? 1 : 0;

        wins.push(correctWins);
        reciprocalMargins.push(
          Number.isFinite(correctRank) ? 1 / correctRank : 0,
        );
      }

      const disambiguationAccuracy = mean(wins);
      const meanReciprocalRank = mean(reciprocalMargins);

      consolidatedSummary.disambiguationAccuracy = disambiguationAccuracy;

      printBenchmarkReport("HM-StressBench Confusers", {
        "Memory Count": memories.length,
        "Query Count": queries.length,
        "Disambiguation Accuracy": disambiguationAccuracy,
        "Correct Memory MRR": meanReciprocalRank,
      });

      expect(disambiguationAccuracy).toBeGreaterThanOrEqual(0.35);
      expect(meanReciprocalRank).toBeGreaterThanOrEqual(0.25);
    } finally {
      fixture.db.close();
    }
  });

  test("Section 4: Signal Tag Edge Cases", () => {
    let truePositive = 0;
    let falsePositive = 0;
    let falseNegative = 0;
    let exactMatches = 0;

    for (const edgeCase of TAG_EDGE_CASES) {
      const actualTags = new Set(
        extractSignalTagsUsingWorkerPatterns(edgeCase.excerpt, edgeCase.args),
      );
      const expectedTags = new Set(edgeCase.expectedTags);

      if (setsEqual(actualTags, expectedTags)) {
        exactMatches += 1;
      }

      for (const tag of actualTags) {
        if (expectedTags.has(tag)) {
          truePositive += 1;
        } else {
          falsePositive += 1;
        }
      }

      for (const tag of expectedTags) {
        if (!actualTags.has(tag)) {
          falseNegative += 1;
        }
      }
    }

    const denominator = 2 * truePositive + falsePositive + falseNegative;
    const tagAccuracy = denominator === 0 ? 1 : (2 * truePositive) / denominator;
    const exactMatchRate = exactMatches / TAG_EDGE_CASES.length;

    consolidatedSummary.tagAccuracy = tagAccuracy;

    printBenchmarkReport("HM-StressBench Signal Tags", {
      "Case Count": TAG_EDGE_CASES.length,
      "Tag Accuracy": tagAccuracy,
      "Exact Match Rate": exactMatchRate,
      "False Positive Tags": falsePositive,
    });

    expect(tagAccuracy).toBeGreaterThanOrEqual(0.4);
    expect(exactMatchRate).toBeGreaterThanOrEqual(0.2);
  });

  test("Section 5: Scale Stress with Confusers", async () => {
    const { memories, queries } = buildScaleDataset();
    const fixture = await createActivationFixture(memories, queries);

    try {
      const results: Array<{ retrieved: string[]; relevant: Set<string> }> = [];

      for (const query of queries) {
        const retrieved = await activateQuery(fixture, query, 5);
        results.push({ retrieved, relevant: new Set(query.relevantTags) });
      }

      const meanPrecisionAt5 = mean(
        results.map((result) => precisionAtK(result.retrieved, result.relevant, 5)),
      );
      const meanRecallAt5 = mean(
        results.map((result) => recallAtK(result.retrieved, result.relevant, 5)),
      );
      const mrr = mean(
        results.map((result) => reciprocalRank(result.retrieved, result.relevant)),
      );

      consolidatedSummary.scalePrecisionAt5 = meanPrecisionAt5;
      consolidatedSummary.scaleRecallAt5 = meanRecallAt5;
      consolidatedSummary.scaleMrr = mrr;

      printBenchmarkReport("HM-StressBench Scale", {
        "Memory Count": memories.length,
        "Query Count": queries.length,
        "P@5": meanPrecisionAt5,
        "R@5": meanRecallAt5,
        "MRR": mrr,
      });

      expect(meanPrecisionAt5).toBeGreaterThanOrEqual(0.12);
      expect(meanRecallAt5).toBeGreaterThanOrEqual(0.25);
      expect(mrr).toBeGreaterThanOrEqual(0.2);
    } finally {
      fixture.db.close();
    }
  });

  afterAll(() => {
    printBenchmarkReport("Stress Benchmark Summary", {
      "False Positive Rate": reportValue(consolidatedSummary.falsePositiveRate),
      "Precision per topic": reportValue(consolidatedSummary.falsePositivePrecision),
      "Signal to Noise Ratio": reportValue(consolidatedSummary.signalToNoiseRatio),
      "Noise Rejection Rate": reportValue(consolidatedSummary.noiseRejectionRate),
      "Signal Retention Rate": reportValue(consolidatedSummary.signalRetentionRate),
      "Disambiguation Accuracy": reportValue(consolidatedSummary.disambiguationAccuracy),
      "Tag Accuracy": reportValue(consolidatedSummary.tagAccuracy),
      "Scale P@5": reportValue(consolidatedSummary.scalePrecisionAt5),
      "Scale R@5": reportValue(consolidatedSummary.scaleRecallAt5),
      "Scale MRR": reportValue(consolidatedSummary.scaleMrr),
    });
  });
});
