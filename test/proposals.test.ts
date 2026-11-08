/**
 * Proposal operations (spec §5.7 step 6, §7.5): open-or-support, decisions per kind, the auto demotion
 * rule and expiry side effects.
 */

import { beforeEach, describe, expect, test } from "vitest";
import type { Database as SqlJsDatabase } from "sql.js";

import { AuthorityViolationError } from "../src/core/errors";
import { ProposalRepository } from "../src/db/repositories/proposals";
import { ProvenanceRepository } from "../src/db/repositories/provenance";
import { TransitionRepository } from "../src/db/repositories/transitions";
import { MemoryRepository } from "../src/memory/repository";
import {
  decideProposal,
  evaluateAutoDemotion,
  expireProposals,
  openOrSupportProposal,
  parseProposalPayload,
  withProposalPayload,
} from "../src/promotion/proposals";
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
    expect(row.signatureKey).toBe("bash|command|cmd|pm test");
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
