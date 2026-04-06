import type { Database as SqlJsDatabase } from "sql.js";

import type { EvidenceMetadata, SignalTag } from "../db/schema/types";
import { openSqlJsDatabase } from "../db/sqlite";

type SqlParameter = string | number | null;
type SqlParameters = Record<string, SqlParameter>;
type ActivationMode = "startup" | "default" | "temporal" | "cross_session";
type OverallStatus = "healthy" | "needs_attention" | "no_data_yet" | "schema_attention";
type ShadowMetricName =
  | "query_type"
  | "activation_mode"
  | "startup_pack_injected"
  | "injected_memory_ids"
  | "session_summary_generated"
  | "dream_actions"
  | "candidate_count"
  | "auto_promoted_count"
  | "review_digest_shown"
  | "summary_generation_skipped_reason";

interface CliOptions {
  dbPath: string;
  json: boolean;
}

interface KeyValueRow {
  label: string;
  value: string;
}

interface StructuralEventSnapshot {
  id: string;
  sessionId: string;
  scopeRef: string;
  toolName: string;
  createdAt: string;
  signalTags: SignalTag[];
}

interface TierDistribution {
  tier1: number;
  tier2: number;
  tier3: number;
  groupCount: number;
}

interface DreamActionDistribution {
  create: number;
  reinforce: number;
  supersede: number;
  stale: number;
  latent: number;
  skip: number;
}

interface AuditRow {
  eventType: string;
  detailsJson: string;
  createdAt: string;
}

interface ShadowMetricStatus {
  metric: ShadowMetricName;
  exists: boolean;
  eventCount: number;
}

interface DatabaseOverviewSection {
  note?: string;
  hasData: boolean;
  totalMemories: number;
  memoriesByStatus: Record<string, number>;
  totalDreamEvidenceEvents: number;
  dreamEvidenceByStatus: Record<string, number>;
  totalSessionSummaries: number;
  totalDreamRuns: number;
}

interface EvidencePipelineSection {
  note?: string;
  hasData: boolean;
  totalEvents: number;
  retentionNumerator: number;
  retentionRate: number | null;
  materializationNumerator: number;
  materializationDenominator: number;
  materializationRate: number | null;
  latentCount: number;
  oldestLatentDays: number | null;
  tierDistribution: TierDistribution | null;
}

interface DreamReconcilerSection {
  note?: string;
  hasData: boolean;
  lastDreamRunAt: string | null;
  lastDreamRunTrigger: string | null;
  lastDreamRunStatus: string | null;
  lastDreamRunSummary: string | null;
  lastActionDistribution: DreamActionDistribution | null;
}

interface SessionSummaryHealthSection {
  note?: string;
  hasData: boolean;
  totalSessionSummaries: number;
  averageEventsPerSummary: number | null;
  mostRecentSummaryAt: string | null;
  sessionsWithEvidence: number;
  sessionsWithoutSummaries: number;
}

interface ActivationHealthSection {
  note?: string;
  hasData: boolean;
  sampledActivations: number;
  modeDistribution: Record<ActivationMode, number>;
  averageActivatedMemoriesPerRequest: number | null;
  startupPackInjectionRate: number | null;
  startupPackInjectionNumerator: number;
  startupPackInjectionDenominator: number;
}

interface ReviewPromotionSection {
  note?: string;
  hasData: boolean;
  pendingCandidatesCount: number;
  oldestCandidateAgeDays: number | null;
  autoPromotedLast7Days: number;
  autoExpiredLast7Days: number;
  reviewDigestShownCount: number;
}

interface ShadowValidationSection {
  note?: string;
  hasData: boolean;
  metrics: ShadowMetricStatus[];
}

interface HealthReport {
  dbPath: string;
  generatedAt: string;
  overallStatus: OverallStatus;
  missingTables: string[];
  shadowMetricsPresent: number;
  shadowMetricsTotal: number;
  sections: {
    databaseOverview: DatabaseOverviewSection;
    evidencePipelineHealth: EvidencePipelineSection;
    dreamReconcilerHealth: DreamReconcilerSection;
    sessionSummaryHealth: SessionSummaryHealthSection;
    activationHealth: ActivationHealthSection;
    reviewPromotionHealth: ReviewPromotionSection;
    shadowValidationSummary: ShadowValidationSection;
  };
}

const DEFAULT_DB_PATH = ".harness-memory/memory.sqlite";
const NO_DATA_MESSAGE = "No data yet - use OpenCode for a few sessions";
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const TIME_ADJACENCY_WINDOW_MS = 5 * 60 * 1000;

const MEMORY_STATUS_BUCKETS = [
  { label: "active", rawStatuses: ["active"] },
  { label: "candidate", rawStatuses: ["candidate"] },
  { label: "stale", rawStatuses: ["stale"] },
  { label: "rejected", rawStatuses: ["rejected"] },
  { label: "inactive", rawStatuses: ["superseded"] },
] as const;

const DREAM_EVIDENCE_STATUS_ORDER = [
  "pending",
  "retained",
  "grouped",
  "materialized",
  "latent",
  "consumed",
  "discarded",
] as const;

const ACTIVATION_MODE_ORDER: readonly ActivationMode[] = [
  "startup",
  "default",
  "temporal",
  "cross_session",
];

const VALID_SIGNAL_TAGS: readonly SignalTag[] = [
  "failure_signal",
  "success_signal",
  "decision_signal",
  "convention_signal",
  "architecture_signal",
  "temporal_cue",
  "explicit_marker",
  "has_file_context",
];

const SHADOW_METRIC_ORDER: readonly ShadowMetricName[] = [
  "query_type",
  "activation_mode",
  "startup_pack_injected",
  "injected_memory_ids",
  "session_summary_generated",
  "dream_actions",
  "candidate_count",
  "auto_promoted_count",
  "review_digest_shown",
  "summary_generation_skipped_reason",
];

function parseArgs(argv: string[]): CliOptions {
  let dbPath = DEFAULT_DB_PATH;
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

function execRows(
  db: SqlJsDatabase,
  sql: string,
  params: SqlParameters = {},
): readonly unknown[][] {
  const result = db.exec(sql, params);
  if (result.length === 0) {
    return [];
  }

  return result[0]?.values ?? [];
}

function toNumber(value: unknown): number {
  if (typeof value === "number") {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number(value);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }

  if (typeof value === "bigint") {
    return Number(value);
  }

  throw new Error(`Expected numeric SQL value, received ${String(value)}`);
}

function toNullableNumber(value: unknown): number | null {
  if (value === null) {
    return null;
  }

  return toNumber(value);
}

function toStringValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  throw new Error(`Expected string SQL value, received ${String(value)}`);
}

function toNullableString(value: unknown): string | null {
  return value === null ? null : toStringValue(value);
}

function selectCount(db: SqlJsDatabase, sql: string, params: SqlParameters = {}): number {
  const rows = execRows(db, sql, params);
  if (rows.length === 0 || rows[0]?.[0] === undefined) {
    return 0;
  }

  return toNumber(rows[0][0]);
}

function selectNullableNumber(
  db: SqlJsDatabase,
  sql: string,
  params: SqlParameters = {},
): number | null {
  const rows = execRows(db, sql, params);
  if (rows.length === 0 || rows[0]?.[0] === undefined) {
    return null;
  }

  return toNullableNumber(rows[0][0]);
}

function selectNullableString(
  db: SqlJsDatabase,
  sql: string,
  params: SqlParameters = {},
): string | null {
  const rows = execRows(db, sql, params);
  if (rows.length === 0 || rows[0]?.[0] === undefined) {
    return null;
  }

  return toNullableString(rows[0][0]);
}

function listTableNames(db: SqlJsDatabase): Set<string> {
  const rows = execRows(
    db,
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name ASC",
  );

  return new Set(rows.map((row) => toStringValue(row[0])));
}

function getMissingTables(existingTables: Set<string>, requiredTables: readonly string[]): string[] {
  return requiredTables.filter((tableName) => !existingTables.has(tableName));
}

function buildSectionNote(missingTables: readonly string[], hasData: boolean): string | undefined {
  if (missingTables.length > 0) {
    return `Schema missing required table(s): ${missingTables.join(", ")} - run npx harness-memory db:migrate`;
  }

  if (!hasData) {
    return NO_DATA_MESSAGE;
  }

  return undefined;
}

function queryCountsByFirstColumn(
  db: SqlJsDatabase,
  sql: string,
  params: SqlParameters = {},
): Record<string, number> {
  const rows = execRows(db, sql, params);
  const counts: Record<string, number> = {};

  for (const row of rows) {
    const key = toStringValue(row[0]);
    const count = toNumber(row[1]);
    counts[key] = count;
  }

  return counts;
}

function sumValues(values: Record<string, number>): number {
  return Object.values(values).reduce((total, count) => total + count, 0);
}

function sumRawStatuses(
  counts: Record<string, number>,
  rawStatuses: readonly string[],
): number {
  return rawStatuses.reduce((total, status) => total + (counts[status] ?? 0), 0);
}

function parseJsonObject(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return null;
  }

  return null;
}

function getStringField(record: Record<string, unknown> | null, key: string): string | undefined {
  if (record === null) {
    return undefined;
  }

  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function getNumberField(record: Record<string, unknown> | null, key: string): number | undefined {
  if (record === null) {
    return undefined;
  }

  const value = record[key];
  return typeof value === "number" ? value : undefined;
}

function getBooleanField(record: Record<string, unknown> | null, key: string): boolean | undefined {
  if (record === null) {
    return undefined;
  }

  const value = record[key];
  return typeof value === "boolean" ? value : undefined;
}

function getArrayField(record: Record<string, unknown> | null, key: string): unknown[] | undefined {
  if (record === null) {
    return undefined;
  }

  const value = record[key];
  return Array.isArray(value) ? value : undefined;
}

function parseMetadata(raw: string | null): EvidenceMetadata | null {
  if (raw === null) {
    return null;
  }

  const parsed = parseJsonObject(raw);
  return parsed === null ? null : (parsed as EvidenceMetadata);
}

function extractSignalTagsFromMetadata(raw: string | null): {
  tags: SignalTag[];
  present: boolean;
} {
  const metadata = parseMetadata(raw);
  if (metadata === null || !Array.isArray(metadata.signalTags)) {
    return { tags: [], present: false };
  }

  const validTagSet = new Set<SignalTag>(VALID_SIGNAL_TAGS);
  const tags: SignalTag[] = [];

  for (const value of metadata.signalTags) {
    if (typeof value === "string" && validTagSet.has(value as SignalTag)) {
      tags.push(value as SignalTag);
    }
  }

  return { tags, present: true };
}

function compareStructuralEvents(
  left: StructuralEventSnapshot,
  right: StructuralEventSnapshot,
): number {
  const createdAtDelta = Date.parse(left.createdAt) - Date.parse(right.createdAt);
  if (createdAtDelta !== 0) {
    return createdAtDelta;
  }

  return left.id.localeCompare(right.id);
}

function buildStructuralGroupKey(event: StructuralEventSnapshot): string {
  return [event.sessionId, event.scopeRef, event.toolName].join("|");
}

function groupStructuralEvents(
  events: readonly StructuralEventSnapshot[],
): Map<string, StructuralEventSnapshot[]> {
  const groups = new Map<string, StructuralEventSnapshot[]>();

  for (const event of events) {
    const key = buildStructuralGroupKey(event);
    const existing = groups.get(key) ?? [];
    existing.push(event);
    groups.set(key, existing);
  }

  for (const [key, grouped] of groups) {
    groups.set(key, [...grouped].sort(compareStructuralEvents));
  }

  return groups;
}

function mergeTimeAdjacentGroups(
  groups: Map<string, StructuralEventSnapshot[]>,
): StructuralEventSnapshot[][] {
  type GroupEntry = {
    key: string;
    events: StructuralEventSnapshot[];
  };

  const buckets = new Map<string, GroupEntry[]>();

  for (const [key, events] of groups) {
    const firstEvent = events[0];
    if (firstEvent === undefined) {
      continue;
    }

    const bucketKey = [firstEvent.sessionId, firstEvent.scopeRef].join("|");
    const entries = buckets.get(bucketKey) ?? [];
    entries.push({ key, events: [...events] });
    buckets.set(bucketKey, entries);
  }

  const merged: StructuralEventSnapshot[][] = [];

  for (const entries of buckets.values()) {
    entries.sort((left, right) => compareStructuralEvents(left.events[0]!, right.events[0]!));

    let current = entries[0];
    if (current === undefined) {
      continue;
    }

    for (const next of entries.slice(1)) {
      const currentLatest = current.events[current.events.length - 1];
      const nextEarliest = next.events[0];

      if (currentLatest === undefined || nextEarliest === undefined) {
        continue;
      }

      const gapMs = Date.parse(nextEarliest.createdAt) - Date.parse(currentLatest.createdAt);
      if (gapMs < TIME_ADJACENCY_WINDOW_MS) {
        const mergedEvents = [...current.events, ...next.events].sort(compareStructuralEvents);
        const preferredKey = next.events.length > current.events.length ? next.key : current.key;
        current = { key: preferredKey, events: mergedEvents };
        continue;
      }

      merged.push(current.events);
      current = next;
    }

    merged.push(current.events);
  }

  return merged;
}

function classifyTier(eventCount: number, tags: readonly SignalTag[]): 1 | 2 | 3 {
  if (eventCount >= 3) {
    return 1;
  }

  if (tags.includes("failure_signal") && tags.includes("has_file_context")) {
    return 1;
  }

  if (eventCount >= 2) {
    return 2;
  }

  if (tags.length > 0) {
    return 2;
  }

  return 3;
}

function computeTierDistribution(
  events: readonly StructuralEventSnapshot[],
): TierDistribution | null {
  const grouped = mergeTimeAdjacentGroups(groupStructuralEvents(events));
  if (grouped.length === 0) {
    return null;
  }

  let tier1 = 0;
  let tier2 = 0;
  let tier3 = 0;

  for (const group of grouped) {
    const tags = [...new Set(group.flatMap((event) => event.signalTags))];
    const tier = classifyTier(group.length, tags);

    if (tier === 1) {
      tier1 += 1;
    } else if (tier === 2) {
      tier2 += 1;
    } else {
      tier3 += 1;
    }
  }

  return {
    tier1,
    tier2,
    tier3,
    groupCount: grouped.length,
  };
}

function listStructuralEventsWithSignalTags(
  db: SqlJsDatabase,
): {
  events: StructuralEventSnapshot[];
  hasSignalTagMetadata: boolean;
} {
  const rows = execRows(
    db,
    `SELECT id, session_id, scope_ref, tool_name, created_at, metadata_json
     FROM dream_evidence_events
     ORDER BY created_at ASC, id ASC`,
  );
  const events: StructuralEventSnapshot[] = [];
  let hasSignalTagMetadata = false;

  for (const row of rows) {
    const signalTagResult = extractSignalTagsFromMetadata(toNullableString(row[5]));
    hasSignalTagMetadata = hasSignalTagMetadata || signalTagResult.present;
    events.push({
      id: toStringValue(row[0]),
      sessionId: toStringValue(row[1]),
      scopeRef: toStringValue(row[2]),
      toolName: toStringValue(row[3]),
      createdAt: toStringValue(row[4]),
      signalTags: signalTagResult.tags,
    });
  }

  return { events, hasSignalTagMetadata };
}

function parseDreamActionDistribution(summary: string | null): DreamActionDistribution | null {
  if (summary === null) {
    return null;
  }

  const match = summary.match(
    /create\s+(\d+),\s*reinforce\s+(\d+),\s*supersede\s+(\d+),\s*stale\s+(\d+),\s*latent\s+(\d+),\s*skip\s+(\d+)/i,
  );

  if (match === null) {
    return null;
  }

  return {
    create: Number(match[1]),
    reinforce: Number(match[2]),
    supersede: Number(match[3]),
    stale: Number(match[4]),
    latent: Number(match[5]),
    skip: Number(match[6]),
  };
}

function listAuditRows(
  db: SqlJsDatabase,
  eventTypes: readonly string[],
  limit?: number,
): AuditRow[] {
  if (eventTypes.length === 0) {
    return [];
  }

  const params: SqlParameters = {};
  const placeholders = eventTypes.map((eventType, index) => {
    const key = `$eventType${index}`;
    params[key] = eventType;
    return key;
  });

  if (limit !== undefined) {
    params.$limit = limit;
  }

  const limitClause = limit === undefined ? "" : " LIMIT $limit";
  const rows = execRows(
    db,
    `SELECT event_type, details_json, created_at
     FROM audit_log
     WHERE event_type IN (${placeholders.join(", ")})
     ORDER BY created_at DESC, id DESC${limitClause}`,
    params,
  );

  return rows.map((row) => ({
    eventType: toStringValue(row[0]),
    detailsJson: toStringValue(row[1]),
    createdAt: toStringValue(row[2]),
  }));
}

function daysSince(isoString: string | null, nowMs: number = Date.now()): number | null {
  if (isoString === null) {
    return null;
  }

  const timestamp = Date.parse(isoString);
  if (Number.isNaN(timestamp)) {
    return null;
  }

  return Math.max(0, (nowMs - timestamp) / MS_PER_DAY);
}

function formatInteger(value: number): string {
  return value.toLocaleString("en-US");
}

function formatDecimal(value: number, digits: number = 1): string {
  return value.toFixed(digits);
}

function formatPercent(numerator: number, denominator: number): string {
  if (denominator === 0) {
    return "n/a";
  }

  return `${formatDecimal((numerator / denominator) * 100)}%`;
}

function formatDays(value: number | null): string {
  if (value === null) {
    return "n/a";
  }

  return `${formatDecimal(value)}d`;
}

function formatAverage(value: number | null): string {
  return value === null ? "n/a" : formatDecimal(value);
}

function formatTimestamp(value: string | null): string {
  return value ?? "n/a";
}

function truncateText(value: string, maxLength: number = 100): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength - 3)}...`;
}

function buildDatabaseOverviewSection(
  db: SqlJsDatabase,
  existingTables: Set<string>,
): DatabaseOverviewSection {
  const missingTables = getMissingTables(existingTables, [
    "memories",
    "dream_evidence_events",
    "session_summaries",
    "dream_runs",
  ]);

  const rawMemoryCounts = existingTables.has("memories")
    ? queryCountsByFirstColumn(db, "SELECT status, COUNT(*) FROM memories GROUP BY status ORDER BY status ASC")
    : {};
  const rawEvidenceCounts = existingTables.has("dream_evidence_events")
    ? queryCountsByFirstColumn(
        db,
        "SELECT status, COUNT(*) FROM dream_evidence_events GROUP BY status ORDER BY status ASC",
      )
    : {};

  const memoriesByStatus = Object.fromEntries(
    MEMORY_STATUS_BUCKETS.map((bucket) => [
      bucket.label,
      sumRawStatuses(rawMemoryCounts, bucket.rawStatuses),
    ]),
  );
  const dreamEvidenceByStatus = Object.fromEntries(
    DREAM_EVIDENCE_STATUS_ORDER.map((status) => [status, rawEvidenceCounts[status] ?? 0]),
  );
  const totalMemories = sumValues(rawMemoryCounts);
  const totalDreamEvidenceEvents = sumValues(rawEvidenceCounts);
  const totalSessionSummaries = existingTables.has("session_summaries")
    ? selectCount(db, "SELECT COUNT(*) FROM session_summaries")
    : 0;
  const totalDreamRuns = existingTables.has("dream_runs")
    ? selectCount(db, "SELECT COUNT(*) FROM dream_runs")
    : 0;
  const hasData =
    totalMemories > 0 ||
    totalDreamEvidenceEvents > 0 ||
    totalSessionSummaries > 0 ||
    totalDreamRuns > 0;

  return {
    note: buildSectionNote(missingTables, hasData),
    hasData,
    totalMemories,
    memoriesByStatus,
    totalDreamEvidenceEvents,
    dreamEvidenceByStatus,
    totalSessionSummaries,
    totalDreamRuns,
  };
}

function buildEvidencePipelineSection(
  db: SqlJsDatabase,
  existingTables: Set<string>,
): EvidencePipelineSection {
  const missingTables = getMissingTables(existingTables, ["dream_evidence_events"]);

  if (!existingTables.has("dream_evidence_events")) {
    return {
      note: buildSectionNote(missingTables, false),
      hasData: false,
      totalEvents: 0,
      retentionNumerator: 0,
      retentionRate: null,
      materializationNumerator: 0,
      materializationDenominator: 0,
      materializationRate: null,
      latentCount: 0,
      oldestLatentDays: null,
      tierDistribution: null,
    };
  }

  const rawCounts = queryCountsByFirstColumn(
    db,
    "SELECT status, COUNT(*) FROM dream_evidence_events GROUP BY status ORDER BY status ASC",
  );
  const totalEvents = sumValues(rawCounts);
  const retentionNumerator =
    (rawCounts.retained ?? 0) +
    (rawCounts.grouped ?? 0) +
    (rawCounts.materialized ?? 0) +
    (rawCounts.latent ?? 0) +
    (rawCounts.consumed ?? 0);
  const materializationNumerator = rawCounts.materialized ?? 0;
  const materializationDenominator =
    (rawCounts.retained ?? 0) +
    (rawCounts.grouped ?? 0) +
    (rawCounts.materialized ?? 0) +
    (rawCounts.latent ?? 0);

  const latentCount = selectCount(
    db,
    "SELECT COUNT(*) FROM dream_evidence_events WHERE status = 'latent'",
  );
  const oldestLatentCreatedAt = selectNullableString(
    db,
    "SELECT MIN(created_at) FROM dream_evidence_events WHERE status = 'latent'",
  );

  const structuralEvents = listStructuralEventsWithSignalTags(db);
  const tierDistribution = structuralEvents.hasSignalTagMetadata
    ? computeTierDistribution(structuralEvents.events)
    : null;
  const hasData = totalEvents > 0;

  return {
    note: buildSectionNote(missingTables, hasData),
    hasData,
    totalEvents,
    retentionNumerator,
    retentionRate: totalEvents === 0 ? null : retentionNumerator / totalEvents,
    materializationNumerator,
    materializationDenominator,
    materializationRate:
      materializationDenominator === 0
        ? null
        : materializationNumerator / materializationDenominator,
    latentCount,
    oldestLatentDays: daysSince(oldestLatentCreatedAt),
    tierDistribution,
  };
}

function buildDreamReconcilerSection(
  db: SqlJsDatabase,
  existingTables: Set<string>,
): DreamReconcilerSection {
  const missingTables = getMissingTables(existingTables, ["dream_runs"]);

  if (!existingTables.has("dream_runs")) {
    return {
      note: buildSectionNote(missingTables, false),
      hasData: false,
      lastDreamRunAt: null,
      lastDreamRunTrigger: null,
      lastDreamRunStatus: null,
      lastDreamRunSummary: null,
      lastActionDistribution: null,
    };
  }

  const rows = execRows(
    db,
    `SELECT trigger, status, summary, created_at, completed_at
     FROM dream_runs
     ORDER BY created_at DESC, id DESC
     LIMIT 1`,
  );

  if (rows.length === 0) {
    return {
      note: buildSectionNote(missingTables, false),
      hasData: false,
      lastDreamRunAt: null,
      lastDreamRunTrigger: null,
      lastDreamRunStatus: null,
      lastDreamRunSummary: null,
      lastActionDistribution: null,
    };
  }

  const row = rows[0]!;
  const summary = toStringValue(row[2]);

  return {
    note: buildSectionNote(missingTables, true),
    hasData: true,
    lastDreamRunAt: toNullableString(row[4]) ?? toStringValue(row[3]),
    lastDreamRunTrigger: toStringValue(row[0]),
    lastDreamRunStatus: toStringValue(row[1]),
    lastDreamRunSummary: summary,
    lastActionDistribution: parseDreamActionDistribution(summary),
  };
}

function buildSessionSummaryHealthSection(
  db: SqlJsDatabase,
  existingTables: Set<string>,
): SessionSummaryHealthSection {
  const missingTables = getMissingTables(existingTables, ["session_summaries", "dream_evidence_events"]);

  const totalSessionSummaries = existingTables.has("session_summaries")
    ? selectCount(db, "SELECT COUNT(*) FROM session_summaries")
    : 0;
  const averageEventsPerSummary = existingTables.has("session_summaries")
    ? selectNullableNumber(db, "SELECT AVG(event_count) FROM session_summaries")
    : null;
  const mostRecentSummaryAt = existingTables.has("session_summaries")
    ? selectNullableString(db, "SELECT MAX(updated_at) FROM session_summaries")
    : null;
  const sessionsWithEvidence = existingTables.has("dream_evidence_events")
    ? selectCount(db, "SELECT COUNT(DISTINCT session_id) FROM dream_evidence_events")
    : 0;
  const sessionsWithoutSummaries =
    existingTables.has("dream_evidence_events") && existingTables.has("session_summaries")
      ? selectCount(
          db,
          `SELECT COUNT(*)
           FROM (
             SELECT DISTINCT evidence.session_id
             FROM dream_evidence_events evidence
             LEFT JOIN session_summaries summaries
               ON summaries.session_id = evidence.session_id
             WHERE summaries.session_id IS NULL
           )`,
        )
      : 0;
  const hasData = totalSessionSummaries > 0 || sessionsWithEvidence > 0;

  return {
    note: buildSectionNote(missingTables, hasData),
    hasData,
    totalSessionSummaries,
    averageEventsPerSummary,
    mostRecentSummaryAt,
    sessionsWithEvidence,
    sessionsWithoutSummaries,
  };
}

function buildActivationHealthSection(
  db: SqlJsDatabase,
  existingTables: Set<string>,
): ActivationHealthSection {
  const missingTables = getMissingTables(existingTables, ["audit_log"]);

  if (!existingTables.has("audit_log")) {
    return {
      note: buildSectionNote(missingTables, false),
      hasData: false,
      sampledActivations: 0,
      modeDistribution: {
        startup: 0,
        default: 0,
        temporal: 0,
        cross_session: 0,
      },
      averageActivatedMemoriesPerRequest: null,
      startupPackInjectionRate: null,
      startupPackInjectionNumerator: 0,
      startupPackInjectionDenominator: 0,
    };
  }

  const rows = listAuditRows(db, ["activation"], 50);
  const modeDistribution: Record<ActivationMode, number> = {
    startup: 0,
    default: 0,
    temporal: 0,
    cross_session: 0,
  };
  let totalActivatedMemories = 0;
  let startupPackInjectionNumerator = 0;
  let startupPackInjectionDenominator = 0;

  for (const row of rows) {
    const details = parseJsonObject(row.detailsJson);
    const activationMode = getStringField(details, "activationMode");

    if (
      activationMode === "startup" ||
      activationMode === "default" ||
      activationMode === "temporal" ||
      activationMode === "cross_session"
    ) {
      modeDistribution[activationMode] += 1;
      if (activationMode === "startup") {
        startupPackInjectionDenominator += 1;
      }
    }

    const activatedCount =
      getNumberField(details, "activatedCount") ?? getArrayField(details, "activated")?.length ?? 0;
    totalActivatedMemories += activatedCount;

    if (getBooleanField(details, "startupPackInjected") === true) {
      startupPackInjectionNumerator += 1;
    }
  }

  const hasData = rows.length > 0;

  return {
    note: buildSectionNote(missingTables, hasData),
    hasData,
    sampledActivations: rows.length,
    modeDistribution,
    averageActivatedMemoriesPerRequest:
      rows.length === 0 ? null : totalActivatedMemories / rows.length,
    startupPackInjectionRate:
      startupPackInjectionDenominator === 0
        ? null
        : startupPackInjectionNumerator / startupPackInjectionDenominator,
    startupPackInjectionNumerator,
    startupPackInjectionDenominator,
  };
}

function buildReviewPromotionSection(
  db: SqlJsDatabase,
  existingTables: Set<string>,
): ReviewPromotionSection {
  const missingTables = getMissingTables(existingTables, ["memories", "audit_log"]);
  const nowMs = Date.now();
  const cutoffIso = new Date(nowMs - 7 * MS_PER_DAY).toISOString();

  const pendingCandidatesCount = existingTables.has("memories")
    ? selectCount(db, "SELECT COUNT(*) FROM memories WHERE status = 'candidate'")
    : 0;
  const oldestCandidateCreatedAt = existingTables.has("memories")
    ? selectNullableString(
        db,
        "SELECT MIN(created_at) FROM memories WHERE status = 'candidate'",
      )
    : null;

  let autoPromotedLast7Days = 0;
  let autoExpiredLast7Days = 0;

  if (existingTables.has("audit_log")) {
    for (const row of listAuditRows(db, ["auto_promotion_cycle"])) {
      if (row.createdAt < cutoffIso) {
        continue;
      }

      const details = parseJsonObject(row.detailsJson);
      autoPromotedLast7Days += getNumberField(details, "promotedCount") ?? 0;
      autoExpiredLast7Days += getNumberField(details, "expiredCount") ?? 0;
    }
  }

  const reviewDigestShownCount = existingTables.has("audit_log")
    ? selectCount(db, "SELECT COUNT(*) FROM audit_log WHERE event_type = 'review_digest_shown'")
    : 0;
  const hasData =
    pendingCandidatesCount > 0 ||
    autoPromotedLast7Days > 0 ||
    autoExpiredLast7Days > 0 ||
    reviewDigestShownCount > 0;

  return {
    note: buildSectionNote(missingTables, hasData),
    hasData,
    pendingCandidatesCount,
    oldestCandidateAgeDays: daysSince(oldestCandidateCreatedAt, nowMs),
    autoPromotedLast7Days,
    autoExpiredLast7Days,
    reviewDigestShownCount,
  };
}

function buildShadowValidationSection(
  db: SqlJsDatabase,
  existingTables: Set<string>,
): ShadowValidationSection {
  const missingTables = getMissingTables(existingTables, ["audit_log"]);

  if (!existingTables.has("audit_log")) {
    return {
      note: buildSectionNote(missingTables, false),
      hasData: false,
      metrics: SHADOW_METRIC_ORDER.map((metric) => ({
        metric,
        exists: false,
        eventCount: 0,
      })),
    };
  }

  const metricCounts = new Map<ShadowMetricName, number>(
    SHADOW_METRIC_ORDER.map((metric) => [metric, 0]),
  );
  const rows = listAuditRows(db, [
    "activation",
    "session_summary_generated",
    "session_summary_skipped",
    "auto_promotion_cycle",
    "review_digest_shown",
    "extraction_action",
  ]);

  for (const row of rows) {
    const details = parseJsonObject(row.detailsJson);

    if (row.eventType === "activation") {
      if (getStringField(details, "queryType") !== undefined) {
        metricCounts.set("query_type", (metricCounts.get("query_type") ?? 0) + 1);
      }
      if (getStringField(details, "activationMode") !== undefined) {
        metricCounts.set("activation_mode", (metricCounts.get("activation_mode") ?? 0) + 1);
      }
      if (getBooleanField(details, "startupPackInjected") !== undefined) {
        metricCounts.set(
          "startup_pack_injected",
          (metricCounts.get("startup_pack_injected") ?? 0) + 1,
        );
      }
      if (getArrayField(details, "activated") !== undefined) {
        metricCounts.set(
          "injected_memory_ids",
          (metricCounts.get("injected_memory_ids") ?? 0) + 1,
        );
      }
      if (getNumberField(details, "candidateCount") !== undefined) {
        metricCounts.set("candidate_count", (metricCounts.get("candidate_count") ?? 0) + 1);
      }
      continue;
    }

    if (row.eventType === "session_summary_generated") {
      metricCounts.set(
        "session_summary_generated",
        (metricCounts.get("session_summary_generated") ?? 0) + 1,
      );
      continue;
    }

    if (row.eventType === "session_summary_skipped") {
      if (getStringField(details, "reason") !== undefined) {
        metricCounts.set(
          "summary_generation_skipped_reason",
          (metricCounts.get("summary_generation_skipped_reason") ?? 0) + 1,
        );
      }
      continue;
    }

    if (row.eventType === "auto_promotion_cycle") {
      if (getNumberField(details, "promotedCount") !== undefined) {
        metricCounts.set(
          "auto_promoted_count",
          (metricCounts.get("auto_promoted_count") ?? 0) + 1,
        );
      }
      continue;
    }

    if (row.eventType === "review_digest_shown") {
      metricCounts.set(
        "review_digest_shown",
        (metricCounts.get("review_digest_shown") ?? 0) + 1,
      );
      if (getNumberField(details, "candidateCount") !== undefined) {
        metricCounts.set("candidate_count", (metricCounts.get("candidate_count") ?? 0) + 1);
      }
      continue;
    }

    if (row.eventType === "extraction_action") {
      metricCounts.set("dream_actions", (metricCounts.get("dream_actions") ?? 0) + 1);
    }
  }

  const metrics = SHADOW_METRIC_ORDER.map((metric) => {
    const eventCount = metricCounts.get(metric) ?? 0;
    return {
      metric,
      exists: eventCount > 0,
      eventCount,
    };
  });

  return {
    note: buildSectionNote(missingTables, rows.length > 0),
    hasData: rows.length > 0,
    metrics,
  };
}

function determineOverallStatus(
  missingTables: readonly string[],
  sections: HealthReport["sections"],
): OverallStatus {
  if (missingTables.length > 0) {
    return "schema_attention";
  }

  const hasAnyData =
    sections.databaseOverview.hasData ||
    sections.evidencePipelineHealth.hasData ||
    sections.dreamReconcilerHealth.hasData ||
    sections.sessionSummaryHealth.hasData ||
    sections.activationHealth.hasData ||
    sections.reviewPromotionHealth.hasData ||
    sections.shadowValidationSummary.hasData;

  if (!hasAnyData) {
    return "no_data_yet";
  }

  const missingShadowMetrics = sections.shadowValidationSummary.metrics.filter((metric) => !metric.exists);
  return missingShadowMetrics.length > 0 ? "needs_attention" : "healthy";
}

function buildHealthReport(db: SqlJsDatabase, dbPath: string): HealthReport {
  const existingTables = listTableNames(db);
  const sections = {
    databaseOverview: buildDatabaseOverviewSection(db, existingTables),
    evidencePipelineHealth: buildEvidencePipelineSection(db, existingTables),
    dreamReconcilerHealth: buildDreamReconcilerSection(db, existingTables),
    sessionSummaryHealth: buildSessionSummaryHealthSection(db, existingTables),
    activationHealth: buildActivationHealthSection(db, existingTables),
    reviewPromotionHealth: buildReviewPromotionSection(db, existingTables),
    shadowValidationSummary: buildShadowValidationSection(db, existingTables),
  };
  const missingTables = getMissingTables(existingTables, [
    "memories",
    "dream_evidence_events",
    "dream_runs",
    "session_summaries",
    "audit_log",
  ]);
  const shadowMetricsPresent = sections.shadowValidationSummary.metrics.filter(
    (metric) => metric.exists,
  ).length;

  return {
    dbPath,
    generatedAt: new Date().toISOString(),
    overallStatus: determineOverallStatus(missingTables, sections),
    missingTables,
    shadowMetricsPresent,
    shadowMetricsTotal: SHADOW_METRIC_ORDER.length,
    sections,
  };
}

function buildHeaderRows(report: HealthReport): KeyValueRow[] {
  const rows: KeyValueRow[] = [
    { label: "Database", value: report.dbPath },
    { label: "Generated at", value: report.generatedAt },
    { label: "Overall status", value: report.overallStatus },
    {
      label: "Shadow coverage",
      value: `${report.shadowMetricsPresent}/${report.shadowMetricsTotal} metrics present`,
    },
  ];

  if (report.missingTables.length > 0) {
    rows.push({ label: "Missing tables", value: report.missingTables.join(", ") });
  }

  return rows;
}

function renderTierDistribution(distribution: TierDistribution | null): string {
  if (distribution === null || distribution.groupCount === 0) {
    return "No signal-tag metadata yet";
  }

  return [
    `tier1 ${formatPercent(distribution.tier1, distribution.groupCount)} (${formatInteger(distribution.tier1)})`,
    `tier2 ${formatPercent(distribution.tier2, distribution.groupCount)} (${formatInteger(distribution.tier2)})`,
    `tier3 ${formatPercent(distribution.tier3, distribution.groupCount)} (${formatInteger(distribution.tier3)})`,
    `${formatInteger(distribution.groupCount)} groups`,
  ].join(" | ");
}

function renderDreamActionDistribution(distribution: DreamActionDistribution | null): string {
  if (distribution === null) {
    return "Unavailable in last dream run summary";
  }

  return [
    `create ${formatInteger(distribution.create)}`,
    `reinforce ${formatInteger(distribution.reinforce)}`,
    `supersede ${formatInteger(distribution.supersede)}`,
    `stale ${formatInteger(distribution.stale)}`,
    `latent ${formatInteger(distribution.latent)}`,
    `skip ${formatInteger(distribution.skip)}`,
  ].join(" | ");
}

function renderCoreDreamRatio(distribution: DreamActionDistribution | null): string {
  if (distribution === null) {
    return "n/a";
  }

  const total =
    distribution.create +
    distribution.reinforce +
    distribution.supersede +
    distribution.stale;

  if (total === 0) {
    return "n/a";
  }

  return [
    `create ${formatPercent(distribution.create, total)}`,
    `reinforce ${formatPercent(distribution.reinforce, total)}`,
    `supersede ${formatPercent(distribution.supersede, total)}`,
    `stale ${formatPercent(distribution.stale, total)}`,
  ].join(" | ");
}

function renderActivationModeDistribution(
  distribution: Record<ActivationMode, number>,
): string {
  return ACTIVATION_MODE_ORDER.map(
    (mode) => `${mode}: ${formatInteger(distribution[mode])}`,
  ).join(", ");
}

function renderShadowMetricValue(metric: ShadowMetricStatus): string {
  return metric.exists ? `yes (${formatInteger(metric.eventCount)} event(s))` : "no";
}

function buildDatabaseOverviewRows(section: DatabaseOverviewSection): KeyValueRow[] {
  const rows: KeyValueRow[] = [];

  if (section.note !== undefined) {
    rows.push({ label: "Note", value: section.note });
  }

  rows.push({ label: "Total memories", value: formatInteger(section.totalMemories) });
  for (const bucket of MEMORY_STATUS_BUCKETS) {
    rows.push({
      label: `  ${bucket.label}`,
      value: formatInteger(section.memoriesByStatus[bucket.label] ?? 0),
    });
  }

  rows.push({
    label: "Total dream evidence events",
    value: formatInteger(section.totalDreamEvidenceEvents),
  });
  for (const status of DREAM_EVIDENCE_STATUS_ORDER) {
    rows.push({
      label: `  ${status}`,
      value: formatInteger(section.dreamEvidenceByStatus[status] ?? 0),
    });
  }

  rows.push({
    label: "Total session summaries",
    value: formatInteger(section.totalSessionSummaries),
  });
  rows.push({ label: "Total dream runs", value: formatInteger(section.totalDreamRuns) });

  return rows;
}

function buildEvidencePipelineRows(section: EvidencePipelineSection): KeyValueRow[] {
  const rows: KeyValueRow[] = [];

  if (section.note !== undefined) {
    rows.push({ label: "Note", value: section.note });
  }

  rows.push({ label: "Total evidence events", value: formatInteger(section.totalEvents) });
  rows.push({
    label: "Evidence retention rate",
    value:
      section.retentionRate === null
        ? "n/a"
        : `${formatPercent(section.retentionNumerator, section.totalEvents)} (${formatInteger(section.retentionNumerator)}/${formatInteger(section.totalEvents)})`,
  });
  rows.push({
    label: "Materialization rate",
    value:
      section.materializationRate === null
        ? "n/a"
        : `${formatPercent(section.materializationNumerator, section.materializationDenominator)} (${formatInteger(section.materializationNumerator)}/${formatInteger(section.materializationDenominator)})`,
  });
  rows.push({ label: "Latent evidence", value: formatInteger(section.latentCount) });
  rows.push({ label: "Oldest latent", value: formatDays(section.oldestLatentDays) });
  rows.push({
    label: "Average tier distribution",
    value: renderTierDistribution(section.tierDistribution),
  });

  return rows;
}

function buildDreamReconcilerRows(section: DreamReconcilerSection): KeyValueRow[] {
  const rows: KeyValueRow[] = [];

  if (section.note !== undefined) {
    rows.push({ label: "Note", value: section.note });
  }

  rows.push({
    label: "Last dream run",
    value:
      section.lastDreamRunAt === null
        ? "n/a"
        : `${section.lastDreamRunAt} (${section.lastDreamRunTrigger ?? "unknown"}, ${section.lastDreamRunStatus ?? "unknown"})`,
  });
  rows.push({
    label: "Last action distribution",
    value: renderDreamActionDistribution(section.lastActionDistribution),
  });
  rows.push({
    label: "Create/reinforce/supersede/stale ratio",
    value: renderCoreDreamRatio(section.lastActionDistribution),
  });

  if (section.lastDreamRunSummary !== null && section.lastActionDistribution === null) {
    rows.push({
      label: "Last run summary",
      value: truncateText(section.lastDreamRunSummary),
    });
  }

  return rows;
}

function buildSessionSummaryRows(section: SessionSummaryHealthSection): KeyValueRow[] {
  const rows: KeyValueRow[] = [];

  if (section.note !== undefined) {
    rows.push({ label: "Note", value: section.note });
  }

  rows.push({
    label: "Total session summaries",
    value: formatInteger(section.totalSessionSummaries),
  });
  rows.push({
    label: "Average events per summary",
    value: formatAverage(section.averageEventsPerSummary),
  });
  rows.push({
    label: "Most recent summary",
    value: formatTimestamp(section.mostRecentSummaryAt),
  });
  rows.push({
    label: "Sessions with evidence",
    value: formatInteger(section.sessionsWithEvidence),
  });
  rows.push({
    label: "Sessions without summaries",
    value: formatInteger(section.sessionsWithoutSummaries),
  });

  return rows;
}

function buildActivationHealthRows(section: ActivationHealthSection): KeyValueRow[] {
  const rows: KeyValueRow[] = [];

  if (section.note !== undefined) {
    rows.push({ label: "Note", value: section.note });
  }

  rows.push({
    label: "Activation sample",
    value: `${formatInteger(section.sampledActivations)} recent activation(s)`,
  });
  rows.push({
    label: "Mode distribution",
    value: renderActivationModeDistribution(section.modeDistribution),
  });
  rows.push({
    label: "Average activated/request",
    value: formatAverage(section.averageActivatedMemoriesPerRequest),
  });
  rows.push({
    label: "Startup pack injection rate",
    value:
      section.startupPackInjectionRate === null
        ? "n/a"
        : `${formatPercent(
            section.startupPackInjectionNumerator,
            section.startupPackInjectionDenominator,
          )} (${formatInteger(section.startupPackInjectionNumerator)}/${formatInteger(section.startupPackInjectionDenominator)} first-turn activations)`,
  });

  return rows;
}

function buildReviewPromotionRows(section: ReviewPromotionSection): KeyValueRow[] {
  const rows: KeyValueRow[] = [];

  if (section.note !== undefined) {
    rows.push({ label: "Note", value: section.note });
  }

  rows.push({
    label: "Pending candidates",
    value: formatInteger(section.pendingCandidatesCount),
  });
  rows.push({
    label: "Oldest candidate",
    value: formatDays(section.oldestCandidateAgeDays),
  });
  rows.push({
    label: "Auto-promoted (last 7d)",
    value: formatInteger(section.autoPromotedLast7Days),
  });
  rows.push({
    label: "Auto-expired (last 7d)",
    value: formatInteger(section.autoExpiredLast7Days),
  });
  rows.push({
    label: "Review digest shown",
    value: formatInteger(section.reviewDigestShownCount),
  });

  return rows;
}

function buildShadowValidationRows(section: ShadowValidationSection): KeyValueRow[] {
  const rows: KeyValueRow[] = [];

  if (section.note !== undefined) {
    rows.push({ label: "Note", value: section.note });
  }

  const presentCount = section.metrics.filter((metric) => metric.exists).length;
  rows.push({
    label: "Coverage",
    value: `${formatInteger(presentCount)}/${formatInteger(section.metrics.length)} metrics present`,
  });

  for (const metric of section.metrics) {
    rows.push({
      label: metric.metric,
      value: renderShadowMetricValue(metric),
    });
  }

  return rows;
}

function renderSection(title: string, rows: readonly KeyValueRow[]): string {
  const normalizedRows = rows.length === 0 ? [{ label: "Status", value: NO_DATA_MESSAGE }] : rows;
  const labelWidth = Math.max(
    12,
    ...normalizedRows.flatMap((row) => row.label.split("\n").map((line) => line.length)),
  );
  const valueWidth = Math.max(
    20,
    title.length,
    ...normalizedRows.flatMap((row) => row.value.split("\n").map((line) => line.length)),
  );
  const outerWidth = labelWidth + valueWidth + 7;
  const border = `+${"-".repeat(outerWidth - 2)}+`;
  const divider = `+${"-".repeat(labelWidth + 2)}+${"-".repeat(valueWidth + 2)}+`;
  const titleLine = `| ${title.padEnd(outerWidth - 4)} |`;
  const lines = [border, titleLine, divider];

  for (const row of normalizedRows) {
    const labelLines = row.label.split("\n");
    const valueLines = row.value.split("\n");
    const lineCount = Math.max(labelLines.length, valueLines.length);

    for (let index = 0; index < lineCount; index += 1) {
      lines.push(
        `| ${(labelLines[index] ?? "").padEnd(labelWidth)} | ${(valueLines[index] ?? "").padEnd(valueWidth)} |`,
      );
    }
  }

  lines.push(border);
  return lines.join("\n");
}

function renderReport(report: HealthReport): string {
  const sections = [
    renderSection("Harness Memory Health Check", buildHeaderRows(report)),
    renderSection("Section 1: Database Overview", buildDatabaseOverviewRows(report.sections.databaseOverview)),
    renderSection(
      "Section 2: Evidence Pipeline Health",
      buildEvidencePipelineRows(report.sections.evidencePipelineHealth),
    ),
    renderSection(
      "Section 3: Dream Reconciler Health",
      buildDreamReconcilerRows(report.sections.dreamReconcilerHealth),
    ),
    renderSection(
      "Section 4: Session Summary Health",
      buildSessionSummaryRows(report.sections.sessionSummaryHealth),
    ),
    renderSection(
      "Section 5: Activation Health",
      buildActivationHealthRows(report.sections.activationHealth),
    ),
    renderSection(
      "Section 6: Review & Promotion Health",
      buildReviewPromotionRows(report.sections.reviewPromotionHealth),
    ),
    renderSection(
      "Section 7: Shadow Validation Summary",
      buildShadowValidationRows(report.sections.shadowValidationSummary),
    ),
  ];

  return sections.join("\n\n");
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const db = await openSqlJsDatabase(options.dbPath, { requireExists: true });

  try {
    const report = buildHealthReport(db, options.dbPath);

    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }

    console.log(renderReport(report));
  } finally {
    db.close();
  }
}

await main();
