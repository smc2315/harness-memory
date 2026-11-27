/**
 * Replacement resolution (0.6.0-rc.3 design §2.1–§2.2, GAP B): a `supersede` contest `P(T, R)` whose target never
 * reached the snapshot (candidate) or already left it (stale, ttl_expired) resolves on one support under `full`.
 *
 * - `checkSupersedeResolution`: §2.1 rules 1–4. The proposal is open and a `supersede`; `T` is a live auto
 *   candidate / ttl_expired row no human defended (humanRejectedContest) whose correction / remember origin, if any,
 *   is answered by one of the proposal's own supporters (the §5.7 step 6 rule); `R` is an auto candidate — or already
 *   active, when another contest of the same run activated it — that no human declined to activate and that no open
 *   proposal of another kind parks. Rule 5, `decideTier` on `R`, is the caller's: it owns the budgets.
 * - `applySupersedeResolution`: §2.2. `decideProposal(accept, auto_rule, full_autonomy)` is the one writer of
 *   `T → superseded` and `R → active` (TTL from tierTtlDays); nothing here activates `R` a second time. Then what the
 *   dead target and the activated row leave behind is closed: `T`'s other contests (`expired`), the `supersede`
 *   proposals whose candidate is `T` (accepted when their own target passes the same target rules with their own
 *   supporters — `T0` is then superseded by `R`, never by the dead `T` — otherwise `expired`, since a proposal whose
 *   candidate is dead can be accepted by nobody), and the `activate_*` proposals on `R`. Every touched target is
 *   re-flagged; one `full_supersede` audit row is written per superseded row.
 *
 * No transaction or SAVEPOINT is opened here: the dream sweep and reconcile step 7 wrap each resolution in their own,
 * so a throw costs that resolution alone. The two literals they share with the rc.2 sweep live here so
 * `countAutoActivationsSince` (reconcile), consolidate and the tests read one definition.
 */

import type { Database as SqlJsDatabase } from "sql.js";

import { createDeterministicId, digestText } from "../core/ids";
import type { ProposalKind } from "../core/vocabulary";
import { ProposalRepository, type ProposalRecord } from "../db/repositories/proposals";
import { MemoryRepository, type MemoryRecord } from "../memory/repository";
import {
  ACTIVATION_PROPOSAL_KINDS,
  decideProposal,
  flagTarget,
  humanRejectedActivation,
  humanRejectedContest,
  supportersCarryHumanSignal,
  targetOriginHasHumanSignal,
} from "./proposals";
import { transitionMemory } from "./transitions";

/** `proposals.decision_note` of every proposal the automatic `full` paths decide: the sweep's closures and the resolutions here. */
export const FULL_AUTONOMY_DECISION_NOTE = "full_autonomy";
/** `memory_transitions.reason` of a sweep activation or resolution; `countAutoActivationsSince` excludes exactly this literal (§2.5). */
export const FULL_SWEEP_TRANSITION_REASON = "full_sweep";
/** `audit_log.event_type` written once per row a resolution supersedes, chain hops included. */
export const FULL_SUPERSEDE_AUDIT_EVENT = "full_supersede";

/** Chain hops walked from one resolution (§2.2); extraction never parks replacements deeper than this. */
const CHAIN_MAX_DEPTH = 10;
/** Proposal kinds that contest their target; closed on a target that just died (the others may still restore it). */
const CONTEST_KINDS: ReadonlySet<ProposalKind> = new Set<ProposalKind>(["supersede", "stale", "revalidate"]);

export type SupersedeSkipReason =
  | "not_open"
  | "kind"
  | "target_missing"
  | "target_human"
  | "target_status"
  | "target_human_rejected"
  | "candidate_missing"
  | "candidate_human"
  | "candidate_status"
  | "candidate_other_proposal"
  | "candidate_human_rejected"
  | "human_signal";

export type SupersedeCheck =
  | {
      ok: true;
      proposal: ProposalRecord;
      target: MemoryRecord;
      candidate: MemoryRecord;
      /** false when the candidate is already active (resolved another contest) */
      needsTierDecision: boolean;
    }
  | { ok: false; reason: SupersedeSkipReason };

/** §2.1 rule 1, status half: never shown (candidate) or already out of the snapshot (stale through its TTL). */
function isResolvableTargetStatus(memory: MemoryRecord): boolean {
  return memory.status === "candidate" || (memory.status === "stale" && memory.statusReason === "ttl_expired");
}

/**
 * §2.1 rules 1–3 on a target, judged with the given proposal's supporters: null when `auto_rule` may supersede it.
 * One definition for the contest itself and for every hop of the chain behind it.
 */
function targetSkipReason(db: SqlJsDatabase, proposals: ProposalRepository, target: MemoryRecord, proposalId: string): SupersedeSkipReason | null {
  if (target.authority !== "auto") return "target_human";
  if (!isResolvableTargetStatus(target)) return "target_status";
  if (humanRejectedContest(proposals, target.id)) return "target_human_rejected";
  if (targetOriginHasHumanSignal(db, target.id) && !supportersCarryHumanSignal(proposals.listSupport(proposalId))) return "human_signal";
  return null;
}

/** §2.1 rules 1–4 (rule 5, decideTier, is the caller's). */
export function checkSupersedeResolution(db: SqlJsDatabase, proposalId: string): SupersedeCheck {
  const proposals = new ProposalRepository(db);
  const repository = new MemoryRepository(db);
  const proposal = proposals.getById(proposalId);
  if (proposal === null || proposal.status !== "open") return { ok: false, reason: "not_open" };
  if (proposal.kind !== "supersede") return { ok: false, reason: "kind" };

  const target = repository.getById(proposal.targetMemoryId);
  if (target === null) return { ok: false, reason: "target_missing" };
  const targetReason = targetSkipReason(db, proposals, target, proposal.id);
  if (targetReason !== null) return { ok: false, reason: targetReason };

  const candidate = proposal.candidateMemoryId === null ? null : repository.getById(proposal.candidateMemoryId);
  if (candidate === null) return { ok: false, reason: "candidate_missing" };
  if (candidate.authority !== "auto") return { ok: false, reason: "candidate_human" };
  if (candidate.status !== "candidate" && candidate.status !== "active") return { ok: false, reason: "candidate_status" };
  // A merge (or any other kind) that names the row keeps it parked exactly as rc.2 would; other supersede contests do not.
  if (proposals.listOpen({ candidateId: candidate.id }).some((other) => other.kind !== "supersede")) {
    return { ok: false, reason: "candidate_other_proposal" };
  }
  if (humanRejectedActivation(proposals, candidate.id)) return { ok: false, reason: "candidate_human_rejected" };

  return { ok: true, proposal, target, candidate, needsTierDecision: candidate.status === "candidate" };
}

export interface ApplySupersedeInput {
  proposalId: string;
  now: string;
  runId?: string | null;
  /** memory_transitions.reason of every transition (default decideProposal's `proposal:supersede`); the sweep passes FULL_SWEEP_TRANSITION_REASON. */
  transitionReason?: string;
  /** Who resolved the contest, recorded in the audit details. */
  source: "sweep" | "extraction";
  /** audit_log.session_id: reconcile knows the episode's session, the sweep has none. */
  sessionId?: string | null;
}

export interface ApplySupersedeResult {
  replacementId: string;
  /** false when `R` was already active before this resolution (another contest of the same run activated it). */
  replacementActivated: boolean;
  /** `T` first, then every chain target in walk order. */
  superseded: string[];
  /** `P` first, then every accepted chain proposal. */
  proposalsAccepted: string[];
  /** Contests on the dead targets, chain proposals that did not pass and activate_* on `R`: all expired(full_autonomy). */
  proposalsClosed: string[];
}

interface Resolution {
  db: SqlJsDatabase;
  proposals: ProposalRepository;
  repository: MemoryRepository;
  input: ApplySupersedeInput;
  replacementId: string;
  result: ApplySupersedeResult;
}

/**
 * §2.2: decideProposal(accept, auto_rule, full_autonomy) + sibling closure + candidate-side chain + activate_* closure + audit.
 * Caller guarantees checkSupersedeResolution ok and (if needsTierDecision) an active TierDecision. The rows are re-read
 * before every write (decideProposal reads its own), so a human target that slipped past the check still throws
 * AuthorityViolationError from transitionMemory before anything is written.
 */
export function applySupersedeResolution(db: SqlJsDatabase, input: ApplySupersedeInput): ApplySupersedeResult {
  const proposals = new ProposalRepository(db);
  const repository = new MemoryRepository(db, { clock: () => input.now });
  const proposal = proposals.getById(input.proposalId);
  if (proposal === null) throw new Error(`Proposal ${input.proposalId} was not found`);
  if (proposal.candidateMemoryId === null) throw new Error(`Proposal ${input.proposalId} (${proposal.kind}) names no replacement`);
  const replacementId = proposal.candidateMemoryId;
  const resolution: Resolution = {
    db,
    proposals,
    repository,
    input,
    replacementId,
    result: { replacementId, replacementActivated: false, superseded: [], proposalsAccepted: [], proposalsClosed: [] },
  };

  const target = repository.getById(proposal.targetMemoryId);
  const decision = decideProposal(db, {
    proposalId: proposal.id,
    decidedBy: "auto_rule",
    accept: true,
    now: input.now,
    note: FULL_AUTONOMY_DECISION_NOTE,
    transitionReason: input.transitionReason,
    runId: input.runId ?? null,
  });
  resolution.result.replacementActivated = decision.effects.includes("replacement:active");
  resolution.result.proposalsAccepted.push(proposal.id);
  if (target !== null && decision.effects.includes("target:superseded")) {
    recordSuperseded(resolution, target, proposal.id, null);
    retireTarget(resolution, target.id, 0);
  }

  for (const open of proposals.listOpen({ targetId: replacementId })) {
    if (ACTIVATION_PROPOSAL_KINDS.has(open.kind)) expire(resolution, open.id);
  }
  flagTarget(db, replacementId, input.now);

  return resolution.result;
}

function expire(resolution: Resolution, proposalId: string): void {
  resolution.proposals.decide(proposalId, { status: "expired", decidedBy: "auto_rule", note: FULL_AUTONOMY_DECISION_NOTE, now: resolution.input.now });
  resolution.result.proposalsClosed.push(proposalId);
}

/**
 * What a row that just died leaves behind: its other contests close (a dead row cannot be contested further), the
 * `supersede` proposals that named it as the replacement of an older row are walked, and its flags are refreshed.
 * Beyond CHAIN_MAX_DEPTH the walk stops and the remaining proposals are left as they are.
 */
function retireTarget(resolution: Resolution, targetId: string, depth: number): void {
  for (const sibling of resolution.proposals.listOpen({ targetId })) {
    if (CONTEST_KINDS.has(sibling.kind)) expire(resolution, sibling.id);
  }
  if (depth < CHAIN_MAX_DEPTH) {
    for (const hop of resolution.proposals.listOpen({ kind: "supersede", candidateId: targetId })) walkChainHop(resolution, hop, targetId, depth + 1);
  }
  flagTarget(resolution.db, targetId, resolution.input.now);
}

/**
 * One chain hop `P'(T0, T)`: `T0` is read afresh and judged by the target rules with `P'`'s own supporters. Passing,
 * it is superseded by `R` (never by the dead `T`), `P'` is accepted and `T0` retired in turn; otherwise `P'` closes as
 * expired and `T0` is left exactly as it is.
 */
function walkChainHop(resolution: Resolution, hop: ProposalRecord, via: string, depth: number): void {
  const { db, proposals, repository, input, replacementId } = resolution;
  const target = repository.getById(hop.targetMemoryId);
  if (target === null || targetSkipReason(db, proposals, target, hop.id) !== null) {
    expire(resolution, hop.id);
    if (target !== null) flagTarget(db, target.id, input.now);
    return;
  }

  transitionMemory(db, {
    memoryId: target.id,
    to: "superseded",
    actor: "auto_rule",
    reason: input.transitionReason ?? "proposal:supersede",
    now: input.now,
    proposalId: hop.id,
    replacementId,
    runId: input.runId ?? null,
  });
  proposals.decide(hop.id, { status: "accepted", decidedBy: "auto_rule", note: FULL_AUTONOMY_DECISION_NOTE, now: input.now });
  resolution.result.proposalsAccepted.push(hop.id);
  recordSuperseded(resolution, target, hop.id, via);
  retireTarget(resolution, target.id, depth);
}

/** One `full_supersede` audit row per superseded row; `via` names the dead row a chain hop was reached through. */
function recordSuperseded(resolution: Resolution, target: MemoryRecord, proposalId: string, via: string | null): void {
  const { input, replacementId } = resolution;
  resolution.result.superseded.push(target.id);
  const details = { targetId: target.id, replacementId, proposalId, source: input.source, ...(via === null ? {} : { via }) };
  resolution.db.run(
    `INSERT OR IGNORE INTO audit_log (id, event_type, session_id, scope_ref, summary, details_json, created_at)
     VALUES (?, ?, ?, NULL, ?, ?, ?)`,
    [
      createDeterministicId(`audit:${FULL_SUPERSEDE_AUDIT_EVENT}:${target.id}:${replacementId}:${input.now}`),
      FULL_SUPERSEDE_AUDIT_EVENT,
      input.sessionId ?? null,
      `full supersede (${input.source}): ${target.type} ${digestText(target.summary, 80)} superseded by ${replacementId}${via === null ? "" : ` via ${via}`}`,
      JSON.stringify(details),
      input.now,
    ]
  );
}
