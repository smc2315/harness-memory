/**
 * A′ ladder and remember-as-human helpers (src/promotion/escalation.ts, src/promotion/remember.ts): the pure
 * decisions as a table, the notice text the SessionStart hook renders, and the database-level escalation
 * (enforcement, history transition, audit row, downgrade / session-age lookups) on a fresh v22 database.
 */

import { beforeEach, describe, expect, test } from "vitest";
import type { Database as SqlJsDatabase } from "sql.js";

import { DEFAULT_CONFIG, mergeConfig, type HarnessConfig } from "../src/core/config";
import type { LedgerLine } from "../src/core/ledger-types";
import { detectRemember } from "../src/core/signals";
import type { SnapshotMemory } from "../src/core/snapshot-types";
import { TransitionRepository } from "../src/db/repositories/transitions";
import { InvalidMemoryTransitionError, MemoryNotFoundError, MemoryRepository } from "../src/memory/repository";
import {
  ESCALATION_AUDIT_EVENT,
  OVERRIDE_DOWNGRADE_EVENT,
  decideEscalation,
  escalateOnReinforce,
  hasCompiledSignature,
  latestOverrideDowngradeAt,
  sessionPredates,
  type DecideEscalationInput,
  type EscalationCandidate,
} from "../src/promotion/escalation";
import {
  REMEMBER_MAX_PER_EPISODE,
  REMEMBER_STATUS_REASON,
  buildRememberNotice,
  citesRememberPrompt,
  detectRememberRequest,
  isRecentRememberRow,
  rememberEnforcement,
  rememberEpisodeOfReason,
  rememberTransitionReason,
  rememberedAtMs,
} from "../src/promotion/remember";
import { adoptActiveMemory } from "../src/promotion/transitions";
import { createTestDb } from "./helpers/create-test-db";
import { promptLine, toolFailLine, toolOkLine } from "./helpers/ledger-fixture";
import { T0, autoMemory, humanMemory, insertEpisode, isoPlus } from "./helpers/memory-fixtures";

function candidate(overrides: Partial<EscalationCandidate> = {}): EscalationCandidate {
  return {
    authority: "auto",
    status: "active",
    enforcement: "advise",
    type: "pitfall",
    knowledgeKind: "correction",
    hasSignature: true,
    distinctSessionCount: 2,
    ...overrides,
  };
}

function input(overrides: Partial<DecideEscalationInput> = {}, memory: Partial<EscalationCandidate> = {}): DecideEscalationInput {
  return { memory: candidate(memory), config: DEFAULT_CONFIG, downgradedAt: null, reinforcingSessionIsNew: true, ...overrides };
}

function withConfig(patch: { autonomy?: HarnessConfig["autonomy_level"]; escalation?: Partial<HarnessConfig["before_tool"]["auto_escalation"]> }): Pick<HarnessConfig, "before_tool" | "autonomy_level"> {
  return {
    autonomy_level: patch.autonomy ?? DEFAULT_CONFIG.autonomy_level,
    before_tool: { ...DEFAULT_CONFIG.before_tool, auto_escalation: { ...DEFAULT_CONFIG.before_tool.auto_escalation, ...patch.escalation } },
  };
}

describe("decideEscalation (A′ ladder: advise → soft_deny)", () => {
  test("the default config is advise-first with a two-session ladder", () => {
    expect(DEFAULT_CONFIG.before_tool.auto_enforcement).toBe("advise");
    expect(DEFAULT_CONFIG.before_tool.auto_escalation).toEqual({ enabled: true, sessions: 2 });
  });

  test("an active auto advise pitfall with a signature, correction kind and two sessions climbs", () => {
    expect(decideEscalation(input())).toEqual({ escalate: true, sessions: 2 });
    expect(decideEscalation(input({}, { knowledgeKind: "failure_resolution", distinctSessionCount: 5 }))).toEqual({ escalate: true, sessions: 5 });
  });

  test.each<[string, DecideEscalationInput, string]>([
    ["escalation disabled", input({ config: withConfig({ escalation: { enabled: false } }) }), "disabled"],
    ["autonomy shadow never exceeds advise", input({ config: withConfig({ autonomy: "shadow" }) }), "autonomy"],
    ["autonomy off", input({ config: withConfig({ autonomy: "off" }) }), "autonomy"],
    ["human rows are never touched", input({}, { authority: "human" }), "human"],
    ["candidate rows wait for decideTier", input({}, { status: "candidate" }), "status"],
    ["stale rows do not climb", input({}, { status: "stale" }), "status"],
    ["already soft_deny", input({}, { enforcement: "soft_deny" }), "enforcement"],
    ["confirm is not on the auto ladder", input({}, { enforcement: "confirm" }), "enforcement"],
    ["policies do not climb", input({}, { type: "policy" }), "type"],
    ["workflows do not climb", input({}, { type: "workflow" }), "type"],
    ["no compiled signature", input({}, { hasSignature: false }), "signature"],
    ["convention kind", input({}, { knowledgeKind: "convention" }), "knowledge_kind"],
    ["null kind", input({}, { knowledgeKind: null }), "knowledge_kind"],
    ["one session only", input({}, { distinctSessionCount: 1 }), "sessions"],
    ["threshold raised to 3", input({ config: withConfig({ escalation: { sessions: 3 } }) }), "sessions"],
    ["downgraded by overrides and the same session reinforces", input({ downgradedAt: T0, reinforcingSessionIsNew: false }), "override_downgraded"],
  ])("%s → no (%s)", (_label, decision, reason) => {
    const result = decideEscalation(decision);
    expect(result.escalate).toBe(false);
    if (!result.escalate) expect(result.reason).toBe(reason);
  });

  test("a session that began after the override downgrade re-escalates; a threshold of 0 behaves like 1", () => {
    expect(decideEscalation(input({ downgradedAt: T0, reinforcingSessionIsNew: true }))).toEqual({ escalate: true, sessions: 2 });
    expect(decideEscalation(input({ config: withConfig({ escalation: { sessions: 0 } }) }, { distinctSessionCount: 1 }))).toEqual({ escalate: true, sessions: 1 });
  });

  test("config parser: before_tool.auto_escalation is tolerant (sessions < 1 and junk fall back to the defaults), auto_enforcement keeps soft_deny selectable", () => {
    // pickNumber semantics (src/core/config.ts): a value below `min` (1) is invalid and falls back, like every other key.
    expect(mergeConfig(DEFAULT_CONFIG, { before_tool: { auto_escalation: { sessions: 0, enabled: "yes" } } }).before_tool.auto_escalation).toEqual({ enabled: true, sessions: 2 });
    expect(mergeConfig(DEFAULT_CONFIG, { before_tool: { auto_escalation: { sessions: -3 } } }).before_tool.auto_escalation).toEqual({ enabled: true, sessions: 2 });
    expect(mergeConfig(DEFAULT_CONFIG, { before_tool: { auto_escalation: { sessions: 1 } } }).before_tool.auto_escalation).toEqual({ enabled: true, sessions: 1 });
    expect(mergeConfig(DEFAULT_CONFIG, { before_tool: { auto_escalation: { sessions: 3, enabled: false } } }).before_tool.auto_escalation).toEqual({ enabled: false, sessions: 3 });
    expect(mergeConfig(DEFAULT_CONFIG, { before_tool: { auto_escalation: 5 } }).before_tool.auto_escalation).toEqual({ enabled: true, sessions: 2 });
    expect(mergeConfig(DEFAULT_CONFIG, { before_tool: { auto_escalation: { sessions: "many" } } }).before_tool.auto_escalation).toEqual({ enabled: true, sessions: 2 });
    expect(mergeConfig(DEFAULT_CONFIG, {}).before_tool).toEqual(DEFAULT_CONFIG.before_tool);
    expect(mergeConfig(DEFAULT_CONFIG, { before_tool: { auto_enforcement: "soft_deny" } }).before_tool.auto_enforcement).toBe("soft_deny");
    expect(mergeConfig(DEFAULT_CONFIG, { before_tool: { auto_enforcement: "deny" } }).before_tool.auto_enforcement).toBe("advise");
    // The rest of before_tool survives a partial override.
    expect(mergeConfig(DEFAULT_CONFIG, { before_tool: { auto_escalation: { enabled: false } } }).before_tool).toMatchObject({ max_items: 3, max_bytes: 2_048, hard_policy: "confirm", auto_enforcement: "advise" });
  });
});

describe("detectRememberRequest (the gate of the human path, stricter than the weight signal)", () => {
  test.each<[string, boolean]>([
    // The nine-prompt probe of the review: the broad signal flagged eight of them, only two are requests.
    ["I don't remember whether this repo uses npm or pnpm — check and run the tests", false],
    ["Can't remember where the config lives, find it", false],
    ["Going forward let's look at the auth module first", false],
    ["앞으로 3일 안에 끝내야 해, 테스트부터 돌려줘", false],
    ["이 함수 기억나? 어디서 쓰였는지 찾아줘", false],
    ["절대 안 돌아가네, 왜 이러지", false],
    ["Please run the tests", false],
    ["앞으로 커밋하기 전에 꼭 pnpm lint를 돌려. 기억해.", true],
    ["remember this: never run npm test here", true],
    // More recall talk that must stay on the automatic path.
    ["Do you remember where we put the migration runner?", false],
    ["I remember we used npm here, is that still right?", false],
    ["Remember when npm test used to work? It fails now", false],
    ["We never remember to bump the version, check it", false],
    ["Did you remember to run lint?", false],
    ["기억 안 나는데 config가 어디 있지", false],
    ["기억하세요? 어제 npm으로 돌렸잖아요", false],
    ["Going forward we need to think about the auth module", false],
    ["From now on I'll handle the deploys myself", false],
    ["앞으로는 제가 배포할게요", false],
    // Explicit requests in several shapes.
    ["Remember to run pnpm lint before committing", true],
    ["remember: always seed before tests", true],
    ["Please remember that this repo uses pnpm", true],
    ["Ok, remember — the API lives in packages/api", true],
    ["I can't remember, but from now on always use pnpm", true],
    ["From now on use pnpm test, not npm test", true],
    ["Going forward, don't touch the generated files", true],
    ["기억해줘: 테스트는 pnpm으로", true],
    ["이거 기억해 둬, 커밋 전에 린트", true],
    ["앞으로는 절대 npm test 쓰지 마", true],
    ["아니, npm test 말고 pnpm test. 앞으로 기억해.", true],
    ["앞으로는 항상 pnpm으로 설치해", true],
    ["앞으로 git push는 하지 마세요", true],
    ["Remember this. Do you remember where the old config was?", true],
    // Not a hook remember signal at all (`이제부터` is a decision marker), so not a request either: explicit ⊂ broad.
    ["이제부터 항상 pnpm으로 설치해", false],
  ])("%s → %s", (text, expected) => {
    expect(detectRememberRequest(text)).toBe(expected);
  });

  test("explicit ⊂ broad: every explicit request also carries the hook's weight flag", () => {
    for (const text of [
      "remember this: never run npm test here",
      "Remember to run pnpm lint before committing",
      "From now on use pnpm test, not npm test",
      "Going forward, don't touch the generated files",
      "기억해줘: 테스트는 pnpm으로",
      "앞으로는 절대 npm test 쓰지 마",
      "앞으로는 항상 pnpm으로 설치해",
      "기억하세요: 린트는 pnpm으로",
    ]) {
      expect(detectRememberRequest(text), text).toBe(true);
      expect(detectRemember(text), text).toBe(true);
    }
  });

  test("the cap and the transition reason helpers", () => {
    expect(REMEMBER_MAX_PER_EPISODE).toBe(2);
    expect(rememberTransitionReason("ep-1")).toBe("remember:episode ep-1");
    expect(rememberEpisodeOfReason("remember:episode ep-1")).toBe("ep-1");
    expect(rememberEpisodeOfReason("remember:episode ")).toBeNull();
    expect(rememberEpisodeOfReason("auto_escalation: advise → soft_deny (2 sessions)")).toBeNull();
    expect(rememberEpisodeOfReason("decideTier")).toBeNull();
  });
});

describe("remember helpers", () => {
  test("rememberEnforcement: policy + signature → hard_policy, pitfall + signature → soft_deny, else advise", () => {
    expect(rememberEnforcement("policy", true, DEFAULT_CONFIG)).toBe("confirm");
    expect(rememberEnforcement("policy", true, { before_tool: { ...DEFAULT_CONFIG.before_tool, hard_policy: "deny" } })).toBe("deny");
    expect(rememberEnforcement("pitfall", true, DEFAULT_CONFIG)).toBe("soft_deny");
    expect(rememberEnforcement("workflow", true, DEFAULT_CONFIG)).toBe("advise");
    expect(rememberEnforcement("policy", false, DEFAULT_CONFIG)).toBe("advise");
    expect(rememberEnforcement("pitfall", false, DEFAULT_CONFIG)).toBe("advise");
    expect(rememberEnforcement("decision", true, DEFAULT_CONFIG)).toBe("advise");
  });

  test("citesRememberPrompt: a create of a remember turn citing an explicit remember prompt line, nothing else", () => {
    const prompt = promptLine("앞으로 커밋 전에 pnpm lint. 기억해.", { seq: 1, remember: 1 });
    const plain = promptLine("run the tests", { seq: 2, remember: 0 });
    const tool = toolOkLine("pnpm lint", { seq: 3 });
    const fail = toolFailLine("npm test", "Exit code 1", { seq: 4 });
    // Flagged by the broad weight signal, but recall talk, not a request: never approval.
    const incidental = promptLine("I don't remember whether this repo uses npm or pnpm — check and run the tests", { seq: 5, remember: 1 });
    // An explicit request the hook did not flag (flag 0) is not taken either: the flag is the hook's word.
    const unflagged = promptLine("remember this: never run npm test here", { seq: 6, remember: 0 });
    const seqMap = new Map<string, LedgerLine>([
      ["e1", prompt],
      ["e2", plain],
      ["e3", tool],
      ["e4", fail],
      ["e5", incidental],
      ["e6", unflagged],
    ]);
    expect(citesRememberPrompt({ remember: 1 }, { action: "create", evidence_refs: ["e1"] }, seqMap)).toBe(true);
    expect(citesRememberPrompt({ remember: 1 }, { action: "create", evidence_refs: ["e3", "e1"] }, seqMap)).toBe(true);
    expect(citesRememberPrompt({ remember: 1 }, { action: "create", evidence_refs: ["e3", "e4"] }, seqMap)).toBe(false);
    expect(citesRememberPrompt({ remember: 1 }, { action: "create", evidence_refs: ["e2"] }, seqMap)).toBe(false);
    expect(citesRememberPrompt({ remember: 1 }, { action: "create", evidence_refs: ["e5"] }, seqMap)).toBe(false);
    expect(citesRememberPrompt({ remember: 1 }, { action: "create", evidence_refs: ["e5", "e3"] }, seqMap)).toBe(false);
    expect(citesRememberPrompt({ remember: 1 }, { action: "create", evidence_refs: ["e6"] }, seqMap)).toBe(false);
    expect(citesRememberPrompt({ remember: 1 }, { action: "reinforce", evidence_refs: ["e1"] }, seqMap)).toBe(false);
    expect(citesRememberPrompt({ remember: 1 }, { action: "propose_stale", evidence_refs: ["e1"] }, seqMap)).toBe(false);
    expect(citesRememberPrompt({ correction: 1 }, { action: "create", evidence_refs: ["e1"] }, seqMap)).toBe(false);
    expect(citesRememberPrompt({ remember: 1 }, { action: "create", evidence_refs: ["e9"] }, seqMap)).toBe(false);
  });

  const NOW = "2026-11-08T12:00:00.000Z";

  function row(overrides: Partial<SnapshotMemory> = {}): Pick<SnapshotMemory, "id" | "summary" | "status" | "authority" | "created_at" | "status_reason" | "last_verified_at"> {
    return {
      id: "66ffa056-1111-4222-8333-444455556666",
      summary: "Run pnpm lint before every git commit",
      status: "active",
      authority: "human",
      status_reason: REMEMBER_STATUS_REASON,
      created_at: isoPlus(NOW, { hours: -2 }),
      last_verified_at: null,
      ...overrides,
    };
  }

  test("rememberedAtMs: the later of created_at and last_verified_at (an adopted twin keeps its old created_at)", () => {
    expect(rememberedAtMs({ created_at: NOW, last_verified_at: null })).toBe(Date.parse(NOW));
    expect(rememberedAtMs({ created_at: isoPlus(NOW, { days: -3 }), last_verified_at: isoPlus(NOW, { hours: -1 }) })).toBe(Date.parse(isoPlus(NOW, { hours: -1 })));
    expect(rememberedAtMs({ created_at: NOW, last_verified_at: isoPlus(NOW, { minutes: -5 }) })).toBe(Date.parse(NOW));
    expect(rememberedAtMs({ created_at: "nope", last_verified_at: NOW })).toBe(Date.parse(NOW));
    expect(Number.isNaN(rememberedAtMs({ created_at: "nope", last_verified_at: null }))).toBe(true);
  });

  test("isRecentRememberRow: active human remember rows remembered within the window, never future or foreign rows", () => {
    const nowMs = Date.parse(NOW);
    expect(isRecentRememberRow(row(), nowMs)).toBe(true);
    expect(isRecentRememberRow(row({ created_at: isoPlus(NOW, { hours: -25 }) }), nowMs)).toBe(false);
    expect(isRecentRememberRow(row({ created_at: isoPlus(NOW, { hours: 1 }) }), nowMs)).toBe(false);
    expect(isRecentRememberRow(row({ status: "stale" }), nowMs)).toBe(false);
    expect(isRecentRememberRow(row({ authority: "auto" }), nowMs)).toBe(false);
    expect(isRecentRememberRow(row({ status_reason: "human" }), nowMs)).toBe(false);
    expect(isRecentRememberRow(row({ status_reason: null }), nowMs)).toBe(false);
    expect(isRecentRememberRow({ ...row(), status_reason: undefined }, nowMs)).toBe(false);
    expect(isRecentRememberRow(row({ created_at: "not a date" }), nowMs)).toBe(false);
    // An adopted twin: created days ago, claimed by the user an hour ago (its reinforce set last_verified_at).
    expect(isRecentRememberRow(row({ created_at: isoPlus(NOW, { days: -3 }), last_verified_at: isoPlus(NOW, { hours: -1 }) }), nowMs)).toBe(true);
    expect(isRecentRememberRow(row({ created_at: isoPlus(NOW, { days: -3 }), last_verified_at: isoPlus(NOW, { days: -2 }) }), nowMs)).toBe(false);
    expect(isRecentRememberRow({ ...row({ created_at: isoPlus(NOW, { days: -3 }) }), last_verified_at: undefined }, nowMs)).toBe(false);
  });

  test("buildRememberNotice: the exact one-rule line, plural newest-first, a cap with a count, null when nothing is recent", () => {
    expect(buildRememberNotice([], NOW)).toBeNull();
    expect(buildRememberNotice([row({ created_at: isoPlus(NOW, { days: -2 }) })], NOW)).toBeNull();
    expect(buildRememberNotice([row()], NOW)).toBe("harness-memory: 1 rule from your request is active — Run pnpm lint before every git commit (undo: hm memory:demote 66ffa056)");
    const older = row({ id: "aaaaaaaa-0000-4000-8000-000000000000", summary: "Older rule", created_at: isoPlus(NOW, { hours: -5 }) });
    const newer = row({ id: "bbbbbbbb-0000-4000-8000-000000000000", summary: "  Newer   rule  ", created_at: isoPlus(NOW, { hours: -1 }) });
    expect(buildRememberNotice([older, newer], NOW)).toBe(
      "harness-memory: 2 rules from your request are active — Newer rule (undo: hm memory:demote bbbbbbbb); Older rule (undo: hm memory:demote aaaaaaaa)"
    );
    const many = ["c1", "c2", "c3", "c4", "c5"].map((tag, index) => row({ id: `${tag}${"0".repeat(6)}-0000-4000-8000-000000000000`, summary: `Rule ${tag}`, created_at: isoPlus(NOW, { minutes: -index }) }));
    const notice = buildRememberNotice(many, NOW);
    expect(notice).toContain("5 rules from your request are active");
    expect(notice).toContain("Rule c1 (undo: hm memory:demote c1000000)");
    expect(notice).toContain("; +2 more (hm memory:list)");
    expect(notice).not.toContain("Rule c4");
    expect(buildRememberNotice(many, NOW, { maxRules: 5 })).not.toContain("more");
    const long = row({ summary: "x".repeat(150) });
    expect(buildRememberNotice([long], NOW)).toContain(`${"x".repeat(99)}…`);
  });

  test("buildRememberNotice orders by when the request took effect: an adopted old twin claimed a minute ago comes first", () => {
    const born = row({ id: "bbbbbbbb-0000-4000-8000-000000000000", summary: "Born an hour ago", created_at: isoPlus(NOW, { hours: -1 }) });
    const adopted = row({ id: "aaaaaaaa-0000-4000-8000-000000000000", summary: "Adopted a minute ago", created_at: isoPlus(NOW, { days: -5 }), last_verified_at: isoPlus(NOW, { minutes: -1 }) });
    const stale = row({ id: "cccccccc-0000-4000-8000-000000000000", summary: "Adopted long ago", created_at: isoPlus(NOW, { days: -5 }), last_verified_at: isoPlus(NOW, { days: -4 }) });
    expect(buildRememberNotice([born, stale, adopted], NOW)).toBe(
      "harness-memory: 2 rules from your request are active — Adopted a minute ago (undo: hm memory:demote aaaaaaaa); Born an hour ago (undo: hm memory:demote bbbbbbbb)"
    );
  });
});

describe("adoptActiveMemory (A′: a remember turn claims an already-active row)", () => {
  let db: SqlJsDatabase;
  let memories: MemoryRepository;
  const NOW = isoPlus(T0, { hours: 1 });

  beforeEach(async () => {
    db = await createTestDb({ now: T0 });
    memories = new MemoryRepository(db, { clock: () => NOW });
  });

  test("an active auto row becomes human (promotion manual, TTL cleared), status_reason remember, with one active → active transition by human", () => {
    const row = memories.create(autoMemory({ status: "active", enforcement: "advise", ttlExpiresAt: isoPlus(T0, { days: 30 }), revalidateAfter: isoPlus(T0, { days: 15 }), statusReason: "auto_rule" }));
    const updated = adoptActiveMemory(db, { memoryId: row.id, reason: rememberTransitionReason("ep-remember"), now: NOW, runId: "run-r", statusReason: REMEMBER_STATUS_REASON });
    expect(updated).toMatchObject({ id: row.id, status: "active", authority: "human", promotionSource: "manual", statusReason: "remember", ttlExpiresAt: null, revalidateAfter: null, updatedAt: NOW, enforcement: "advise" });
    expect(memories.getById(row.id)).toEqual(updated);
    const transitions = new TransitionRepository(db).listForMemory(row.id);
    expect(transitions).toHaveLength(1);
    expect(transitions[0]).toMatchObject({ fromStatus: "active", toStatus: "active", actor: "human", proposalId: null, extractionRunId: "run-r", reason: "remember:episode ep-remember", createdAt: NOW });
  });

  test("an already-human active row only gains the status_reason and the history row; a non-active or missing row throws before anything is written", () => {
    const human = memories.create(humanMemory({ status: "active", enforcement: "confirm" }));
    const adopted = adoptActiveMemory(db, { memoryId: human.id, reason: rememberTransitionReason("ep-2"), now: NOW, statusReason: REMEMBER_STATUS_REASON });
    expect(adopted).toMatchObject({ authority: "human", statusReason: "remember", enforcement: "confirm", updatedAt: NOW });
    expect(new TransitionRepository(db).listForMemory(human.id)).toHaveLength(1);

    const candidate = memories.create(autoMemory({ status: "candidate" }));
    expect(() => adoptActiveMemory(db, { memoryId: candidate.id, reason: "remember:episode ep-3", now: NOW, statusReason: REMEMBER_STATUS_REASON })).toThrow(InvalidMemoryTransitionError);
    expect(memories.getById(candidate.id)).toMatchObject({ status: "candidate", authority: "auto", statusReason: null });
    expect(new TransitionRepository(db).listForMemory(candidate.id)).toEqual([]);
    expect(() => adoptActiveMemory(db, { memoryId: "missing", reason: "remember:episode ep-4", now: NOW, statusReason: REMEMBER_STATUS_REASON })).toThrow(MemoryNotFoundError);
  });
});

describe("escalateOnReinforce on the database", () => {
  let db: SqlJsDatabase;
  let memories: MemoryRepository;
  const NOW = isoPlus(T0, { hours: 1 });
  const signature = { tool: "bash" as const, target: "command" as const, pattern_kind: "cmd" as const, pattern: "npm test" };

  beforeEach(async () => {
    db = await createTestDb({ now: T0 });
    memories = new MemoryRepository(db, { clock: () => NOW });
  });

  function ladderRow(overrides: Parameters<typeof autoMemory>[0] = {}) {
    return memories.create(
      autoMemory({
        status: "active",
        enforcement: "advise",
        knowledgeKind: "correction",
        triggerSignature: signature,
        signatureKey: "bash|command|cmd|npm test",
        summary: "Run pnpm test instead of npm test in this repository.",
        ...overrides,
      })
    );
  }

  function setSessions(id: string, count: number): void {
    db.run("UPDATE memories SET distinct_session_count = ? WHERE id = ?", [count, id]);
  }

  test("hasCompiledSignature needs a stored signature that compiles and a non-empty key", () => {
    expect(hasCompiledSignature({ triggerSignature: signature, signatureKey: "bash|command|cmd|npm test" })).toBe(true);
    expect(hasCompiledSignature({ triggerSignature: null, signatureKey: "" })).toBe(false);
    expect(hasCompiledSignature({ triggerSignature: signature, signatureKey: "" })).toBe(false);
    expect(hasCompiledSignature({ triggerSignature: { ...signature, pattern_kind: "regex", pattern: "(" }, signatureKey: "x" })).toBe(false);
  });

  test("two sessions: enforcement soft_deny, one active → active auto_rule transition with the run id, one audit row; a second call is a no-op", () => {
    const memory = ladderRow();
    setSessions(memory.id, 2);
    const result = escalateOnReinforce(db, { memoryId: memory.id, sessionId: "session-b", runId: "run-2", config: DEFAULT_CONFIG, now: NOW });
    expect(result.applied).toBe(true);
    expect(result.decision).toEqual({ escalate: true, sessions: 2 });
    expect(result.memory).toMatchObject({ enforcement: "soft_deny", authority: "auto", status: "active", updatedAt: NOW });
    const transitions = new TransitionRepository(db).listForMemory(memory.id);
    expect(transitions).toHaveLength(1);
    expect(transitions[0]).toMatchObject({ fromStatus: "active", toStatus: "active", actor: "auto_rule", extractionRunId: "run-2", proposalId: null, createdAt: NOW });
    expect(transitions[0]!.reason.startsWith("auto_escalation")).toBe(true);
    expect(transitions[0]!.reason).toContain("advise → soft_deny");
    const audit = db.exec(`SELECT event_type, session_id, details_json FROM audit_log WHERE event_type = '${ESCALATION_AUDIT_EVENT}'`);
    expect(audit[0]?.values).toHaveLength(1);
    expect(audit[0]?.values[0]?.[1]).toBe("session-b");
    expect(JSON.parse(String(audit[0]?.values[0]?.[2]))).toMatchObject({ memoryId: memory.id, from: "advise", to: "soft_deny", sessions: 2, runId: "run-2" });

    const again = escalateOnReinforce(db, { memoryId: memory.id, sessionId: "session-c", runId: "run-3", config: DEFAULT_CONFIG, now: isoPlus(NOW, { hours: 1 }) });
    expect(again.applied).toBe(false);
    expect(again.decision).toMatchObject({ escalate: false, reason: "enforcement" });
    expect(new TransitionRepository(db).listForMemory(memory.id)).toHaveLength(1);
  });

  test("one session, shadow autonomy, a human row and a missing row never escalate", () => {
    const one = ladderRow();
    setSessions(one.id, 1);
    expect(escalateOnReinforce(db, { memoryId: one.id, sessionId: "s", runId: null, config: DEFAULT_CONFIG, now: NOW }).decision).toMatchObject({ escalate: false, reason: "sessions" });
    setSessions(one.id, 3);
    const shadow: Pick<HarnessConfig, "before_tool" | "autonomy_level"> = { autonomy_level: "shadow", before_tool: DEFAULT_CONFIG.before_tool };
    expect(escalateOnReinforce(db, { memoryId: one.id, sessionId: "s", runId: null, config: shadow, now: NOW }).decision).toMatchObject({ escalate: false, reason: "autonomy" });
    expect(memories.getById(one.id)?.enforcement).toBe("advise");

    const human = memories.create(humanMemory({ type: "pitfall", status: "active", enforcement: "advise", knowledgeKind: "correction", triggerSignature: signature, signatureKey: "bash|command|cmd|npm test", scopeGlob: "**/*", lifecycleTriggers: ["before_tool"] }));
    setSessions(human.id, 4);
    const untouched = escalateOnReinforce(db, { memoryId: human.id, sessionId: "s", runId: null, config: DEFAULT_CONFIG, now: NOW });
    expect(untouched.decision).toMatchObject({ escalate: false, reason: "human" });
    expect(memories.getById(human.id)).toMatchObject({ enforcement: "advise", authority: "human" });
    expect(new TransitionRepository(db).listForMemory(human.id)).toEqual([]);

    expect(escalateOnReinforce(db, { memoryId: "nope", sessionId: "s", runId: null, config: DEFAULT_CONFIG, now: NOW })).toMatchObject({ applied: false, memory: null });
  });

  test("the override downgrade marker and the session-age lookup gate re-escalation", () => {
    const memory = ladderRow();
    setSessions(memory.id, 2);
    expect(latestOverrideDowngradeAt(db, memory.id)).toBeNull();
    const downgradedAt = isoPlus(T0, { hours: 2 });
    // The consolidator's audit row (src/dream/consolidate.ts fireAndOverride): details_json carries the memory id.
    db.run("INSERT INTO audit_log (id, event_type, session_id, scope_ref, summary, details_json, created_at) VALUES (?, ?, NULL, NULL, ?, ?, ?)", [
      "audit-downgrade-1",
      OVERRIDE_DOWNGRADE_EVENT,
      `override downgrade: ${memory.id} soft_deny → advise (overrides 3, evidence 2)`,
      JSON.stringify({ memoryId: memory.id, from: "soft_deny", overrideCount: 3, evidenceScore: 2 }),
      downgradedAt,
    ]);
    db.run("INSERT INTO audit_log (id, event_type, session_id, scope_ref, summary, details_json, created_at) VALUES (?, ?, NULL, NULL, ?, ?, ?)", [
      "audit-downgrade-other",
      OVERRIDE_DOWNGRADE_EVENT,
      "override downgrade of another row",
      JSON.stringify({ memoryId: "someone-else", from: "soft_deny", overrideCount: 3, evidenceScore: 1 }),
      isoPlus(T0, { hours: 3 }),
    ]);
    expect(latestOverrideDowngradeAt(db, memory.id)).toBe(downgradedAt);

    insertEpisode(db, { session_id: "session-old", started_at: isoPlus(T0, { hours: 1 }), closed_at: isoPlus(T0, { hours: 1, minutes: 5 }) }, T0);
    insertEpisode(db, { session_id: "session-new", started_at: isoPlus(T0, { hours: 3 }), closed_at: isoPlus(T0, { hours: 3, minutes: 5 }) }, T0);
    expect(sessionPredates(db, "session-old", downgradedAt)).toBe(true);
    expect(sessionPredates(db, "session-new", downgradedAt)).toBe(false);
    expect(sessionPredates(db, "session-unknown", downgradedAt)).toBe(false);

    const blocked = escalateOnReinforce(db, { memoryId: memory.id, sessionId: "session-old", runId: "run-old", config: DEFAULT_CONFIG, now: isoPlus(T0, { hours: 4 }) });
    expect(blocked.applied).toBe(false);
    expect(blocked.decision).toMatchObject({ escalate: false, reason: "override_downgraded" });
    expect(memories.getById(memory.id)?.enforcement).toBe("advise");

    const allowed = escalateOnReinforce(db, { memoryId: memory.id, sessionId: "session-new", runId: "run-new", config: DEFAULT_CONFIG, now: isoPlus(T0, { hours: 5 }) });
    expect(allowed.applied).toBe(true);
    expect(memories.getById(memory.id)?.enforcement).toBe("soft_deny");
  });
});
