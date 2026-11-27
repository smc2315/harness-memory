/**
 * Proposal queue operations (spec §5.7 step 6, §5.8 (2)(3), §7.5).
 *
 * - `openOrSupportProposal`: one open proposal per (kind, target, candidate); the same claim from
 *   another episode upserts a support row; derived counts are recomputed in the same savepoint;
 *   a claim rejected within 30 days is skipped (`skipped_recent_reject`).
 * - `decideProposal`: accept / reject with the per-kind side effects, every status change through
 *   `transitionMemory` (human decisions make the row human; auto_rule never touches human rows). An accept
 *   that could not do what the proposal says (fix_* without a payload, supersede whose replacement is no
 *   longer live) throws `ProposalNotApplicableError` before anything is written and the proposal stays open.
 *   Rejecting a `revalidate` answers the TTL question like the proposal's expiry would: stale(ttl_expired).
 * - `evaluateAutoDemotion`: the §5.7 step 6 rule that lets two sessions demote an auto row.
 * - `expireProposals`: open → expired; an expired `revalidate` sends its auto row to stale(ttl_expired).
 * - `targetOriginHasHumanSignal` / `supportersCarryHumanSignal` / `humanRejectedContest` / `flagTarget`: the rules the
 *   auto demotion shares with the 0.6.0-rc.3 replacement resolution (design §2.1), exported so both read one definition.
 */

import type { Database as SqlJsDatabase } from "sql.js";

import { compileSignature } from "../activation/signature";
import type { EpisodeFlags } from "../core/episode-types";
import { AuthorityViolationError } from "../core/errors";
import {
  maxEnforcement,
  type ProposalCreator,
  type ProposalDecider,
  type ProposalKind,
  type TransitionActor,
  type TriggerSignature,
} from "../core/vocabulary";
import type { LifecycleTrigger } from "../db/schema/types";
import { EpisodeRepository } from "../db/repositories/episodes";
import { ProposalRepository, type ProposalRecord, type ProposalSupportRecord } from "../db/repositories/proposals";
import { ProvenanceRepository } from "../db/repositories/provenance";
import { InvalidMemoryTransitionError, MemoryRepository, type MemoryRecord } from "../memory/repository";
import { tierTtlDays } from "./authority";
import { addDays, midpointIso, revalidateMemory } from "./revalidate";
import { transitionMemory } from "./transitions";

export const RECENT_REJECT_SKIP_DAYS = 30;
export const AUTO_DEMOTION_MIN_SESSIONS = 2;
/** The proposal kinds whose human reject the automatic activation paths honour (0.6.0-rc.2 design §1). */
export const ACTIVATION_PROPOSAL_KINDS: ReadonlySet<ProposalKind> = new Set<ProposalKind>(["activate_policy", "activate_global"]);

/**
 * 0.6.0-rc.2 (design §1): true when a human rejected an `activate_policy` / `activate_global` proposal on this row.
 * Under `full`, reconcile's decideTiers and the dream sweep then leave the row a candidate for its life — it meets the
 * `retention.candidate_days` expiry like any declined rc.1 candidate — instead of enacting the claim the human
 * declined; `standard`'s re-proposal path keeps its own 30-day skip (openOrSupportProposal). Only
 * `decided_by = 'human'` counts: expiry and auto_rule write `expired`, never `rejected`.
 */
export function humanRejectedActivation(proposals: ProposalRepository, memoryId: string): boolean {
  return proposals
    .listForMemory(memoryId, { status: "rejected" })
    .some((proposal) => ACTIVATION_PROPOSAL_KINDS.has(proposal.kind) && proposal.decidedBy === "human" && proposal.targetMemoryId === memoryId);
}

/**
 * 0.6.0-rc.3 (design §2.1 rule 2): true when a human rejected a `supersede` / `stale` proposal whose literal target is
 * this row. The replacement resolution then leaves the row alone for good — a claim a human declined is never enacted
 * by the automatic path (design §7). Only `decided_by = 'human'` counts: the automatic paths close proposals as `expired`.
 */
export function humanRejectedContest(proposals: ProposalRepository, targetId: string): boolean {
  return proposals
    .listDecided({ targetId, status: "rejected" })
    .some((proposal) => (proposal.kind === "supersede" || proposal.kind === "stale") && proposal.decidedBy === "human");
}

export type ProposalNotApplicableCode = "payload_missing" | "candidate_not_live";

/**
 * Accepting the proposal would not do what it says (no payload to apply, replacement row no longer live).
 * Thrown before anything is written, so the proposal stays open and the rows are untouched. It extends
 * InvalidMemoryTransitionError on purpose: the requested change is a memory transition that cannot happen,
 * and the CLI renders that family as one error line (exit 1) instead of a stack trace.
 */
export class ProposalNotApplicableError extends InvalidMemoryTransitionError {
  constructor(
    public readonly proposalId: string,
    public readonly kind: ProposalKind,
    public readonly code: ProposalNotApplicableCode,
    detail: string
  ) {
    super(`Proposal ${proposalId} (${kind}) cannot be accepted: ${detail}`);
    this.name = "ProposalNotApplicableError";
  }
}

/** Marker that separates the human-readable rationale from a JSON payload (fix_scope / fix_signature). */
export const PROPOSAL_PAYLOAD_MARKER = "\n@payload ";

export interface ProposalPayload {
  scope_glob?: string;
  lifecycle_triggers?: LifecycleTrigger[];
  trigger_signature?: TriggerSignature | null;
  [key: string]: unknown;
}

export function withProposalPayload(rationale: string, payload: ProposalPayload): string {
  return `${rationale}${PROPOSAL_PAYLOAD_MARKER}${JSON.stringify(payload)}`;
}

export function parseProposalPayload(rationale: string): ProposalPayload | null {
  const index = rationale.lastIndexOf(PROPOSAL_PAYLOAD_MARKER);
  if (index === -1) return null;
  try {
    const parsed: unknown = JSON.parse(rationale.slice(index + PROPOSAL_PAYLOAD_MARKER.length));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as ProposalPayload) : null;
  } catch {
    return null;
  }
}

export interface ProposalSupportInput {
  episodeId: string;
  sessionId: string;
  extractionRunId?: string | null;
  confidence: number;
  /** Episode flags.correction or flags.remember. */
  hasHumanSignal?: 0 | 1;
  /** The signature command ran tool_ok in the same turn with no failure. */
  deterministic?: 0 | 1;
}

export interface OpenOrSupportInput {
  kind: ProposalKind;
  targetMemoryId: string;
  candidateMemoryId?: string | null;
  rationale: string;
  confidence: number;
  createdBy: ProposalCreator;
  now: string;
  expiresInDays?: number;
  support?: ProposalSupportInput | null;
  /** Days during which a rejected claim is not re-proposed (default 30; 0 disables). */
  rejectSkipDays?: number;
  /** Set open_proposal_id / contested on the target row (default true). */
  flagTarget?: boolean;
}

export interface OpenOrSupportResult {
  proposalId: string | null;
  proposal: ProposalRecord | null;
  created: boolean;
  supportCount: number;
  supportSessions: number;
  skipped: "recent_reject" | null;
}

/** Proposal kinds that contradict the target row; the others (activation, scope / signature fixes) only wait on a review. */
const CONTESTING_KINDS: ReadonlySet<string> = new Set(["supersede", "stale", "revalidate"]);

/**
 * Refreshes `open_proposal_id` / `contested` on a target from its open proposals, keeping the proposal the row already
 * names while it stays open. Shared with the 0.6.0-rc.3 replacement resolution, which refreshes every target it touches.
 */
export function flagTarget(db: SqlJsDatabase, targetId: string, now: string): void {
  const repository = new MemoryRepository(db, { clock: () => now });
  const target = repository.getById(targetId);
  if (target === null) return;
  const open = new ProposalRepository(db).listOpen({ targetId });
  const first = open[0] ?? null;
  const openProposalId = first === null ? null : target.openProposalId !== null && open.some((p) => p.id === target.openProposalId) ? target.openProposalId : first.id;
  const contested: 0 | 1 = open.some((proposal) => CONTESTING_KINDS.has(proposal.kind)) ? 1 : 0;
  if (target.openProposalId !== openProposalId || target.contested !== contested) {
    repository.setFlags(targetId, { openProposalId, contested, updatedAt: target.updatedAt });
  }
}

/** §7.5: open proposals are unique per (kind, target, candidate); the same claim only adds support. */
export function openOrSupportProposal(db: SqlJsDatabase, input: OpenOrSupportInput): OpenOrSupportResult {
  const proposals = new ProposalRepository(db);
  const candidateId = input.candidateMemoryId ?? null;
  const skipDays = input.rejectSkipDays ?? RECENT_REJECT_SKIP_DAYS;

  let proposal = proposals.findOpen(input.kind, input.targetMemoryId, candidateId);
  let created = false;

  if (proposal === null) {
    if (skipDays > 0) {
      const since = addDays(input.now, -skipDays);
      const rejected = proposals
        .listDecided({ kind: input.kind, targetId: input.targetMemoryId, status: "rejected", since })
        .filter((row) => (row.candidateMemoryId ?? null) === candidateId);
      if (rejected.length > 0) {
        return { proposalId: null, proposal: null, created: false, supportCount: 0, supportSessions: 0, skipped: "recent_reject" };
      }
    }
    proposal = proposals.create({
      kind: input.kind,
      targetMemoryId: input.targetMemoryId,
      candidateMemoryId: candidateId,
      rationale: input.rationale,
      confidence: input.confidence,
      createdBy: input.createdBy,
      now: input.now,
      expiresInDays: input.expiresInDays,
    });
    created = true;
  }

  if (input.support !== undefined && input.support !== null) {
    proposals.addSupport(proposal.id, {
      episodeId: input.support.episodeId,
      sessionId: input.support.sessionId,
      extractionRunId: input.support.extractionRunId ?? null,
      confidence: input.support.confidence,
      createdAt: input.now,
      hasHumanSignal: input.support.hasHumanSignal ?? 0,
      deterministic: input.support.deterministic ?? 0,
    });
  }

  const counts = proposals.recomputeDerived(proposal.id);
  if (input.flagTarget !== false) flagTarget(db, input.targetMemoryId, input.now);
  const refreshed = proposals.getById(proposal.id) ?? proposal;

  return {
    proposalId: refreshed.id,
    proposal: refreshed,
    created,
    supportCount: counts.supportCount,
    supportSessions: counts.supportSessions,
    skipped: null,
  };
}

export interface DecideProposalInput {
  proposalId: string;
  decidedBy: ProposalDecider;
  accept: boolean;
  now: string;
  note?: string | null;
  /** Actor written to memory_transitions; defaults to the decider. */
  actorForTransition?: TransitionActor;
  runId?: string | null;
  /**
   * memory_transitions.reason for every transition this decision makes (default `proposal:<kind>`; the reject paths keep
   * their `proposal:<kind> rejected`). The dream sweep passes `full_sweep` so countAutoActivationsSince keeps excluding
   * its activations from the daily caps (0.6.0-rc.3 §2.5); extraction-time resolutions keep the default and are counted.
   */
  transitionReason?: string;
}

export interface DecideProposalResult {
  proposal: ProposalRecord;
  /** Human-readable side-effect log (`target:superseded`, `replacement:active`, `target:stale(ttl_expired)` …). */
  effects: string[];
  memories: MemoryRecord[];
}

function actorOf(input: DecideProposalInput): TransitionActor {
  return input.actorForTransition ?? input.decidedBy;
}

function isLive(status: MemoryRecord["status"]): boolean {
  return status === "candidate" || status === "active" || status === "stale";
}

/**
 * Applies a decision with its side effects (§7.5):
 * - supersede → target superseded by the candidate; the candidate row is promoted (human decisions make it human);
 *   a candidate that is no longer live (rejected / superseded) cannot replace anything → ProposalNotApplicableError.
 *   By `auto_rule` the target may be active, candidate or stale(ttl_expired) (0.6.0-rc.3 §2.6 edges); a human-demoted
 *   stale target throws InvalidMemoryTransitionError from transitionMemory before anything is written
 * - stale → target stale
 * - activate_policy / activate_global → target active with authority human (human decider only)
 * - fix_scope / fix_signature → payload applied through setScope, needs_scope cleared (human → setAuthority human);
 *   without a payload there is nothing to apply → ProposalNotApplicableError (the proposal stays open)
 * - revalidate → TTL extended; a stale target returns to active
 * - merge → survivor = older row, enforcement = max, aliases merged; loser superseded (human only)
 * Rejecting a supersede by a human also rejects the still-candidate replacement row. Rejecting a revalidate
 * ("let it go stale", §5.8 (2)) sends the active target to stale(ttl_expired) like the proposal's expiry would,
 * so the consolidator does not re-open the same question at the next dream.
 */
export function decideProposal(db: SqlJsDatabase, input: DecideProposalInput): DecideProposalResult {
  const proposals = new ProposalRepository(db);
  const repository = new MemoryRepository(db, { clock: () => input.now });
  const proposal = proposals.getById(input.proposalId);
  if (proposal === null) throw new Error(`Proposal ${input.proposalId} was not found`);
  if (proposal.status !== "open") throw new Error(`Proposal ${input.proposalId} is already ${proposal.status}`);

  const actor = actorOf(input);
  const effects: string[] = [];
  const touched = new Map<string, MemoryRecord>();
  const remember = (memory: MemoryRecord | null): void => {
    if (memory !== null) touched.set(memory.id, memory);
  };
  const reason = input.transitionReason ?? `proposal:${proposal.kind}`;
  const target = repository.getById(proposal.targetMemoryId);
  const candidate = proposal.candidateMemoryId === null ? null : repository.getById(proposal.candidateMemoryId);

  if (input.accept) {
    if (target === null) {
      effects.push("target_missing");
    } else {
      switch (proposal.kind) {
        case "supersede": {
          if (candidate === null) {
            effects.push("candidate_missing");
            break;
          }
          if (!isLive(candidate.status)) {
            throw new ProposalNotApplicableError(
              proposal.id,
              proposal.kind,
              "candidate_not_live",
              `replacement ${candidate.id} is ${candidate.status}, so there is nothing live to activate in place of ${target.id}; reject the proposal (hm proposals:reject) or restore the replacement first`
            );
          }
          if (isLive(target.status)) {
            remember(
              transitionMemory(db, {
                memoryId: target.id,
                to: "superseded",
                actor,
                reason,
                now: input.now,
                proposalId: proposal.id,
                replacementId: candidate.id,
                runId: input.runId ?? null,
              })
            );
            effects.push("target:superseded");
          }
          if (candidate.status === "candidate" || candidate.status === "stale") {
            if (actor === "auto_rule" && candidate.authority !== "auto") {
              effects.push("replacement:left_candidate(human_row)");
            } else if (actor === "auto_rule" && candidate.status === "stale" && candidate.statusReason !== "ttl_expired") {
              effects.push("replacement:left_stale");
            } else {
              const promoted = transitionMemory(db, {
                memoryId: candidate.id,
                to: "active",
                actor,
                reason,
                now: input.now,
                proposalId: proposal.id,
                runId: input.runId ?? null,
              });
              if (actor === "auto_rule") {
                // The TTL every other activation path gives the row (0.6.0-rc.3 §2.7): the 7-day ceiling for a `task`
                // horizon, KNOWLEDGE_TTL_DAYS for a decision / architecture_constraint, baseTtlDays(kind) otherwise.
                const ttl = addDays(input.now, tierTtlDays(promoted.knowledgeKind, promoted.horizon, promoted.type));
                remember(repository.setTtl(candidate.id, { ttlExpiresAt: ttl, revalidateAfter: midpointIso(input.now, ttl), validationCount: Math.max(0, promoted.evidenceCount - 1), updatedAt: input.now }));
              } else {
                remember(promoted);
              }
              effects.push("replacement:active");
            }
          }
          break;
        }
        case "stale": {
          if (target.status === "active") {
            remember(transitionMemory(db, { memoryId: target.id, to: "stale", actor, reason, now: input.now, proposalId: proposal.id, runId: input.runId ?? null }));
            effects.push("target:stale");
          } else {
            effects.push(`target:unchanged(${target.status})`);
          }
          break;
        }
        case "activate_policy":
        case "activate_global": {
          if (actor !== "human") throw new AuthorityViolationError(target.id, actor, `accept ${proposal.kind}`);
          if (target.status === "candidate" || target.status === "stale" || target.status === "superseded") {
            remember(transitionMemory(db, { memoryId: target.id, to: "active", actor: "human", reason, now: input.now, proposalId: proposal.id }));
            effects.push("target:active(human)");
          } else {
            if (target.authority !== "human") remember(repository.setAuthority(target.id, "human", input.now));
            effects.push(`target:unchanged(${target.status})`);
          }
          break;
        }
        case "fix_scope":
        case "fix_signature": {
          const payload = parseProposalPayload(proposal.rationale);
          if (payload === null) {
            // Migration 019 and the consolidator write plain prose: without a payload an accept would only
            // clear needs_scope and seal the row as human while its scope / signature stay as they are.
            throw new ProposalNotApplicableError(
              proposal.id,
              proposal.kind,
              "payload_missing",
              "its rationale carries no @payload (scope_glob / lifecycle_triggers / trigger_signature), so accepting would change nothing but clear needs_scope and make the row human; reject or skip it, or re-create the row with `hm memory:add --scope … --signature … --active` and demote the old one"
            );
          }
          let signature: TriggerSignature | null | undefined = payload.trigger_signature;
          let signatureKey: string | undefined;
          if (signature !== undefined && signature !== null) {
            const compiled = compileSignature(signature);
            if (compiled.ok) {
              signatureKey = compiled.compiled.signature_key;
            } else {
              effects.push(`signature_dropped:${compiled.code}`);
              signature = null;
            }
          }
          remember(
            repository.setScope(target.id, {
              scopeGlob: payload.scope_glob ?? target.scopeGlob,
              lifecycleTriggers: payload.lifecycle_triggers,
              triggerSignature: signature,
              signatureKey,
              updatedAt: input.now,
            })
          );
          effects.push("target:scope_applied");
          remember(repository.setFlags(target.id, { needsScope: 0, updatedAt: input.now }));
          if (input.decidedBy === "human" && target.authority !== "human") {
            remember(repository.setAuthority(target.id, "human", input.now));
            effects.push("target:authority_human");
          }
          break;
        }
        case "revalidate": {
          const revalidated = revalidateMemory(db, target.id, { now: input.now, closedAt: input.now });
          remember(revalidated.memory);
          effects.push(revalidated.applied ? "target:revalidated" : `target:revalidate_skipped(${revalidated.skipped ?? "unchanged"})`);
          if (target.status === "stale") {
            try {
              remember(transitionMemory(db, { memoryId: target.id, to: "active", actor, reason, now: input.now, proposalId: proposal.id, runId: input.runId ?? null }));
              effects.push("target:active");
            } catch (error) {
              if (!(error instanceof InvalidMemoryTransitionError)) throw error;
              effects.push("target:left_stale");
            }
          }
          break;
        }
        case "merge": {
          if (actor !== "human") throw new AuthorityViolationError(target.id, actor, "accept merge");
          if (candidate === null) {
            effects.push("candidate_missing");
            break;
          }
          const [survivor, loser] = Date.parse(target.createdAt) <= Date.parse(candidate.createdAt) ? [target, candidate] : [candidate, target];
          const enforcement = maxEnforcement([survivor.enforcement, loser.enforcement]) ?? survivor.enforcement;
          if (enforcement !== survivor.enforcement) remember(repository.setEnforcement(survivor.id, enforcement, input.now));
          const aliases = [...new Set([...survivor.aliases, ...loser.aliases])];
          if (aliases.length !== survivor.aliases.length) remember(repository.setAliases(survivor.id, aliases, input.now));
          if (isLive(loser.status)) {
            remember(transitionMemory(db, { memoryId: loser.id, to: "superseded", actor: "human", reason, now: input.now, proposalId: proposal.id, replacementId: survivor.id }));
          }
          if (survivor.status === "candidate" || survivor.status === "stale") {
            remember(transitionMemory(db, { memoryId: survivor.id, to: "active", actor: "human", reason, now: input.now, proposalId: proposal.id }));
          }
          effects.push(`merge:survivor=${survivor.id}`);
          break;
        }
      }
    }
  } else if (proposal.kind === "supersede" && candidate !== null && candidate.status === "candidate" && input.decidedBy === "human") {
    remember(
      transitionMemory(db, {
        memoryId: candidate.id,
        to: "rejected",
        actor: "human",
        reason: input.transitionReason ?? "proposal:supersede rejected",
        now: input.now,
        proposalId: proposal.id,
      })
    );
    effects.push("replacement:rejected");
  } else if (proposal.kind === "revalidate" && target !== null && target.status === "active") {
    // §5.8 (2): the proposal asks "confirm the memory still holds or let it go stale"; a reject is the second
    // answer, so the row ends where the proposal's expiry would have sent it. A human may say so at any time;
    // any other decider only once the TTL has actually passed, and only for the auto rows it is allowed to touch.
    const staleActor: TransitionActor = input.decidedBy === "human" ? "human" : "expiry";
    const ttlPassed = target.ttlExpiresAt !== null && Date.parse(target.ttlExpiresAt) <= Date.parse(input.now);
    if (staleActor === "human" || (target.authority === "auto" && ttlPassed)) {
      remember(
        transitionMemory(db, {
          memoryId: target.id,
          to: "stale",
          actor: staleActor,
          reason: input.transitionReason ?? "proposal:revalidate rejected",
          now: input.now,
          proposalId: proposal.id,
          statusReason: target.authority === "auto" ? "ttl_expired" : undefined,
          runId: input.runId ?? null,
        })
      );
      effects.push(`target:stale(${target.authority === "auto" ? "ttl_expired" : "human"})`);
    }
  }

  const decided = proposals.decide(proposal.id, {
    status: input.accept ? "accepted" : "rejected",
    decidedBy: input.decidedBy,
    note: input.note ?? null,
    now: input.now,
  });

  if (target !== null) {
    flagTarget(db, target.id, input.now);
    remember(repository.getById(target.id));
  }
  if (candidate !== null) remember(repository.getById(candidate.id));

  return { proposal: decided, effects, memories: [...touched.values()] };
}

export interface AutoDemotionInput {
  proposalId: string;
  now: string;
  runId?: string | null;
  /**
   * memory_transitions.reason of the decision's transitions (default decideProposal's `proposal:<kind>`); the dream
   * sweep passes `full_sweep` so its activations stay out of the daily caps (0.6.0-rc.3 §2.5).
   */
  transitionReason?: string;
}

export interface AutoDemotionResult {
  applied: boolean;
  reason: string;
  decision?: DecideProposalResult;
}

function hasHumanSignalFlags(flags: EpisodeFlags): boolean {
  return flags.correction === 1 || flags.remember === 1;
}

/**
 * The §5.7 step 6 human-signal rule, target side (0.6.0-rc.3 §2.1 rule 3): true when an `origin` episode of the row
 * carries `correction` or `remember` — the row is the user's own words, so an agent's claim alone may not demote or
 * replace it. Reinforcing episodes do not count: they say the row was confirmed, not where it came from.
 */
export function targetOriginHasHumanSignal(db: SqlJsDatabase, memoryId: string): boolean {
  const episodes = new EpisodeRepository(db);
  return new ProvenanceRepository(db)
    .listForMemory(memoryId)
    .filter((row) => row.relation === "origin")
    .some((row) => {
      const episode = episodes.getById(row.episodeId);
      return episode !== null && hasHumanSignalFlags(episode.flags);
    });
}

/** The supporter side of the same rule: one supporter with has_human_signal or deterministic answers a human-signal origin. */
export function supportersCarryHumanSignal(supports: readonly ProposalSupportRecord[]): boolean {
  return supports.some((row) => row.hasHumanSignal === 1 || row.deterministic === 1);
}

/**
 * §5.7 step 6 auto demotion: type ≠ policy ∧ support_sessions ≥ 2 ∧ (when the target's origin episode
 * was a correction / remember episode, one supporter must carry has_human_signal or deterministic)
 * ∧ target active ∧ authority auto → accept by auto_rule. Human targets only get the proposal.
 */
export function evaluateAutoDemotion(db: SqlJsDatabase, input: AutoDemotionInput): AutoDemotionResult {
  const proposals = new ProposalRepository(db);
  const proposal = proposals.getById(input.proposalId);
  if (proposal === null || proposal.status !== "open") return { applied: false, reason: "not_open" };
  if (proposal.kind !== "supersede" && proposal.kind !== "stale") return { applied: false, reason: "kind" };
  const repository = new MemoryRepository(db, { clock: () => input.now });
  const target = repository.getById(proposal.targetMemoryId);
  if (target === null) return { applied: false, reason: "target_missing" };
  if (target.authority !== "auto") return { applied: false, reason: "human_target" };
  if (target.type === "policy") return { applied: false, reason: "policy" };
  if (target.status !== "active") return { applied: false, reason: `status:${target.status}` };
  if (proposal.supportSessions < AUTO_DEMOTION_MIN_SESSIONS) return { applied: false, reason: "support_sessions" };
  if (proposal.kind === "supersede" && proposal.candidateMemoryId !== null) {
    // A replacement that expired or was rejected while the proposal gathered support cannot take the target's place.
    const candidate = repository.getById(proposal.candidateMemoryId);
    if (candidate !== null && !isLive(candidate.status)) return { applied: false, reason: "candidate_not_live" };
  }

  if (targetOriginHasHumanSignal(db, target.id) && !supportersCarryHumanSignal(proposals.listSupport(proposal.id))) {
    return { applied: false, reason: "origin_human_signal_unmatched" };
  }

  const decision = decideProposal(db, {
    proposalId: proposal.id,
    decidedBy: "auto_rule",
    accept: true,
    now: input.now,
    note: `auto demotion: ${String(proposal.supportSessions)} sessions`,
    transitionReason: input.transitionReason,
    runId: input.runId ?? null,
  });
  return { applied: true, reason: "accepted", decision };
}

export interface ExpireProposalsResult {
  expired: string[];
  /** Targets of expired `revalidate` proposals sent to stale(ttl_expired). */
  staled: string[];
}

/** §5.8 (3): open proposals past expires_at become `expired`; an expired revalidate stales its auto row (§5.8 (2)). */
export function expireProposals(db: SqlJsDatabase, options: { now: string }): ExpireProposalsResult {
  const proposals = new ProposalRepository(db);
  const repository = new MemoryRepository(db, { clock: () => options.now });
  const expired = proposals.expire(options.now);
  const staled: string[] = [];

  for (const id of expired) {
    const proposal = proposals.getById(id);
    if (proposal === null) continue;
    const target = repository.getById(proposal.targetMemoryId);
    if (target === null) continue;
    if (
      proposal.kind === "revalidate" &&
      target.authority === "auto" &&
      target.status === "active" &&
      target.ttlExpiresAt !== null &&
      Date.parse(target.ttlExpiresAt) <= Date.parse(options.now)
    ) {
      transitionMemory(db, {
        memoryId: target.id,
        to: "stale",
        actor: "expiry",
        reason: "revalidate proposal expired",
        now: options.now,
        proposalId: proposal.id,
        statusReason: "ttl_expired",
      });
      staled.push(target.id);
    }
    flagTarget(db, target.id, options.now);
  }

  return { expired, staled };
}
