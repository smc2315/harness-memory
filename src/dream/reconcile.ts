/**
 * reconcile — applies one validated extraction run to the database (spec §5.7 steps 1–8; §12 R1, R4, R5).
 *
 * Runs inside lock session 2's transaction (`Store.withWriteLock`); every fact gets its own SAVEPOINT so a
 * bad fact never poisons the batch. Order per fact:
 *   2 normalize (type boundary, trigger correction, semantic_key, failure classes)
 *   3 resolve the target: `t` = target_memory_id (following superseded_by), `m` = live row with the same
 *     semantic_key, else a Jaccard ≥ 0.6 neighbour of the same type with an intersecting scope
 *   4 create → reinforce(m) when a twin exists, else MemoryRepository.create({authority:'auto', status:'candidate'})
 *     + memory_provenance(origin) + recomputeDerived INSIDE the savepoint (R1: step 7 must see evidence_score)
 *   5 reinforce → provenance(reinforce) + recomputeDerived + revalidateMemory (auto active/stale), stale(ttl_expired) → active
 *   6 propose_supersede / propose_stale → replacement candidate row, provenance(contradict), openOrSupportProposal,
 *     auto demotion rule (two sessions) — human rows are only flagged contested
 *   7 decideTier for every created / reinforced auto candidate (replacement rows are always candidate)
 *   8 extraction_runs.outcomes_json, episodes.status = extracted, session_summaries upsert; the WriteOp carries the run id
 *
 * Step 1 (write_ops idempotency) is answered through `ctx.alreadyApplied(runId)`; a re-applied run only marks
 * the episode extracted (noop + wrote) so the store skips derive / generation / write_ops.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";

import type { Database as SqlJsDatabase } from "sql.js";

import { globMatchesPath, matchSignatureKey } from "../activation/signature";
import type { HarnessConfig } from "../core/config";
import type { EpisodeDescriptor } from "../core/episode-types";
import { EXTRACTOR_VERSION, type ExtractionOutput, type FactOutcome, type FactOutcomeKind } from "../core/extraction-types";
import { createDeterministicId, normalizeScopeGlob, normalizeSummary, semanticKey as computeSemanticKey } from "../core/ids";
import type { LedgerLine, NotifyFile } from "../core/ledger-types";
import { notifyFile as notifyFilePath, type HarnessPaths } from "../core/paths";
import {
  GLOBAL_SCOPE,
  LIVE_STATUSES,
  isGlobalScope,
  type KnowledgeKind,
  type MemoryStatus,
  type ProviderName,
  type RunStatus,
} from "../core/vocabulary";
import type { ActivationClass, LifecycleTrigger, MemoryType } from "../db/schema/types";
import { EpisodeRepository, type EpisodeRecord } from "../db/repositories/episodes";
import { ProposalRepository } from "../db/repositories/proposals";
import { ProvenanceRepository, recomputeDerived } from "../db/repositories/provenance";
import { ExtractionRunRepository } from "../db/repositories/runs";
import { selectOne } from "../db/sql";
import type { WriteOp } from "../db/store";
import { PROBE_FAILURE_CACHE_MS } from "./extract/providers/types";
import { createMemoryIdentityKey } from "../memory/utils";
import {
  DuplicateMemoryContentError,
  MemoryNotFoundError,
  MemoryRepository,
  type CreateMemoryInput,
  type MemoryRecord,
} from "../memory/repository";
import { decideTier, enforcementDefault } from "../promotion/authority";
import { evaluateAutoDemotion, openOrSupportProposal } from "../promotion/proposals";
import { revalidateMemory } from "../promotion/revalidate";
import { transitionMemory } from "../promotion/transitions";
import { scanMemoryContent } from "../security/scanner";
import { renderEventLine } from "./extract/prompt";
import type { ValidatedFact, ValidationResult } from "./extract/validate";

export const NEIGHBOUR_JACCARD = 0.6;
export const NEIGHBOUR_COSINE = 0.85;
export const RECENT_REJECT_DAYS = 30;
export const MAX_EXTRACTION_ATTEMPTS = 3;
/** Backoff after the n-th failed attempt (1-based); the third failure makes the episode `dead` (§9.4 F3). */
export const RETRY_BACKOFF_MS: readonly number[] = [60 * 60_000, 6 * 60 * 60_000];
/**
 * Provider-unavailable statuses do not burn an attempt; the episode is due again when the failed probe may be retried
 * (`PROBE_FAILURE_CACHE_MS`, ten minutes — m0-facts #3), so a login is picked up by the next worker run.
 */
export const PROVIDER_UNAVAILABLE_RETRY_MS = PROBE_FAILURE_CACHE_MS;

export const TYPE_IMPORTANCE: Readonly<Record<MemoryType, number>> = {
  policy: 0.8,
  architecture_constraint: 0.8,
  decision: 0.7,
  pitfall: 0.7,
  workflow: 0.6,
};

export interface ReconcileLogger {
  log(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface ReconcileRunInfo {
  provider: ProviderName;
  model: string | null;
  promptSha256: string;
  inputChars: number;
  startedAt: string;
  rawOutputRef: string | null;
}

export interface ReconcileContext {
  now: string;
  config: HarnessConfig;
  run: ReconcileRunInfo;
  /** Positional event id (`e1`, `e2`, … from buildExtractionPrompt) → ledger line; excerpts, provenance seqs and failure classes come from here. */
  seqMap: ReadonlyMap<string, LedgerLine>;
  /** The corrected episode when `descriptor.correction_for` is set (failure classes union, §5.7 step 2). */
  correctionForEpisode?: EpisodeRecord | null;
  /** When present, `activate_policy` proposals born from a correction write the session notify file (§7.4). */
  paths?: HarnessPaths | null;
  /** `WriteContext.alreadyApplied` from the store (step 1). */
  alreadyApplied: (opId: string) => boolean;
  logger?: ReconcileLogger;
}

export interface ReconcileInput {
  descriptor: EpisodeDescriptor;
  runId: string;
  validated: ValidationResult & { output?: ExtractionOutput | null };
  ctx: ReconcileContext;
}

export interface ReconcileReport {
  runId: string;
  status: RunStatus;
  outcomes: FactOutcome[];
  created: string[];
  reinforced: string[];
  activated: string[];
  proposals: string[];
  factsTotal: number;
  factsAccepted: number;
}

export type ReconcileWriteOp = WriteOp & { report: ReconcileReport };

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

function startOfUtcDay(iso: string): string {
  return `${iso.slice(0, 10)}T00:00:00.000Z`;
}

function addMs(iso: string, ms: number): string {
  return new Date(Date.parse(iso) + ms).toISOString();
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

export function summaryTokens(summary: string): Set<string> {
  return new Set(
    normalizeSummary(summary)
      .split(/[^\p{L}\p{N}]+/u)
      .filter((token) => token.length >= 2)
  );
}

export function jaccard(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  if (left.size === 0 && right.size === 0) return 0;
  let intersection = 0;
  for (const token of left) if (right.has(token)) intersection += 1;
  const union = left.size + right.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export function cosine(left: Float32Array, right: Float32Array): number {
  if (left.length !== right.length || left.length === 0) return 0;
  let dot = 0;
  let normLeft = 0;
  let normRight = 0;
  for (let i = 0; i < left.length; i += 1) {
    dot += left[i]! * right[i]!;
    normLeft += left[i]! * left[i]!;
    normRight += right[i]! * right[i]!;
  }
  return normLeft === 0 || normRight === 0 ? 0 : dot / Math.sqrt(normLeft * normRight);
}

const GLOB_MAGIC = /[*?[\]{}()!]/;

function literalPrefix(glob: string): string {
  const segments = glob.split("/");
  const literal: string[] = [];
  for (const segment of segments) {
    if (GLOB_MAGIC.test(segment)) break;
    literal.push(segment);
  }
  return literal.join("/");
}

/** Approximate glob/glob intersection: equality, a global side, or one glob covering the other's literal prefix. */
export function scopesIntersect(leftGlob: string, rightGlob: string): boolean {
  const left = normalizeScopeGlob(leftGlob);
  const right = normalizeScopeGlob(rightGlob);
  if (left === right) return true;
  if (isGlobalScope(left) || isGlobalScope(right)) return true;
  const leftPrefix = literalPrefix(left);
  const rightPrefix = literalPrefix(right);
  if (leftPrefix.length > 0 && globMatchesPath(right, leftPrefix)) return true;
  if (rightPrefix.length > 0 && globMatchesPath(left, rightPrefix)) return true;
  if (leftPrefix.length > 0 && rightPrefix.length > 0) {
    return leftPrefix.startsWith(`${rightPrefix}/`) || rightPrefix.startsWith(`${leftPrefix}/`);
  }
  return false;
}

function uniqueTriggers(triggers: readonly LifecycleTrigger[]): LifecycleTrigger[] {
  const order: LifecycleTrigger[] = ["session_start", "before_model", "before_tool", "after_tool"];
  const set = new Set(triggers);
  return order.filter((trigger) => set.has(trigger));
}

// ---------------------------------------------------------------------------------------------
// Step 2 — normalization
// ---------------------------------------------------------------------------------------------

export interface NormalizedFact {
  fact: ValidatedFact;
  type: MemoryType;
  scopeGlob: string;
  activationClass: ActivationClass;
  lifecycleTriggers: LifecycleTrigger[];
  relevantTools: string[] | null;
  signatureKey: string;
  semanticKey: string;
  knowledgeKind: KnowledgeKind;
  failureClasses: string[];
  relabels: string[];
}

export function normalizeFact(
  fact: ValidatedFact,
  descriptor: EpisodeDescriptor,
  seqMap: ReadonlyMap<string, LedgerLine>,
  correctionFor: EpisodeRecord | null | undefined
): NormalizedFact {
  const relabels = [...fact.relabels];
  const compiled = fact.compiledSignature;
  const hasSignature = compiled !== null && fact.trigger_signature !== null;
  let type: MemoryType = fact.type;

  // Type boundary: a correction / failure-resolution with a signature is a pitfall, not a policy.
  if (type === "policy" && hasSignature && (fact.knowledge_kind === "correction" || fact.knowledge_kind === "failure_resolution")) {
    type = "pitfall";
    relabels.push("policy_to_pitfall");
  }

  const scopeGlob = normalizeScopeGlob(fact.normalizedScope ?? fact.scope_glob);
  const commandWithoutPath = hasSignature && compiled.target === "command" && scopeGlob === GLOBAL_SCOPE;
  const activationClass: ActivationClass = commandWithoutPath ? "event" : "scoped";

  // Trigger correction.
  let triggers = uniqueTriggers(fact.lifecycle_triggers);
  const before = triggers.join(",");
  if (type === "decision" || type === "architecture_constraint") {
    triggers = uniqueTriggers([...triggers.filter((t) => t !== "before_tool"), "session_start", "before_model"]);
  } else if (hasSignature && (type === "pitfall" || type === "policy")) {
    triggers = uniqueTriggers([...triggers, "before_tool"]);
  } else if (!hasSignature && triggers.includes("before_tool") && type !== "pitfall" && type !== "policy") {
    triggers = uniqueTriggers([...triggers.filter((t) => t !== "before_tool"), "before_model"]);
  }
  if (triggers.length === 0) triggers = ["before_model"];
  if (triggers.join(",") !== before) relabels.push("triggers_adjusted");

  const signatureKey = hasSignature ? compiled.signature_key : "";
  const semanticKey = type === fact.type ? fact.semanticKey : computeSemanticKey(type, scopeGlob, signatureKey, fact.summary);

  const failureClasses = new Set<string>();
  for (const ref of fact.evidence_refs) {
    const line = seqMap.get(ref);
    if (line !== undefined && line.kind === "tool_fail") failureClasses.add(line.failure_class);
  }
  if (descriptor.correction_for !== null && correctionFor !== null && correctionFor !== undefined) {
    for (const entry of correctionFor.failureSignatures) failureClasses.add(entry.class);
  }

  const relevantTools = fact.relevant_tools.length > 0 ? [...new Set(fact.relevant_tools)] : null;

  return {
    fact,
    type,
    scopeGlob,
    activationClass,
    lifecycleTriggers: triggers,
    relevantTools,
    signatureKey,
    semanticKey,
    knowledgeKind: fact.knowledge_kind,
    failureClasses: [...failureClasses].sort(),
    relabels,
  };
}

// ---------------------------------------------------------------------------------------------
// Session notify file (§7.4)
// ---------------------------------------------------------------------------------------------

export function appendNotify(paths: HarnessPaths, host: string, sessionKey: string, message: string, now: string): void {
  const file = notifyFilePath(paths, host, sessionKey);
  let existing: NotifyFile | null = null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (typeof parsed === "object" && parsed !== null && Array.isArray((parsed as NotifyFile).messages)) existing = parsed as NotifyFile;
  } catch {
    existing = null;
  }
  const messages = [...(existing?.messages ?? []), message].slice(-5);
  const payload: NotifyFile = { schema: "notify.v1", messages, created_at: existing?.created_at ?? now };
  mkdirSync(paths.stateDir, { recursive: true });
  const tmp = `${file}.tmp-${String(process.pid)}`;
  writeFileSync(tmp, JSON.stringify(payload), "utf8");
  renameSync(tmp, file);
}

// ---------------------------------------------------------------------------------------------
// Session summaries (step 8)
// ---------------------------------------------------------------------------------------------

const SUMMARY_MEDIUM_MAX = 2_000;

export function upsertSessionSummary(
  db: SqlJsDatabase,
  input: { sessionId: string; summary: string; episodeId: string; tools: readonly string[]; typeDistribution: Record<string, number>; eventCount: number; now: string }
): void {
  const summary = oneLine(input.summary, 400);
  if (summary.length === 0) return;
  const existing = selectOne(db, "SELECT summary_medium, source_event_ids, tool_names, event_count FROM session_summaries WHERE session_id = ?", [input.sessionId]);
  const previousMedium = existing === null ? "" : String(existing.summary_medium ?? "");
  const mediumLines = previousMedium.length === 0 ? [] : previousMedium.split("\n");
  mediumLines.push(summary);
  let medium = mediumLines.join("\n");
  while (medium.length > SUMMARY_MEDIUM_MAX && mediumLines.length > 1) {
    mediumLines.shift();
    medium = mediumLines.join("\n");
  }
  const parseList = (value: unknown): string[] => {
    try {
      const parsed: unknown = JSON.parse(String(value ?? "[]"));
      return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
    } catch {
      return [];
    }
  };
  const sourceIds = [...new Set([...(existing === null ? [] : parseList(existing.source_event_ids)), input.episodeId])];
  const tools = [...new Set([...(existing === null ? [] : parseList(existing.tool_names)), ...input.tools])].sort();
  const typeDistribution: Record<string, number> = {};
  for (const key of Object.keys(input.typeDistribution).sort()) typeDistribution[key] = input.typeDistribution[key]!;
  const eventCount = (existing === null ? 0 : Number(existing.event_count ?? 0)) + input.eventCount;

  db.run(
    `
      INSERT INTO session_summaries (
        id, session_id, summary_short, summary_medium, embedding, source_event_ids, tool_names, type_distribution, event_count, created_at, updated_at
      )
      VALUES ($id, $sessionId, $short, $medium, NULL, $sourceIds, $tools, $types, $eventCount, $now, $now)
      ON CONFLICT(session_id) DO UPDATE SET
        summary_short = excluded.summary_short,
        summary_medium = excluded.summary_medium,
        source_event_ids = excluded.source_event_ids,
        tool_names = excluded.tool_names,
        type_distribution = excluded.type_distribution,
        event_count = excluded.event_count,
        updated_at = excluded.updated_at
    `,
    {
      $id: createDeterministicId(`session-summary:${input.sessionId}`),
      $sessionId: input.sessionId,
      $short: summary,
      $medium: medium,
      $sourceIds: JSON.stringify(sourceIds),
      $tools: JSON.stringify(tools),
      $types: JSON.stringify(typeDistribution),
      $eventCount: eventCount,
      $now: input.now,
    }
  );
}

// ---------------------------------------------------------------------------------------------
// Failure bookkeeping (§9.4 F3)
// ---------------------------------------------------------------------------------------------

export interface ExtractionFailureInput {
  episodeId: string;
  runId: string;
  run: ReconcileRunInfo;
  status: Exclude<RunStatus, "started" | "ok">;
  error: string;
  now: string;
  /** episodes.attempt_count after the lease that produced this failure. */
  attemptCount: number;
  outcomes?: readonly FactOutcome[];
  factsTotal?: number;
  /**
   * True when the failure describes the provider, not this episode (a probe that timed out or returned garbage
   * before any extraction call): the episode waits like a `no_provider` one instead of burning an attempt.
   */
  providerUnavailable?: boolean;
}

export interface ExtractionFailureResult {
  op: WriteOp;
  /** `retry` (failed, next_attempt_at set), `dead`, or `waiting` (provider unavailable: queued again without burning an attempt). */
  disposition: "retry" | "dead" | "waiting";
  nextAttemptAt: string | null;
}

export function isProviderUnavailable(status: RunStatus): boolean {
  return status === "no_provider" || status === "not_logged_in" || status === "nested_refusal";
}

/** Records a run that produced nothing to apply and schedules the episode (retry with backoff, dead, or waiting). */
export function recordExtractionFailure(db: SqlJsDatabase, input: ExtractionFailureInput): ExtractionFailureResult {
  const runs = new ExtractionRunRepository(db);
  const episodes = new EpisodeRepository(db);
  runs.start({
    id: input.runId,
    episodeId: input.episodeId,
    provider: input.run.provider,
    model: input.run.model,
    extractorVersion: EXTRACTOR_VERSION,
    promptSha256: input.run.promptSha256,
    inputChars: input.run.inputChars,
    startedAt: input.run.startedAt,
  });
  runs.finish(input.runId, {
    status: input.status,
    finishedAt: input.now,
    error: input.error,
    rawOutputRef: input.run.rawOutputRef,
    outcomes: input.outcomes ?? [],
    factsTotal: input.factsTotal ?? 0,
    factsAccepted: 0,
    model: input.run.model,
  });

  const op: WriteOp = { id: null, kind: "extract:failed", noop: true, wrote: true };
  if (input.providerUnavailable === true || isProviderUnavailable(input.status)) {
    const nextAttemptAt = addMs(input.now, PROVIDER_UNAVAILABLE_RETRY_MS);
    episodes.requeue(input.episodeId, { nextAttemptAt, undoAttempt: true, lastError: oneLine(`${input.status}: ${input.error}`, 2_000) });
    return { op, disposition: "waiting", nextAttemptAt };
  }
  if (input.attemptCount >= MAX_EXTRACTION_ATTEMPTS) {
    episodes.markFailed(input.episodeId, `${input.status}: ${input.error}`, { retryAt: null, dead: true });
    return { op, disposition: "dead", nextAttemptAt: null };
  }
  const backoff = RETRY_BACKOFF_MS[Math.min(RETRY_BACKOFF_MS.length, Math.max(1, input.attemptCount)) - 1] ?? RETRY_BACKOFF_MS[RETRY_BACKOFF_MS.length - 1]!;
  const nextAttemptAt = addMs(input.now, backoff);
  episodes.markFailed(input.episodeId, `${input.status}: ${input.error}`, { retryAt: nextAttemptAt });
  return { op, disposition: "retry", nextAttemptAt };
}

export function suspectRunStatus(reason: ValidationResult["suspectReason"]): Exclude<RunStatus, "started" | "ok"> {
  return reason === "schema" ? "invalid_output" : "suspect";
}

// ---------------------------------------------------------------------------------------------
// The reconcile
// ---------------------------------------------------------------------------------------------

interface RunState {
  db: SqlJsDatabase;
  descriptor: EpisodeDescriptor;
  runId: string;
  ctx: ReconcileContext;
  repository: MemoryRepository;
  provenance: ProvenanceRepository;
  proposals: ProposalRepository;
  outcomes: FactOutcome[];
  tierCandidates: Set<string>;
  created: string[];
  reinforced: string[];
  activated: string[];
  proposalIds: string[];
  activatedToday: number;
  activatedThisRun: number;
  isImport: boolean;
  hasHumanSignal: 0 | 1;
  lines: LedgerLine[];
}

function outcomeFor(fact: ValidatedFact, kind: FactOutcomeKind, extra: Partial<FactOutcome>, relabels: readonly string[]): FactOutcome {
  const outcome: FactOutcome = { ordinal: fact.ordinal, action: fact.action, outcome: kind, ...extra };
  if (relabels.length > 0) outcome.relabel = [...new Set(relabels)].join(",");
  return outcome;
}

function excerptFor(state: RunState, ref: string): string {
  const line = state.ctx.seqMap.get(ref);
  if (line === undefined) return "";
  return oneLine(renderEventLine(line, ref), 500);
}

function insertProvenance(state: RunState, memoryId: string, fact: ValidatedFact, relation: "origin" | "reinforce" | "contradict" | "import"): void {
  for (const ref of fact.evidence_refs) {
    state.provenance.insert({
      memoryId,
      episodeId: state.descriptor.id,
      eventSeq: state.isImport ? 0 : (state.ctx.seqMap.get(ref)?.seq ?? 0),
      relation,
      confidence: fact.confidence,
      excerpt: excerptFor(state, ref),
      extractionRunId: state.runId,
      createdAt: state.ctx.now,
    });
  }
}

/** Follows `superseded_by` from a terminal row to its live successor (≤ 10 hops). */
export function resolveTargetRow(repository: MemoryRepository, targetId: string | null): MemoryRecord | null {
  if (targetId === null) return null;
  let current = repository.getById(targetId);
  let hops = 0;
  while (current !== null && !(LIVE_STATUSES as readonly MemoryStatus[]).includes(current.status) && hops < 10) {
    if (current.supersededByMemoryId === null) return null;
    current = repository.getById(current.supersededByMemoryId);
    hops += 1;
  }
  return current !== null && (LIVE_STATUSES as readonly MemoryStatus[]).includes(current.status) ? current : null;
}

export function findNeighbour(repository: MemoryRepository, normalized: NormalizedFact): MemoryRecord | null {
  const tokens = summaryTokens(normalized.fact.summary);
  let best: { memory: MemoryRecord; score: number } | null = null;
  for (const memory of repository.list({ type: normalized.type, status: LIVE_STATUSES })) {
    if (!scopesIntersect(memory.scopeGlob, normalized.scopeGlob)) continue;
    const score = jaccard(tokens, summaryTokens(memory.summary));
    if (score >= NEIGHBOUR_JACCARD && (best === null || score > best.score)) best = { memory, score };
  }
  return best?.memory ?? null;
}

function recentlyRejected(repository: MemoryRepository, normalized: NormalizedFact, input: CreateMemoryInput, now: string): MemoryRecord | null {
  const since = Date.parse(now) - RECENT_REJECT_DAYS * 24 * 60 * 60_000;
  const candidates: Array<MemoryRecord | null> = [repository.getBySemanticKey(normalized.semanticKey, { live: false })];
  const identityKey = createMemoryIdentityKey({
    type: input.type,
    summary: input.summary,
    details: input.details,
    scopeGlob: input.scopeGlob,
    lifecycleTriggers: input.lifecycleTriggers,
  });
  candidates.push(repository.getByIdentityKey(identityKey, { live: false }));
  for (const row of candidates) {
    if (row !== null && row.status === "rejected" && Date.parse(row.updatedAt) >= since) return row;
  }
  return null;
}

function deterministicFor(state: RunState, target: MemoryRecord): 0 | 1 {
  if (target.signatureKey.length === 0 || target.triggerSignature === null || target.triggerSignature.pattern_kind !== "cmd") return 0;
  let ok = false;
  for (const line of state.lines) {
    if (line.kind !== "tool_ok" && line.kind !== "tool_fail") continue;
    if (!matchSignatureKey(target.signatureKey, line.input_digest, line.shell_dialect)) continue;
    if (line.kind === "tool_fail") return 0;
    ok = true;
  }
  return ok ? 1 : 0;
}

function createInputFor(state: RunState, normalized: NormalizedFact, supersedes: MemoryRecord | null): CreateMemoryInput {
  const { fact } = normalized;
  const hasSignature = fact.compiledSignature !== null && fact.trigger_signature !== null;
  const authority = state.isImport ? "human" : "auto";
  const knowledgeKind: KnowledgeKind = state.isImport ? "import" : normalized.knowledgeKind;
  const enforcement = enforcementDefault({
    type: normalized.type,
    authority,
    policySubtype: null,
    hasSignature,
    specificityOk: hasSignature,
    knowledgeKind,
    importUnconfirmed: state.isImport ? 1 : 0,
    config: state.ctx.config,
    summary: fact.summary,
  });
  return {
    type: normalized.type,
    summary: fact.summary,
    details: fact.details,
    scopeGlob: normalized.scopeGlob,
    activationClass: normalized.activationClass,
    lifecycleTriggers: normalized.lifecycleTriggers,
    confidence: fact.confidence,
    importance: TYPE_IMPORTANCE[normalized.type],
    status: state.isImport ? "active" : "candidate",
    supersedesMemoryId: supersedes?.id ?? null,
    relevantTools: normalized.relevantTools,
    promotionSource: state.isImport ? "manual" : "auto",
    authority,
    sourceKind: state.isImport ? "import" : "extraction",
    knowledgeKind,
    enforcement,
    triggerSignature: hasSignature ? fact.trigger_signature : null,
    signatureKey: normalized.signatureKey,
    semanticKey: normalized.semanticKey,
    aliases: fact.aliases,
    failureClasses: normalized.failureClasses,
    sourceRef: state.isImport ? state.descriptor.ledger_ref : `episode:${state.descriptor.id}`,
    importUnconfirmed: state.isImport ? 1 : 0,
    createdAt: state.ctx.now,
    updatedAt: state.ctx.now,
    lastVerifiedAt: state.descriptor.closed_at,
    reviveTerminal: true,
  };
}

type FactStep = { kind: "created"; memory: MemoryRecord } | { kind: "reinforced"; memory: MemoryRecord } | { kind: "skipped"; outcome: FactOutcome };

function createRow(state: RunState, normalized: NormalizedFact, supersedes: MemoryRecord | null): FactStep {
  const input = createInputFor(state, normalized, supersedes);
  const rejected = recentlyRejected(state.repository, normalized, input, state.ctx.now);
  if (rejected !== null) {
    return {
      kind: "skipped",
      outcome: outcomeFor(normalized.fact, "skipped", { rejection: "skipped_recent_reject", memory_id: rejected.id, detail: `rejected ${rejected.updatedAt}` }, normalized.relabels),
    };
  }
  let memory: MemoryRecord;
  try {
    memory = state.repository.create(input);
  } catch (error) {
    if (error instanceof DuplicateMemoryContentError && error.matchedBy !== "terminal_twin") {
      const twin = state.repository.getById(error.existingMemoryId);
      if (twin !== null) return reinforceRow(state, normalized, twin);
    }
    throw error;
  }
  insertProvenance(state, memory.id, normalized.fact, state.isImport ? "import" : "origin");
  recomputeDerived(state.db, memory.id);
  state.created.push(memory.id);
  if (memory.authority === "auto" && memory.status === "candidate") state.tierCandidates.add(memory.id);
  const refreshed = state.repository.getById(memory.id) ?? memory;
  return { kind: "created", memory: refreshed };
}

function reinforceRow(state: RunState, normalized: NormalizedFact, target: MemoryRecord): FactStep {
  insertProvenance(state, target.id, normalized.fact, state.isImport ? "import" : "reinforce");
  recomputeDerived(state.db, target.id);
  const closedAt = state.descriptor.closed_at;

  if (target.authority === "auto") {
    if (target.status === "active" || target.status === "stale") {
      revalidateMemory(state.db, target.id, { now: state.ctx.now, closedAt });
      if (target.status === "stale" && target.statusReason === "ttl_expired") {
        transitionMemory(state.db, { memoryId: target.id, to: "active", actor: "auto_rule", reason: "reinforce", now: state.ctx.now, runId: state.runId });
      }
    } else if (target.status === "candidate") {
      state.repository.setTtl(target.id, { ttlExpiresAt: target.ttlExpiresAt, revalidateAfter: target.revalidateAfter, lastVerifiedAt: closedAt, updatedAt: state.ctx.now });
      state.tierCandidates.add(target.id);
    }
    const aliases = [...new Set([...target.aliases, ...normalized.fact.aliases])];
    if (aliases.length !== target.aliases.length) state.repository.setAliases(target.id, aliases, state.ctx.now);
  } else {
    // Human rows: counters (recomputeDerived) and last_verified_at only; confidence / importance stay frozen.
    state.repository.setTtl(target.id, { ttlExpiresAt: target.ttlExpiresAt, revalidateAfter: target.revalidateAfter, lastVerifiedAt: closedAt, updatedAt: target.updatedAt });
  }

  state.reinforced.push(target.id);
  const refreshed = state.repository.getById(target.id) ?? target;
  return { kind: "reinforced", memory: refreshed };
}

function supportFor(state: RunState, target: MemoryRecord, confidence: number) {
  return {
    episodeId: state.descriptor.id,
    sessionId: state.descriptor.session_id,
    extractionRunId: state.runId,
    confidence,
    hasHumanSignal: state.hasHumanSignal,
    deterministic: deterministicFor(state, target),
  };
}

interface ProposalStep {
  proposalId: string;
  /** `auto_demotion:<effects>` when the §5.7 step 6 rule fired, else the support counts. */
  detail: string;
}

/** `memory_provenance(contradict)` + openOrSupportProposal + the auto demotion rule; null when a recent reject skips it. */
function supportProposal(state: RunState, normalized: NormalizedFact, target: MemoryRecord, kind: "supersede" | "stale", candidate: MemoryRecord | null): ProposalStep | null {
  const { fact } = normalized;
  insertProvenance(state, target.id, fact, "contradict");
  const opened = openOrSupportProposal(state.db, {
    kind,
    targetMemoryId: target.id,
    candidateMemoryId: candidate?.id ?? null,
    rationale: oneLine(fact.rationale.length > 0 ? fact.rationale : fact.summary, 300),
    confidence: fact.confidence,
    createdBy: "extractor",
    now: state.ctx.now,
    expiresInDays: state.ctx.config.retention.proposal_days,
    support: supportFor(state, target, fact.confidence),
  });
  if (opened.proposalId === null) return null;
  state.proposalIds.push(opened.proposalId);
  const demotion = evaluateAutoDemotion(state.db, { proposalId: opened.proposalId, now: state.ctx.now, runId: state.runId });
  const detail = demotion.applied ? `auto_demotion:${demotion.decision?.effects.join("|") ?? ""}` : `support=${String(opened.supportCount)}/${String(opened.supportSessions)} (${demotion.reason})`;
  return { proposalId: opened.proposalId, detail };
}

function proposeAgainst(state: RunState, normalized: NormalizedFact, target: MemoryRecord, kind: "supersede" | "stale", candidate: MemoryRecord | null): FactOutcome {
  const { fact } = normalized;
  const step = supportProposal(state, normalized, target, kind, candidate);
  if (step === null) {
    return outcomeFor(fact, "skipped", { rejection: "skipped_recent_reject", memory_id: target.id, detail: "proposal rejected within 30 days" }, normalized.relabels);
  }
  return outcomeFor(
    fact,
    kind === "supersede" ? "superseded_proposed" : "proposed",
    { memory_id: candidate?.id ?? target.id, proposal_id: step.proposalId, detail: step.detail },
    normalized.relabels
  );
}

function isLiveRow(memory: MemoryRecord): boolean {
  return (LIVE_STATUSES as readonly MemoryStatus[]).includes(memory.status);
}

/** True when `candidate` is the replacement row an earlier run proposed for `target` (§5.7 step 6). */
function isReplacementOf(state: RunState, candidate: MemoryRecord, target: MemoryRecord): boolean {
  if (candidate.id === target.id) return false;
  return candidate.supersedesMemoryId === target.id || state.proposals.findOpen("supersede", target.id, candidate.id) !== null;
}

/**
 * A later session that reproduces an existing replacement row (`reinforce` on it, or a `create` that collapsed into
 * its live twin) is the same claim as the open `supersede` proposal(s) carrying that row as candidate: add this
 * session's support so the two-session rule of §5.7 step 6 can supersede the target and activate the replacement.
 */
function supportReplacementProposals(state: RunState, normalized: NormalizedFact, candidate: MemoryRecord): ProposalStep | null {
  if (candidate.authority !== "auto" || candidate.status !== "candidate") return null;
  let step: ProposalStep | null = null;
  for (const proposal of state.proposals.listOpen({ kind: "supersede", candidateId: candidate.id })) {
    const target = state.repository.getById(proposal.targetMemoryId);
    if (target === null || !isLiveRow(target)) continue;
    const supported = supportProposal(state, normalized, target, "supersede", candidate);
    if (supported !== null) step = step === null ? supported : { proposalId: step.proposalId, detail: `${step.detail}; ${supported.detail}` };
  }
  return step;
}

function applyFact(state: RunState, fact: ValidatedFact): FactOutcome {
  const normalized = normalizeFact(fact, state.descriptor, state.ctx.seqMap, state.ctx.correctionForEpisode);
  const target = resolveTargetRow(state.repository, fact.target_memory_id);
  const sameKey = state.repository.getBySemanticKey(normalized.semanticKey);
  const hasSignature = fact.compiledSignature !== null && fact.trigger_signature !== null;

  switch (fact.action) {
    case "create":
    case "reinforce": {
      let twin = target ?? sameKey;
      if (twin === null && fact.action === "create") {
        const neighbour = findNeighbour(state.repository, normalized);
        if (neighbour !== null && !(neighbour.signatureKey.length === 0 && hasSignature)) twin = neighbour;
      }
      const step = twin !== null ? reinforceRow(state, normalized, twin) : createRow(state, normalized, null);
      if (step.kind === "skipped") return step.outcome;
      const outcome = outcomeFor(fact, step.kind, { memory_id: step.memory.id, detail: step.kind === "reinforced" && twin !== null ? `target=${twin.id}` : undefined }, normalized.relabels);
      if (step.kind === "reinforced") {
        // Reinforcing a proposed replacement row supports its open supersede proposal (same claim, §7.5).
        const supported = supportReplacementProposals(state, normalized, step.memory);
        if (supported !== null) {
          outcome.proposal_id = supported.proposalId;
          outcome.detail = outcome.detail === undefined ? supported.detail : `${outcome.detail}; ${supported.detail}`;
        }
      }
      return outcome;
    }
    case "propose_supersede": {
      const resolved = target ?? sameKey;
      if (resolved === null) return outcomeFor(fact, "rejected", { rejection: "rejected_no_target" }, normalized.relabels);
      if (resolved.semanticKey !== null && resolved.semanticKey === normalized.semanticKey) {
        // Same claim as the target: reinforce it and ask for `stale` instead of a duplicate replacement.
        reinforceRow(state, normalized, resolved);
        return proposeAgainst(state, normalized, resolved, "stale", null);
      }
      const replacement = createRow(state, normalized, resolved);
      if (replacement.kind === "skipped") return replacement.outcome;
      if (replacement.kind === "reinforced") {
        // The replacement already exists (an earlier session proposed it): the same (supersede, target, candidate)
        // proposal gains this session's support, which is the only way §5.7 step 6 can activate a replacement.
        if (isReplacementOf(state, replacement.memory, resolved)) return proposeAgainst(state, normalized, resolved, "supersede", replacement.memory);
        return proposeAgainst(state, normalized, resolved, "stale", null);
      }
      return proposeAgainst(state, normalized, resolved, "supersede", replacement.memory);
    }
    case "propose_stale": {
      const resolved = target ?? sameKey;
      if (resolved === null) return outcomeFor(fact, "rejected", { rejection: "rejected_no_target" }, normalized.relabels);
      return proposeAgainst(state, normalized, resolved, "stale", null);
    }
  }
}

function countAutoActivationsSince(db: SqlJsDatabase, startIso: string): number {
  const row = selectOne(db, "SELECT COUNT(*) AS n FROM memory_transitions WHERE actor = 'auto_rule' AND to_status = 'active' AND created_at >= ?", [startIso]);
  return row === null ? 0 : Number(row.n ?? 0);
}

function writeAudit(db: SqlJsDatabase, eventType: string, id: string, summary: string, details: unknown, now: string, sessionId: string | null): void {
  db.run(
    `INSERT OR IGNORE INTO audit_log (id, event_type, session_id, scope_ref, summary, details_json, created_at)
     VALUES (?, ?, ?, NULL, ?, ?, ?)`,
    [id, eventType, sessionId, summary, JSON.stringify(details), now]
  );
}

function decideTiers(state: RunState): void {
  const { config } = state.ctx;
  for (const memoryId of state.tierCandidates) {
    const memory = state.repository.getById(memoryId);
    if (memory === null || memory.authority !== "auto" || memory.status !== "candidate") continue;
    const supersedesLive = memory.supersedesMemoryId !== null && resolveTargetRow(state.repository, memory.supersedesMemoryId) !== null;
    const isReplacementRow = supersedesLive || state.proposals.listOpen({ candidateId: memory.id }).length > 0;
    const hasSignature = memory.triggerSignature !== null && memory.signatureKey.length > 0;
    const decision = decideTier({
      memory: {
        type: memory.type,
        scopeGlob: memory.scopeGlob,
        hasSignature,
        signatureTool: memory.triggerSignature?.tool ?? null,
        relevantTools: memory.relevantTools,
        lifecycleTriggers: memory.lifecycleTriggers,
        confidence: memory.confidence,
        authority: memory.authority,
      },
      evidenceScore: memory.evidenceScore,
      capsRemaining: {
        episode: config.extraction.max_auto_activations_per_episode - state.activatedThisRun,
        day: config.extraction.max_auto_activations_per_day - state.activatedToday,
      },
      autonomyLevel: config.autonomy_level,
      knowledgeKind: memory.knowledgeKind,
      isReplacementRow,
      // The validator (V6) already rejected unsafe facts of this run; the stored text of a row that predates
      // v0.6 (or was imported) is scanned here so a legacy candidate cannot auto-activate with unsafe text.
      scanSafe: scanMemoryContent(memory.summary, memory.details).safe,
      now: state.ctx.now,
    });

    const outcome =
      state.outcomes.find((entry) => entry.memory_id === memory.id && (entry.outcome === "created" || entry.outcome === "reinforced")) ??
      state.outcomes.find((entry) => entry.memory_id === memory.id && entry.outcome === "superseded_proposed");

    if (decision.status === "active") {
      transitionMemory(state.db, { memoryId: memory.id, to: "active", actor: "auto_rule", reason: "decideTier", now: state.ctx.now, runId: state.runId });
      state.repository.setTtl(memory.id, {
        ttlExpiresAt: decision.ttlExpiresAt ?? null,
        revalidateAfter: decision.revalidateAfter ?? null,
        validationCount: Math.max(0, memory.evidenceCount - 1),
        updatedAt: state.ctx.now,
      });
      state.activated.push(memory.id);
      state.activatedThisRun += 1;
      state.activatedToday += 1;
      if (outcome !== undefined) {
        if (outcome.outcome === "created" || outcome.outcome === "reinforced") outcome.outcome = "activated";
        outcome.detail = outcome.detail === undefined ? "tier=active" : `${outcome.detail}; tier=active`;
      }
      continue;
    }

    if (decision.shadow === "active") {
      writeAudit(
        state.db,
        "auto_activation_shadow",
        createDeterministicId(`audit:auto_activation_shadow:${state.runId}:${memory.id}`),
        `shadow: ${memory.type} ${oneLine(memory.summary, 80)} would activate`,
        { memoryId: memory.id, runId: state.runId, evidenceScore: memory.evidenceScore, confidence: memory.confidence },
        state.ctx.now,
        state.descriptor.session_id
      );
    }

    if (decision.proposal !== undefined) {
      const opened = openOrSupportProposal(state.db, {
        kind: decision.proposal,
        targetMemoryId: memory.id,
        rationale: `${decision.proposal}: ${oneLine(memory.summary, 200)}`,
        confidence: memory.confidence,
        createdBy: "extractor",
        now: state.ctx.now,
        expiresInDays: config.retention.proposal_days,
        support: supportFor(state, memory, memory.confidence),
      });
      if (opened.proposalId !== null) {
        state.proposalIds.push(opened.proposalId);
        if (outcome !== undefined) outcome.proposal_id = opened.proposalId;
        if (decision.proposal === "activate_policy" && state.descriptor.flags.correction === 1 && state.ctx.paths !== undefined && state.ctx.paths !== null) {
          try {
            appendNotify(
              state.ctx.paths,
              state.descriptor.host,
              state.descriptor.session_key,
              `harness-memory: a policy learned from your correction awaits review (hm review): ${oneLine(memory.summary, 120)}`,
              state.ctx.now
            );
          } catch (error) {
            state.ctx.logger?.warn(`notify file not written: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      }
    }

    if (outcome !== undefined) {
      const reason = decision.reason ?? "candidate";
      outcome.detail = outcome.detail === undefined ? `tier=candidate:${reason}` : `${outcome.detail}; tier=candidate:${reason}`;
    }
  }
}

/**
 * Applies a validated run. Returns the WriteOp for the store (`id = runId`) with the report attached.
 * A suspect validation result (breaker) is recorded as a failed run instead (`suspect` / `invalid_output`).
 */
export function reconcileRun(db: SqlJsDatabase, input: ReconcileInput): ReconcileWriteOp {
  const { descriptor, runId, validated, ctx } = input;
  const episodes = new EpisodeRepository(db);
  const episode = episodes.getById(descriptor.id);

  // Step 1: idempotency.
  if (ctx.alreadyApplied(runId)) {
    const wrote = episode !== null && episode.status !== "extracted";
    if (wrote) episodes.markExtracted(descriptor.id, runId);
    const report: ReconcileReport = { runId, status: "ok", outcomes: [], created: [], reinforced: [], activated: [], proposals: [], factsTotal: 0, factsAccepted: 0 };
    return { id: runId, kind: "extract", noop: true, wrote, report };
  }

  if (validated.suspect) {
    const status = suspectRunStatus(validated.suspectReason);
    const failure = recordExtractionFailure(db, {
      episodeId: descriptor.id,
      runId,
      run: ctx.run,
      status,
      error: `validation breaker: ${validated.suspectReason ?? "suspect"}`,
      now: ctx.now,
      attemptCount: episode?.attemptCount ?? 1,
      outcomes: validated.outcomes,
      factsTotal: validated.outcomes.length,
    });
    const report: ReconcileReport = { runId, status, outcomes: [...validated.outcomes], created: [], reinforced: [], activated: [], proposals: [], factsTotal: validated.outcomes.length, factsAccepted: 0 };
    return { ...failure.op, report };
  }

  const runs = new ExtractionRunRepository(db);
  runs.start({
    id: runId,
    episodeId: descriptor.id,
    provider: ctx.run.provider,
    model: ctx.run.model,
    extractorVersion: EXTRACTOR_VERSION,
    promptSha256: ctx.run.promptSha256,
    inputChars: ctx.run.inputChars,
    startedAt: ctx.run.startedAt,
  });

  const state: RunState = {
    db,
    descriptor,
    runId,
    ctx,
    repository: new MemoryRepository(db, { clock: () => ctx.now }),
    provenance: new ProvenanceRepository(db),
    proposals: new ProposalRepository(db),
    outcomes: [...validated.outcomes],
    tierCandidates: new Set(),
    created: [],
    reinforced: [],
    activated: [],
    proposalIds: [],
    activatedToday: countAutoActivationsSince(db, startOfUtcDay(ctx.now)),
    activatedThisRun: 0,
    isImport: descriptor.host === "import",
    hasHumanSignal: descriptor.flags.correction === 1 || descriptor.flags.remember === 1 ? 1 : 0,
    lines: [...ctx.seqMap.values()],
  };

  validated.accepted.forEach((fact, index) => {
    const savepoint = `sp_fact_${String(index)}`;
    db.run(`SAVEPOINT ${savepoint}`);
    try {
      state.outcomes.push(applyFact(state, fact));
      db.run(`RELEASE ${savepoint}`);
    } catch (error) {
      db.run(`ROLLBACK TO ${savepoint}`);
      db.run(`RELEASE ${savepoint}`);
      const message = error instanceof Error ? error.message : String(error);
      ctx.logger?.warn(`fact ${String(fact.ordinal)} rolled back: ${message}`);
      state.outcomes.push(outcomeFor(fact, "skipped", { detail: `error: ${oneLine(message, 200)}` }, fact.relabels));
    }
  });

  // Step 7 runs in its own savepoint per candidate decision.
  db.run("SAVEPOINT sp_tiers");
  try {
    decideTiers(state);
    db.run("RELEASE sp_tiers");
  } catch (error) {
    db.run("ROLLBACK TO sp_tiers");
    db.run("RELEASE sp_tiers");
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof MemoryNotFoundError) ctx.logger?.warn(`tier decision skipped: ${message}`);
    else ctx.logger?.error(`tier decisions rolled back: ${message}`);
  }

  state.outcomes.sort((a, b) => a.ordinal - b.ordinal);
  const factsTotal = validated.accepted.length + validated.outcomes.filter((entry) => entry.rejection !== "schema").length;
  const applied = new Set<FactOutcomeKind>(["created", "reinforced", "proposed", "superseded_proposed", "activated"]);
  const factsAccepted = state.outcomes.filter((entry) => applied.has(entry.outcome)).length;

  runs.finish(runId, {
    status: "ok",
    finishedAt: ctx.now,
    factsTotal,
    factsAccepted,
    rawOutputRef: ctx.run.rawOutputRef,
    outcomes: state.outcomes,
    model: ctx.run.model,
  });
  episodes.markExtracted(descriptor.id, runId);

  const summary = validated.output?.episode_summary ?? "";
  if (summary.length > 0) {
    const typeDistribution: Record<string, number> = {};
    for (const fact of validated.accepted) typeDistribution[fact.type] = (typeDistribution[fact.type] ?? 0) + 1;
    upsertSessionSummary(db, {
      sessionId: descriptor.session_id,
      summary,
      episodeId: descriptor.id,
      tools: descriptor.tools,
      typeDistribution,
      eventCount: descriptor.event_count,
      now: ctx.now,
    });
  }

  const report: ReconcileReport = {
    runId,
    status: "ok",
    outcomes: state.outcomes,
    created: state.created,
    reinforced: [...new Set(state.reinforced)],
    activated: state.activated,
    proposals: [...new Set(state.proposalIds)],
    factsTotal,
    factsAccepted,
  };
  return { id: runId, kind: "extract", noop: false, wrote: true, report };
}
