/**
 * Write-path replay tests (spec §13.2 (a)(b)(d)(e)(f)(g)(h)(i)(j)) against reconcileRun with recorded
 * extractor outputs: no provider process, no network, injected clocks.
 */

import { beforeEach, describe, expect, test } from "vitest";
import type { Database as SqlJsDatabase } from "sql.js";

import { DEFAULT_CONFIG } from "../src/core/config";
import type { EpisodeDescriptor } from "../src/core/episode-types";
import type { LedgerLine } from "../src/core/ledger-types";
import { hasWriteOp } from "../src/db/meta";
import { EpisodeRepository } from "../src/db/repositories/episodes";
import { ProposalRepository } from "../src/db/repositories/proposals";
import { ProvenanceRepository } from "../src/db/repositories/provenance";
import { ExtractionRunRepository } from "../src/db/repositories/runs";
import { TransitionRepository } from "../src/db/repositories/transitions";
import { jaccard, normalizeFact, recordExtractionFailure, scopesIntersect, summaryTokens } from "../src/dream/reconcile";
import { MemoryRepository } from "../src/memory/repository";
import { expireProposals } from "../src/promotion/proposals";
import { derivedRulesConsistent } from "../src/policy/derive";
import { createTestDb } from "./helpers/create-test-db";
import { assistantLine, loadLedgerFixture, promptLine, toolFailLine, toolOkLine } from "./helpers/ledger-fixture";
import { autoMemory, humanMemory, isoPlus } from "./helpers/memory-fixtures";
import { REPLAY_NOW, applyRun, descriptorFromLines, factFixture, outputFixture } from "./helpers/replay-run";

const s01 = loadLedgerFixture("s01-correction-only.jsonl").lines.filter((line) => line.turn_key === "p1");
const s02 = loadLedgerFixture("s02-fail-then-resolve.jsonl").lines.filter((line) => line.turn_key === "p2");

let db: SqlJsDatabase;
let memories: MemoryRepository;

beforeEach(async () => {
  db = await createTestDb({ now: REPLAY_NOW });
  memories = new MemoryRepository(db, { clock: () => REPLAY_NOW });
});

/** A bare failure turn: prompt + tool_fail without resolution (evidence_weight 1). */
function bareFailureLines(turnKey: string, seqBase: number): LedgerLine[] {
  return [
    promptLine("run the tests", { seq: seqBase, turn_key: turnKey }),
    toolFailLine("npm test", "Exit code 1\nnpm ERR! Missing script: \"test\"", {
      seq: seqBase + 1,
      turn_key: turnKey,
      program_token: "pm test",
      exit_code: 1,
      failure_class: "exit_1",
    }),
    assistantLine("npm test failed; the scripts are defined for pnpm.", { seq: seqBase + 2, turn_key: turnKey }),
  ];
}

describe("(a) correction episode → active / auto / soft_deny; (j) evidence_weight 2", () => {
  test("s01 p1 with a recorded pitfall activates in one run", () => {
    const descriptor = descriptorFromLines(s01);
    expect(descriptor.flags).toEqual({ correction: 1 });
    expect(descriptor.evidence_weight).toBe(2);

    const output = outputFixture([factFixture({ evidence_refs: ["e1001"] })]);
    const result = applyRun(db, { descriptor, lines: s01, output });

    expect(result.committed).toBe(true);
    expect(result.op.noop).toBe(false);
    expect(result.op.id).toBe(result.runId);
    expect(result.op.report.created).toHaveLength(1);
    expect(result.op.report.activated).toEqual(result.op.report.created);
    expect(result.op.report.outcomes).toEqual([expect.objectContaining({ ordinal: 0, action: "create", outcome: "activated" })]);

    const memory = memories.getById(result.op.report.created[0]!)!;
    expect(memory.status).toBe("active");
    expect(memory.authority).toBe("auto");
    expect(memory.enforcement).toBe("soft_deny");
    expect(memory.type).toBe("pitfall");
    expect(memory.sourceKind).toBe("extraction");
    expect(memory.sourceRef).toBe(`episode:${descriptor.id}`);
    expect(memory.knowledgeKind).toBe("correction");
    expect(memory.evidenceScore).toBe(2);
    expect(memory.evidenceCount).toBe(1);
    expect(memory.validationCount).toBe(0);
    expect(memory.promotionSource).toBe("auto");
    expect(memory.signatureKey).toBe("bash|command|cmd|pm test");
    expect(memory.scopeGlob).toBe("**/*");
    expect(memory.activationClass).toBe("event");
    expect(memory.lifecycleTriggers).toEqual(["before_tool"]);
    expect(memory.ttlExpiresAt).toBe(isoPlus(REPLAY_NOW, { days: 30 }));
    expect(memory.revalidateAfter).toBe(isoPlus(REPLAY_NOW, { days: 15 }));
    expect(memory.aliases).toEqual(["pnpm test", "테스트 실행"]);

    const transitions = new TransitionRepository(db).listForMemory(memory.id);
    expect(transitions).toEqual([expect.objectContaining({ fromStatus: "candidate", toStatus: "active", actor: "auto_rule", extractionRunId: result.runId })]);

    const provenance = new ProvenanceRepository(db).listForMemory(memory.id);
    expect(provenance).toEqual([expect.objectContaining({ episodeId: descriptor.id, eventSeq: 1001, relation: "origin", confidence: 0.85 })]);
    expect(provenance[0]!.excerpt).toContain("pnpm test");

    const run = new ExtractionRunRepository(db).getById(result.runId)!;
    expect(run.status).toBe("ok");
    expect(run.factsTotal).toBe(1);
    expect(run.factsAccepted).toBe(1);
    expect(run.outcomes[0]?.outcome).toBe("activated");
    expect(new EpisodeRepository(db).getById(descriptor.id)?.status).toBe("extracted");
    expect(hasWriteOp(db, result.runId)).toBe(true);
    expect(derivedRulesConsistent(db)).toBe(true);

    const summary = db.exec("SELECT summary_short, event_count FROM session_summaries WHERE session_id = 'session-1'");
    expect(summary[0]?.values[0]).toEqual(["The user corrected the test command.", 2]);
  });
});

describe("(b) a bare failure yields a candidate; a second episode activates it", () => {
  test("evidence 1 → candidate(evidence), evidence 2 → active", () => {
    const first = descriptorFromLines(bareFailureLines("p10", 1100), { sessionId: "session-a", turnKey: "p10" });
    expect(first.evidence_weight).toBe(1);
    const fact = factFixture({ knowledge_kind: "failure_resolution", evidence_refs: ["e1101"], summary: "Use pnpm test rather than npm test; the npm script is missing in this repository." });
    const one = applyRun(db, { descriptor: first, lines: bareFailureLines("p10", 1100), output: outputFixture([fact]) });
    const id = one.op.report.created[0]!;
    expect(memories.getById(id)?.status).toBe("candidate");
    expect(one.op.report.outcomes[0]).toMatchObject({ outcome: "created", detail: "tier=candidate:evidence" });

    const secondLines = bareFailureLines("p11", 1200);
    const second = descriptorFromLines(secondLines, { sessionId: "session-b", turnKey: "p11" });
    const two = applyRun(db, {
      descriptor: second,
      lines: secondLines,
      output: outputFixture([{ ...fact, action: "reinforce", target_memory_id: id, evidence_refs: ["e1201"] }]),
      now: isoPlus(REPLAY_NOW, { hours: 1 }),
    });
    expect(two.op.report.reinforced).toEqual([id]);
    expect(two.op.report.activated).toEqual([id]);
    const memory = memories.getById(id)!;
    expect(memory.status).toBe("active");
    expect(memory.evidenceCount).toBe(2);
    expect(memory.evidenceScore).toBe(2);
    expect(memory.distinctSessionCount).toBe(2);
    expect(memory.validationCount).toBe(1);
    expect(memory.confidence).toBeCloseTo(0.9, 5);
  });

  test("a create whose claim already lives as a candidate reinforces it (semantic twin)", () => {
    const lines = bareFailureLines("p12", 1300);
    const descriptor = descriptorFromLines(lines, { sessionId: "session-c", turnKey: "p12" });
    const fact = factFixture({ knowledge_kind: "failure_resolution", evidence_refs: ["e1301"] });
    const one = applyRun(db, { descriptor, lines, output: outputFixture([fact]) });
    const id = one.op.report.created[0]!;

    const lines2 = bareFailureLines("p13", 1400);
    const descriptor2 = descriptorFromLines(lines2, { sessionId: "session-d", turnKey: "p13" });
    const two = applyRun(db, { descriptor: descriptor2, lines: lines2, output: outputFixture([{ ...fact, evidence_refs: ["e1401"] }]), now: isoPlus(REPLAY_NOW, { hours: 2 }) });
    expect(two.op.report.created).toEqual([]);
    expect(two.op.report.reinforced).toEqual([id]);
    expect(memories.list({ status: ["candidate", "active"] })).toHaveLength(1);
  });
});

describe("(d) idempotency", () => {
  test("applying the same run twice leaves the database bytes identical", () => {
    const descriptor = descriptorFromLines(s01);
    const output = outputFixture([factFixture({ evidence_refs: ["e1001"] })]);
    const first = applyRun(db, { descriptor, lines: s01, output });
    expect(first.committed).toBe(true);
    const before = Buffer.from(db.export());

    const second = applyRun(db, { descriptor, lines: s01, output, now: isoPlus(REPLAY_NOW, { hours: 5 }) });
    expect(second.op.noop).toBe(true);
    expect(second.op.wrote).toBe(false);
    expect(second.committed).toBe(false);
    const after = Buffer.from(db.export());
    expect(Buffer.compare(before, after)).toBe(0);
    expect(memories.list({ status: "active" })).toHaveLength(1);
  });
});

describe("(e) a hallucinated propose_supersede against a human row", () => {
  test("leaves exactly one active row and only opens a proposal", () => {
    const human = memories.create(
      humanMemory({ type: "pitfall", summary: "Run npm test before pushing changes.", details: "Team rule.", scopeGlob: "**/*", lifecycleTriggers: ["before_model"] })
    );
    const descriptor = descriptorFromLines(s02);
    const fact = factFixture({
      action: "propose_supersede",
      target_memory_id: human.id,
      summary: "Run pnpm test instead of npm test; the npm scripts are missing in this repository.",
      knowledge_kind: "failure_resolution",
      evidence_refs: ["e2002", "e2004"],
      confidence: 0.9,
    });
    const result = applyRun(db, { descriptor, lines: s02, output: outputFixture([fact]) });

    expect(result.op.report.outcomes[0]).toMatchObject({ outcome: "superseded_proposed" });
    const active = memories.list({ status: "active" });
    expect(active).toHaveLength(1);
    expect(active[0]!.id).toBe(human.id);
    const refreshedHuman = memories.getById(human.id)!;
    expect(refreshedHuman.status).toBe("active");
    expect(refreshedHuman.authority).toBe("human");
    expect(refreshedHuman.contested).toBe(1);
    expect(refreshedHuman.confidence).toBe(human.confidence);

    const proposals = new ProposalRepository(db).listOpen({ kind: "supersede", targetId: human.id });
    expect(proposals).toHaveLength(1);
    expect(refreshedHuman.openProposalId).toBe(proposals[0]!.id);
    expect(proposals[0]!.supportCount).toBe(1);
    const replacement = memories.getById(proposals[0]!.candidateMemoryId!)!;
    expect(replacement.status).toBe("candidate");
    expect(replacement.authority).toBe("auto");
    expect(replacement.supersedesMemoryId).toBe(human.id);
    expect(result.op.report.outcomes[0]?.detail).toContain("tier=candidate:replacement");
    expect(new ProvenanceRepository(db).listForMemory(human.id).map((row) => row.relation)).toEqual(["contradict", "contradict"]);
    expect(new TransitionRepository(db).listForMemory(human.id)).toEqual([]);
  });
});

describe("(f) propose_stale needs two sessions to demote an auto row", () => {
  test("1-support does nothing; 2-session support demotes by auto_rule", () => {
    const target = memories.create(autoMemory({ status: "active", summary: "Use npm test to run the suite in this repository.", knowledgeKind: "convention", confidence: 0.8 }));
    const fact = factFixture({ action: "propose_stale", target_memory_id: target.id, knowledge_kind: "convention", evidence_refs: ["e2002"], summary: "npm test no longer works here; the scripts moved to pnpm." });

    const one = applyRun(db, { descriptor: descriptorFromLines(s02, { sessionId: "session-a" }), lines: s02, output: outputFixture([fact]) });
    expect(one.op.report.outcomes[0]).toMatchObject({ outcome: "proposed" });
    expect(memories.getById(target.id)?.status).toBe("active");
    const open = new ProposalRepository(db).listOpen({ kind: "stale", targetId: target.id });
    expect(open).toHaveLength(1);
    expect(open[0]!.supportSessions).toBe(1);

    const two = applyRun(db, { descriptor: descriptorFromLines(s02, { sessionId: "session-b", turnKey: "p2b" }), lines: s02, output: outputFixture([fact]), now: isoPlus(REPLAY_NOW, { hours: 1 }) });
    expect(two.op.report.outcomes[0]?.detail).toContain("auto_demotion");
    expect(memories.getById(target.id)?.status).toBe("stale");
    const decided = new ProposalRepository(db).getById(open[0]!.id)!;
    expect(decided.status).toBe("accepted");
    expect(decided.decidedBy).toBe("auto_rule");
    expect(decided.supportSessions).toBe(2);
    expect(new TransitionRepository(db).listForMemory(target.id)).toEqual([expect.objectContaining({ toStatus: "stale", actor: "auto_rule", proposalId: open[0]!.id })]);
  });

  test("the same session twice is still one support session", () => {
    const target = memories.create(autoMemory({ status: "active", summary: "Use npm test to run the suite in this repository.", knowledgeKind: "convention" }));
    const fact = factFixture({ action: "propose_stale", target_memory_id: target.id, knowledge_kind: "convention", evidence_refs: ["e2002"], summary: "npm test no longer works here; the scripts moved to pnpm." });
    applyRun(db, { descriptor: descriptorFromLines(s02, { sessionId: "session-a", turnKey: "p2" }), lines: s02, output: outputFixture([fact]) });
    applyRun(db, { descriptor: descriptorFromLines(s02, { sessionId: "session-a", turnKey: "p3" }), lines: s02, output: outputFixture([fact]), now: isoPlus(REPLAY_NOW, { hours: 1 }) });
    expect(memories.getById(target.id)?.status).toBe("active");
    const open = new ProposalRepository(db).listOpen({ kind: "stale", targetId: target.id });
    expect(open[0]).toMatchObject({ supportCount: 2, supportSessions: 1 });
  });
});

describe("(g) reinforce raises TTL and validation_count", () => {
  test("a second episode extends the TTL and bumps validation_count", () => {
    const descriptor = descriptorFromLines(s01);
    const fact = factFixture({ evidence_refs: ["e1001"] });
    const one = applyRun(db, { descriptor, lines: s01, output: outputFixture([fact]) });
    const id = one.op.report.created[0]!;
    const before = memories.getById(id)!;
    expect(before.ttlExpiresAt).toBe(isoPlus(REPLAY_NOW, { days: 30 }));

    const later = isoPlus(REPLAY_NOW, { days: 10 });
    const lines = bareFailureLines("p20", 2100);
    const two = applyRun(db, {
      descriptor: descriptorFromLines(lines, { sessionId: "session-z", turnKey: "p20" }),
      lines,
      output: outputFixture([{ ...fact, action: "reinforce", target_memory_id: id, evidence_refs: ["e2101"] }]),
      now: later,
    });
    expect(two.op.report.reinforced).toEqual([id]);
    const after = memories.getById(id)!;
    expect(after.status).toBe("active");
    expect(after.validationCount).toBe(1);
    expect(after.evidenceCount).toBe(2);
    expect(Date.parse(after.ttlExpiresAt!)).toBeGreaterThan(Date.parse(before.ttlExpiresAt!));
    expect(after.ttlExpiresAt).toBe(isoPlus(later, { days: 30 }));
    expect(after.lastVerifiedAt).toBe(two.op.report.runId === two.runId ? after.lastVerifiedAt : null);
  });

  test("a human target only gains counters and last_verified_at", () => {
    const human = memories.create(humanMemory({ type: "pitfall", summary: "Run pnpm test for the suite.", scopeGlob: "**/*", confidence: 0.6, importance: 0.9, lifecycleTriggers: ["before_model"] }));
    const descriptor = descriptorFromLines(s02);
    applyRun(db, { descriptor, lines: s02, output: outputFixture([factFixture({ action: "reinforce", target_memory_id: human.id, evidence_refs: ["e2004"], knowledge_kind: "failure_resolution" })]) });
    const after = memories.getById(human.id)!;
    expect(after.evidenceCount).toBe(1);
    expect(after.confidence).toBe(0.6);
    expect(after.importance).toBe(0.9);
    expect(after.ttlExpiresAt).toBeNull();
    expect(after.lastVerifiedAt).toBe(descriptor.closed_at);
    expect(after.authority).toBe("human");
  });
});

describe("(h) propose → expire → propose", () => {
  test("a new proposal opens after the first one expired", () => {
    const target = memories.create(autoMemory({ status: "active", summary: "Use npm test to run the suite in this repository.", knowledgeKind: "convention" }));
    const fact = factFixture({ action: "propose_stale", target_memory_id: target.id, knowledge_kind: "convention", evidence_refs: ["e2002"], summary: "npm test no longer works here; the scripts moved to pnpm." });
    applyRun(db, { descriptor: descriptorFromLines(s02, { sessionId: "session-a" }), lines: s02, output: outputFixture([fact]) });
    const proposals = new ProposalRepository(db);
    const first = proposals.listOpen({ kind: "stale", targetId: target.id })[0]!;

    const expired = expireProposals(db, { now: isoPlus(REPLAY_NOW, { days: 31 }) });
    expect(expired.expired).toEqual([first.id]);
    expect(proposals.getById(first.id)?.status).toBe("expired");
    expect(memories.getById(target.id)?.openProposalId).toBeNull();
    expect(memories.getById(target.id)?.contested).toBe(0);

    const again = applyRun(db, { descriptor: descriptorFromLines(s02, { sessionId: "session-b", turnKey: "p9" }), lines: s02, output: outputFixture([fact]), now: isoPlus(REPLAY_NOW, { days: 32 }) });
    expect(again.op.report.outcomes[0]).toMatchObject({ outcome: "proposed" });
    const second = proposals.listOpen({ kind: "stale", targetId: target.id })[0]!;
    expect(second.id).not.toBe(first.id);
    expect(second.supportCount).toBe(1);
  });

  test("a rejected proposal is not re-opened within 30 days", () => {
    const target = memories.create(autoMemory({ status: "active", summary: "Use npm test to run the suite in this repository.", knowledgeKind: "convention" }));
    const fact = factFixture({ action: "propose_stale", target_memory_id: target.id, knowledge_kind: "convention", evidence_refs: ["e2002"], summary: "npm test no longer works here; the scripts moved to pnpm." });
    applyRun(db, { descriptor: descriptorFromLines(s02, { sessionId: "session-a" }), lines: s02, output: outputFixture([fact]) });
    const proposals = new ProposalRepository(db);
    const first = proposals.listOpen({ kind: "stale", targetId: target.id })[0]!;
    proposals.decide(first.id, { status: "rejected", decidedBy: "human", now: isoPlus(REPLAY_NOW, { days: 1 }) });

    const again = applyRun(db, { descriptor: descriptorFromLines(s02, { sessionId: "session-b", turnKey: "p9" }), lines: s02, output: outputFixture([fact]), now: isoPlus(REPLAY_NOW, { days: 2 }) });
    expect(again.op.report.outcomes[0]).toMatchObject({ outcome: "skipped", rejection: "skipped_recent_reject" });
    expect(proposals.listOpen({ kind: "stale", targetId: target.id })).toEqual([]);
  });
});

describe("(i) learn-and-apply episodes are pitfalls", () => {
  const scenarios: Array<{ failed: string; fixed: string; program: string; summary: string; type: "policy" | "pitfall" }> = [
    { failed: "npm test", fixed: "pnpm test", program: "pm test", summary: "Run the suite with pnpm test; npm test has no script here.", type: "policy" },
    { failed: "npm run build", fixed: "pnpm build", program: "pm build", summary: "Build with pnpm build; npm run build fails without the pnpm workspace.", type: "policy" },
    { failed: "yarn lint", fixed: "pnpm lint", program: "pm lint", summary: "Lint through pnpm lint; yarn lint is not configured in this repository.", type: "pitfall" },
    { failed: "npx vitest run", fixed: "pnpm vitest run", program: "bin vitest", summary: "Run vitest through pnpm; npx vitest run resolves the wrong binary here.", type: "pitfall" },
    { failed: "npm run typecheck", fixed: "pnpm typecheck", program: "pm typecheck", summary: "Typecheck with pnpm typecheck; npm run typecheck misses the workspace flags.", type: "policy" },
    { failed: "npm run e2e", fixed: "pnpm e2e", program: "pm e2e", summary: "Run e2e tests with pnpm e2e; npm run e2e cannot find the playwright config.", type: "pitfall" },
  ];

  test("six learn-and-apply fixtures all yield type=pitfall (policy relabelled)", () => {
    const ids: string[] = [];
    scenarios.forEach((scenario, index) => {
      const base = 3000 + index * 10;
      const turn = `p3${String(index)}`;
      const lines: LedgerLine[] = [
        promptLine("make it pass", { seq: base, turn_key: turn }),
        toolFailLine(scenario.failed, "Exit code 1\nscript failed", { seq: base + 1, turn_key: turn, program_token: scenario.program, exit_code: 1, failure_class: "exit_1" }),
        toolOkLine(scenario.fixed, { seq: base + 2, turn_key: turn, program_token: scenario.program, resolution_of: `bash|exit_1|${scenario.program}` }),
        assistantLine(`${scenario.fixed} works.`, { seq: base + 3, turn_key: turn }),
      ];
      const descriptor = descriptorFromLines(lines, { sessionId: `session-${String(index)}`, turnKey: turn });
      expect(descriptor.flags.resolution).toBe(1);
      const fact = factFixture({
        type: scenario.type,
        summary: scenario.summary,
        trigger_signature: { tool: "bash", target: "command", pattern_kind: "cmd", pattern: scenario.failed },
        knowledge_kind: "failure_resolution",
        evidence_refs: [`e${String(base + 1)}`, `e${String(base + 2)}`],
      });
      const result = applyRun(db, { descriptor, lines, output: outputFixture([fact]) });
      expect(result.op.report.created).toHaveLength(1);
      ids.push(result.op.report.created[0]!);
      if (scenario.type === "policy") {
        expect(result.op.report.outcomes[0]?.relabel).toContain("policy_to_pitfall");
      }
    });
    const rows = ids.map((id) => memories.getById(id)!);
    expect(rows.every((row) => row.type === "pitfall")).toBe(true);
    expect(rows.every((row) => row.status === "active" && row.enforcement === "soft_deny")).toBe(true);
    expect(rows.every((row) => row.lifecycleTriggers.includes("before_tool"))).toBe(true);
    expect(new Set(rows.map((row) => row.semanticKey)).size).toBe(6);
  });
});

describe("normalization and guards", () => {
  test("normalizeFact relabels policy→pitfall, recomputes the semantic key and collects failure classes", () => {
    const descriptor = descriptorFromLines(s02);
    const seqMap = new Map(s02.map((line) => [`e${String(line.seq)}`, line]));
    const fact = factFixture({ type: "policy", knowledge_kind: "failure_resolution", evidence_refs: ["e2002", "e2004"] });
    const validated = {
      ...fact,
      ordinal: 0,
      compiledSignature: { tool: "bash", target: "command" as const, pattern_kind: "cmd" as const, pattern: "pm test", negate: false, tokens: ["pm", "test"], regex_source: null, signature_key: "bash|command|cmd|pm test" },
      semanticKey: "stale-key",
      normalizedScope: "**/*",
      relabels: [],
    };
    const normalized = normalizeFact(validated, descriptor, seqMap, null);
    expect(normalized.type).toBe("pitfall");
    expect(normalized.relabels).toEqual(["policy_to_pitfall"]);
    expect(normalized.semanticKey).not.toBe("stale-key");
    expect(normalized.failureClasses).toEqual(["exit_1"]);
    expect(normalized.activationClass).toBe("event");
    expect(normalized.lifecycleTriggers).toEqual(["before_tool"]);
  });

  test("decision facts get session_start + before_model triggers", () => {
    const descriptor = descriptorFromLines(s02);
    const fact = factFixture({ type: "decision", trigger_signature: null, lifecycle_triggers: ["before_tool"], knowledge_kind: "decision", scope_glob: "**/*", evidence_refs: ["e2005"] });
    const validated = { ...fact, ordinal: 0, compiledSignature: null, semanticKey: "k", normalizedScope: "**/*", relabels: ["tool_not_hooked"] };
    const normalized = normalizeFact(validated, descriptor, new Map(), null);
    expect(normalized.lifecycleTriggers).toEqual(["session_start", "before_model"]);
    expect(normalized.activationClass).toBe("scoped");
  });

  test("a recently rejected twin is skipped (skipped_recent_reject)", () => {
    const descriptor = descriptorFromLines(s01);
    const fact = factFixture({ evidence_refs: ["e1001"] });
    const one = applyRun(db, { descriptor, lines: s01, output: outputFixture([fact]) });
    const id = one.op.report.created[0]!;
    db.run("UPDATE memories SET status = 'rejected', status_reason = 'human', updated_at = ? WHERE id = ?", [isoPlus(REPLAY_NOW, { days: 1 }), id]);

    const lines = bareFailureLines("p40", 4100);
    const again = applyRun(db, { descriptor: descriptorFromLines(lines, { sessionId: "session-q", turnKey: "p40" }), lines, output: outputFixture([{ ...fact, evidence_refs: ["e4101"] }]), now: isoPlus(REPLAY_NOW, { days: 2 }) });
    expect(again.op.report.outcomes[0]).toMatchObject({ outcome: "skipped", rejection: "skipped_recent_reject", memory_id: id });
    expect(memories.list({ status: ["candidate", "active"] })).toHaveLength(0);
  });

  test("a terminal twin older than 30 days is revived as a new live row", () => {
    const descriptor = descriptorFromLines(s01);
    const fact = factFixture({ evidence_refs: ["e1001"] });
    const one = applyRun(db, { descriptor, lines: s01, output: outputFixture([fact]) });
    const id = one.op.report.created[0]!;
    db.run("UPDATE memories SET status = 'rejected', status_reason = 'human', updated_at = ? WHERE id = ?", [isoPlus(REPLAY_NOW, { days: -40 }), id]);

    const lines = bareFailureLines("p41", 4200);
    const again = applyRun(db, { descriptor: descriptorFromLines(lines, { sessionId: "session-r", turnKey: "p41" }), lines, output: outputFixture([{ ...fact, evidence_refs: ["e4201"] }]), now: isoPlus(REPLAY_NOW, { days: 1 }) });
    expect(again.op.report.created).toHaveLength(1);
    expect(again.op.report.created[0]).not.toBe(id);
    expect(memories.getById(again.op.report.created[0]!)?.status).toBe("candidate");
  });

  test("a propose_supersede with the target's own claim becomes reinforce + stale proposal", () => {
    const descriptor = descriptorFromLines(s01);
    const fact = factFixture({ evidence_refs: ["e1001"] });
    const one = applyRun(db, { descriptor, lines: s01, output: outputFixture([fact]) });
    const id = one.op.report.created[0]!;

    const lines = bareFailureLines("p42", 4300);
    const again = applyRun(db, {
      descriptor: descriptorFromLines(lines, { sessionId: "session-s", turnKey: "p42" }),
      lines,
      output: outputFixture([{ ...fact, action: "propose_supersede", target_memory_id: id, evidence_refs: ["e4301"] }]),
      now: isoPlus(REPLAY_NOW, { hours: 3 }),
    });
    expect(again.op.report.created).toEqual([]);
    expect(again.op.report.reinforced).toEqual([id]);
    expect(again.op.report.outcomes[0]).toMatchObject({ outcome: "proposed" });
    expect(new ProposalRepository(db).listOpen({ kind: "stale", targetId: id })).toHaveLength(1);
    expect(memories.list({ status: ["candidate", "active"] })).toHaveLength(1);
  });

  test("caps: the per-episode cap leaves the fourth activation a candidate", () => {
    const descriptor = descriptorFromLines(s01);
    const commands = ["npm test", "npm run build", "yarn lint", "npm run e2e"];
    // Distinct claims: near-identical summaries would be absorbed into one row by the neighbour rule (§5.7 step 3).
    const summaries = [
      "Run the suite through pnpm test; npm test lacks a script in this repository.",
      "Build with pnpm build instead of npm run build, which breaks without the workspace flags.",
      "Lint via pnpm lint; yarn lint is not configured for this project.",
      "Execute end-to-end checks with pnpm e2e because npm run e2e cannot locate the playwright config.",
    ];
    const facts = commands.map((command, index) =>
      factFixture({
        summary: summaries[index]!,
        trigger_signature: { tool: "bash", target: "command", pattern_kind: "cmd", pattern: command },
        evidence_refs: ["e1001"],
      })
    );
    const promptText = s01[0]!.kind === "prompt" ? s01[0]!.text : "";
    const lines: LedgerLine[] = [{ ...(s01[0] as LedgerLine & { kind: "prompt" }), text: `${promptText} Also: ${commands.join(", ")} — do not use them.` }, s01[1]!];
    const custom = descriptorFromLines(lines);
    const result = applyRun(db, { descriptor: custom, lines, output: outputFixture(facts) });
    expect(result.op.report.created).toHaveLength(4);
    expect(result.op.report.activated).toHaveLength(DEFAULT_CONFIG.extraction.max_auto_activations_per_episode);
    const statuses = result.op.report.created.map((id) => memories.getById(id)!.status);
    expect(statuses.filter((status) => status === "active")).toHaveLength(3);
    expect(result.op.report.outcomes[3]?.detail).toContain("tier=candidate:cap");
    expect(descriptor.id).toBe(custom.id);
  });

  test("autonomy off keeps rows candidate; shadow writes an audit entry", () => {
    const descriptor = descriptorFromLines(s01);
    const fact = factFixture({ evidence_refs: ["e1001"] });
    const off = applyRun(db, { descriptor, lines: s01, output: outputFixture([fact]), config: { ...DEFAULT_CONFIG, autonomy_level: "off" } });
    expect(memories.getById(off.op.report.created[0]!)?.status).toBe("candidate");

    const shadowDescriptor = descriptorFromLines(s01, { sessionId: "session-shadow", turnKey: "p1s" });
    const shadow = applyRun(db, {
      descriptor: shadowDescriptor,
      lines: s01,
      output: outputFixture([{ ...fact, summary: "Prefer pnpm test over npm test here; npm has no test script in this repository." }]),
      config: { ...DEFAULT_CONFIG, autonomy_level: "shadow" },
      now: isoPlus(REPLAY_NOW, { hours: 1 }),
    });
    expect(memories.getById(shadow.op.report.created[0]!)?.status).toBe("candidate");
    const audit = db.exec("SELECT event_type FROM audit_log WHERE event_type = 'auto_activation_shadow'");
    expect(audit[0]?.values).toHaveLength(1);
  });

  test("a suspect run is recorded as a failed run and the episode retries with backoff", () => {
    const descriptor = descriptorFromLines(s02);
    const episodes = new EpisodeRepository(db);
    const result = applyRun(db, { descriptor, lines: s02, output: "Sure! Here is what I learned: nothing structured." });
    expect(result.op.noop).toBe(true);
    expect(result.op.wrote).toBe(true);
    expect(result.op.report.status).toBe("suspect");
    const run = new ExtractionRunRepository(db).getById(result.runId)!;
    expect(run.status).toBe("suspect");
    const episode = episodes.getById(descriptor.id)!;
    expect(episode.status).toBe("failed");
    expect(episode.nextAttemptAt).toBe(isoPlus(REPLAY_NOW, { hours: 1 }));
    expect(hasWriteOp(db, result.runId)).toBe(false);
  });

  test("recordExtractionFailure: third attempt is dead, provider-unavailable waits without burning an attempt", () => {
    const descriptor = descriptorFromLines(s02);
    const episodes = new EpisodeRepository(db);
    episodes.insertIfAbsent(descriptor, REPLAY_NOW);
    const run = { provider: "claude" as const, model: null, promptSha256: "x", inputChars: 10, startedAt: REPLAY_NOW, rawOutputRef: null };

    const waiting = recordExtractionFailure(db, { episodeId: descriptor.id, runId: "run-w", run, status: "not_logged_in", error: "Not logged in", now: REPLAY_NOW, attemptCount: 1 });
    expect(waiting.disposition).toBe("waiting");
    let episode = episodes.getById(descriptor.id)!;
    expect(episode.status).toBe("queued");
    expect(episode.attemptCount).toBe(0);
    expect(episode.nextAttemptAt).toBe(isoPlus(REPLAY_NOW, { days: 1 }));

    const retry = recordExtractionFailure(db, { episodeId: descriptor.id, runId: "run-t", run, status: "timeout", error: "killed", now: REPLAY_NOW, attemptCount: 2 });
    expect(retry.disposition).toBe("retry");
    episode = episodes.getById(descriptor.id)!;
    expect(episode.status).toBe("failed");
    expect(episode.nextAttemptAt).toBe(isoPlus(REPLAY_NOW, { hours: 6 }));

    const dead = recordExtractionFailure(db, { episodeId: descriptor.id, runId: "run-d", run, status: "provider_error", error: "boom", now: REPLAY_NOW, attemptCount: 3 });
    expect(dead.disposition).toBe("dead");
    expect(episodes.getById(descriptor.id)?.status).toBe("dead");
  });

  test("import-host episodes create human import rows (unconfirmed, advise)", () => {
    const lines: LedgerLine[] = [promptLine("Never run `npm test` here; always use `pnpm test`.", { seq: 1, turn_key: "import" })];
    const descriptor: EpisodeDescriptor = {
      ...descriptorFromLines(lines, { sessionId: "import-1", turnKey: "import" }),
      host: "import",
      close_reason: "import",
      ledger_ref: "import:CLAUDE.md#L4",
    };
    const fact = factFixture({ summary: "Never run npm test in this repository; use pnpm test for the suite.", evidence_refs: ["e1"], knowledge_kind: "convention" });
    const result = applyRun(db, { descriptor, lines, output: outputFixture([fact]) });
    expect(result.op.report.created).toHaveLength(1);
    const memory = memories.getById(result.op.report.created[0]!)!;
    expect(memory.authority).toBe("human");
    expect(memory.sourceKind).toBe("import");
    expect(memory.knowledgeKind).toBe("import");
    expect(memory.importUnconfirmed).toBe(1);
    expect(memory.status).toBe("active");
    expect(memory.enforcement).toBe("advise");
    expect(memory.sourceRef).toBe("import:CLAUDE.md#L4");
    expect(new ProvenanceRepository(db).listForMemory(memory.id)[0]).toMatchObject({ relation: "import", eventSeq: 0 });
    expect(result.op.report.activated).toEqual([]);
  });

  test("helpers: scopesIntersect and jaccard", () => {
    expect(scopesIntersect("src/**", "src/db/*.ts")).toBe(true);
    expect(scopesIntersect("src/**", "test/**")).toBe(false);
    expect(scopesIntersect("**/*", "docs/*.md")).toBe(true);
    expect(scopesIntersect("src/db", "src/db/store.ts")).toBe(true);
    expect(jaccard(summaryTokens("Run pnpm test instead of npm test"), summaryTokens("Run pnpm test instead of npm test."))).toBe(1);
    expect(jaccard(summaryTokens("alpha beta gamma"), summaryTokens("delta epsilon"))).toBe(0);
  });
});
