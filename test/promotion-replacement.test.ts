/**
 * Replacement resolution (0.6.0-rc.3 design §2.1 / §2.2): checkSupersedeResolution says whether an open `supersede`
 * contest against a never-shown candidate or a TTL-expired row may be resolved by auto_rule; applySupersedeResolution
 * resolves it through decideProposal and closes what the dead target and the activated replacement leave behind.
 */

import { beforeEach, describe, expect, test } from "vitest";
import type { Database as SqlJsDatabase } from "sql.js";

import { AuthorityViolationError } from "../src/core/errors";
import type { ProposalKind } from "../src/core/vocabulary";
import { ProposalRepository } from "../src/db/repositories/proposals";
import { ProvenanceRepository } from "../src/db/repositories/provenance";
import { TransitionRepository } from "../src/db/repositories/transitions";
import { selectAll } from "../src/db/sql";
import { FULL_AUTONOMY_DECISION_NOTE as CONSOLIDATE_NOTE, FULL_SWEEP_TRANSITION_REASON as CONSOLIDATE_REASON } from "../src/dream/consolidate";
import { MemoryRepository, type CreateMemoryInput, type MemoryRecord } from "../src/memory/repository";
import * as promotion from "../src/promotion";
import { decideProposal, openOrSupportProposal } from "../src/promotion/proposals";
import {
  CHAIN_MAX_DEPTH,
  FULL_AUTONOMY_DECISION_NOTE,
  FULL_SUPERSEDE_AUDIT_EVENT,
  FULL_SWEEP_TRANSITION_REASON,
  applySupersedeResolution,
  chainTargets,
  checkSupersedeResolution,
} from "../src/promotion/replacement";
import { transitionMemory } from "../src/promotion/transitions";
import { createTestDb } from "./helpers/create-test-db";
import { T0, autoMemory, humanMemory, insertEpisode, isoPlus } from "./helpers/memory-fixtures";

let db: SqlJsDatabase;
let memories: MemoryRepository;
let proposals: ProposalRepository;
let transitions: TransitionRepository;
/** Rows are created at T0; the dream / reconcile that resolves them runs an hour later. */
const NOW = isoPlus(T0, { hours: 1 });

beforeEach(async () => {
  db = await createTestDb({ now: T0 });
  memories = new MemoryRepository(db, { clock: () => T0 });
  proposals = new ProposalRepository(db);
  transitions = new TransitionRepository(db);
});

interface SupportSpec {
  episodeId: string;
  sessionId: string;
  hasHumanSignal?: 0 | 1;
  deterministic?: 0 | 1;
}

/** Opens a proposal or adds a support to the open one (an extractor claim at confidence 0.8). */
function open(kind: ProposalKind, targetId: string, candidateId: string | null, support?: SupportSpec): string {
  const result = openOrSupportProposal(db, {
    kind,
    targetMemoryId: targetId,
    candidateMemoryId: candidateId,
    rationale: "r",
    confidence: 0.8,
    createdBy: "extractor",
    now: T0,
    support: support === undefined ? null : { confidence: 0.8, ...support },
  });
  return result.proposalId!;
}

/** A supersede contest P(T, R): R is a fresh auto candidate (a convention rule unless overridden) naming `targetId`. */
function contest(targetId: string, replacement: Partial<CreateMemoryInput> = {}, support?: SupportSpec) {
  const candidate = memories.create(autoMemory({ knowledgeKind: "convention", supersedesMemoryId: targetId, ...replacement }));
  const proposalId = open("supersede", targetId, candidate.id, support);
  return { candidate, proposalId };
}

/** An auto row that went stale through its TTL — the second target shape §2.1 rule 1 admits. */
function ttlExpiredRow(summary: string) {
  const row = memories.create(autoMemory({ status: "active", summary }));
  return transitionMemory(db, { memoryId: row.id, to: "stale", actor: "expiry", reason: "ttl_expired", now: T0, statusReason: "ttl_expired" });
}

/** The row's origin episode, with the flags that make it the user's own words. */
function origin(memoryId: string, episodeId: string, flags: Record<string, 1> = {}): void {
  insertEpisode(db, { id: episodeId, session_id: `session-${episodeId}`, flags });
  new ProvenanceRepository(db).insert({ memoryId, episodeId, eventSeq: 1, relation: "origin", confidence: 0.8, createdAt: T0 });
}

function auditRows() {
  const sql = `SELECT session_id, summary, details_json FROM audit_log WHERE event_type = '${FULL_SUPERSEDE_AUDIT_EVENT}' ORDER BY rowid ASC`;
  return selectAll(db, sql).map((row) => ({
    sessionId: row.session_id,
    summary: String(row.summary),
    details: JSON.parse(String(row.details_json)) as Record<string, unknown>,
  }));
}

/** checkSupersedeResolution with rule 5 as this test judges it: every replacement passes the bar unless the test says otherwise. */
function check(proposalId: string, passesTier: (candidate: MemoryRecord) => boolean = () => true) {
  return checkSupersedeResolution(db, proposalId, { passesTier });
}

/** Rule 5 by the stored confidence alone (decideTier's bar is 0.7): the cheapest stand-in for the caller's decideTier. */
const confidenceBar = (candidate: MemoryRecord): boolean => candidate.confidence >= 0.7;

/** A resolution the sweep would run: reason `full_sweep`, no session. */
function sweep(proposalId: string) {
  return applySupersedeResolution(db, { proposalId, now: NOW, source: "sweep", transitionReason: FULL_SWEEP_TRANSITION_REASON });
}

function expired(id: string): void {
  expect(proposals.getById(id)).toMatchObject({ status: "expired", decidedBy: "auto_rule", decisionNote: FULL_AUTONOMY_DECISION_NOTE, decidedAt: NOW });
}

describe("replacement module surface", () => {
  test("the literals the sweep, reconcile and the tests share are defined once; consolidate and the promotion barrel re-export them", () => {
    expect(FULL_AUTONOMY_DECISION_NOTE).toBe("full_autonomy");
    expect(FULL_SWEEP_TRANSITION_REASON).toBe("full_sweep");
    expect(FULL_SUPERSEDE_AUDIT_EVENT).toBe("full_supersede");
    expect(CONSOLIDATE_NOTE).toBe(FULL_AUTONOMY_DECISION_NOTE);
    expect(CONSOLIDATE_REASON).toBe(FULL_SWEEP_TRANSITION_REASON);
    expect(promotion.checkSupersedeResolution).toBe(checkSupersedeResolution);
    expect(promotion.applySupersedeResolution).toBe(applySupersedeResolution);
    expect(promotion.chainTargets).toBe(chainTargets);
    expect(CHAIN_MAX_DEPTH).toBe(10);
  });
});

describe("checkSupersedeResolution (design §2.1 rules 1–4)", () => {
  test("a candidate target, a candidate replacement and no signals resolve on one support; the replacement still needs its tier decision", () => {
    const target = memories.create(autoMemory({ summary: "Never-shown target" }));
    const { candidate, proposalId } = contest(target.id, {}, { episodeId: "ep-c1", sessionId: "s1" });

    expect(check(proposalId)).toMatchObject({
      ok: true,
      needsTierDecision: true,
      proposal: { id: proposalId, kind: "supersede", status: "open", supportCount: 1 },
      target: { id: target.id, status: "candidate", authority: "auto" },
      candidate: { id: candidate.id, status: "candidate", authority: "auto" },
    });
  });

  test("an active target keeps the two-session rule: target_status", () => {
    const target = memories.create(autoMemory({ status: "active", summary: "Injected target" }));
    const { proposalId } = contest(target.id, {}, { episodeId: "ep-c2", sessionId: "s2" });

    expect(check(proposalId)).toEqual({ ok: false, reason: "target_status" });
  });

  test("a stale target resolves only when its TTL expired; a human's demotion is target_status", () => {
    const expiredTarget = ttlExpiredRow("Expired target");
    expect(check(contest(expiredTarget.id).proposalId)).toMatchObject({
      ok: true,
      target: { id: expiredTarget.id, status: "stale", statusReason: "ttl_expired" },
    });

    const demoted = memories.create(autoMemory({ status: "active", summary: "Demoted target" }));
    transitionMemory(db, { memoryId: demoted.id, to: "stale", actor: "human", reason: "cli:memory:demote", now: T0 });
    expect(memories.getById(demoted.id)?.statusReason).toBe("human");
    expect(check(contest(demoted.id).proposalId)).toEqual({ ok: false, reason: "target_status" });
  });

  test("a human target is target_human whatever its status", () => {
    const active = memories.create(humanMemory({ summary: "Human rule" }));
    expect(check(contest(active.id).proposalId)).toEqual({ ok: false, reason: "target_human" });

    const candidate = memories.create(humanMemory({ status: "candidate", summary: "Human candidate" }));
    expect(check(contest(candidate.id).proposalId)).toEqual({ ok: false, reason: "target_human" });
  });

  test("a correction-born target needs a supporter with has_human_signal or deterministic (rule 3)", () => {
    const corrected = memories.create(autoMemory({ summary: "Correction-born target" }));
    origin(corrected.id, "ep-o5", { correction: 1 });
    const { candidate, proposalId } = contest(corrected.id, {}, { episodeId: "ep-s5a", sessionId: "s5a" });
    expect(check(proposalId)).toEqual({ ok: false, reason: "human_signal" });

    open("supersede", corrected.id, candidate.id, { episodeId: "ep-s5b", sessionId: "s5b", hasHumanSignal: 1 });
    expect(check(proposalId)).toMatchObject({ ok: true, proposal: { id: proposalId, supportCount: 2 } });

    const remembered = memories.create(autoMemory({ summary: "Remember-born target" }));
    origin(remembered.id, "ep-o5b", { remember: 1 });
    const deterministic = contest(remembered.id, {}, { episodeId: "ep-s5c", sessionId: "s5c", deterministic: 1 });
    expect(check(deterministic.proposalId)).toMatchObject({ ok: true, target: { id: remembered.id } });

    // a plain origin asks nothing of the supporters
    const plain = memories.create(autoMemory({ summary: "Plain-born target" }));
    origin(plain.id, "ep-o5c");
    const plainContest = contest(plain.id, {}, { episodeId: "ep-s5d", sessionId: "s5d" });
    expect(check(plainContest.proposalId)).toMatchObject({ ok: true });
  });

  test("a supersede / stale on the target rejected by a human blocks for good; an auto_rule reject does not (rule 2)", () => {
    const defended = memories.create(autoMemory({ summary: "Target a human defended" }));
    decideProposal(db, { proposalId: open("stale", defended.id, null), decidedBy: "human", accept: false, now: T0 });
    expect(check(contest(defended.id).proposalId)).toEqual({ ok: false, reason: "target_human_rejected" });

    const declined = memories.create(autoMemory({ summary: "Target the auto rule declined to stale" }));
    decideProposal(db, { proposalId: open("stale", declined.id, null), decidedBy: "auto_rule", accept: false, now: T0 });
    expect(check(contest(declined.id).proposalId)).toMatchObject({ ok: true, target: { id: declined.id } });
  });

  test("a replacement parked by an open proposal of another kind is candidate_other_proposal; a second supersede naming it is not", () => {
    const target = memories.create(autoMemory({ summary: "Target" }));
    const { candidate, proposalId } = contest(target.id);
    const otherTarget = memories.create(autoMemory({ summary: "Other target the same row replaces" }));
    open("supersede", otherTarget.id, candidate.id);
    expect(check(proposalId)).toMatchObject({ ok: true });

    const twin = memories.create(autoMemory({ summary: "Near-duplicate of the replacement" }));
    open("merge", twin.id, candidate.id);
    expect(check(proposalId)).toEqual({ ok: false, reason: "candidate_other_proposal" });
  });

  test("a replacement that is already active (it resolved another contest) is ok without a tier decision; other shapes are refused", () => {
    const against = (replacementId: string) => check(open("supersede", memories.create(autoMemory()).id, replacementId));

    const active = memories.create(autoMemory({ status: "active", summary: "Already active replacement" }));
    expect(against(active.id)).toMatchObject({ ok: true, needsTierDecision: false, candidate: { id: active.id, status: "active" } });

    const human = memories.create(humanMemory({ summary: "Human replacement" }));
    expect(against(human.id)).toEqual({ ok: false, reason: "candidate_human" });

    const expiredReplacement = ttlExpiredRow("Expired replacement");
    expect(against(expiredReplacement.id)).toEqual({ ok: false, reason: "candidate_status" });

    const rejected = memories.create(autoMemory({ summary: "Rejected replacement" }));
    transitionMemory(db, { memoryId: rejected.id, to: "rejected", actor: "human", reason: "cli:memory:reject", now: T0 });
    expect(against(rejected.id)).toEqual({ ok: false, reason: "candidate_status" });
  });

  test("a replacement whose activate_* proposal a human rejected is candidate_human_rejected", () => {
    const target = memories.create(autoMemory({ summary: "Target" }));
    const { candidate, proposalId } = contest(target.id);
    decideProposal(db, { proposalId: open("activate_global", candidate.id, null), decidedBy: "human", accept: false, now: T0 });

    expect(check(proposalId)).toEqual({ ok: false, reason: "candidate_human_rejected" });
  });

  test("a decided or unknown proposal is not_open; another kind is kind", () => {
    const target = memories.create(autoMemory({ summary: "Target" }));
    const { proposalId } = contest(target.id);
    decideProposal(db, { proposalId, decidedBy: "auto_rule", accept: true, now: T0, note: FULL_AUTONOMY_DECISION_NOTE });
    expect(check(proposalId)).toEqual({ ok: false, reason: "not_open" });
    expect(check("no-such-proposal")).toEqual({ ok: false, reason: "not_open" });

    const active = memories.create(autoMemory({ status: "active", summary: "Active row with a stale claim" }));
    expect(check(open("stale", active.id, null))).toEqual({ ok: false, reason: "kind" });
  });

  test("rule 4b: a replacement that is itself the target of a resolvable contest is candidate_contested — the chain resolves from R's end", () => {
    const oldest = memories.create(autoMemory({ summary: "Oldest target" }));
    const middle = contest(oldest.id, { summary: "Middle row, passes the bar", confidence: 0.85 });
    const newest = contest(middle.candidate.id, { summary: "Newest row, passes the bar", confidence: 0.85 });

    // P1(T0, T) is held although T passes: P2(T, R) resolves first and settles P1 through the chain walk (T0 by R, never by T).
    expect(check(middle.proposalId, confidenceBar)).toEqual({ ok: false, reason: "candidate_contested" });
    expect(check(newest.proposalId, confidenceBar)).toMatchObject({
      ok: true,
      needsTierDecision: true,
      target: { id: middle.candidate.id },
      candidate: { id: newest.candidate.id },
    });
    // Nothing is written by a check: both contests are still open and every row is where it was.
    expect(proposals.getById(middle.proposalId)?.status).toBe("open");
    expect(proposals.getById(newest.proposalId)?.status).toBe("open");
    expect(memories.getById(oldest.id)?.status).toBe("candidate");
    expect(memories.getById(middle.candidate.id)?.status).toBe("candidate");
  });

  test("rule 4b holds nothing when the contest on the replacement cannot resolve (§3): R below the bar, R human-rejected, or R already active", () => {
    const oldest = memories.create(autoMemory({ summary: "Oldest target" }));
    const middle = contest(oldest.id, { summary: "Middle row, passes the bar", confidence: 0.85 });
    const weak = contest(middle.candidate.id, { summary: "Newest row, below the bar", confidence: 0.65 });
    expect(check(weak.proposalId, confidenceBar)).toMatchObject({ ok: true, needsTierDecision: true });
    expect(check(middle.proposalId, confidenceBar)).toMatchObject({ ok: true, needsTierDecision: true, candidate: { id: middle.candidate.id } });

    // A second contest on T whose replacement a human declined to activate is not resolvable either.
    const declined = contest(middle.candidate.id, { summary: "Newest row a human declined", confidence: 0.85 });
    decideProposal(db, { proposalId: open("activate_global", declined.candidate.id, null), decidedBy: "human", accept: false, now: T0 });
    expect(check(declined.proposalId, confidenceBar)).toEqual({ ok: false, reason: "candidate_human_rejected" });
    expect(check(middle.proposalId, confidenceBar)).toMatchObject({ ok: true });

    // An active replacement (it resolved another contest this run) keeps the two-session rule for its own contests: P proceeds without a tier decision.
    const other = memories.create(autoMemory({ summary: "Other target" }));
    const active = memories.create(autoMemory({ status: "active", summary: "Already active replacement" }));
    const onActive = open("supersede", other.id, active.id);
    contest(active.id, { summary: "Row said to replace the active replacement", confidence: 0.85 });
    expect(check(onActive, confidenceBar)).toMatchObject({ ok: true, needsTierDecision: false, candidate: { id: active.id, status: "active" } });
  });
});

describe("chainTargets (the rows a resolution's chain walk would reach)", () => {
  test("a chain of three behind the target, nearest first; a decided proposal and a row without proposals count for nothing", () => {
    const oldest = memories.create(autoMemory({ summary: "Oldest target" }));
    const second = contest(oldest.id, { summary: "Second row" });
    const third = contest(second.candidate.id, { summary: "Third row" });
    const newest = contest(third.candidate.id, { summary: "Newest row" });

    expect(chainTargets(proposals, third.candidate.id)).toEqual([second.candidate.id, oldest.id]);
    expect(chainTargets(proposals, newest.candidate.id)).toEqual([third.candidate.id, second.candidate.id, oldest.id]);
    expect(chainTargets(proposals, oldest.id)).toEqual([]);

    decideProposal(db, { proposalId: second.proposalId, decidedBy: "auto_rule", accept: false, now: T0 });
    expect(chainTargets(proposals, third.candidate.id)).toEqual([second.candidate.id]);
  });

  test("a diamond names each target once; the walk stops after CHAIN_MAX_DEPTH hops", () => {
    const bottom = memories.create(autoMemory({ summary: "Diamond bottom" }));
    const left = contest(bottom.id, { summary: "Diamond left" });
    const top = contest(left.candidate.id, { summary: "Diamond top" });
    open("supersede", bottom.id, top.candidate.id);
    expect(chainTargets(proposals, top.candidate.id)).toEqual([left.candidate.id, bottom.id]);

    let row = memories.create(autoMemory({ summary: "Chain root" }));
    const ids = [row.id];
    for (let hop = 0; hop < CHAIN_MAX_DEPTH + 2; hop += 1) {
      row = contest(row.id, { summary: `Chain hop ${String(hop)}` }).candidate;
      ids.push(row.id);
    }
    const reached = chainTargets(proposals, row.id);
    expect(reached).toHaveLength(CHAIN_MAX_DEPTH);
    expect(reached).toEqual(ids.slice(-CHAIN_MAX_DEPTH - 1, -1).reverse());
  });
});

describe("applySupersedeResolution (design §2.2)", () => {
  test("T is superseded by R, R activates once with the tierTtlDays TTL, the proposal is accepted by auto_rule (full_autonomy) and audited", () => {
    const target = memories.create(autoMemory({ summary: "Candidate target" }));
    const { candidate, proposalId } = contest(target.id, { knowledgeKind: "convention" }, { episodeId: "ep-a1", sessionId: "s1" });

    const result = applySupersedeResolution(db, {
      proposalId,
      now: NOW,
      runId: "run-a",
      transitionReason: FULL_SWEEP_TRANSITION_REASON,
      source: "sweep",
      sessionId: "session-a",
    });

    expect(result).toEqual({
      replacementId: candidate.id,
      replacementActivated: true,
      superseded: [target.id],
      proposalsAccepted: [proposalId],
      proposalsClosed: [],
    });
    expect(memories.getById(target.id)).toMatchObject({
      status: "superseded",
      statusReason: "auto_rule",
      supersededByMemoryId: candidate.id,
      contested: 0,
      openProposalId: null,
    });
    // a convention rule: baseTtlDays = 7, revalidate at the midpoint, validation_count = evidence_count − 1
    expect(memories.getById(candidate.id)).toMatchObject({
      status: "active",
      authority: "auto",
      promotionSource: "auto",
      ttlExpiresAt: isoPlus(NOW, { days: 7 }),
      revalidateAfter: isoPlus(NOW, { hours: 84 }),
      validationCount: 0,
      contested: 0,
      openProposalId: null,
    });
    expect(proposals.getById(proposalId)).toMatchObject({
      status: "accepted",
      decidedBy: "auto_rule",
      decisionNote: FULL_AUTONOMY_DECISION_NOTE,
      decidedAt: NOW,
    });
    const written = { actor: "auto_rule", reason: FULL_SWEEP_TRANSITION_REASON, proposalId, extractionRunId: "run-a", createdAt: NOW };
    expect(transitions.listForMemory(target.id)).toEqual([expect.objectContaining({ fromStatus: "candidate", toStatus: "superseded", ...written })]);
    expect(transitions.listForMemory(candidate.id)).toEqual([expect.objectContaining({ fromStatus: "candidate", toStatus: "active", ...written })]);
    expect(auditRows()).toEqual([
      {
        sessionId: "session-a",
        summary: expect.stringContaining(candidate.id),
        details: { targetId: target.id, replacementId: candidate.id, proposalId, source: "sweep" },
      },
    ]);
  });

  test("a decision-type replacement gets KNOWLEDGE_TTL_DAYS; an extraction-time resolution keeps the default transition reason", () => {
    const decision: Partial<CreateMemoryInput> = { type: "decision", knowledgeKind: "decision", lifecycleTriggers: ["before_model"] };
    const target = memories.create(autoMemory({ ...decision, summary: "Old decision" }));
    const { candidate, proposalId } = contest(target.id, { ...decision, summary: "New decision" });

    const result = applySupersedeResolution(db, { proposalId, now: NOW, source: "extraction" });

    expect(result).toMatchObject({ replacementActivated: true, superseded: [target.id] });
    expect(memories.getById(candidate.id)).toMatchObject({
      status: "active",
      ttlExpiresAt: isoPlus(NOW, { days: 30 }),
      revalidateAfter: isoPlus(NOW, { days: 15 }),
    });
    // counted by the daily caps like any decideTier activation (§2.5): not `full_sweep`
    const written = { reason: "proposal:supersede", extractionRunId: null };
    expect(transitions.listForMemory(target.id)).toEqual([expect.objectContaining({ toStatus: "superseded", ...written })]);
    expect(transitions.listForMemory(candidate.id)).toEqual([expect.objectContaining({ toStatus: "active", ...written })]);
    expect(auditRows()).toEqual([
      {
        sessionId: null,
        summary: expect.any(String),
        details: { targetId: target.id, replacementId: candidate.id, proposalId, source: "extraction" },
      },
    ]);
  });

  test("the other open supersede / stale / revalidate proposals on the dead target close as expired(full_autonomy); a rival replacement stays parked", () => {
    const target = memories.create(autoMemory({ summary: "Doubly contested target" }));
    const staleClaim = open("stale", target.id, null);
    const revalidateClaim = open("revalidate", target.id, null);
    const { candidate, proposalId } = contest(target.id);
    const rival = memories.create(autoMemory({ summary: "Rival replacement", supersedesMemoryId: target.id }));
    const rivalProposal = open("supersede", target.id, rival.id);
    // not a contest: a human may still accept it to restore the row, so it is left to the reviewer
    const activate = open("activate_policy", target.id, null);

    const result = sweep(proposalId);

    expect(result).toMatchObject({
      replacementId: candidate.id,
      superseded: [target.id],
      proposalsAccepted: [proposalId],
      proposalsClosed: [staleClaim, revalidateClaim, rivalProposal],
    });
    expired(staleClaim);
    expired(revalidateClaim);
    expired(rivalProposal);
    expect(proposals.getById(activate)?.status).toBe("open");
    expect(memories.getById(target.id)).toMatchObject({
      status: "superseded",
      supersededByMemoryId: candidate.id,
      contested: 0,
      openProposalId: activate,
    });
    expect(memories.getById(rival.id)).toMatchObject({ status: "candidate", supersedesMemoryId: target.id });
    expect(transitions.listForMemory(rival.id)).toEqual([]);
  });

  test("the chain T0 ← T ← R: T0 is superseded by R through its own proposal, its siblings close, the audit names the hop", () => {
    const oldest = memories.create(autoMemory({ summary: "Oldest target" }));
    const oldestStale = open("stale", oldest.id, null);
    const middle = contest(oldest.id, { summary: "Middle row" }, { episodeId: "ep-ch1", sessionId: "s1" });
    const newest = contest(middle.candidate.id, { summary: "Newest row" }, { episodeId: "ep-ch2", sessionId: "s2" });
    expect(check(newest.proposalId)).toMatchObject({ ok: true, needsTierDecision: true });

    const result = applySupersedeResolution(db, {
      proposalId: newest.proposalId,
      now: NOW,
      source: "extraction",
      runId: "run-c",
      sessionId: "session-c",
    });

    expect(result).toEqual({
      replacementId: newest.candidate.id,
      replacementActivated: true,
      superseded: [middle.candidate.id, oldest.id],
      proposalsAccepted: [newest.proposalId, middle.proposalId],
      proposalsClosed: [oldestStale],
    });
    expect(memories.getById(middle.candidate.id)).toMatchObject({
      status: "superseded",
      supersededByMemoryId: newest.candidate.id,
      contested: 0,
      openProposalId: null,
    });
    expect(memories.getById(oldest.id)).toMatchObject({
      status: "superseded",
      statusReason: "auto_rule",
      supersededByMemoryId: newest.candidate.id,
      contested: 0,
      openProposalId: null,
    });
    expect(memories.getById(newest.candidate.id)).toMatchObject({ status: "active", ttlExpiresAt: isoPlus(NOW, { days: 7 }) });
    expect(proposals.getById(middle.proposalId)).toMatchObject({
      status: "accepted",
      decidedBy: "auto_rule",
      decisionNote: FULL_AUTONOMY_DECISION_NOTE,
      decidedAt: NOW,
    });
    expired(oldestStale);
    expect(transitions.listForMemory(oldest.id)).toEqual([
      expect.objectContaining({
        fromStatus: "candidate",
        toStatus: "superseded",
        actor: "auto_rule",
        reason: "proposal:supersede",
        proposalId: middle.proposalId,
        extractionRunId: "run-c",
      }),
    ]);
    expect(transitions.listForMemory(middle.candidate.id)).toEqual([
      expect.objectContaining({ fromStatus: "candidate", toStatus: "superseded", proposalId: newest.proposalId }),
    ]);
    expect(transitions.listForMemory(newest.candidate.id).map((entry) => entry.toStatus)).toEqual(["active"]);
    expect(auditRows()).toEqual([
      {
        sessionId: "session-c",
        summary: expect.stringContaining(newest.candidate.id),
        details: { targetId: middle.candidate.id, replacementId: newest.candidate.id, proposalId: newest.proposalId, source: "extraction" },
      },
      {
        sessionId: "session-c",
        summary: expect.stringContaining(middle.candidate.id),
        details: {
          targetId: oldest.id,
          replacementId: newest.candidate.id,
          proposalId: middle.proposalId,
          source: "extraction",
          via: middle.candidate.id,
        },
      },
    ]);
    // both contests are decided: the caller's next check never reaches apply again
    expect(check(newest.proposalId)).toEqual({ ok: false, reason: "not_open" });
    expect(check(middle.proposalId)).toEqual({ ok: false, reason: "not_open" });
  });

  test("a stale(ttl_expired) target resolves like a candidate: stale → superseded by auto_rule, the replacement active with its TTL, the proposal accepted", () => {
    const expiredTarget = ttlExpiredRow("Expired target");
    const { candidate, proposalId } = contest(expiredTarget.id, { knowledgeKind: "convention" });
    expect(check(proposalId)).toMatchObject({ ok: true, needsTierDecision: true, target: { status: "stale", statusReason: "ttl_expired" } });

    const result = sweep(proposalId);

    expect(result).toEqual({
      replacementId: candidate.id,
      replacementActivated: true,
      superseded: [expiredTarget.id],
      proposalsAccepted: [proposalId],
      proposalsClosed: [],
    });
    expect(memories.getById(expiredTarget.id)).toMatchObject({
      status: "superseded",
      statusReason: "auto_rule",
      supersededByMemoryId: candidate.id,
      contested: 0,
      openProposalId: null,
    });
    expect(memories.getById(candidate.id)).toMatchObject({
      status: "active",
      authority: "auto",
      ttlExpiresAt: isoPlus(NOW, { days: 7 }),
      revalidateAfter: isoPlus(NOW, { hours: 84 }),
    });
    expect(proposals.getById(proposalId)).toMatchObject({ status: "accepted", decidedBy: "auto_rule", decisionNote: FULL_AUTONOMY_DECISION_NOTE, decidedAt: NOW });
    expect(transitions.listForMemory(expiredTarget.id).map((entry) => [entry.fromStatus, entry.toStatus])).toEqual([
      ["active", "stale"],
      ["stale", "superseded"],
    ]);
    expect(transitions.listForMemory(expiredTarget.id)[1]).toMatchObject({ actor: "auto_rule", reason: FULL_SWEEP_TRANSITION_REASON, proposalId });
    expect(auditRows()).toEqual([
      { sessionId: null, summary: expect.any(String), details: { targetId: expiredTarget.id, replacementId: candidate.id, proposalId, source: "sweep" } },
    ]);
  });

  test.each([
    ["P′1(T0a, T) before P′2(T0b, T)", false],
    ["P′2(T0b, T) before P′1(T0a, T)", true],
  ])("the diamond T0b ← T0a ← T, T0b ← T behind R resolves without a throw (%s): three targets superseded by R, each proposal decided once", (_order, reversed) => {
    const bottom = memories.create(autoMemory({ summary: "Oldest target T0b" }));
    const left = contest(bottom.id, { summary: "Middle row T0a", confidence: 0.65 });
    const top = memories.create(autoMemory({ summary: "Row T, below the bar", confidence: 0.65, supersedesMemoryId: left.candidate.id }));
    const viaLeft = () => open("supersede", left.candidate.id, top.id);
    const viaBottom = () => open("supersede", bottom.id, top.id);
    const [first, second] = reversed ? [viaBottom(), viaLeft()] : [viaLeft(), viaBottom()];
    const newest = contest(top.id, { summary: "Newest row R" });

    let result: ReturnType<typeof applySupersedeResolution> | null = null;
    expect(() => {
      result = sweep(newest.proposalId);
    }).not.toThrow();

    // Walk order follows the hop list: the first hop supersedes its target and retires it; the recursion closes the second
    // hop as that target's sibling (reversed: the inner P″ is the sibling), so the outer loop finds it decided and skips it.
    const walked = reversed ? [bottom.id, left.candidate.id] : [left.candidate.id, bottom.id];
    expect(result).toEqual({
      replacementId: newest.candidate.id,
      replacementActivated: true,
      superseded: [top.id, ...walked],
      proposalsAccepted: reversed ? [newest.proposalId, first, second] : [newest.proposalId, first, left.proposalId],
      proposalsClosed: reversed ? [left.proposalId] : [second],
    });
    for (const id of [top.id, left.candidate.id, bottom.id]) {
      expect(memories.getById(id)).toMatchObject({ status: "superseded", supersededByMemoryId: newest.candidate.id, contested: 0, openProposalId: null });
      expect(transitions.listForMemory(id)).toEqual([expect.objectContaining({ fromStatus: "candidate", toStatus: "superseded", actor: "auto_rule" })]);
    }
    expect(memories.getById(newest.candidate.id)?.status).toBe("active");
    const decided = [newest.proposalId, first, second, left.proposalId].map((id) => proposals.getById(id)!);
    expect(decided.map((proposal) => proposal.status).sort()).toEqual(["accepted", "accepted", "accepted", "expired"]);
    for (const proposal of decided) expect(proposal).toMatchObject({ decidedBy: "auto_rule", decisionNote: FULL_AUTONOMY_DECISION_NOTE, decidedAt: NOW });
    expect(proposals.countOpen()).toBe(0);
    expect(auditRows().map((row) => row.details.targetId)).toEqual([top.id, ...walked]);
  });

  test("a chain hop whose target is human, active or human-signal-protected closes as expired and leaves the row alone, without throwing", () => {
    const human = memories.create(humanMemory({ summary: "Human rule" }));
    const humanHop = contest(human.id, { summary: "Row said to replace the human rule" });
    const active = memories.create(autoMemory({ status: "active", summary: "Injected row" }));
    const activeHop = open("supersede", active.id, humanHop.candidate.id);
    const corrected = memories.create(autoMemory({ summary: "Correction-born row" }));
    origin(corrected.id, "ep-o-hop", { correction: 1 });
    const correctedHop = open("supersede", corrected.id, humanHop.candidate.id, { episodeId: "ep-s-hop", sessionId: "s-hop" });
    const top = contest(humanHop.candidate.id, { summary: "Row replacing the middle row" });

    let result: ReturnType<typeof applySupersedeResolution> | null = null;
    expect(() => {
      result = sweep(top.proposalId);
    }).not.toThrow();
    expect(result).toEqual({
      replacementId: top.candidate.id,
      replacementActivated: true,
      superseded: [humanHop.candidate.id],
      proposalsAccepted: [top.proposalId],
      proposalsClosed: [humanHop.proposalId, activeHop, correctedHop],
    });
    expired(humanHop.proposalId);
    expired(activeHop);
    expired(correctedHop);
    const untouched = { supersededByMemoryId: null, contested: 0, openProposalId: null };
    expect(memories.getById(human.id)).toMatchObject({ status: "active", authority: "human", ...untouched });
    expect(memories.getById(active.id)).toMatchObject({ status: "active", ...untouched });
    expect(memories.getById(corrected.id)).toMatchObject({ status: "candidate", ...untouched });
    expect(transitions.listForMemory(human.id)).toEqual([]);
    expect(transitions.listForMemory(active.id)).toEqual([]);
    expect(transitions.listForMemory(corrected.id)).toEqual([]);
    expect(auditRows().map((row) => row.details.targetId)).toEqual([humanHop.candidate.id]);
  });

  test("open activate_policy / activate_global proposals on the activated replacement close as expired(full_autonomy) and its flag is refreshed", () => {
    const target = memories.create(autoMemory({ summary: "Target" }));
    const { candidate, proposalId } = contest(target.id);
    const activatePolicy = open("activate_policy", candidate.id, null);
    const activateGlobal = open("activate_global", candidate.id, null);
    expect(memories.getById(candidate.id)).toMatchObject({ openProposalId: activatePolicy, contested: 0 });

    const result = sweep(proposalId);

    expect(result.proposalsClosed).toEqual([activatePolicy, activateGlobal]);
    expired(activatePolicy);
    expired(activateGlobal);
    expect(memories.getById(candidate.id)).toMatchObject({ status: "active", openProposalId: null, contested: 0 });
  });

  test("one replacement resolving two contests activates once; the second resolution needs no tier decision", () => {
    const first = memories.create(autoMemory({ summary: "First target" }));
    const second = memories.create(autoMemory({ summary: "Second target" }));
    const replacement = memories.create(autoMemory({ summary: "Shared replacement", knowledgeKind: "convention" }));
    const firstProposal = open("supersede", first.id, replacement.id);
    const secondProposal = open("supersede", second.id, replacement.id);
    expect(check(firstProposal)).toMatchObject({ ok: true, needsTierDecision: true });

    expect(sweep(firstProposal)).toEqual({
      replacementId: replacement.id,
      replacementActivated: true,
      superseded: [first.id],
      proposalsAccepted: [firstProposal],
      proposalsClosed: [],
    });

    expect(check(secondProposal)).toMatchObject({
      ok: true,
      needsTierDecision: false,
      candidate: { id: replacement.id, status: "active" },
    });
    expect(sweep(secondProposal)).toEqual({
      replacementId: replacement.id,
      replacementActivated: false,
      superseded: [second.id],
      proposalsAccepted: [secondProposal],
      proposalsClosed: [],
    });

    expect(memories.getById(first.id)).toMatchObject({ status: "superseded", supersededByMemoryId: replacement.id });
    expect(memories.getById(second.id)).toMatchObject({ status: "superseded", supersededByMemoryId: replacement.id });
    expect(memories.getById(replacement.id)).toMatchObject({
      status: "active",
      ttlExpiresAt: isoPlus(NOW, { days: 7 }),
      contested: 0,
      openProposalId: null,
    });
    expect(transitions.listForMemory(replacement.id)).toEqual([
      expect.objectContaining({ fromStatus: "candidate", toStatus: "active", proposalId: firstProposal }),
    ]);
    expect(auditRows().map((row) => row.details.targetId)).toEqual([first.id, second.id]);
  });

  test("a human target never reaches apply through check; forced anyway, AuthorityViolationError is thrown before anything is written", () => {
    const human = memories.create(humanMemory({ summary: "Human rule" }));
    const { candidate, proposalId } = contest(human.id);
    expect(check(proposalId)).toEqual({ ok: false, reason: "target_human" });

    expect(() => sweep(proposalId)).toThrow(AuthorityViolationError);

    expect(transitions.listForMemory(human.id)).toEqual([]);
    expect(transitions.listForMemory(candidate.id)).toEqual([]);
    expect(memories.getById(human.id)).toMatchObject({
      status: "active",
      authority: "human",
      supersededByMemoryId: null,
      contested: 1,
      openProposalId: proposalId,
    });
    expect(memories.getById(candidate.id)).toMatchObject({ status: "candidate", ttlExpiresAt: null });
    expect(proposals.getById(proposalId)?.status).toBe("open");
    expect(auditRows()).toEqual([]);
  });
});
