/**
 * reconcile — applies one validated extraction run to the database (spec §5.7 steps 1–8; §12 R1, R4, R5).
 *
 * Runs inside lock session 2's transaction (`Store.withWriteLock`); every fact gets its own SAVEPOINT so a
 * bad fact never poisons the batch. Order per fact:
 *   2 normalize (type boundary, trigger correction, semantic_key, failure classes)
 *   3 resolve the target: `t` = target_memory_id (following superseded_by), `m` = live row with the same
 *     semantic_key, else a neighbour of the same type with an intersecting scope (findNeighbour: Jaccard ≥ 0.6 on
 *     the summary, or — 0.6.0-rc.2 design §4 — signature keys that are equal or name one mistake (signatureKeysTwin),
 *     ≥ 2 shared aliases, a shared error-code token corroborated by wording or an alias; the two soft rules never pair
 *     two distinct signatures, and a signature-bearing fact is never absorbed by a signature-less row)
 *   4 create → reinforce(m) when a twin exists, else MemoryRepository.create({authority:'auto', status:'candidate'})
 *     + memory_provenance(origin) + recomputeDerived INSIDE the savepoint (R1: step 7 must see evidence_score). A
 *     create whose text already lives as a signature-less auto row (identity_key twin) adopts its signature onto that
 *     row before the reinforce (adoptSignatureOntoTwin — on the automatic path, the remember path and for
 *     propose_supersede replacements alike; never onto a human row or past an open / human-rejected activate_* proposal).
 *     The row is born with the validator's signature_precision, the signature's side_effect and the fact's horizon
 *     (migration 023), which enforcementDefault reads for the silent-write soft_deny birth (design §3 rule 1); a
 *     reinforce leaves the three stored values alone
 *   5 reinforce → provenance(reinforce) + recomputeDerived + revalidateMemory (auto active/stale), stale(ttl_expired) → active
 *   6 propose_supersede / propose_stale → replacement candidate row, provenance(contradict), openOrSupportProposal,
 *     auto demotion rule (two sessions) — human rows are only flagged contested
 *   7 decideTier for every created / reinforced auto candidate (replacement rows are always candidate). Under
 *     `autonomy_level` full (design §1) nothing opens a proposal or writes the notify file; decision /
 *     architecture_constraint activations are counted against `extraction.max_auto_knowledge_activations_per_day`,
 *     separately from the pitfall / workflow / policy caps
 *   8 extraction_runs.outcomes_json, episodes.status = extracted, session_summaries upsert; the WriteOp carries the run id
 *
 * Step 1 (write_ops idempotency) is answered through `ctx.alreadyApplied(runId)`; a re-applied run only marks
 * the episode extracted (noop + wrote) so the store skips derive / generation / write_ops.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";

import type { Database as SqlJsDatabase } from "sql.js";

import { compileSignatureKey, globMatchesPath, matchSignatureKey, parseSignatureKey } from "../activation/signature";
import type { HarnessConfig } from "../core/config";
import type { EpisodeDescriptor } from "../core/episode-types";
import { EXTRACTOR_VERSION, type ExtractionOutput, type FactOutcome, type FactOutcomeKind } from "../core/extraction-types";
import { createDeterministicId, normalizeScopeGlob, normalizeSummary, semanticKey as computeSemanticKey } from "../core/ids";
import type { LedgerLine, NotifyFile } from "../core/ledger-types";
import { notifyFile as notifyFilePath, type HarnessPaths } from "../core/paths";
import {
  ENFORCEMENT_RANK,
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
import { normalizeRecallSummary } from "./recall-summary";
import { createMemoryIdentityKey } from "../memory/utils";
import {
  DuplicateMemoryContentError,
  MemoryNotFoundError,
  MemoryRepository,
  type CreateMemoryInput,
  type DuplicateMatchKind,
  type MemoryRecord,
} from "../memory/repository";
import { decideTier, enforcementDefault } from "../promotion/authority";
import { escalateOnReinforce } from "../promotion/escalation";
import { ACTIVATION_PROPOSAL_KINDS, evaluateAutoDemotion, humanRejectedActivation, openOrSupportProposal } from "../promotion/proposals";
import { citesRememberPrompt, REMEMBER_MAX_PER_EPISODE, REMEMBER_STATUS_REASON, rememberEnforcement, rememberTransitionReason } from "../promotion/remember";
import { revalidateMemory } from "../promotion/revalidate";
import { adoptActiveMemory, transitionMemory } from "../promotion/transitions";
import { scanMemoryContent } from "../security/scanner";
import { renderEventLine } from "./extract/prompt";
import type { ValidatedFact, ValidationResult } from "./extract/validate";

export const NEIGHBOUR_JACCARD = 0.6;
export const NEIGHBOUR_COSINE = 0.85;
/** 0.6.0-rc.2 design §4: shared case-folded aliases that make two live rows of one type twins without a Jaccard hit. */
export const NEIGHBOUR_MIN_SHARED_ALIASES = 2;
/**
 * Summary Jaccard from which a shared error-code token counts (design §4): the code shapes also read Jira keys,
 * RFC / ISO numbers or JWT algorithm names, so a shared token needs this much common wording — or one shared alias —
 * before it makes two rows twins.
 */
export const NEIGHBOUR_CORROBORATION_JACCARD = 0.2;
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
  /** A′ ladder: auto rows this run raised from advise to soft_deny (src/promotion/escalation.ts). */
  escalated: string[];
  /** A′ remember-as-human: rows made active human by the user's own request (src/promotion/remember.ts). */
  remembered: string[];
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
// Neighbour rules (step 3; 0.6.0-rc.2 design §4)
// ---------------------------------------------------------------------------------------------

/**
 * Error-code shapes: `C001`, `G006`, `P003`, `E0308`; `ERROR 1054`; `JDBC-11021`, `ORA-00942`. Upper-case only — a code
 * is quoted the way the tool printed it — and matched over summary + details of both rows. The shapes are loose on
 * purpose and also catch Jira keys (`PROJ-1234`), RFC / ISO numbers, JWT algorithms (`RS256`) or GPU names, which is
 * why a shared token is only a corroborating signal in neighbourRulesFor (NEIGHBOUR_CORROBORATION_JACCARD or a shared
 * alias), never a match on its own.
 */
const ERROR_CODE_PATTERNS: readonly RegExp[] = [/\b[A-Z]{1,4}[0-9]{3,4}\b/g, /\bERROR [0-9]{4}\b/g, /\b[A-Z]+-[0-9]{4,5}\b/g];
/** A four-digit run that reads as a year (`FY2026`, `CVE-2026`, `ERROR 2026`) names a date, not a failure. */
const YEAR_DIGITS = /^(?:19|20)[0-9]{2}$/;
/** Upper-case technical names of the first shape that name an algorithm or a standard rather than a failure. */
export const ERROR_CODE_STOPLIST: ReadonlySet<string> = new Set([
  "SHA256",
  "SHA384",
  "SHA512",
  "AES128",
  "AES192",
  "AES256",
  "RSA2048",
  "RSA4096",
  "ISO8601",
  "X509",
  "H264",
  "H265",
]);

/** Error-code tokens of a text (design §4), years and the stoplist excluded; compared verbatim between two rows. */
export function errorCodeTokens(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const pattern of ERROR_CODE_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const token = match[0];
      const digits = /[0-9]+$/.exec(token)?.[0] ?? "";
      if (YEAR_DIGITS.test(digits) || ERROR_CODE_STOPLIST.has(token)) continue;
      tokens.add(token);
    }
  }
  return tokens;
}

/**
 * Design §2 / §4: two non-empty signature keys name one mistake when they are equal ("signature_key"), or when they
 * parse (activation/signature.ts parseSignatureKey) to the same tool, target, pattern kind and negation and the
 * matcher of either would fire on what the other names ("signature_substring"):
 *   - cmd: both keys are rebuilt into the matcher the hooks run (compileSignatureKey: the §4.6 canonical tokens, where
 *     `npm test` folds to `pm test` and `pnpm dlx vitest` to `bin vitest`, plus the literal program a folded pattern
 *     pins — `npm`, `pnpm dlx`, `npx`; none for the family words `pm` / `bin` and for unfolded programs such as `git`).
 *     Twins need the same pinned program (a pinned manager and an unpinned family word differ: `npm test` / `pm test`
 *     is no twin), the same first canonical token, and every remaining token of the shorter pattern among the longer
 *     one's — the matcher is order-insensitive after the program, so a stored `npm test` already fires on
 *     `npm test --coverage`. `npm test` / `npm test:e2e` are two scripts, `npm` / `pnpm` two managers, and a two-token
 *     program is not its first word (`pnpm dlx vitest run` / `pnpm vitest run`, `npm exec vitest` / `npm vitest`):
 *     no twin;
 *   - substring: one pattern contains the other;
 *   - glob and regex: equality only (`.env` is not `.env.example`, a longer regex is not a narrower one).
 * A negated key is never the twin of a plain one; another tool, target or kind, or a key that does not parse or
 * compile, is null.
 */
export function signatureKeysTwin(left: string, right: string): "signature_key" | "signature_substring" | null {
  if (left.length === 0 || right.length === 0) return null;
  if (left === right) return "signature_key";
  const a = parseSignatureKey(left);
  const b = parseSignatureKey(right);
  if (a === null || b === null) return null;
  if (a.tool !== b.tool || a.target !== b.target || a.pattern_kind !== b.pattern_kind || a.negate !== b.negate) return null;
  if (a.pattern.length === 0 || b.pattern.length === 0) return null;
  switch (a.pattern_kind) {
    case "cmd": {
      const compiledA = compileSignatureKey(left);
      const compiledB = compileSignatureKey(right);
      if (compiledA === null || compiledB === null || compiledA.tokens === null || compiledB.tokens === null) return null;
      // `program` is the literal a folded pattern pins (`npm`, `pnpm dlx`); absent on both sides is a match too.
      if ((compiledA.program ?? null) !== (compiledB.program ?? null)) return null;
      const aTokens = compiledA.tokens;
      const bTokens = compiledB.tokens;
      const [shorter, longer] = aTokens.length <= bTokens.length ? [aTokens, bTokens] : [bTokens, aTokens];
      if (shorter.length === 0 || shorter[0] !== longer[0]) return null;
      return shorter.slice(1).every((token) => longer.includes(token)) ? "signature_substring" : null;
    }
    case "substring":
      return a.pattern.includes(b.pattern) || b.pattern.includes(a.pattern) ? "signature_substring" : null;
    case "glob":
    case "regex":
      return null;
  }
}

function foldedAliases(aliases: readonly string[]): Set<string> {
  const folded = new Set<string>();
  for (const alias of aliases) {
    const key = alias.trim().toLowerCase();
    if (key.length > 0) folded.add(key);
  }
  return folded;
}

/** Number of aliases two rows share after trimming and case-folding (design §4: ≥ NEIGHBOUR_MIN_SHARED_ALIASES makes twins). */
export function sharedAliasCount(left: readonly string[], right: readonly string[]): number {
  const rightSet = foldedAliases(right);
  let shared = 0;
  for (const alias of foldedAliases(left)) if (rightSet.has(alias)) shared += 1;
  return shared;
}

export type NeighbourRule = "jaccard" | "signature_key" | "signature_substring" | "aliases" | "error_code";

export interface NeighbourMatch {
  memory: MemoryRecord;
  /** Token Jaccard of the two summaries — the tie-breaker among several matches, whatever rule matched. */
  score: number;
  /** Every rule that matched, in the order above; never empty. */
  rules: NeighbourRule[];
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
  escalated: string[];
  remembered: string[];
  /** Today's / this run's auto activations of pitfall / workflow / policy rows (extraction.max_auto_activations_per_day / _per_episode). */
  activatedToday: number;
  activatedThisRun: number;
  /** 0.6.0-rc.2: today's auto activations of decision / architecture_constraint rows (extraction.max_auto_knowledge_activations_per_day). */
  knowledgeActivatedToday: number;
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

interface NeighbourProbe {
  tokens: Set<string>;
  aliases: readonly string[];
  codes: Set<string>;
}

function neighbourProbe(normalized: NormalizedFact): NeighbourProbe {
  const { fact } = normalized;
  return { tokens: summaryTokens(fact.summary), aliases: fact.aliases, codes: errorCodeTokens(`${fact.summary}\n${fact.details}`) };
}

function neighbourRulesFor(normalized: NormalizedFact, probe: NeighbourProbe, memory: MemoryRecord): { score: number; rules: NeighbourRule[] } {
  const score = jaccard(probe.tokens, summaryTokens(memory.summary));
  const rules: NeighbourRule[] = [];
  if (score >= NEIGHBOUR_JACCARD) rules.push("jaccard");
  const keyRule = signatureKeysTwin(normalized.signatureKey, memory.signatureKey);
  if (keyRule !== null) rules.push(keyRule);
  // Two signatures that are no twins name two different mistakes of one kind (`npm test` / `npm build`, two SQL typos
  // quoting the same ERROR 1054): shared aliases or codes never fold them — only the wording (jaccard above) can. A
  // reinforce keeps the row's signature, so a wrong fold here would lose the second mistake's signature for good.
  const distinctMistakes = normalized.signatureKey.length > 0 && memory.signatureKey.length > 0 && keyRule === null;
  if (distinctMistakes) return { score, rules };
  const sharedAliases = sharedAliasCount(probe.aliases, memory.aliases);
  if (sharedAliases >= NEIGHBOUR_MIN_SHARED_ALIASES) rules.push("aliases");
  // An error-code token corroborates a match it cannot make alone (see ERROR_CODE_PATTERNS): the rows must also share
  // some wording (NEIGHBOUR_CORROBORATION_JACCARD) or one alias.
  if (probe.codes.size > 0 && (score >= NEIGHBOUR_CORROBORATION_JACCARD || sharedAliases >= 1)) {
    const memoryCodes = errorCodeTokens(`${memory.summary}\n${memory.details}`);
    for (const code of probe.codes) {
      if (memoryCodes.has(code)) {
        rules.push("error_code");
        break;
      }
    }
  }
  return { score, rules };
}

/**
 * The step 3 rules (§5.7; 0.6.0-rc.2 design §4) that make a live row of the fact's type with an intersecting scope its
 * twin: summary Jaccard ≥ NEIGHBOUR_JACCARD; signature keys that are equal or name one mistake (signatureKeysTwin);
 * ≥ NEIGHBOUR_MIN_SHARED_ALIASES shared aliases; a shared error-code token when the summaries also reach
 * NEIGHBOUR_CORROBORATION_JACCARD or the rows share an alias. The alias and error-code rules are skipped when both
 * sides carry a signature and the keys are no twins (two distinct mistakes of one kind). Empty when the row is no
 * twin — including every signature-less row when the fact carries a signature (§5.7: a signature is never absorbed by
 * a row without one), and every row of another type or a disjoint scope.
 */
export function neighbourRules(normalized: NormalizedFact, memory: MemoryRecord): NeighbourRule[] {
  if (memory.type !== normalized.type || !isLiveRow(memory)) return [];
  if (!scopesIntersect(memory.scopeGlob, normalized.scopeGlob)) return [];
  if (normalized.signatureKey.length > 0 && memory.signatureKey.length === 0) return [];
  return neighbourRulesFor(normalized, neighbourProbe(normalized), memory).rules;
}

/**
 * Step 3 neighbour: among the live rows of the fact's type whose scope intersects (and, for a signature-bearing fact,
 * that carry a signature themselves), every row that matches any rule is a candidate and the one with the highest
 * summary Jaccard wins — a key or alias match with little shared wording loses to a closer restatement. Ties keep the
 * first row in repository order (newest first).
 */
export function findNeighbourMatch(repository: MemoryRepository, normalized: NormalizedFact): NeighbourMatch | null {
  const probe = neighbourProbe(normalized);
  const factHasSignature = normalized.signatureKey.length > 0;
  let best: NeighbourMatch | null = null;
  for (const memory of repository.list({ type: normalized.type, status: LIVE_STATUSES })) {
    if (!scopesIntersect(memory.scopeGlob, normalized.scopeGlob)) continue;
    if (factHasSignature && memory.signatureKey.length === 0) continue;
    const { score, rules } = neighbourRulesFor(normalized, probe, memory);
    if (rules.length === 0) continue;
    if (best === null || score > best.score) best = { memory, score, rules };
  }
  return best;
}

export function findNeighbour(repository: MemoryRepository, normalized: NormalizedFact): MemoryRecord | null {
  return findNeighbourMatch(repository, normalized)?.memory ?? null;
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

/**
 * A′ remember-as-human: a `create` of a remember turn (`flags.remember = 1`) that cites the remember prompt line
 * whose text is an explicit request (citesRememberPrompt → detectRememberRequest; the hook's broad weight flag alone
 * is not approval). The user's words are the approval, so the row skips the candidate / proposal path — including
 * decideTier's autonomy_level gate and the auto-activation caps, exactly like `hm memory:add` / `hm import` rows,
 * which is why at most REMEMBER_MAX_PER_EPISODE such rows are taken per turn (later ones follow the automatic path).
 * Import episodes have their own human path; facts citing only tool lines, reinforce and propose_* facts stay on
 * the automatic path.
 */
function isRememberCreate(state: RunState, normalized: NormalizedFact): boolean {
  if (state.isImport || state.remembered.length >= REMEMBER_MAX_PER_EPISODE) return false;
  return citesRememberPrompt(state.descriptor.flags, normalized.fact, state.ctx.seqMap);
}

function createInputFor(state: RunState, normalized: NormalizedFact, supersedes: MemoryRecord | null): CreateMemoryInput {
  const { fact } = normalized;
  const hasSignature = fact.compiledSignature !== null && fact.trigger_signature !== null;
  // A replacement row (propose_supersede) is never a remember row: its fact action is not `create`.
  const remember = supersedes === null && isRememberCreate(state, normalized);
  const authority = state.isImport || remember ? "human" : "auto";
  const knowledgeKind: KnowledgeKind = state.isImport ? "import" : normalized.knowledgeKind;
  // 0.6.0-rc.2 (migration 023, design §2): the validator's precision and the signature's side effect exist only with
  // a signature; the horizon is the fact's (`durable` when the extractor said nothing). Stored once at birth — a
  // reinforce never rewrites them, the first extraction's verdict stands.
  const signaturePrecision = hasSignature ? fact.signature_precision : null;
  const sideEffect = hasSignature ? fact.side_effect : null;
  const enforcement = remember
    ? rememberEnforcement(normalized.type, hasSignature, state.ctx.config)
    : enforcementDefault({
        type: normalized.type,
        authority,
        policySubtype: null,
        hasSignature,
        specificityOk: hasSignature,
        knowledgeKind,
        importUnconfirmed: state.isImport ? 1 : 0,
        config: state.ctx.config,
        summary: fact.summary,
        // Design §3 rule 1 (silent-write soft_deny birth) reads these four; the evidence a row is born with is this
        // episode's weight — its first and only provenance at this point (recomputeDerived runs after the insert).
        signaturePrecision,
        sideEffect,
        horizon: fact.horizon,
        evidenceScore: state.descriptor.evidence_weight,
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
    // Human rows (import, remember) are active from birth and carry no TTL; auto rows wait for decideTier.
    status: state.isImport || remember ? "active" : "candidate",
    supersedesMemoryId: supersedes?.id ?? null,
    relevantTools: normalized.relevantTools,
    promotionSource: state.isImport || remember ? "manual" : "auto",
    // A remembered policy with a signature is a hard policy (its enforcement is before_tool.hard_policy, §7.3).
    ...(remember && normalized.type === "policy" && hasSignature ? { policySubtype: "hard" as const } : {}),
    ...(remember ? { statusReason: REMEMBER_STATUS_REASON } : {}),
    authority,
    sourceKind: state.isImport ? "import" : "extraction",
    knowledgeKind,
    enforcement,
    triggerSignature: hasSignature ? fact.trigger_signature : null,
    signatureKey: normalized.signatureKey,
    semanticKey: normalized.semanticKey,
    signaturePrecision,
    sideEffect,
    horizon: fact.horizon,
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

/** `detail` is appended to the outcome detail by applyFact (`adopted=signature`, `collapsed=identity_key` from collapseIntoTwin). */
type ReinforcedStep = { kind: "reinforced"; memory: MemoryRecord; detail?: string };
type FactStep = { kind: "created"; memory: MemoryRecord } | ReinforcedStep | { kind: "skipped"; outcome: FactOutcome };

function createRow(state: RunState, normalized: NormalizedFact, supersedes: MemoryRecord | null): FactStep {
  const input = createInputFor(state, normalized, supersedes);
  const remember = input.statusReason === REMEMBER_STATUS_REASON;
  // A′: the user's explicit request outranks a reject of the same claim within 30 days (reviveTerminal makes a new live row).
  const rejected = remember ? null : recentlyRejected(state.repository, normalized, input, state.ctx.now);
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
      if (twin !== null) {
        if (!remember) return collapseIntoTwin(state, normalized, twin, error.matchedBy);
        // A′: the signature the user's words approved is adopted first, while the twin is still an auto row
        // (adoptSignatureOntoTwin never rewrites a human one), and the remember transition then reads the refreshed
        // record — adoptRememberTwin derives the remember enforcement from the signature it carries (pitfall +
        // signature → soft_deny). The user's request is the approval, so the review-gate check does not apply here.
        const adopted = adoptSignatureOntoTwin(state, normalized, twin, error.matchedBy, { rememberApproved: true });
        const step = adoptRememberTwin(state, normalized, adopted.twin);
        return adopted.detail === undefined ? step : { ...step, detail: adopted.detail };
      }
    }
    throw error;
  }
  insertProvenance(state, memory.id, normalized.fact, state.isImport ? "import" : "origin");
  recomputeDerived(state.db, memory.id);
  state.created.push(memory.id);
  if (remember) state.remembered.push(memory.id);
  if (memory.authority === "auto" && memory.status === "candidate") state.tierCandidates.add(memory.id);
  const refreshed = state.repository.getById(memory.id) ?? memory;
  return { kind: "created", memory: refreshed };
}

/**
 * A′: a remember create whose claim already lives as a (live) row. The user's words approve the twin the way
 * `hm memory:promote` would, and every adopted row ends up human / active / status_reason `remember` so the
 * `[remember]` tag, `memory:show` and the SessionStart undo notice apply to it:
 *   - auto candidate / stale twin → active by actor human (transitionMemory: authority human, promotion manual, TTL
 *     cleared) and the remember enforcement replaces the system-chosen one;
 *   - auto active twin → adoptActiveMemory (authority human, status_reason remember, an active → active transition by
 *     human in its history) and the remember enforcement;
 *   - human candidate / stale twin (e.g. a rule the user demoted with `hm memory:demote` and now asks for again) →
 *     active again by human with status_reason remember; its enforcement only climbs to the remember default, a
 *     human's higher setting is kept;
 *   - human active twin → only reinforced (counters): its enforcement is the user's own setting.
 * The reinforce then runs on the human row: counters and last_verified_at (= this episode's close, which is what the
 * notice window keys on), no ladder. `twin` is the record to act on — createRow hands over the refreshed row after
 * adoptSignatureOntoTwin, so the remember enforcement sees the signature the user's words approved.
 */
function adoptRememberTwin(state: RunState, normalized: NormalizedFact, twin: MemoryRecord): ReinforcedStep {
  const reason = rememberTransitionReason(state.descriptor.id);
  const hasSignature = twin.triggerSignature !== null && twin.signatureKey.length > 0;
  const wanted = rememberEnforcement(twin.type, hasSignature, state.ctx.config);
  if (twin.authority === "auto") {
    if (twin.status === "active") {
      adoptActiveMemory(state.db, { memoryId: twin.id, reason, now: state.ctx.now, runId: state.runId, statusReason: REMEMBER_STATUS_REASON });
    } else {
      transitionMemory(state.db, { memoryId: twin.id, to: "active", actor: "human", reason, now: state.ctx.now, runId: state.runId, statusReason: REMEMBER_STATUS_REASON });
    }
    if (wanted !== twin.enforcement) state.repository.setEnforcement(twin.id, wanted, state.ctx.now);
    state.remembered.push(twin.id);
  } else if (twin.status !== "active") {
    transitionMemory(state.db, { memoryId: twin.id, to: "active", actor: "human", reason, now: state.ctx.now, runId: state.runId, statusReason: REMEMBER_STATUS_REASON });
    if (ENFORCEMENT_RANK[wanted] > ENFORCEMENT_RANK[twin.enforcement]) state.repository.setEnforcement(twin.id, wanted, state.ctx.now);
    state.remembered.push(twin.id);
  }
  return reinforceRow(state, normalized, state.repository.getById(twin.id) ?? twin);
}

interface AdoptSignatureOptions {
  /**
   * A′ remember create: the user's words approve the claim and the row leaves the automatic path at once
   * (adoptRememberTwin), so the review-gate check below does not apply — the signature those words approved rides along.
   */
  rememberApproved?: boolean;
}

/**
 * 0.6.0-rc.2 design §1: true when the row waits behind an OPEN activate_policy / activate_global proposal (`standard`'s
 * review gate) or a human rejected such a proposal on it (humanRejectedActivation). A signature adopted onto such a
 * signature-less row would turn it into one decideTier may activate by auto_rule — past the human's pending or
 * declined answer — so the automatic path keeps the row as it is.
 */
function activationGated(state: RunState, memoryId: string): boolean {
  if (state.proposals.listOpen({ targetId: memoryId }).some((proposal) => ACTIVATION_PROPOSAL_KINDS.has(proposal.kind))) return true;
  return humanRejectedActivation(state.proposals, memoryId);
}

/**
 * The signature half of an identity_key collapse (§5.7 step 4). An identity_key twin (same type / summary / details /
 * scope / triggers) is found even when the fact carries a signature and the row has none — the step 3 rules never pair
 * those two (§5.7), and a plain reinforce keeps the row's (empty) signature, so the fact's signature would vanish and
 * the hook would never learn the command. Hence a live, signature-less AUTO twin adopts the signature (setScope: the
 * fact's trigger signature and key plus the activation class a signed row is born with; scope, triggers and text
 * unchanged — identity_key stays, semantic_key is recomputed) and the refreshed record comes back with detail
 * `adopted=signature`. The twin comes back untouched with detail `collapsed=identity_key` — the dropped signature stays
 * visible in the run's outcomes — when it is a human row (the automatic path never rewrites one), when it is parked
 * behind an open activate_* proposal or a human rejected one (activationGated; not checked for a remember create, see
 * AdoptSignatureOptions), or when setScope refuses a semantic-key collision with another live row
 * (DuplicateMemoryContentError → logger.warn). No detail when there was no signature to drop: another match kind, a
 * signature-less fact, a twin that already carries a key. signature_precision / side_effect stay NULL on the adopted
 * row (read as noun / read, the safe direction).
 */
function adoptSignatureOntoTwin(
  state: RunState,
  normalized: NormalizedFact,
  twin: MemoryRecord,
  matchedBy: DuplicateMatchKind,
  options: AdoptSignatureOptions = {}
): { twin: MemoryRecord; detail?: string } {
  const { fact } = normalized;
  const signed = normalized.signatureKey.length > 0 && fact.trigger_signature !== null;
  if (matchedBy !== "identity_key" || !signed || twin.signatureKey.length > 0) return { twin };
  if (twin.authority === "auto" && isLiveRow(twin) && (options.rememberApproved === true || !activationGated(state, twin.id))) {
    try {
      const adopted = state.repository.setScope(twin.id, {
        scopeGlob: twin.scopeGlob,
        activationClass: normalized.activationClass,
        triggerSignature: fact.trigger_signature,
        signatureKey: normalized.signatureKey,
        updatedAt: state.ctx.now,
      });
      return { twin: adopted, detail: "adopted=signature" };
    } catch (error) {
      if (!(error instanceof DuplicateMemoryContentError)) throw error;
      state.ctx.logger?.warn(`memory ${twin.id}: signature ${normalized.signatureKey} not adopted (${error.message}); reinforced without it`);
    }
  }
  return { twin, detail: "collapsed=identity_key" };
}

/**
 * A create whose text already lives as a live row (`repository.create` threw DuplicateMemoryContentError): the row
 * is reinforced instead of duplicated — after adoptSignatureOntoTwin has given a signature-less auto identity twin
 * the fact's signature, so the reinforce runs on the refreshed row and the outcome says `adopted=signature` (or
 * `collapsed=identity_key` when the signature was dropped). Called from the automatic path only: a remember create
 * goes through adoptRememberTwin instead (createRow). The twin can be any live row with the fact's text, including a
 * replacement row an earlier session proposed (applyFact's propose_supersede branch, which then supports that
 * proposal) or the supersede target itself when the replacement text equals the target's and only the signature
 * differs (the fallback `stale` proposal then names the target and the outcome carries `twin=<id>`).
 */
function collapseIntoTwin(state: RunState, normalized: NormalizedFact, twin: MemoryRecord, matchedBy: DuplicateMatchKind): ReinforcedStep {
  const adopted = adoptSignatureOntoTwin(state, normalized, twin, matchedBy);
  const step = reinforceRow(state, normalized, adopted.twin);
  return adopted.detail === undefined ? step : { ...step, detail: adopted.detail };
}

function reinforceRow(state: RunState, normalized: NormalizedFact, target: MemoryRecord): ReinforcedStep {
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
    // A′ ladder: a reinforce (or a create that collapsed into this row) from another session may raise an active
    // advise pitfall to soft_deny; decided deterministically after recomputeDerived. Import bullets are not sessions.
    if (!state.isImport) {
      const escalation = escalateOnReinforce(state.db, { memoryId: target.id, sessionId: state.descriptor.session_id, runId: state.runId, config: state.ctx.config, now: state.ctx.now });
      if (escalation.applied) state.escalated.push(target.id);
    }
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

  switch (fact.action) {
    case "create":
    case "reinforce": {
      let twin = target ?? sameKey;
      // Step 3 neighbour (findNeighbourMatch applies the §5.7 rule: a signature-bearing fact never lands on a
      // signature-less row); the matching rules are reported in the outcome detail for the replay fixtures.
      let neighbour: NeighbourMatch | null = null;
      if (twin === null && fact.action === "create") {
        neighbour = findNeighbourMatch(state.repository, normalized);
        if (neighbour !== null) twin = neighbour.memory;
      }
      const escalatedBefore = state.escalated.length;
      const rememberedBefore = state.remembered.length;
      const step =
        twin !== null
          ? isRememberCreate(state, normalized)
            ? adoptRememberTwin(state, normalized, twin)
            : reinforceRow(state, normalized, twin)
          : createRow(state, normalized, null);
      if (step.kind === "skipped") return step.outcome;
      const outcome = outcomeFor(fact, step.kind, { memory_id: step.memory.id, detail: step.kind === "reinforced" && twin !== null ? `target=${twin.id}` : undefined }, normalized.relabels);
      const addDetail = (extra: string): void => {
        outcome.detail = outcome.detail === undefined ? extra : `${outcome.detail}; ${extra}`;
      };
      if (step.kind === "reinforced" && neighbour !== null) addDetail(`neighbour=${neighbour.rules.join("+")}`);
      if (step.kind === "reinforced" && step.detail !== undefined) addDetail(step.detail);
      if (state.remembered.length > rememberedBefore) addDetail("remember:active");
      if (state.escalated.length > escalatedBefore) addDetail("escalated=soft_deny");
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
        // proposal gains this session's support, which is the only way §5.7 step 6 can activate a replacement. A
        // live twin that is no replacement of the target (an independent row, or the target itself) falls back to a
        // `stale` proposal whose outcome names the target, so the twin is reported as `twin=<id>`. Either way the
        // collapse detail (`adopted=signature` / `collapsed=identity_key`) is appended, as the create path does.
        const stale = !isReplacementOf(state, replacement.memory, resolved);
        const outcome = stale
          ? proposeAgainst(state, normalized, resolved, "stale", null)
          : proposeAgainst(state, normalized, resolved, "supersede", replacement.memory);
        for (const extra of [replacement.detail, stale ? `twin=${replacement.memory.id}` : undefined]) {
          if (extra !== undefined) outcome.detail = outcome.detail === undefined ? extra : `${outcome.detail}; ${extra}`;
        }
        return outcome;
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

const KNOWLEDGE_TYPES: readonly MemoryType[] = ["decision", "architecture_constraint"];
const KNOWLEDGE_TYPE_SQL = KNOWLEDGE_TYPES.map((type) => `'${type}'`).join(", ");

/** 0.6.0-rc.2 (design §1): decision / architecture_constraint rows draw on `extraction.max_auto_knowledge_activations_per_day`, not on the rule caps. */
export function isKnowledgeType(type: MemoryType): boolean {
  return KNOWLEDGE_TYPES.includes(type);
}

/**
 * Today's automatic activations (memory_transitions by auto_rule into active) charged to one of the two daily budgets:
 * `rules` = pitfall / workflow / policy rows (extraction.max_auto_activations_per_day), `knowledge` = decision /
 * architecture_constraint rows (extraction.max_auto_knowledge_activations_per_day, 0.6.0-rc.2). The split keeps a
 * knowledge activation from eating the rule budget on the next run of the day. from_status <> to_status: an A′
 * escalation is recorded as active → active by auto_rule and is not an activation.
 */
function countAutoActivationsSince(db: SqlJsDatabase, startIso: string, budget: "rules" | "knowledge"): number {
  const typeFilter = budget === "knowledge" ? `m.type IN (${KNOWLEDGE_TYPE_SQL})` : `(m.type IS NULL OR m.type NOT IN (${KNOWLEDGE_TYPE_SQL}))`;
  const row = selectOne(
    db,
    `SELECT COUNT(*) AS n
     FROM memory_transitions t
     LEFT JOIN memories m ON m.id = t.memory_id
     WHERE t.actor = 'auto_rule' AND t.to_status = 'active' AND t.from_status <> t.to_status AND t.created_at >= ?
       AND (t.reason IS NULL OR t.reason <> 'full_sweep') AND ${typeFilter}`,
    [startIso]
  );
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
      // 0.6.0-rc.2 (`full`): decision / architecture_constraint rows have their own daily budget (design §1) and the
      // row's horizon sets the TTL (task → 7 days). Both are ignored by the `standard` / `shadow` / `off` chain.
      knowledgeCapsRemaining: { day: config.extraction.max_auto_knowledge_activations_per_day - state.knowledgeActivatedToday },
      horizon: memory.horizon,
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

    // 0.6.0-rc.2 (design §1): the automatic path never enacts a claim a human declined — a row whose activate_*
    // proposal a human rejected stays a candidate under `full` (`standard` never returns `active` for such rows; its
    // re-proposal path keeps the 30-day skip in openOrSupportProposal).
    if (decision.status === "active" && humanRejectedActivation(state.proposals, memory.id)) {
      if (outcome !== undefined) outcome.detail = outcome.detail === undefined ? "tier=candidate(human_rejected)" : `${outcome.detail}; tier=candidate(human_rejected)`;
      continue;
    }

    if (decision.status === "active") {
      transitionMemory(state.db, { memoryId: memory.id, to: "active", actor: "auto_rule", reason: "decideTier", now: state.ctx.now, runId: state.runId });
      state.repository.setTtl(memory.id, {
        ttlExpiresAt: decision.ttlExpiresAt ?? null,
        revalidateAfter: decision.revalidateAfter ?? null,
        validationCount: Math.max(0, memory.evidenceCount - 1),
        updatedAt: state.ctx.now,
      });
      state.activated.push(memory.id);
      // Each type family draws on its own budget: a knowledge row (only ever active here under `full`) must not
      // consume the pitfall / workflow / policy caps, nor the other way round.
      if (isKnowledgeType(memory.type)) {
        state.knowledgeActivatedToday += 1;
      } else {
        state.activatedThisRun += 1;
        state.activatedToday += 1;
      }
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

    // `standard` (and its shadow dry run / off) only: decideTier never sets a proposal under `full`, so no activate_*
    // proposal is opened and no notify file is written there (design §1).
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
    const report: ReconcileReport = { runId, status: "ok", outcomes: [], created: [], reinforced: [], activated: [], proposals: [], escalated: [], remembered: [], factsTotal: 0, factsAccepted: 0 };
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
    const report: ReconcileReport = { runId, status, outcomes: [...validated.outcomes], created: [], reinforced: [], activated: [], proposals: [], escalated: [], remembered: [], factsTotal: validated.outcomes.length, factsAccepted: 0 };
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
    escalated: [],
    remembered: [],
    activatedToday: countAutoActivationsSince(db, startOfUtcDay(ctx.now), "rules"),
    activatedThisRun: 0,
    knowledgeActivatedToday: countAutoActivationsSince(db, startOfUtcDay(ctx.now), "knowledge"),
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
    // A′ recall layer: the extractor's summary becomes the episode's recall text (replaces the worker's derived one)
    // — only when the V12 content scanner clears it: this free LLM text is injected into OTHER sessions' model
    // context at UserPromptSubmit, so an instruction-shaped or credential-bearing summary leaves the derived one in
    // place. Normalized first (one line, control characters stripped) so what is scanned is what gets stored; import
    // episodes are refused by the repository (their bullet is already the memory).
    const recallText = normalizeRecallSummary(summary);
    const scan = scanMemoryContent(recallText, "");
    if (scan.safe) {
      episodes.setSummary(descriptor.id, recallText, "extracted");
    } else {
      const blocked = scan.threats.filter((threat) => threat.severity === "block").map((threat) => threat.pattern);
      ctx.logger?.warn(`episode ${descriptor.id}: episode_summary rejected by the content scanner (${blocked.join(", ")}); the derived summary stays`);
    }
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
    escalated: [...new Set(state.escalated)],
    remembered: [...new Set(state.remembered)],
    factsTotal,
    factsAccepted,
  };
  return { id: runId, kind: "extract", noop: false, wrote: true, report };
}
