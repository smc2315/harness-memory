/**
 * Replacement resolution (0.6.0-rc.3 design §2.1–§2.2, GAP B): a `supersede` contest `P(T, R)` whose target never
 * reached the snapshot (candidate) or already left it (stale, ttl_expired) resolves on one support under `full`.
 *
 * - `checkSupersedeResolution`: §2.1 rules 1–4 and 4b. The proposal is open and a `supersede`; `T` is a live auto
 *   candidate / ttl_expired row no human defended (humanRejectedContest) whose correction / remember origin, if any,
 *   is answered by one of the proposal's own supporters (the §5.7 step 6 rule); `R` is an auto candidate — or already
 *   active, when another contest of the same run activated it — that no human declined to activate and that no open
 *   proposal of another kind parks. Rule 5, `decideTier` on `R`, is the caller's (it owns the budgets) and is passed in
 *   as `passesTier`, because rule 4b needs it: when `R` is itself the target of an open contest `P′(R, R′)` that is
 *   resolvable — rules 1–5 on `P′`, or rules 1–4 with `P′` held in turn by a resolvable contest on `R′`, recursively up
 *   to CHAIN_MAX_DEPTH — `P` is `candidate_contested`: the chain is resolved from the correction end, so the resolution
 *   at its top walks `P′` and then `P`, and `T` is superseded by the correction, never by the contested `R` (§2.2,
 *   §2.4). A contest on `R` that cannot resolve holds nothing (§3): `P` proceeds as if it were not there.
 * - `applySupersedeResolution`: §2.2. `decideProposal(accept, auto_rule, full_autonomy)` is the one writer of
 *   `T → superseded` and `R → active` (TTL from tierTtlDays); nothing here activates `R` a second time. Then what the
 *   dead target and the activated row leave behind is closed: `T`'s other contests (`expired`), the `supersede`
 *   proposals whose candidate is `T` (accepted when their own target passes the same target rules with their own
 *   supporters — `T0` is then superseded by `R`, never by the dead `T` — otherwise `expired`, since a proposal whose
 *   candidate is dead can be accepted by nobody), and the `activate_*` proposals on `R`. Every proposal is re-read
 *   before it is decided: a diamond (one row replacing two rows of the same chain) lets an earlier hop's recursion
 *   close a later hop as a sibling, and that hop is then skipped instead of decided twice. Every touched target is
 *   re-flagged; one `full_supersede` audit row is written per superseded row.
 * - `chainTargets`: the read-only twin of that walk — the rows a resolution would reach behind a target — which the
 *   sweep holds back from its drain when a resolution throws (§2.4).
 *
 * No transaction or SAVEPOINT is opened here: the dream sweep and reconcile step 7 wrap each resolution in their own,
 * so a throw costs that resolution alone. The decision note and the transition reason the automatic `full` paths
 * share live here: consolidate re-exports them, reconcile binds FULL_SWEEP_TRANSITION_REASON in
 * `countAutoActivationsSince` (§2.5), and the tests read the same definitions. What counts as a contest is
 * proposals.ts's CONTESTING_KINDS, the set flagTarget's `contested` flag reads.
 */

import type { Database as SqlJsDatabase } from "sql.js";

import { createDeterministicId, digestText } from "../core/ids";
import { ProposalRepository, type ProposalRecord } from "../db/repositories/proposals";
import { MemoryRepository, type MemoryRecord } from "../memory/repository";
import {
  ACTIVATION_PROPOSAL_KINDS,
  CONTESTING_KINDS,
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

/** Chain hops walked from one resolution (§2.2), followed by rule 4b and chainTargets alike; extraction never parks replacements deeper than this. */
export const CHAIN_MAX_DEPTH = 10;

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
  | "candidate_contested"
  | "human_signal";

export interface SupersedeCheckOptions {
  /** §2.1 rule 5 as the caller judges it (decideTier with its own budgets); rule 4b asks it about the replacement of a contest on `R`. */
  passesTier: (candidate: MemoryRecord) => boolean;
}

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

/** §2.1 rules 1–4 and 4b (rule 5 is `options.passesTier`, the caller's decideTier; `depth` counts the 4b recursion). */
export function checkSupersedeResolution(db: SqlJsDatabase, proposalId: string, options: SupersedeCheckOptions, depth = 0): SupersedeCheck {
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

  // Rule 4b: a resolvable contest on R resolves first and settles this one through its chain walk (T is then superseded
  // by R's replacement, never by the contested R). A contest on R that is itself candidate_contested passed rules 1–4 and
  // is walked by the resolution further up, which then walks this one too, so it holds P as well. An unresolvable
  // contest on R holds nothing (§3). An active R keeps the two-session rule for its own contests, so they never resolve here.
  if (depth < CHAIN_MAX_DEPTH) {
    for (const contest of proposals.listOpen({ kind: "supersede", targetId: candidate.id })) {
      const inner = checkSupersedeResolution(db, contest.id, options, depth + 1);
      const held = inner.ok ? !inner.needsTierDecision || options.passesTier(inner.candidate) : inner.reason === "candidate_contested";
      if (held) return { ok: false, reason: "candidate_contested" };
    }
  }

  return { ok: true, proposal, target, candidate, needsTierDecision: candidate.status === "candidate" };
}

/**
 * The rows a resolution's chain walk would reach behind `targetId` (read-only, nearest first): the targets of the open
 * `supersede` proposals whose candidate is the row, then theirs, up to CHAIN_MAX_DEPTH hops, each named once. The sweep
 * holds them back with the literal target when a resolution throws, so the retry still finds them candidates (§2.4).
 */
export function chainTargets(proposals: ProposalRepository, targetId: string): string[] {
  const seen = new Set<string>([targetId]);
  const found: string[] = [];
  let frontier = [targetId];
  for (let depth = 0; depth < CHAIN_MAX_DEPTH && frontier.length > 0; depth += 1) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const hop of proposals.listOpen({ kind: "supersede", candidateId: id })) {
        if (seen.has(hop.targetMemoryId)) continue;
        seen.add(hop.targetMemoryId);
        found.push(hop.targetMemoryId);
        next.push(hop.targetMemoryId);
      }
    }
    frontier = next;
  }
  return found;
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
    if (ACTIVATION_PROPOSAL_KINDS.has(open.kind)) decideOnce(resolution, open.id, "expired");
  }
  flagTarget(db, replacementId, input.now);

  return resolution.result;
}

/**
 * Decides a proposal by auto_rule (full_autonomy) once: the record is re-read first, because an earlier hop's recursion
 * may already have closed it (a diamond's second hop is a sibling of the target the first hop retired), and deciding a
 * decided proposal throws, which would roll back the whole resolution on every run.
 */
function decideOnce(resolution: Resolution, proposalId: string, status: "accepted" | "expired"): void {
  if (resolution.proposals.getById(proposalId)?.status !== "open") return;
  resolution.proposals.decide(proposalId, { status, decidedBy: "auto_rule", note: FULL_AUTONOMY_DECISION_NOTE, now: resolution.input.now });
  (status === "accepted" ? resolution.result.proposalsAccepted : resolution.result.proposalsClosed).push(proposalId);
}

/**
 * What a row that just died leaves behind: its other contests close (a dead row cannot be contested further), the
 * `supersede` proposals that named it as the replacement of an older row are walked — each re-read first, since an
 * earlier hop's recursion may have decided it — and its flags are refreshed. Beyond CHAIN_MAX_DEPTH the walk stops and
 * the remaining proposals are left as they are.
 */
function retireTarget(resolution: Resolution, targetId: string, depth: number): void {
  for (const sibling of resolution.proposals.listOpen({ targetId })) {
    if (CONTESTING_KINDS.has(sibling.kind)) decideOnce(resolution, sibling.id, "expired");
  }
  if (depth < CHAIN_MAX_DEPTH) {
    for (const { id } of resolution.proposals.listOpen({ kind: "supersede", candidateId: targetId })) {
      const hop = resolution.proposals.getById(id);
      if (hop !== null && hop.status === "open") walkChainHop(resolution, hop, targetId, depth + 1);
    }
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
    decideOnce(resolution, hop.id, "expired");
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
  decideOnce(resolution, hop.id, "accepted");
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
