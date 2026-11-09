/**
 * Proposal operations (spec §5.7 step 6, §7.5): open-or-support, decisions per kind, the auto demotion
 * rule and expiry side effects.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, test } from "vitest";
import type { Database as SqlJsDatabase } from "sql.js";

import { DEFAULT_CONFIG } from "../src/core/config";
import { AuthorityViolationError } from "../src/core/errors";
import { resolvePaths } from "../src/core/paths";
import { ProposalRepository } from "../src/db/repositories/proposals";
import { ProvenanceRepository } from "../src/db/repositories/provenance";
import { TransitionRepository } from "../src/db/repositories/transitions";
import { runDream } from "../src/dream/consolidate";
import { InvalidMemoryTransitionError, MemoryRepository } from "../src/memory/repository";
import {
  ProposalNotApplicableError,
  decideProposal,
  evaluateAutoDemotion,
  expireProposals,
  openOrSupportProposal,
  parseProposalPayload,
  withProposalPayload,
} from "../src/promotion/proposals";
import { transitionMemory } from "../src/promotion/transitions";
import { createTestDb } from "./helpers/create-test-db";
import { T0, autoMemory, humanMemory, insertEpisode, isoPlus } from "./helpers/memory-fixtures";

let db: SqlJsDatabase;
let memories: MemoryRepository;
let proposals: ProposalRepository;

beforeEach(async () => {
  db = await createTestDb({ now: T0 });
  memories = new MemoryRepository(db, { clock: () => T0 });
  proposals = new ProposalRepository(db);
});

function support(episodeId: string, sessionId: string, extra: { hasHumanSignal?: 0 | 1; deterministic?: 0 | 1 } = {}) {
  return { episodeId, sessionId, confidence: 0.8, ...extra };
}

/** `worker dream` on the database only (skipFiles: nothing under these paths is ever touched). */
const dreamPaths = resolvePaths(join(tmpdir(), "hm-proposals-dream-unused"));
async function dream(now: string) {
  db.run("BEGIN");
  try {
    const op = await runDream(db, { paths: dreamPaths, config: DEFAULT_CONFIG, now, skipFiles: true });
    db.run("COMMIT");
    return op;
  } catch (error) {
    db.run("ROLLBACK");
    throw error;
  }
}

function captureError(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to throw");
}

describe("openOrSupportProposal", () => {
  test("opens once, then only adds support; derived counts follow; the target is flagged", () => {
    const target = memories.create(autoMemory({ status: "active" }));
    const first = openOrSupportProposal(db, { kind: "stale", targetMemoryId: target.id, rationale: "r", confidence: 0.7, createdBy: "extractor", now: T0, support: support("ep-a", "s1") });
    expect(first).toMatchObject({ created: true, supportCount: 1, supportSessions: 1, skipped: null });
    const second = openOrSupportProposal(db, { kind: "stale", targetMemoryId: target.id, rationale: "r", confidence: 0.7, createdBy: "extractor", now: isoPlus(T0, { hours: 1 }), support: support("ep-b", "s2") });
    expect(second).toMatchObject({ created: false, proposalId: first.proposalId, supportCount: 2, supportSessions: 2 });
    const flagged = memories.getById(target.id)!;
    expect(flagged.contested).toBe(1);
    expect(flagged.openProposalId).toBe(first.proposalId);
    expect(flagged.updatedAt).toBe(target.updatedAt);
  });

  test("a claim rejected within 30 days is skipped; after 30 days it opens again", () => {
    const target = memories.create(autoMemory({ status: "active" }));
    const first = openOrSupportProposal(db, { kind: "stale", targetMemoryId: target.id, rationale: "r", confidence: 0.7, createdBy: "extractor", now: T0 });
    decideProposal(db, { proposalId: first.proposalId!, decidedBy: "human", accept: false, now: isoPlus(T0, { days: 1 }) });
    const soon = openOrSupportProposal(db, { kind: "stale", targetMemoryId: target.id, rationale: "r", confidence: 0.7, createdBy: "extractor", now: isoPlus(T0, { days: 10 }) });
    expect(soon).toMatchObject({ proposalId: null, created: false, skipped: "recent_reject" });
    const later = openOrSupportProposal(db, { kind: "stale", targetMemoryId: target.id, rationale: "r", confidence: 0.7, createdBy: "extractor", now: isoPlus(T0, { days: 40 }) });
    expect(later.created).toBe(true);
  });

  test("payload helpers round-trip", () => {
    const rationale = withProposalPayload("fix the scope", { scope_glob: "src/**", lifecycle_triggers: ["before_model"] });
    expect(parseProposalPayload(rationale)).toEqual({ scope_glob: "src/**", lifecycle_triggers: ["before_model"] });
    expect(parseProposalPayload("no payload here")).toBeNull();
  });
});

describe("decideProposal", () => {
  test("accepting a supersede by a human supersedes the target and makes the replacement an active human row", () => {
    const target = memories.create(humanMemory({ summary: "Old rule" }));
    const replacement = memories.create(autoMemory({ summary: "New rule", supersedesMemoryId: target.id }));
    const opened = openOrSupportProposal(db, { kind: "supersede", targetMemoryId: target.id, candidateMemoryId: replacement.id, rationale: "r", confidence: 0.8, createdBy: "extractor", now: T0 });
    const result = decideProposal(db, { proposalId: opened.proposalId!, decidedBy: "human", accept: true, now: isoPlus(T0, { hours: 1 }), note: "ok" });
    expect(result.effects).toEqual(["target:superseded", "replacement:active"]);
    expect(result.proposal.status).toBe("accepted");
    const oldRow = memories.getById(target.id)!;
    expect(oldRow.status).toBe("superseded");
    expect(oldRow.supersededByMemoryId).toBe(replacement.id);
    expect(oldRow.contested).toBe(0);
    expect(oldRow.openProposalId).toBeNull();
    const newRow = memories.getById(replacement.id)!;
    expect(newRow.status).toBe("active");
    expect(newRow.authority).toBe("human");
    expect(newRow.ttlExpiresAt).toBeNull();
    expect(new TransitionRepository(db).listForMemory(target.id)[0]).toMatchObject({ toStatus: "superseded", actor: "human", proposalId: opened.proposalId });
  });

  test("rejecting a supersede by a human rejects the still-candidate replacement", () => {
    const target = memories.create(humanMemory());
    const replacement = memories.create(autoMemory({ supersedesMemoryId: target.id }));
    const opened = openOrSupportProposal(db, { kind: "supersede", targetMemoryId: target.id, candidateMemoryId: replacement.id, rationale: "r", confidence: 0.8, createdBy: "extractor", now: T0 });
    const result = decideProposal(db, { proposalId: opened.proposalId!, decidedBy: "human", accept: false, now: T0 });
    expect(result.effects).toEqual(["replacement:rejected"]);
    expect(memories.getById(replacement.id)?.status).toBe("rejected");
    expect(memories.getById(target.id)?.status).toBe("active");
  });

  test("accepting a supersede whose replacement is no longer live is refused before anything is written", () => {
    const target = memories.create(humanMemory({ summary: "Old rule that must not dangle" }));
    const replacement = memories.create(autoMemory({ summary: "Replacement the user already rejected", supersedesMemoryId: target.id }));
    const opened = openOrSupportProposal(db, { kind: "supersede", targetMemoryId: target.id, candidateMemoryId: replacement.id, rationale: "r", confidence: 0.8, createdBy: "extractor", now: T0 });
    // `hm memory:reject <replacement>` while the proposal is still open
    transitionMemory(db, { memoryId: replacement.id, to: "rejected", actor: "human", reason: "cli:memory:reject", now: isoPlus(T0, { hours: 1 }) });

    const error = captureError(() => decideProposal(db, { proposalId: opened.proposalId!, decidedBy: "human", accept: true, now: isoPlus(T0, { hours: 2 }) }));
    expect(error).toBeInstanceOf(ProposalNotApplicableError);
    expect(error).toBeInstanceOf(InvalidMemoryTransitionError);
    expect(error).toMatchObject({ code: "candidate_not_live", proposalId: opened.proposalId, kind: "supersede" });
    expect((error as Error).message).toContain("is rejected");

    expect(memories.getById(target.id)).toMatchObject({ status: "active", supersededByMemoryId: null, contested: 1, openProposalId: opened.proposalId });
    expect(memories.getById(replacement.id)?.status).toBe("rejected");
    expect(proposals.getById(opened.proposalId!)?.status).toBe("open");
    expect(new TransitionRepository(db).listForMemory(target.id)).toEqual([]);

    // the way out is a reject: the proposal closes and the target is unflagged
    const rejected = decideProposal(db, { proposalId: opened.proposalId!, decidedBy: "human", accept: false, now: isoPlus(T0, { hours: 3 }) });
    expect(rejected.proposal.status).toBe("rejected");
    expect(rejected.effects).toEqual([]);
    expect(memories.getById(target.id)).toMatchObject({ status: "active", contested: 0, openProposalId: null });
  });

  test("auto_rule may not accept activate_policy / activate_global / merge", () => {
    const target = memories.create(autoMemory({ type: "policy" }));
    const opened = openOrSupportProposal(db, { kind: "activate_policy", targetMemoryId: target.id, rationale: "r", confidence: 0.8, createdBy: "extractor", now: T0 });
    expect(() => decideProposal(db, { proposalId: opened.proposalId!, decidedBy: "auto_rule", accept: true, now: T0 })).toThrow(AuthorityViolationError);
    expect(proposals.getById(opened.proposalId!)?.status).toBe("open");
  });

  test("accepting activate_policy promotes the candidate to an active human row", () => {
    const target = memories.create(autoMemory({ type: "policy", ttlExpiresAt: isoPlus(T0, { days: 7 }) }));
    const opened = openOrSupportProposal(db, { kind: "activate_policy", targetMemoryId: target.id, rationale: "r", confidence: 0.8, createdBy: "extractor", now: T0 });
    const result = decideProposal(db, { proposalId: opened.proposalId!, decidedBy: "human", accept: true, now: T0 });
    expect(result.effects).toEqual(["target:active(human)"]);
    const row = memories.getById(target.id)!;
    expect(row).toMatchObject({ status: "active", authority: "human", ttlExpiresAt: null, promotionSource: "manual" });
  });

  test("accepting fix_scope applies the payload, clears needs_scope and makes the row human", () => {
    const target = memories.create(autoMemory({ scopeGlob: "**/*", needsScope: 1, lifecycleTriggers: ["before_model"] }));
    const rationale = withProposalPayload("set the scope", {
      scope_glob: "src/db/**",
      lifecycle_triggers: ["before_tool", "before_model"],
      trigger_signature: { tool: "bash", target: "command", pattern_kind: "cmd", pattern: "npm test" },
    });
    const opened = openOrSupportProposal(db, { kind: "fix_scope", targetMemoryId: target.id, rationale, confidence: 0.5, createdBy: "migration", now: T0 });
    const result = decideProposal(db, { proposalId: opened.proposalId!, decidedBy: "human", accept: true, now: T0 });
    expect(result.effects).toEqual(["target:scope_applied", "target:authority_human"]);
    const row = memories.getById(target.id)!;
    expect(row.scopeGlob).toBe("src/db/**");
    expect(row.lifecycleTriggers).toEqual(["before_model", "before_tool"]);
    expect(row.signatureKey).toBe("bash|command|cmd|npm test");
    expect(row.needsScope).toBe(0);
    expect(row.authority).toBe("human");
  });

  test("fix_signature with an uncompilable signature drops it and reports the reason", () => {
    const target = memories.create(humanMemory({ triggerSignature: { tool: "bash", target: "command", pattern_kind: "regex", pattern: "(a+)+$" } }));
    const rationale = withProposalPayload("fix", { trigger_signature: { tool: "bash", target: "command", pattern_kind: "cmd", pattern: "npm" } });
    const opened = openOrSupportProposal(db, { kind: "fix_signature", targetMemoryId: target.id, rationale, confidence: 0.5, createdBy: "consolidator", now: T0 });
    const result = decideProposal(db, { proposalId: opened.proposalId!, decidedBy: "human", accept: true, now: T0 });
    expect(result.effects[0]).toMatch(/^signature_dropped:signature_unspecific/);
    expect(memories.getById(target.id)?.triggerSignature).toBeNull();
  });

  test("a fix_scope / fix_signature proposal without a payload cannot be accepted: nothing is cleared, promoted or decided", () => {
    // Exactly what migration 019 inserts for an R2 victim (needs_scope = 1): prose, no @payload.
    const legacy = memories.create(autoMemory({ status: "active", scopeGlob: "**/*", needsScope: 1, lifecycleTriggers: ["before_model"], summary: "Legacy v0.5 row without a scope" }));
    const fixScope = openOrSupportProposal(db, {
      kind: "fix_scope",
      targetMemoryId: legacy.id,
      rationale: "v0.5 stored scope **/* and trigger before_model only; set scope, trigger and signature",
      confidence: 0.5,
      createdBy: "migration",
      now: T0,
      expiresInDays: 90,
    });
    const error = captureError(() => decideProposal(db, { proposalId: fixScope.proposalId!, decidedBy: "human", accept: true, now: T0 }));
    expect(error).toBeInstanceOf(ProposalNotApplicableError);
    expect(error).toMatchObject({ code: "payload_missing", kind: "fix_scope" });
    expect(memories.getById(legacy.id)).toMatchObject({ scopeGlob: "**/*", lifecycleTriggers: ["before_model"], needsScope: 1, authority: "auto", status: "active", openProposalId: fixScope.proposalId });
    expect(proposals.getById(fixScope.proposalId!)?.status).toBe("open");

    // The consolidator's fix_signature rationale is prose as well.
    const broken = { tool: "bash", target: "command", pattern_kind: "regex", pattern: "(a+)+$" } as const;
    const human = memories.create(humanMemory({ triggerSignature: broken }));
    const fixSignature = openOrSupportProposal(db, {
      kind: "fix_signature",
      targetMemoryId: human.id,
      rationale: "stored signature does not compile (signature_regex_unsafe: catastrophic backtracking); the hooks ignore it",
      confidence: 0.5,
      createdBy: "consolidator",
      now: T0,
    });
    expect(() => decideProposal(db, { proposalId: fixSignature.proposalId!, decidedBy: "human", accept: true, now: T0 })).toThrow(ProposalNotApplicableError);
    expect(memories.getById(human.id)?.triggerSignature).toEqual(broken);
    expect(proposals.getById(fixSignature.proposalId!)?.status).toBe("open");

    // Rejecting stays possible and is the only decision such a proposal takes.
    expect(decideProposal(db, { proposalId: fixSignature.proposalId!, decidedBy: "human", accept: false, now: T0 }).proposal.status).toBe("rejected");

    // With a payload the same kind still applies it (the 019 proposal could be re-opened with one by a future editor).
    const withPayload = openOrSupportProposal(db, { kind: "fix_scope", targetMemoryId: legacy.id, rationale: withProposalPayload("set the scope", { scope_glob: "src/db/**" }), confidence: 0.5, createdBy: "migration", now: isoPlus(T0, { hours: 1 }), rejectSkipDays: 0 });
    expect(withPayload.created).toBe(false);
    expect(withPayload.proposalId).toBe(fixScope.proposalId);
  });

  test("accepting revalidate extends the TTL and returns a stale row to active", () => {
    const target = memories.create(autoMemory({ status: "active", knowledgeKind: "correction", ttlExpiresAt: isoPlus(T0, { days: -1 }), validationCount: 0 }));
    insertEpisode(db, { id: "ep-origin", session_id: "s1" });
    new ProvenanceRepository(db).insert({ memoryId: target.id, episodeId: "ep-origin", eventSeq: 1, relation: "origin", confidence: 0.8, createdAt: T0 });
    const opened = openOrSupportProposal(db, { kind: "revalidate", targetMemoryId: target.id, rationale: "ttl", confidence: 0.8, createdBy: "consolidator", now: T0 });
    const result = decideProposal(db, { proposalId: opened.proposalId!, decidedBy: "human", accept: true, now: T0 });
    expect(result.effects).toEqual(["target:revalidated"]);
    const row = memories.getById(target.id)!;
    expect(Date.parse(row.ttlExpiresAt!)).toBeGreaterThan(Date.parse(T0));
    expect(row.status).toBe("active");
  });

  test("rejecting a revalidate by a human stales the row as ttl_expired and the next dream does not re-propose it", async () => {
    const target = memories.create(autoMemory({ status: "active", knowledgeKind: "correction", ttlExpiresAt: isoPlus(T0, { days: 30 }), summary: "Correction whose TTL ran out" }));
    const atTtl = await dream(isoPlus(T0, { days: 31 }));
    expect(atTtl.report.revalidateProposals).toHaveLength(1);
    const proposalId = atTtl.report.revalidateProposals[0]!;

    const rejectedAt = isoPlus(T0, { days: 31, hours: 1 });
    const result = decideProposal(db, { proposalId, decidedBy: "human", accept: false, now: rejectedAt });
    expect(result.proposal).toMatchObject({ status: "rejected", decidedBy: "human" });
    expect(result.effects).toEqual(["target:stale(ttl_expired)"]);
    expect(result.memories.map((memory) => memory.id)).toEqual([target.id]);
    expect(memories.getById(target.id)).toMatchObject({ status: "stale", statusReason: "ttl_expired", authority: "auto", contested: 0, openProposalId: null });
    expect(new TransitionRepository(db).listForMemory(target.id)).toEqual([
      expect.objectContaining({ fromStatus: "active", toStatus: "stale", actor: "human", proposalId, reason: "proposal:revalidate rejected", createdAt: rejectedAt }),
    ]);

    // Six hours later (dream.interval_hours) the consolidator finds no active row at its TTL: no second proposal.
    const next = await dream(isoPlus(T0, { days: 31, hours: 7 }));
    expect(next.report.revalidateProposals).toEqual([]);
    expect(next.report.staled).toEqual([]);
    expect(proposals.listOpen({ targetId: target.id })).toEqual([]);
    expect(proposals.listForMemory(target.id)).toHaveLength(1);
    expect(memories.getById(target.id)?.status).toBe("stale");

    // A revalidate rejected on a row that is no longer active changes nothing.
    const other = memories.create(autoMemory({ status: "active", knowledgeKind: "correction", ttlExpiresAt: isoPlus(T0, { days: -1 }), summary: "Already demoted meanwhile" }));
    const opened = openOrSupportProposal(db, { kind: "revalidate", targetMemoryId: other.id, rationale: "ttl", confidence: 0.8, createdBy: "consolidator", now: T0 });
    transitionMemory(db, { memoryId: other.id, to: "stale", actor: "human", reason: "cli:memory:demote", now: T0 });
    const unchanged = decideProposal(db, { proposalId: opened.proposalId!, decidedBy: "human", accept: false, now: isoPlus(T0, { hours: 1 }) });
    expect(unchanged.effects).toEqual([]);
    expect(memories.getById(other.id)).toMatchObject({ status: "stale", statusReason: "human" });
  });

  test("accepting merge keeps the older row with the max enforcement and merged aliases; the loser is superseded", () => {
    const older = memories.create(autoMemory({ status: "active", summary: "Older", enforcement: "advise", aliases: ["a"], createdAt: T0, updatedAt: T0 }));
    const newer = memories.create(autoMemory({ status: "active", summary: "Newer", enforcement: "soft_deny", aliases: ["b"], createdAt: isoPlus(T0, { hours: 1 }), updatedAt: isoPlus(T0, { hours: 1 }) }));
    const opened = openOrSupportProposal(db, { kind: "merge", targetMemoryId: older.id, candidateMemoryId: newer.id, rationale: "dup", confidence: 0.9, createdBy: "consolidator", now: T0 });
    const result = decideProposal(db, { proposalId: opened.proposalId!, decidedBy: "human", accept: true, now: isoPlus(T0, { hours: 2 }) });
    expect(result.effects).toEqual([`merge:survivor=${older.id}`]);
    const survivor = memories.getById(older.id)!;
    expect(survivor.enforcement).toBe("soft_deny");
    expect(survivor.aliases).toEqual(["a", "b"]);
    expect(survivor.status).toBe("active");
    const loser = memories.getById(newer.id)!;
    expect(loser.status).toBe("superseded");
    expect(loser.supersededByMemoryId).toBe(older.id);
  });

  test("stale accepted by auto_rule on a human row is refused before anything is written", () => {
    const target = memories.create(humanMemory());
    const opened = openOrSupportProposal(db, { kind: "stale", targetMemoryId: target.id, rationale: "r", confidence: 0.8, createdBy: "extractor", now: T0 });
    expect(() => decideProposal(db, { proposalId: opened.proposalId!, decidedBy: "auto_rule", accept: true, now: T0 })).toThrow(AuthorityViolationError);
    expect(memories.getById(target.id)?.status).toBe("active");
    expect(proposals.getById(opened.proposalId!)?.status).toBe("open");
  });
});

describe("evaluateAutoDemotion", () => {
  function activeAuto(summary: string, originEpisode: { id: string; flags?: Record<string, 1> }) {
    const target = memories.create(autoMemory({ status: "active", summary, knowledgeKind: "convention" }));
    insertEpisode(db, { id: originEpisode.id, session_id: `origin-${originEpisode.id}`, flags: originEpisode.flags ?? {} });
    new ProvenanceRepository(db).insert({ memoryId: target.id, episodeId: originEpisode.id, eventSeq: 1, relation: "origin", confidence: 0.8, createdAt: T0 });
    return target;
  }

  test("two sessions demote an auto row whose origin was not a human-signal episode", () => {
    const target = activeAuto("Plain auto row", { id: "ep-o1" });
    insertEpisode(db, { id: "ep-s1", session_id: "s1" });
    insertEpisode(db, { id: "ep-s2", session_id: "s2" });
    const one = openOrSupportProposal(db, { kind: "stale", targetMemoryId: target.id, rationale: "r", confidence: 0.8, createdBy: "extractor", now: T0, support: support("ep-s1", "s1") });
    expect(evaluateAutoDemotion(db, { proposalId: one.proposalId!, now: T0 })).toMatchObject({ applied: false, reason: "support_sessions" });
    openOrSupportProposal(db, { kind: "stale", targetMemoryId: target.id, rationale: "r", confidence: 0.8, createdBy: "extractor", now: T0, support: support("ep-s2", "s2") });
    const result = evaluateAutoDemotion(db, { proposalId: one.proposalId!, now: T0 });
    expect(result.applied).toBe(true);
    expect(memories.getById(target.id)?.status).toBe("stale");
    expect(proposals.getById(one.proposalId!)).toMatchObject({ status: "accepted", decidedBy: "auto_rule" });
  });

  test("a correction-born row needs a human-signal or deterministic supporter", () => {
    const target = activeAuto("Correction-born row", { id: "ep-o2", flags: { correction: 1 } });
    insertEpisode(db, { id: "ep-s3", session_id: "s3" });
    insertEpisode(db, { id: "ep-s4", session_id: "s4" });
    const opened = openOrSupportProposal(db, { kind: "stale", targetMemoryId: target.id, rationale: "r", confidence: 0.8, createdBy: "extractor", now: T0, support: support("ep-s3", "s3") });
    openOrSupportProposal(db, { kind: "stale", targetMemoryId: target.id, rationale: "r", confidence: 0.8, createdBy: "extractor", now: T0, support: support("ep-s4", "s4") });
    expect(evaluateAutoDemotion(db, { proposalId: opened.proposalId!, now: T0 })).toMatchObject({ applied: false, reason: "origin_human_signal_unmatched" });
    expect(memories.getById(target.id)?.status).toBe("active");

    openOrSupportProposal(db, { kind: "stale", targetMemoryId: target.id, rationale: "r", confidence: 0.8, createdBy: "extractor", now: T0, support: support("ep-s4", "s4", { hasHumanSignal: 1 }) });
    expect(evaluateAutoDemotion(db, { proposalId: opened.proposalId!, now: T0 }).applied).toBe(true);
    expect(memories.getById(target.id)?.status).toBe("stale");
  });

  test("a supersede whose replacement expired as a candidate is not applied by the auto rule", () => {
    const target = activeAuto("Auto row with a dead replacement", { id: "ep-o3" });
    const replacement = memories.create(autoMemory({ summary: "Replacement that expired first", supersedesMemoryId: target.id, createdAt: isoPlus(T0, { days: -50 }), updatedAt: isoPlus(T0, { days: -50 }) }));
    insertEpisode(db, { id: "ep-s5", session_id: "s5" });
    insertEpisode(db, { id: "ep-s6", session_id: "s6" });
    const opened = openOrSupportProposal(db, { kind: "supersede", targetMemoryId: target.id, candidateMemoryId: replacement.id, rationale: "r", confidence: 0.8, createdBy: "extractor", now: T0, support: support("ep-s5", "s5") });
    openOrSupportProposal(db, { kind: "supersede", targetMemoryId: target.id, candidateMemoryId: replacement.id, rationale: "r", confidence: 0.8, createdBy: "extractor", now: T0, support: support("ep-s6", "s6") });
    // consolidate (3) with retention.proposal_days >= candidate_days: the candidate expires before the proposal does
    transitionMemory(db, { memoryId: replacement.id, to: "rejected", actor: "expiry", reason: "candidate older than 45 d", now: T0, statusReason: "expiry" });

    expect(evaluateAutoDemotion(db, { proposalId: opened.proposalId!, now: T0 })).toEqual({ applied: false, reason: "candidate_not_live" });
    expect(memories.getById(target.id)).toMatchObject({ status: "active", supersededByMemoryId: null });
    expect(proposals.getById(opened.proposalId!)?.status).toBe("open");
  });

  test("human targets and policy rows are never demoted automatically", () => {
    const human = memories.create(humanMemory());
    const opened = openOrSupportProposal(db, { kind: "stale", targetMemoryId: human.id, rationale: "r", confidence: 0.8, createdBy: "extractor", now: T0, support: support("ep-h1", "s1") });
    openOrSupportProposal(db, { kind: "stale", targetMemoryId: human.id, rationale: "r", confidence: 0.8, createdBy: "extractor", now: T0, support: support("ep-h2", "s2") });
    expect(evaluateAutoDemotion(db, { proposalId: opened.proposalId!, now: T0 })).toMatchObject({ applied: false, reason: "human_target" });
    expect(memories.getById(human.id)).toMatchObject({ status: "active", contested: 1 });

    const policy = memories.create(autoMemory({ type: "policy", status: "active" }));
    const p = openOrSupportProposal(db, { kind: "stale", targetMemoryId: policy.id, rationale: "r", confidence: 0.8, createdBy: "extractor", now: T0, support: support("ep-p1", "s1") });
    openOrSupportProposal(db, { kind: "stale", targetMemoryId: policy.id, rationale: "r", confidence: 0.8, createdBy: "extractor", now: T0, support: support("ep-p2", "s2") });
    expect(evaluateAutoDemotion(db, { proposalId: p.proposalId!, now: T0 })).toMatchObject({ applied: false, reason: "policy" });
  });
});

describe("expireProposals", () => {
  test("expired revalidate proposals stale their auto rows; other kinds only clear the flags", () => {
    const corr = memories.create(autoMemory({ status: "active", knowledgeKind: "correction", ttlExpiresAt: isoPlus(T0, { days: -1 }) }));
    const other = memories.create(autoMemory({ status: "active", knowledgeKind: "convention" }));
    const reval = openOrSupportProposal(db, { kind: "revalidate", targetMemoryId: corr.id, rationale: "ttl", confidence: 0.8, createdBy: "consolidator", now: T0 });
    const stale = openOrSupportProposal(db, { kind: "stale", targetMemoryId: other.id, rationale: "r", confidence: 0.8, createdBy: "extractor", now: T0 });
    const result = expireProposals(db, { now: isoPlus(T0, { days: 31 }) });
    expect(result.expired.sort()).toEqual([reval.proposalId!, stale.proposalId!].sort());
    expect(result.staled).toEqual([corr.id]);
    expect(memories.getById(corr.id)).toMatchObject({ status: "stale", statusReason: "ttl_expired", contested: 0, openProposalId: null });
    expect(memories.getById(other.id)).toMatchObject({ status: "active", contested: 0, openProposalId: null });
    expect(proposals.getById(reval.proposalId!)).toMatchObject({ status: "expired", decidedBy: "expiry" });
  });
});
