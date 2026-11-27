/**
 * consolidate — `worker dream` (spec §5.8). Invents no memories; it only moves rows along the state
 * machine, opens proposals and cleans up:
 *
 *   (4) fire roll-ups already written by lock session 1 → auto rows: ttl = max(ttl, last_fired_at + 14 d);
 *       override downgrade: auto ∧ override_count ≥ 3 ∧ evidence_score < 3 → enforcement 'advise' + audit_log
 *   (S) full sweep (0.6.0-rc.2 / rc.3, `autonomy_level: "full"` only), three phases on one budget of
 *       dream.full_sweep_per_run units: (1) open `supersede` contests whose target is an auto candidate /
 *       stale(ttl_expired) row are resolved oldest first when the contest passes design §2.1 (a contest whose
 *       replacement is itself the target of a resolvable contest waits for that one, which settles it through the
 *       chain walk) and the replacement passes decideTier — target superseded, replacement activated, one unit each;
 *       (2) open supersede / stale proposals on active auto rows are recounted in session blocks and judged by the
 *       two-session rule (evaluateAutoDemotion, no unit; a budget of 0 stops phases 1 and 3 only); a replacement it
 *       activates gets the same bookkeeping as the other phases — activate_* proposals closed, `full_sweep_activation`
 *       audit row; (3) auto candidates that are not replacement rows are re-evaluated with decideTier, oldest first,
 *       one unit per activation. Every transition is by `auto_rule` (reason `full_sweep`), the rows' open activate_*
 *       proposals close as expired(full_autonomy), and each resolution / activation runs in its own SAVEPOINT (a throw
 *       costs that row and lands in sweptErrors). Runs before (2)/(3) so a candidate that passes today is activated
 *       rather than expired.
 *   (2) TTL: correction / failure_resolution auto rows open a `revalidate` proposal, other auto rows → stale(ttl_expired)
 *   (3) auto candidates older than retention.candidate_days → rejected(expiry); proposals past expires_at → expired
 *       (an expired revalidate stales its row)
 *   (5) auto↔auto near-duplicates (Jaccard ≥ 0.8 or cosine ≥ 0.92) → `merge` proposal only
 *   (6) embedding backfill through an injected `embed(texts)` (inside the dream lock session, §5.8; the
 *       extract path uses the lock-free selectEmbeddingBacklog → embedBacklog → applyEmbeddings split instead)
 *   (7) idle-turn sweep of state/*.json (ledger idle > 1 h → close as `idle`, enqueue) and GC
 *       (ledger segments 14 d, raw 24 h, tmp 10 min, audit_log 30 d)
 *   (8) snapshot — done by Store.withWriteLock after the commit
 *
 * (4) runs before (2) so a row that fired recently is extended instead of expired (documented deviation
 * from the spec's listing order; the spec defines the extension as the "in use" signal).
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

import type { Database as SqlJsDatabase } from "sql.js";

import { compileSignature } from "../activation/signature";
import type { HarnessConfig } from "../core/config";
import type { EpisodeDescriptor } from "../core/episode-types";
import { createDeterministicId } from "../core/ids";
import type { LedgerLine, SessionState, ToolFailLine, ToolOkLine } from "../core/ledger-types";
import { ledgerFile, queueFile, type HarnessPaths } from "../core/paths";
import { LIVE_STATUSES } from "../core/vocabulary";
import { cleanOrphanTmp } from "../db/db-file";
import { META_KEYS, MetaRepository } from "../db/repositories/meta";
import { ProposalRepository } from "../db/repositories/proposals";
import { ProvenanceRepository } from "../db/repositories/provenance";
import { selectAll } from "../db/sql";
import type { WriteOp } from "../db/store";
import { MemoryRepository, type MemoryRecord } from "../memory/repository";
import { decideTier, type DecideTierInput } from "../promotion/authority";
import { ACTIVATION_PROPOSAL_KINDS, evaluateAutoDemotion, expireProposals, humanRejectedActivation, openOrSupportProposal } from "../promotion/proposals";
import {
  FULL_AUTONOMY_DECISION_NOTE,
  FULL_SWEEP_TRANSITION_REASON,
  applySupersedeResolution,
  chainTargets,
  checkSupersedeResolution,
} from "../promotion/replacement";
import { extendTtlOnFire } from "../promotion/revalidate";
import { transitionMemory } from "../promotion/transitions";
import { scanMemoryContent } from "../security/scanner";
import { buildEpisodeDescriptor } from "./episode";
import { appendLedgerLine, makeSeq, readLedgerRangeLines } from "./ledger";
import { cosine, jaccard, resolveTargetRow, scopesIntersect, summaryTokens } from "./reconcile";

export const MERGE_JACCARD = 0.8;
export const MERGE_COSINE = 0.92;
export const OVERRIDE_DOWNGRADE_COUNT = 3;
export const OVERRIDE_DOWNGRADE_MAX_EVIDENCE = 3;
export const IDLE_TURN_MS = 60 * 60 * 1000;
// The sweep's decision note and transition reason are shared with the replacement resolution (0.6.0-rc.3 §2.2, §2.5).
export { FULL_AUTONOMY_DECISION_NOTE, FULL_SWEEP_TRANSITION_REASON } from "../promotion/replacement";
const EMBED_BATCH = 32;

export type EmbedFn = (texts: string[]) => Promise<Float32Array[]>;

export interface DreamLogger {
  log(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface DreamOptions {
  paths: HarnessPaths;
  config: HarnessConfig;
  now: string;
  /** Embedding backfill (step 6); omitted/null = skip. */
  embed?: EmbedFn | null;
  logger?: DreamLogger;
  /** Skip the file-system steps (idle sweep + GC); tests that only exercise the state machine set this. */
  skipFiles?: boolean;
}

export interface DreamReport {
  ttlExtended: string[];
  downgraded: string[];
  revalidateProposals: string[];
  staled: string[];
  rejectedCandidates: string[];
  expiredProposals: string[];
  staledByExpiry: string[];
  mergeProposals: string[];
  fixSignatureProposals: string[];
  /**
   * Full sweep (`autonomy_level: "full"` only, empty otherwise): auto rows the sweep activated — by decideTier in phase 3,
   * by decideProposal as the replacement of a resolved or demoted contest in phases 1–2.
   */
  sweptActivated: string[];
  /**
   * Full sweep: activate_policy / activate_global proposals closed as expired(full_autonomy) with their target (rc.2) and the
   * contests a resolution closed the same way — the dead target's other contests and chain proposals that did not pass (rc.3).
   */
  sweptProposalsClosed: string[];
  /** 0.6.0-rc.3 full sweep: targets superseded by a resolution (chain hops included) or by the re-judged two-session rule. */
  sweptSuperseded: string[];
  /** 0.6.0-rc.3 full sweep: `resolution <proposalId>: <message>` / `activation <memoryId>: <message>` per row whose savepoint rolled back. */
  sweptErrors: string[];
  embedded: number;
  idleClosed: string[];
  gc: { ledgers: number; states: number; raw: number; tmp: number; audit: number };
  errors: string[];
}

export type DreamWriteOp = WriteOp & { report: DreamReport };

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

function addDays(iso: string, days: number): string {
  return new Date(Date.parse(iso) + days * 24 * 60 * 60 * 1000).toISOString();
}

function writeAudit(db: SqlJsDatabase, eventType: string, id: string, summary: string, details: unknown, now: string): void {
  db.run(
    `INSERT OR IGNORE INTO audit_log (id, event_type, session_id, scope_ref, summary, details_json, created_at)
     VALUES (?, ?, NULL, NULL, ?, ?, ?)`,
    [id, eventType, summary, JSON.stringify(details), now]
  );
}

// ---------------------------------------------------------------------------------------------
// Steps on the database
// ---------------------------------------------------------------------------------------------

function fireAndOverride(db: SqlJsDatabase, repository: MemoryRepository, now: string, report: DreamReport): boolean {
  let changed = false;
  for (const memory of repository.list({ authority: "auto", status: LIVE_STATUSES })) {
    if (memory.status === "active" && memory.lastFiredAt !== null) {
      const extended = extendTtlOnFire(db, memory.id, { lastFiredAt: memory.lastFiredAt });
      if (extended.applied) {
        report.ttlExtended.push(memory.id);
        changed = true;
      }
    }
    if (memory.overrideCount >= OVERRIDE_DOWNGRADE_COUNT && memory.evidenceScore < OVERRIDE_DOWNGRADE_MAX_EVIDENCE && memory.enforcement !== "advise") {
      repository.setEnforcement(memory.id, "advise", now);
      writeAudit(
        db,
        "enforcement_downgrade",
        createDeterministicId(`audit:enforcement_downgrade:${memory.id}:${now}`),
        `override downgrade: ${memory.id} ${memory.enforcement} → advise (overrides ${String(memory.overrideCount)}, evidence ${String(memory.evidenceScore)})`,
        { memoryId: memory.id, from: memory.enforcement, overrideCount: memory.overrideCount, evidenceScore: memory.evidenceScore },
        now
      );
      report.downgraded.push(memory.id);
      changed = true;
    }
  }
  return changed;
}

/**
 * Same bookkeeping as the proposal queue's flagTarget after the sweep closed a row's activate_* proposals:
 * `open_proposal_id` keeps pointing at a still-open proposal or is cleared. `contested` tracks supersede / stale /
 * revalidate proposals only, which this path never touches.
 */
function refreshOpenProposalFlag(repository: MemoryRepository, proposals: ProposalRepository, memoryId: string): void {
  const target = repository.getById(memoryId);
  if (target === null) return;
  const open = proposals.listOpen({ targetId: memoryId });
  const first = open[0] ?? null;
  const openProposalId = first === null ? null : open.some((proposal) => proposal.id === target.openProposalId) ? target.openProposalId : first.id;
  if (target.openProposalId !== openProposalId) repository.setFlags(memoryId, { openProposalId, updatedAt: target.updatedAt });
}

/** Closes the row's open activate_policy / activate_global proposals as expired(full_autonomy) and refreshes its flag; returns their ids. */
function closeActivationProposals(repository: MemoryRepository, proposals: ProposalRepository, memoryId: string, now: string): string[] {
  const closed: string[] = [];
  for (const proposal of proposals.listOpen({ targetId: memoryId })) {
    if (!ACTIVATION_PROPOSAL_KINDS.has(proposal.kind)) continue;
    proposals.decide(proposal.id, { status: "expired", decidedBy: "auto_rule", note: FULL_AUTONOMY_DECISION_NOTE, now });
    closed.push(proposal.id);
  }
  if (closed.length > 0) refreshOpenProposalFlag(repository, proposals, memoryId);
  return closed;
}

/**
 * The decideTier input the sweep builds from a stored row: the sweep's own budget on every cap (never the extraction
 * day caps), `originDecisionMarker` from the row's origin provenance (0.6.0-rc.3 §1.1: a decision-born rule row at
 * evidence_score 0 passes the evidence step without being rewritten), never a replacement row (a contested
 * replacement is judged on its own merits, §2.1 rule 5), and the stored text scanned again — the validator rejected
 * unsafe facts when the row was written, but legacy / imported text never passed it.
 */
function sweepTierInput(memory: MemoryRecord, provenance: ProvenanceRepository, remaining: number, now: string): DecideTierInput {
  return {
    memory: {
      type: memory.type,
      scopeGlob: memory.scopeGlob,
      hasSignature: memory.triggerSignature !== null && memory.signatureKey.length > 0,
      signatureTool: memory.triggerSignature?.tool ?? null,
      relevantTools: memory.relevantTools,
      lifecycleTriggers: memory.lifecycleTriggers,
      confidence: memory.confidence,
      authority: memory.authority,
    },
    evidenceScore: memory.evidenceScore,
    originDecisionMarker: provenance.hasDecisionOrigin(memory.id),
    capsRemaining: { episode: remaining, day: remaining },
    knowledgeCapsRemaining: { day: remaining },
    autonomyLevel: "full",
    knowledgeKind: memory.knowledgeKind,
    isReplacementRow: false,
    scanSafe: scanMemoryContent(memory.summary, memory.details).safe,
    horizon: memory.horizon,
    now,
  };
}

/** The contest a replacement was activated through, named in its `full_sweep_activation` audit row. */
interface ActivationVia {
  proposalId: string;
  superseded: string[];
}

/** The rc.2 `full_sweep_activation` audit row for a row the sweep activated, read after its TTL was stored. */
function writeActivationAudit(db: SqlJsDatabase, memory: MemoryRecord, closed: string[], via: ActivationVia | null, now: string): void {
  const how = via === null ? "" : ` via supersede of ${via.superseded.join(", ")}`;
  const facts = `evidence ${String(memory.evidenceScore)}, confidence ${String(memory.confidence)}`;
  writeAudit(
    db,
    "full_sweep_activation",
    createDeterministicId(`audit:full_sweep_activation:${memory.id}:${now}`),
    `full sweep: ${memory.type} ${oneLine(memory.summary, 80)} activated${how} (${facts})`,
    {
      memoryId: memory.id,
      type: memory.type,
      evidenceScore: memory.evidenceScore,
      confidence: memory.confidence,
      ttlExpiresAt: memory.ttlExpiresAt,
      proposalsClosed: closed,
      ...(via === null ? {} : { proposalId: via.proposalId, superseded: via.superseded }),
    },
    now
  );
}

type SavepointOutcome<T> = { ok: true; value: T } | { ok: false; error: string };

/** Runs `fn` in its own SAVEPOINT (as reconcile runs every fact): a throw rolls back that work alone and is returned, not raised. */
function inSavepoint<T>(db: SqlJsDatabase, name: string, fn: () => T): SavepointOutcome<T> {
  db.run(`SAVEPOINT ${name}`);
  try {
    const value = fn();
    db.run(`RELEASE ${name}`);
    return { ok: true, value };
  } catch (error) {
    db.run(`ROLLBACK TO ${name}`);
    db.run(`RELEASE ${name}`);
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Oldest first, ids as the tie-break: the order every sweep phase walks its rows and proposals in. */
function byAge(left: { createdAt: string; id: string }, right: { createdAt: string; id: string }): number {
  return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}

/**
 * Backlog drain (design rc.2 §1, rc.3 §2.4; `autonomy_level: "full"` only): three phases on one budget of
 * dream.full_sweep_per_run units. Every transition is by `auto_rule` with reason `full_sweep`, which
 * countAutoActivationsSince excludes, so the sweep consumes neither extraction day cap (§2.5). Every resolution and
 * every activation runs in its own SAVEPOINT: a throw costs that row alone, is reported in `report.sweptErrors` and
 * never rolls back the run's other work.
 *
 * 1. Open `supersede` contests, oldest first, whose target is an auto candidate / stale(ttl_expired) row and whose
 *    replacement is an auto candidate (checkSupersedeResolution, §2.1 rules 1–4 and 4b: a contest whose replacement
 *    is itself the target of a resolvable contest is skipped as `candidate_contested` — that later contest resolves in
 *    the same pass and its chain walk settles the skipped one, so the old target is superseded by the correction,
 *    never by the contested middle row). The replacement must pass decideTier on its own (rule 5) unless an earlier
 *    contest of this run already activated it; then applySupersedeResolution lets decideProposal supersede the
 *    target and activate the replacement (§2.2, the one activation owner), closes what the dead target leaves behind
 *    and walks the chain of proposals that named it. One unit per resolution (a skipped contest costs nothing); the
 *    replacement gets the rc.2 `full_sweep_activation` audit row as well. A resolution that throws holds its target
 *    and every chain target behind it (chainTargets) back from phase 3, so the retry still finds the chain intact.
 * 2. Open `supersede` / `stale` proposals on active auto rows keep the two-session rule (§2.3): `support_sessions`
 *    is recounted in session blocks and evaluateAutoDemotion judges the proposal, so a claim that already has two
 *    blocks resolves at this dream instead of waiting for a fresh support. rc.1 mechanics: no unit is spent, and a
 *    budget of 0 (which stops phases 1 and 3) does not stop this phase. A replacement activated this way gets the
 *    bookkeeping of the other phases: its open activate_* proposals close as expired(full_autonomy) and one
 *    `full_sweep_activation` audit row names the contest.
 * 3. The rc.2 drain: auto candidates that are not replacement rows — no live `supersedes_memory_id` target and not
 *    the candidate of an open proposal, the same test as reconcile's decideTiers — and whose activate_* proposal no
 *    human rejected (humanRejectedActivation: the automatic path never enacts a claim a human declined) are
 *    re-evaluated with decideTier, oldest first, and activated when they pass, one unit each. Each row is re-read
 *    first: a target phase 1 superseded, a replacement it activated and a target (or chain target) whose resolution
 *    threw this run are skipped (the last keep their contests for the next dream instead of draining as plain
 *    candidates). A row that does not pass costs nothing, so unpassable old rows cannot stall the drain; an activation
 *    stores the decision's TTL / revalidate with validation_count = evidence_count − 1 and closes the row's open
 *    activate_* proposals as expired(full_autonomy).
 *
 * Human rows are never selected or superseded; `standard`, `shadow` and `off` leave this step out entirely.
 */
function fullSweep(db: SqlJsDatabase, repository: MemoryRepository, config: HarnessConfig, now: string, report: DreamReport): boolean {
  if (config.autonomy_level !== "full") return false;
  let remaining = Math.max(0, Math.floor(config.dream.full_sweep_per_run));
  const proposals = new ProposalRepository(db);
  const provenance = new ProvenanceRepository(db);
  const candidates = repository.list({ authority: "auto", status: "candidate" }).sort(byAge);
  const heldBack = new Set<string>();
  let changed = false;
  // §2.1 rule 5 as the sweep judges it, with the budget left at the time of the call; rule 4b asks it about chain replacements too.
  const passesTier = (candidate: MemoryRecord): boolean => decideTier(sweepTierInput(candidate, provenance, remaining, now)).status === "active";

  for (const [index, proposal] of proposals.listOpen({ kind: "supersede" }).sort(byAge).entries()) {
    if (remaining <= 0) break;
    const outcome = inSavepoint(db, `sp_sweep_res_${String(index)}`, () => {
      const check = checkSupersedeResolution(db, proposal.id, { passesTier });
      if (!check.ok) return null;
      if (check.needsTierDecision && !passesTier(check.candidate)) return null;
      const result = applySupersedeResolution(db, { proposalId: proposal.id, now, transitionReason: FULL_SWEEP_TRANSITION_REASON, source: "sweep" });
      if (result.replacementActivated) {
        const activated = repository.getById(result.replacementId) ?? check.candidate;
        writeActivationAudit(db, activated, result.proposalsClosed, { proposalId: proposal.id, superseded: result.superseded }, now);
      }
      return result;
    });
    if (!outcome.ok) {
      report.sweptErrors.push(`resolution ${proposal.id}: ${outcome.error}`);
      // The chain behind the target (T0 behind T) drains as plain candidates otherwise, and the retry could no longer supersede it.
      for (const id of [proposal.targetMemoryId, ...chainTargets(proposals, proposal.targetMemoryId)]) heldBack.add(id);
      continue;
    }
    if (outcome.value === null) continue;
    report.sweptSuperseded.push(...outcome.value.superseded);
    if (outcome.value.replacementActivated) report.sweptActivated.push(outcome.value.replacementId);
    report.sweptProposalsClosed.push(...outcome.value.proposalsClosed);
    remaining -= 1;
    changed = true;
  }

  const contests = proposals.listOpen().filter((proposal) => proposal.kind === "supersede" || proposal.kind === "stale");
  for (const [index, proposal] of contests.sort(byAge).entries()) {
    const target = repository.getById(proposal.targetMemoryId);
    if (target === null || target.authority !== "auto" || target.status !== "active") continue;
    const outcome = inSavepoint(db, `sp_sweep_demote_${String(index)}`, () => {
      proposals.recomputeDerived(proposal.id);
      const demotion = evaluateAutoDemotion(db, { proposalId: proposal.id, now, transitionReason: FULL_SWEEP_TRANSITION_REASON });
      const replacementId = proposal.candidateMemoryId;
      const activated = demotion.applied && replacementId !== null && demotion.decision?.effects.includes("replacement:active") === true;
      let closed: string[] = [];
      if (activated) {
        // The same bookkeeping phases 1 and 3 give an activated row; the audit row is read after decideProposal stored the TTL.
        closed = closeActivationProposals(repository, proposals, replacementId, now);
        const replacement = repository.getById(replacementId);
        if (replacement !== null) writeActivationAudit(db, replacement, closed, { proposalId: proposal.id, superseded: [target.id] }, now);
      }
      return { demotion, activated, closed };
    });
    if (!outcome.ok) {
      report.sweptErrors.push(`resolution ${proposal.id}: ${outcome.error}`);
      continue;
    }
    if (!outcome.value.demotion.applied) continue;
    (proposal.kind === "supersede" ? report.sweptSuperseded : report.staled).push(target.id);
    if (outcome.value.activated && proposal.candidateMemoryId !== null) report.sweptActivated.push(proposal.candidateMemoryId);
    report.sweptProposalsClosed.push(...outcome.value.closed);
    changed = true;
  }

  for (const [index, memory] of candidates.entries()) {
    if (remaining <= 0) break;
    const current = repository.getById(memory.id);
    if (current === null || current.status !== "candidate" || current.authority !== "auto" || heldBack.has(current.id)) continue;
    const supersedesLive = current.supersedesMemoryId !== null && resolveTargetRow(repository, current.supersedesMemoryId) !== null;
    if (supersedesLive || proposals.listOpen({ candidateId: current.id }).length > 0) continue;
    if (humanRejectedActivation(proposals, current.id)) continue;
    const decision = decideTier(sweepTierInput(current, provenance, remaining, now));
    if (decision.status !== "active") continue;

    const outcome = inSavepoint(db, `sp_sweep_act_${String(index)}`, () => {
      transitionMemory(db, { memoryId: current.id, to: "active", actor: "auto_rule", reason: FULL_SWEEP_TRANSITION_REASON, now });
      const activated = repository.setTtl(current.id, {
        ttlExpiresAt: decision.ttlExpiresAt ?? null,
        revalidateAfter: decision.revalidateAfter ?? null,
        validationCount: Math.max(0, current.evidenceCount - 1),
        updatedAt: now,
      });
      const closed = closeActivationProposals(repository, proposals, current.id, now);
      writeActivationAudit(db, activated, closed, null, now);
      return closed;
    });
    if (!outcome.ok) {
      report.sweptErrors.push(`activation ${current.id}: ${outcome.error}`);
      continue;
    }
    report.sweptActivated.push(current.id);
    report.sweptProposalsClosed.push(...outcome.value);
    remaining -= 1;
    changed = true;
  }
  return changed;
}

function ttlExpiry(db: SqlJsDatabase, repository: MemoryRepository, config: HarnessConfig, now: string, report: DreamReport): boolean {
  let changed = false;
  for (const memory of repository.list({ authority: "auto", status: "active", ttlExpiredBefore: now })) {
    if (memory.knowledgeKind === "correction" || memory.knowledgeKind === "failure_resolution") {
      const opened = openOrSupportProposal(db, {
        kind: "revalidate",
        targetMemoryId: memory.id,
        rationale: `TTL reached ${memory.ttlExpiresAt ?? now}; confirm the memory still holds or let it go stale`,
        confidence: memory.confidence,
        createdBy: "consolidator",
        now,
        expiresInDays: config.retention.proposal_days,
        // A rejected revalidate stales the row (decideProposal), so the row leaves this query; no skip needed.
        rejectSkipDays: 0,
      });
      if (opened.created && opened.proposalId !== null) {
        report.revalidateProposals.push(opened.proposalId);
        changed = true;
      }
      continue;
    }
    transitionMemory(db, { memoryId: memory.id, to: "stale", actor: "expiry", reason: "ttl_expired", now, statusReason: "ttl_expired" });
    report.staled.push(memory.id);
    changed = true;
  }
  return changed;
}

function candidateAndProposalExpiry(db: SqlJsDatabase, repository: MemoryRepository, config: HarnessConfig, now: string, report: DreamReport): boolean {
  let changed = false;
  const cutoff = addDays(now, -config.retention.candidate_days);
  for (const memory of repository.list({ authority: "auto", status: "candidate", createdBefore: cutoff })) {
    transitionMemory(db, { memoryId: memory.id, to: "rejected", actor: "expiry", reason: `candidate older than ${String(config.retention.candidate_days)} d`, now, statusReason: "expiry" });
    report.rejectedCandidates.push(memory.id);
    changed = true;
  }
  const expired = expireProposals(db, { now });
  report.expiredProposals.push(...expired.expired);
  report.staledByExpiry.push(...expired.staled);
  if (expired.expired.length > 0) changed = true;
  return changed;
}

function nearDuplicateMerges(db: SqlJsDatabase, repository: MemoryRepository, config: HarnessConfig, now: string, report: DreamReport): boolean {
  let changed = false;
  const rows = repository.list({ authority: "auto", status: ["active", "candidate"] });
  const tokens = new Map<string, Set<string>>();
  for (const row of rows) tokens.set(row.id, summaryTokens(row.summary));
  const byType = new Map<string, MemoryRecord[]>();
  for (const row of rows) {
    const bucket = byType.get(row.type) ?? [];
    bucket.push(row);
    byType.set(row.type, bucket);
  }
  for (const bucket of byType.values()) {
    for (let i = 0; i < bucket.length; i += 1) {
      for (let j = i + 1; j < bucket.length; j += 1) {
        const left = bucket[i]!;
        const right = bucket[j]!;
        if (!scopesIntersect(left.scopeGlob, right.scopeGlob)) continue;
        const lexical = jaccard(tokens.get(left.id)!, tokens.get(right.id)!);
        const dense = left.embedding !== null && right.embedding !== null ? cosine(left.embedding, right.embedding) : 0;
        if (lexical < MERGE_JACCARD && dense < MERGE_COSINE) continue;
        const [older, newer] = Date.parse(left.createdAt) <= Date.parse(right.createdAt) ? [left, right] : [right, left];
        const opened = openOrSupportProposal(db, {
          kind: "merge",
          targetMemoryId: older.id,
          candidateMemoryId: newer.id,
          rationale: `near-duplicate (jaccard ${lexical.toFixed(2)}${dense > 0 ? `, cosine ${dense.toFixed(2)}` : ""}); survivor = older row, enforcement = max`,
          confidence: Math.max(lexical, dense),
          createdBy: "consolidator",
          now,
          expiresInDays: config.retention.proposal_days,
        });
        if (opened.created && opened.proposalId !== null) {
          report.mergeProposals.push(opened.proposalId);
          changed = true;
        }
      }
    }
  }
  return changed;
}

function fixSignatureProposals(db: SqlJsDatabase, repository: MemoryRepository, config: HarnessConfig, now: string, report: DreamReport): boolean {
  let changed = false;
  for (const memory of repository.list({ status: "active" })) {
    if (memory.triggerSignature === null) continue;
    const compiled = compileSignature(memory.triggerSignature);
    if (compiled.ok) continue;
    const opened = openOrSupportProposal(db, {
      kind: "fix_signature",
      targetMemoryId: memory.id,
      rationale: `stored signature does not compile (${compiled.code}: ${compiled.detail}); the hooks ignore it`,
      confidence: 0.5,
      createdBy: "consolidator",
      now,
      expiresInDays: config.retention.proposal_days,
      // default rejectSkipDays (§7.5, 30 d): a human who rejected the fix is not asked again at every dream
    });
    if (opened.created && opened.proposalId !== null) {
      report.fixSignatureProposals.push(opened.proposalId);
      changed = true;
    }
  }
  return changed;
}

export interface BackfillEmbeddingsOptions {
  embed: EmbedFn;
  logger?: DreamLogger;
  /** Upper bound on rows embedded in one call (default: every live row without a vector). */
  limit?: number;
}

export interface BackfillEmbeddingsResult {
  embedded: number;
  errors: string[];
}

/**
 * Embeds live rows whose `embedding` is NULL (`summary\ndetails`, batches of EMBED_BATCH) through the injected
 * `embed`. Stops at the first embedder error and reports it; rows that already have a vector are left alone.
 * Shared by `worker dream` and the post-extraction pass of `worker extract` (new rows become dense-searchable
 * without waiting for the next dream).
 */
export async function backfillEmbeddings(repository: MemoryRepository, options: BackfillEmbeddingsOptions): Promise<BackfillEmbeddingsResult> {
  const result: BackfillEmbeddingsResult = { embedded: 0, errors: [] };
  let missing = repository.list({ status: LIVE_STATUSES }).filter((memory) => memory.embedding === null);
  if (options.limit !== undefined) missing = missing.slice(0, options.limit);
  for (let start = 0; start < missing.length; start += EMBED_BATCH) {
    const batch = missing.slice(start, start + EMBED_BATCH);
    let vectors: Float32Array[];
    try {
      vectors = await options.embed(batch.map((memory) => `${memory.summary}\n${memory.details}`));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      options.logger?.warn(`embedding backfill stopped: ${message}`);
      result.errors.push(`embed: ${message}`);
      break;
    }
    batch.forEach((memory, index) => {
      const vector = vectors[index];
      if (vector === undefined || vector.length === 0) return;
      repository.updateEmbedding(memory.id, vector);
      result.embedded += 1;
    });
  }
  return result;
}

/** One row awaiting a vector; `contentHash` lets the writer skip rows edited while the model ran. */
export interface EmbeddingBacklogItem {
  id: string;
  text: string;
  contentHash: string;
}

/**
 * Live rows without a vector, `preferIds` (the rows this run created) first, then the oldest backlog up to
 * `limit`. Read without the write lock by `worker extract`; the model then runs lock-free on the result.
 */
export function selectEmbeddingBacklog(repository: MemoryRepository, options: { preferIds?: ReadonlySet<string>; limit?: number } = {}): EmbeddingBacklogItem[] {
  const prefer = options.preferIds ?? new Set<string>();
  const missing = repository.list({ status: LIVE_STATUSES }).filter((memory) => memory.embedding === null);
  const preferred = missing.filter((memory) => prefer.has(memory.id));
  let rest = missing.filter((memory) => !prefer.has(memory.id)).sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  if (options.limit !== undefined) rest = rest.slice(0, Math.max(0, options.limit));
  return [...preferred, ...rest].map((memory) => ({ id: memory.id, text: `${memory.summary}\n${memory.details}`, contentHash: memory.contentHash }));
}

export interface EmbedBacklogResult {
  vectors: Map<string, Float32Array>;
  errors: string[];
}

/** Runs the embedder over `items` in batches of EMBED_BATCH (no database access); stops at the first embedder error. */
export async function embedBacklog(embed: EmbedFn, items: readonly EmbeddingBacklogItem[], logger?: DreamLogger): Promise<EmbedBacklogResult> {
  const result: EmbedBacklogResult = { vectors: new Map(), errors: [] };
  for (let start = 0; start < items.length; start += EMBED_BATCH) {
    const batch = items.slice(start, start + EMBED_BATCH);
    let vectors: Float32Array[];
    try {
      vectors = await embed(batch.map((item) => item.text));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger?.warn(`embedding pass stopped: ${message}`);
      result.errors.push(`embed: ${message}`);
      break;
    }
    batch.forEach((item, index) => {
      const vector = vectors[index];
      if (vector !== undefined && vector.length > 0) result.vectors.set(item.id, vector);
    });
  }
  return result;
}

/**
 * Writes vectors computed outside the lock: a row that vanished, left the live statuses, changed its text
 * (`content_hash`) or got a vector meanwhile is skipped. Returns the number of rows updated.
 */
export function applyEmbeddings(repository: MemoryRepository, items: readonly EmbeddingBacklogItem[], vectors: ReadonlyMap<string, Float32Array>): number {
  let written = 0;
  for (const item of items) {
    const vector = vectors.get(item.id);
    if (vector === undefined) continue;
    const current = repository.getById(item.id);
    if (current === null || !(LIVE_STATUSES as readonly string[]).includes(current.status)) continue;
    if (current.contentHash !== item.contentHash || current.embedding !== null) continue;
    repository.updateEmbedding(item.id, vector);
    written += 1;
  }
  return written;
}

// ---------------------------------------------------------------------------------------------
// Idle-turn sweep and GC (file system)
// ---------------------------------------------------------------------------------------------

function isSessionState(value: unknown): value is SessionState {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return record.schema === "state.v1" && typeof record.host === "string" && typeof record.session_id === "string" && typeof record.session_key === "string";
}

function writeJsonAtomic(file: string, value: unknown): void {
  const tmp = `${file}.tmp-${String(process.pid)}`;
  writeFileSync(tmp, JSON.stringify(value), "utf8");
  renameSync(tmp, file);
}

export interface IdleSweepResult {
  closed: EpisodeDescriptor[];
  errors: string[];
}

export interface IdleSweepOptions {
  /** Test seam: runs after a session was read and judged idle, right before its state is re-checked and advanced. */
  beforeAdvance?: (stateFile: string) => void;
}

function readStateFile(file: string): SessionState | null {
  const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
  return isSessionState(parsed) ? parsed : null;
}

/** Same test as the hooks' closeSegment: a segment of only assistant / marker lines is not an episode. */
function hasEpisodeContent(lines: readonly LedgerLine[]): boolean {
  return lines.some((line) => line.kind === "prompt" || line.kind === "tool_ok" || line.kind === "tool_fail" || line.kind === "fired");
}

function isToolLine(line: LedgerLine): line is ToolOkLine | ToolFailLine {
  return line.kind === "tool_ok" || line.kind === "tool_fail";
}

/** True when another writer (the session's own prompt/stop hook) changed the state or the ledger since `seen`. */
function sessionMoved(file: string, ledger: string, seen: SessionState, ledgerSize: number): boolean {
  let current: SessionState | null;
  try {
    current = readStateFile(file);
  } catch {
    return true;
  }
  if (current === null) return true;
  if (current.updated_at !== seen.updated_at || current.turn_key !== seen.turn_key || current.turn_start_offset !== seen.turn_start_offset || current.segment !== seen.segment) return true;
  try {
    return statSync(ledger).size !== ledgerSize;
  } catch {
    return true;
  }
}

/**
 * Closes open turns whose ledger has been idle for more than `idleMs` as `close_reason = 'idle'` and
 * writes their queue files (§5.8 (7), §9.4 F7). Selection and the resulting state follow the hooks'
 * closeSegment (src/adapters/hook-core.ts): only a segment with episode content is closed, `turn_key` is kept,
 * `segment` advances and `turn_start_offset` moves past the appended `idle_close` marker, so a session that
 * resumes afterwards closes its continuation as the next segment and its prompt hook sees the swept turn
 * through `last_episode_range`. The state is re-read right before it is advanced: when the session's own hook
 * moved it meanwhile (the user resumed), the sweep leaves it alone (§9.1: hooks own state/*.json).
 */
export function sweepIdleTurns(paths: HarnessPaths, now: string, idleMs: number = IDLE_TURN_MS, options: IdleSweepOptions = {}): IdleSweepResult {
  const result: IdleSweepResult = { closed: [], errors: [] };
  let entries: string[];
  try {
    entries = readdirSync(paths.stateDir);
  } catch {
    return result;
  }
  const nowMs = Date.parse(now);
  for (const name of entries) {
    if (!name.endsWith(".json") || name.endsWith(".notify.json") || /\.tmp-\d+$/.test(name)) continue;
    const file = join(paths.stateDir, name);
    try {
      const parsed = readStateFile(file);
      if (parsed === null || parsed.turn_key === null) continue;
      const ledger = ledgerFile(paths, parsed.host, parsed.session_key);
      if (!existsSync(ledger)) continue;
      const stat = statSync(ledger);
      if (parsed.turn_start_offset >= stat.size || nowMs - stat.mtimeMs < idleMs) continue;

      const range = readLedgerRangeLines(ledger, parsed.turn_start_offset, stat.size);
      if (!hasEpisodeContent(range.lines)) continue;

      let contextLines: LedgerLine[] | null = null;
      const previous = parsed.last_episode_range;
      if (parsed.correction_for !== undefined && previous !== undefined && previous.end > previous.start) {
        contextLines = readLedgerRangeLines(ledger, previous.start, previous.end).lines.filter(isToolLine);
      }
      const descriptor = buildEpisodeDescriptor({
        host: parsed.host,
        sessionId: parsed.session_id,
        sessionKey: parsed.session_key,
        turnKey: parsed.turn_key,
        segment: parsed.segment,
        lines: range.lines,
        byteStart: parsed.turn_start_offset,
        byteEnd: stat.size,
        ledgerFileName: basename(ledger),
        closeReason: "idle",
        now,
        correctionFor: parsed.correction_for ?? null,
        contextLines,
      });

      // The session's prompt hook may have closed this turn itself while we read: then nothing here is ours.
      options.beforeAdvance?.(file);
      if (sessionMoved(file, ledger, parsed, stat.size)) continue;

      mkdirSync(paths.queueDir, { recursive: true });
      writeJsonAtomic(queueFile(paths, descriptor.id), descriptor);
      result.closed.push(descriptor);
      const appended = appendLedgerLine(ledger, { kind: "marker", ts: now, seq: makeSeq(nowMs), turn_key: parsed.turn_key, marker: "idle_close", detail: descriptor.id });
      const next: SessionState = {
        ...parsed,
        segment: parsed.segment + 1,
        turn_start_offset: stat.size + appended,
        last_episode_id: descriptor.id,
        last_episode_range: { start: parsed.turn_start_offset, end: stat.size },
        updated_at: now,
      };
      writeJsonAtomic(file, next);
    } catch (error) {
      result.errors.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return result;
}

export interface GcResult {
  ledgers: number;
  states: number;
  raw: number;
  tmp: number;
}

function olderThan(file: string, nowMs: number, maxAgeMs: number): boolean {
  try {
    return nowMs - statSync(file).mtimeMs > maxAgeMs;
  } catch {
    return false;
  }
}

function openLedgerFiles(paths: HarnessPaths): Set<string> {
  const open = new Set<string>();
  try {
    for (const name of readdirSync(paths.stateDir)) {
      if (!name.endsWith(".json") || name.endsWith(".notify.json")) continue;
      try {
        const parsed: unknown = JSON.parse(readFileSync(join(paths.stateDir, name), "utf8"));
        if (isSessionState(parsed) && parsed.turn_key !== null) open.add(basename(ledgerFile(paths, parsed.host, parsed.session_key)));
      } catch {
        // unreadable state: leave its ledger alone
      }
    }
  } catch {
    // no state dir
  }
  return open;
}

/** Ledger files idle for `ledger_days` (not referenced by an open turn), stale state files, raw cache > `raw_hours`, tmp orphans. */
/** `hm import` writes its descriptor list next to the database and removes it afterwards; a crash leaves it behind. */
const IMPORT_DESCRIPTOR_FILE = /^import-[0-9]+-[0-9a-z]+\.json$/;

export function garbageCollectFiles(paths: HarnessPaths, config: HarnessConfig, now: string): GcResult {
  const nowMs = Date.parse(now);
  const result: GcResult = { ledgers: 0, states: 0, raw: 0, tmp: 0 };
  const ledgerMaxMs = config.retention.ledger_days * 24 * 60 * 60 * 1000;
  const open = openLedgerFiles(paths);

  try {
    for (const name of readdirSync(paths.ledgerDir)) {
      if (!name.endsWith(".jsonl") || open.has(name)) continue;
      const file = join(paths.ledgerDir, name);
      if (olderThan(file, nowMs, ledgerMaxMs)) {
        rmSync(file, { force: true });
        result.ledgers += 1;
      }
    }
  } catch {
    // no ledger dir
  }
  try {
    for (const name of readdirSync(paths.stateDir)) {
      if (!name.endsWith(".json")) continue;
      const file = join(paths.stateDir, name);
      if (!olderThan(file, nowMs, ledgerMaxMs)) continue;
      let ledgerPresent = true;
      try {
        const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
        if (isSessionState(parsed)) ledgerPresent = existsSync(ledgerFile(paths, parsed.host, parsed.session_key));
      } catch {
        ledgerPresent = false;
      }
      if (!ledgerPresent) {
        rmSync(file, { force: true });
        result.states += 1;
      }
    }
  } catch {
    // no state dir
  }
  try {
    const rawMaxMs = config.retention.raw_hours * 60 * 60 * 1000;
    for (const name of readdirSync(paths.rawDir)) {
      const file = join(paths.rawDir, name);
      if (olderThan(file, nowMs, rawMaxMs)) {
        rmSync(file, { force: true });
        result.raw += 1;
      }
    }
  } catch {
    // no raw dir
  }
  try {
    const rawMaxMs = config.retention.raw_hours * 60 * 60 * 1000;
    for (const name of readdirSync(paths.dir)) {
      if (!IMPORT_DESCRIPTOR_FILE.test(name)) continue;
      const file = join(paths.dir, name);
      if (olderThan(file, nowMs, rawMaxMs)) {
        rmSync(file, { force: true });
        result.tmp += 1;
      }
    }
  } catch {
    // no harness dir
  }
  result.tmp += cleanOrphanTmp(paths, undefined, nowMs).length;
  return result;
}

function gcAuditLog(db: SqlJsDatabase, config: HarnessConfig, now: string): number {
  const cutoff = addDays(now, -config.retention.audit_days);
  db.run("DELETE FROM audit_log WHERE created_at < ?", [cutoff]);
  const rows = selectAll(db, "SELECT changes() AS n");
  return rows.length === 0 ? 0 : Number(rows[0]!.n ?? 0);
}

// ---------------------------------------------------------------------------------------------
// runDream
// ---------------------------------------------------------------------------------------------

export async function runDream(db: SqlJsDatabase, options: DreamOptions): Promise<DreamWriteOp> {
  const { config, now, paths } = options;
  const repository = new MemoryRepository(db, { clock: () => now });
  const report: DreamReport = {
    ttlExtended: [],
    downgraded: [],
    revalidateProposals: [],
    staled: [],
    rejectedCandidates: [],
    expiredProposals: [],
    staledByExpiry: [],
    mergeProposals: [],
    fixSignatureProposals: [],
    sweptActivated: [],
    sweptProposalsClosed: [],
    sweptSuperseded: [],
    sweptErrors: [],
    embedded: 0,
    idleClosed: [],
    gc: { ledgers: 0, states: 0, raw: 0, tmp: 0, audit: 0 },
    errors: [],
  };
  let changed = false;

  const step = (name: string, fn: () => boolean): void => {
    db.run(`SAVEPOINT sp_dream_${name}`);
    try {
      if (fn()) changed = true;
      db.run(`RELEASE sp_dream_${name}`);
    } catch (error) {
      db.run(`ROLLBACK TO sp_dream_${name}`);
      db.run(`RELEASE sp_dream_${name}`);
      const message = error instanceof Error ? error.message : String(error);
      options.logger?.error(`dream step ${name} rolled back: ${message}`);
      report.errors.push(`${name}: ${message}`);
    }
  };

  step("fire", () => fireAndOverride(db, repository, now, report));
  step("sweep", () => fullSweep(db, repository, config, now, report));
  step("ttl", () => ttlExpiry(db, repository, config, now, report));
  step("expiry", () => candidateAndProposalExpiry(db, repository, config, now, report));
  step("merge", () => nearDuplicateMerges(db, repository, config, now, report));
  step("signature", () => fixSignatureProposals(db, repository, config, now, report));

  if (options.embed !== undefined && options.embed !== null) {
    db.run("SAVEPOINT sp_dream_embed");
    try {
      const backfill = await backfillEmbeddings(repository, { embed: options.embed, logger: options.logger });
      report.embedded += backfill.embedded;
      report.errors.push(...backfill.errors);
      if (backfill.embedded > 0) changed = true;
      db.run("RELEASE sp_dream_embed");
    } catch (error) {
      db.run("ROLLBACK TO sp_dream_embed");
      db.run("RELEASE sp_dream_embed");
      report.errors.push(`embed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (options.skipFiles !== true) {
    try {
      const swept = sweepIdleTurns(paths, now);
      report.idleClosed.push(...swept.closed.map((descriptor) => descriptor.id));
      report.errors.push(...swept.errors.map((message) => `sweep: ${message}`));
      const gc = garbageCollectFiles(paths, config, now);
      report.gc = { ...gc, audit: 0 };
    } catch (error) {
      report.errors.push(`files: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  report.gc.audit = gcAuditLog(db, config, now);

  new MetaRepository(db).set(META_KEYS.lastDreamAt, now);

  const op: WriteOp = changed
    ? { id: `dream:${now}`, kind: "dream", noop: false, wrote: true }
    : { id: null, kind: "dream", noop: true, wrote: true };
  return { ...op, report };
}
