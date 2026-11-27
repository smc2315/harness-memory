import { describe, expect, test } from "vitest";

import { toolGlobFamilies } from "../src/activation/tool-vocabulary";
import { DEFAULT_CONFIG, type HarnessConfig } from "../src/core/config";
import { PRE_TOOL_HOOKED_FAMILIES } from "../src/core/vocabulary";
import {
  ACTIVATION_MIN_EVIDENCE,
  FULL_ACTIVATION_MIN_EVIDENCE,
  FULL_DECISION_MARKER_EVIDENCE,
  KNOWLEDGE_TTL_DAYS,
  SILENT_WRITE_MIN_EVIDENCE,
  TASK_TTL_DAYS,
  addDays,
  baseTtlDays,
  decideTier,
  enforcementDefault,
  isReachableTrigger,
  tierTtlDays,
  type DecideTierInput,
  type EnforcementDefaultInput,
} from "../src/promotion/authority";

const config: Pick<HarnessConfig, "before_tool"> = { before_tool: DEFAULT_CONFIG.before_tool };

function human(overrides: Partial<EnforcementDefaultInput> = {}): EnforcementDefaultInput {
  return {
    type: "policy",
    authority: "human",
    policySubtype: "hard",
    hasSignature: true,
    specificityOk: true,
    knowledgeKind: "manual",
    importUnconfirmed: 0,
    config,
    ...overrides,
  };
}

function auto(overrides: Partial<EnforcementDefaultInput> = {}): EnforcementDefaultInput {
  return {
    type: "pitfall",
    authority: "auto",
    policySubtype: null,
    hasSignature: true,
    specificityOk: true,
    knowledgeKind: "correction",
    importUnconfirmed: 0,
    config,
    ...overrides,
  };
}

/** The 0.6.0-rc.2 §3 rule-1 row: a mistake_exact signature on a write into a shared system, learned from a correction with evidence 2. */
function silentWrite(overrides: Partial<EnforcementDefaultInput> = {}): EnforcementDefaultInput {
  return auto({ signaturePrecision: "mistake_exact", sideEffect: "write", horizon: "durable", evidenceScore: 2, ...overrides });
}

describe("enforcementDefault (§7.3)", () => {
  test.each<[string, EnforcementDefaultInput, string]>([
    ["human policy hard + signature", human(), "confirm"],
    ["human policy hard without signature", human({ hasSignature: false }), "advise"],
    ["human policy soft + signature", human({ policySubtype: "soft" }), "advise"],
    ["human policy null subtype + signature", human({ policySubtype: null }), "advise"],
    ["confirmed import with strong wording + signature", human({ policySubtype: null, knowledgeKind: "import", summary: "Never commit .env files." }), "confirm"],
    ["confirmed import with Korean strong wording + signature", human({ policySubtype: null, knowledgeKind: "import", summary: "절대 .env 파일을 커밋하지 않는다." }), "confirm"],
    ["import --yes (unconfirmed) with strong wording", human({ policySubtype: null, knowledgeKind: "import", importUnconfirmed: 1, summary: "Never commit .env files." }), "advise"],
    ["confirmed import with weak wording", human({ policySubtype: null, knowledgeKind: "import", summary: "Prefer pnpm for installs." }), "advise"],
    ["human pitfall + signature", human({ type: "pitfall", policySubtype: null }), "advise"],
    ["auto pitfall + signature + correction + V10", auto(), "advise"],
    ["auto pitfall + signature + failure_resolution", auto({ knowledgeKind: "failure_resolution" }), "advise"],
    ["auto pitfall + signature + convention", auto({ knowledgeKind: "convention" }), "advise"],
    ["auto pitfall without signature", auto({ hasSignature: false, specificityOk: false }), "advise"],
    ["auto pitfall whose signature failed V10", auto({ specificityOk: false }), "advise"],
    ["auto workflow + signature + correction", auto({ type: "workflow" }), "advise"],
    ["auto policy + signature + correction", auto({ type: "policy" }), "advise"],
    ["auto decision", auto({ type: "decision", knowledgeKind: "decision" }), "advise"],
    ["auto architecture_constraint", auto({ type: "architecture_constraint" }), "advise"],
  ])("%s → %s", (_label, input, expected) => {
    expect(enforcementDefault(input)).toBe(expected);
  });

  test("config overrides the defaults", () => {
    const custom: Pick<HarnessConfig, "before_tool"> = {
      before_tool: { ...DEFAULT_CONFIG.before_tool, auto_enforcement: "advise", hard_policy: "deny" },
    };
    expect(enforcementDefault(auto({ config: custom }))).toBe("advise");
    expect(enforcementDefault(human({ config: custom }))).toBe("deny");
  });
});

describe("enforcementDefault: the silent-write birth (0.6.0-rc.2 design §3 rule 1)", () => {
  test("the default config is soft_deny for a silent write and advise for the plain auto pitfall", () => {
    expect(DEFAULT_CONFIG.before_tool.auto_enforcement_silent_write).toBe("soft_deny");
    expect(DEFAULT_CONFIG.before_tool.auto_enforcement).toBe("advise");
    expect(SILENT_WRITE_MIN_EVIDENCE).toBe(2);
  });

  test("positive: pitfall or policy, correction or failure_resolution, evidence ≥ 2, durable (or unknown) horizon", () => {
    expect(enforcementDefault(silentWrite())).toBe("soft_deny");
    expect(enforcementDefault(silentWrite({ type: "policy" }))).toBe("soft_deny");
    expect(enforcementDefault(silentWrite({ knowledgeKind: "failure_resolution" }))).toBe("soft_deny");
    expect(enforcementDefault(silentWrite({ evidenceScore: 3.5 }))).toBe("soft_deny");
    // An auto policy's subtype is not part of the rule (subtypes belong to the human defaults).
    expect(enforcementDefault(silentWrite({ type: "policy", policySubtype: "soft" }))).toBe("soft_deny");
    // Horizon null / omitted = unknown = durable (it is the precision gate, not the horizon, that keeps pre-023 rows down).
    expect(enforcementDefault(silentWrite({ horizon: null }))).toBe("soft_deny");
    expect(enforcementDefault(silentWrite({ horizon: undefined }))).toBe("soft_deny");
  });

  test.each<[string, EnforcementDefaultInput]>([
    ["noun-level signature", silentWrite({ signaturePrecision: "noun" })],
    ["null precision (a row from before migration 023)", silentWrite({ signaturePrecision: null })],
    ["precision not given", silentWrite({ signaturePrecision: undefined })],
    ["read side effect", silentWrite({ sideEffect: "read" })],
    ["null side effect", silentWrite({ sideEffect: null })],
    ["side effect not given", silentWrite({ sideEffect: undefined })],
    ["evidence 1", silentWrite({ evidenceScore: 1 })],
    ["evidence just under 2", silentWrite({ evidenceScore: 1.9 })],
    ["evidence not given (0)", silentWrite({ evidenceScore: undefined })],
    ["task horizon", silentWrite({ horizon: "task" })],
    ["convention kind", silentWrite({ knowledgeKind: "convention" })],
    ["decision kind", silentWrite({ knowledgeKind: "decision" })],
    ["null kind", silentWrite({ knowledgeKind: null })],
    ["no signature", silentWrite({ hasSignature: false, specificityOk: false })],
    ["signature failed V10", silentWrite({ specificityOk: false })],
    ["workflow", silentWrite({ type: "workflow" })],
    ["decision type", silentWrite({ type: "decision", knowledgeKind: "decision" })],
    ["architecture_constraint", silentWrite({ type: "architecture_constraint" })],
  ])("negative: %s → advise", (_label, input) => {
    expect(enforcementDefault(input)).toBe("advise");
  });

  test("human rows keep the human defaults whatever the rc.2 facts say", () => {
    const facts = { signaturePrecision: "mistake_exact", sideEffect: "write", horizon: "durable", evidenceScore: 5 } as const;
    expect(enforcementDefault(human(facts))).toBe("confirm");
    expect(enforcementDefault(human({ ...facts, policySubtype: "soft" }))).toBe("advise");
    expect(enforcementDefault(human({ ...facts, type: "pitfall", policySubtype: null }))).toBe("advise");
    expect(enforcementDefault(human({ ...facts, hasSignature: false, specificityOk: false }))).toBe("advise");
    expect(enforcementDefault(human({ ...facts, policySubtype: null, knowledgeKind: "import", summary: "Never commit .env files." }))).toBe("confirm");
    // The task-horizon gate belongs to the auto rules only.
    expect(enforcementDefault(human({ horizon: "task" }))).toBe("confirm");
  });

  test("before_tool.auto_enforcement_silent_write = advise turns rule 1 off; rule 2 (auto_enforcement, pitfall only) still applies", () => {
    const off: Pick<HarnessConfig, "before_tool"> = { before_tool: { ...DEFAULT_CONFIG.before_tool, auto_enforcement_silent_write: "advise" } };
    expect(enforcementDefault(silentWrite({ config: off }))).toBe("advise");
    expect(enforcementDefault(silentWrite({ config: off, type: "policy" }))).toBe("advise");
    const preAPrime: Pick<HarnessConfig, "before_tool"> = { before_tool: { ...DEFAULT_CONFIG.before_tool, auto_enforcement_silent_write: "advise", auto_enforcement: "soft_deny" } };
    expect(enforcementDefault(silentWrite({ config: preAPrime }))).toBe("soft_deny");
    expect(enforcementDefault(silentWrite({ config: preAPrime, type: "policy" }))).toBe("advise");
  });

  test("a task-horizon auto row never exceeds advise through the auto rules, even under the pre-A′ auto_enforcement = soft_deny", () => {
    const preAPrime: Pick<HarnessConfig, "before_tool"> = { before_tool: { ...DEFAULT_CONFIG.before_tool, auto_enforcement: "soft_deny" } };
    expect(enforcementDefault(auto({ config: preAPrime }))).toBe("soft_deny");
    expect(enforcementDefault(auto({ config: preAPrime, horizon: "task" }))).toBe("advise");
    expect(enforcementDefault(auto({ config: preAPrime, horizon: "durable" }))).toBe("soft_deny");
    expect(enforcementDefault(auto({ config: preAPrime, horizon: null }))).toBe("soft_deny");
    expect(enforcementDefault(silentWrite({ config: preAPrime, horizon: "task" }))).toBe("advise");
  });
});

describe("decideTier (§7.4)", () => {
  const NOW = "2026-11-08T00:00:00.000Z";
  // autonomy_level is pinned to "standard" here on purpose: the default is "full" since 0.6.0-rc.2, and these are the
  // review-gate assertions (proposals, informational types waiting). The nested describe below covers "full".
  function input(overrides: Partial<DecideTierInput> = {}, memory: Partial<DecideTierInput["memory"]> = {}): DecideTierInput {
    return {
      memory: {
        type: "pitfall",
        scopeGlob: "**/*",
        hasSignature: true,
        signatureTool: "bash",
        relevantTools: ["bash"],
        lifecycleTriggers: ["before_tool"],
        confidence: 0.85,
        authority: "auto",
        ...memory,
      },
      evidenceScore: 2,
      capsRemaining: { episode: 3, day: 10 },
      autonomyLevel: "standard",
      knowledgeKind: "correction",
      isReplacementRow: false,
      now: NOW,
      ...overrides,
    };
  }

  test("a correction pitfall with a signature and evidence 2 activates with a 30-day TTL", () => {
    expect(decideTier(input())).toEqual({
      status: "active",
      ttlExpiresAt: "2026-12-08T00:00:00.000Z",
      revalidateAfter: "2026-11-23T00:00:00.000Z",
    });
  });

  test("convention knowledge gets the 7-day TTL", () => {
    expect(decideTier(input({ knowledgeKind: "convention" }))).toEqual({
      status: "active",
      ttlExpiresAt: "2026-11-15T00:00:00.000Z",
      revalidateAfter: "2026-11-11T12:00:00.000Z",
    });
    expect(decideTier(input({ knowledgeKind: "failure_resolution" })).ttlExpiresAt).toBe("2026-12-08T00:00:00.000Z");
    expect(decideTier(input({ knowledgeKind: null })).ttlExpiresAt).toBe("2026-11-15T00:00:00.000Z");
  });

  const standardCases: Array<[string, DecideTierInput, Record<string, unknown>]> = [
    ["evidence below 2", input({ evidenceScore: 1 }), { status: "candidate", reason: "evidence" }],
    ["confidence below 0.7", input({}, { confidence: 0.69 }), { status: "candidate", reason: "confidence" }],
    ["episode cap exhausted", input({ capsRemaining: { episode: 0, day: 10 } }), { status: "candidate", reason: "cap" }],
    ["daily cap exhausted", input({ capsRemaining: { episode: 3, day: 0 } }), { status: "candidate", reason: "cap" }],
    ["replacement row", input({ isReplacementRow: true }), { status: "candidate", reason: "replacement" }],
    ["policy", input({}, { type: "policy" }), { status: "candidate", reason: "type", proposal: "activate_policy" }],
    ["policy even when autonomy is off", input({ autonomyLevel: "off" }, { type: "policy" }), { status: "candidate", reason: "type", proposal: "activate_policy" }],
    ["decision", input({}, { type: "decision", lifecycleTriggers: ["session_start"] }), { status: "candidate", reason: "type" }],
    ["architecture_constraint", input({}, { type: "architecture_constraint", lifecycleTriggers: ["before_model"] }), { status: "candidate", reason: "type" }],
    ["signature-less global pitfall", input({}, { hasSignature: false, signatureTool: null }), { status: "candidate", reason: "scope", proposal: "activate_global" }],
    ["signature-less global decision", input({}, { type: "decision", hasSignature: false, signatureTool: null, lifecycleTriggers: ["before_model"] }), { status: "candidate", reason: "scope", proposal: "activate_global" }],
    ["autonomy off", input({ autonomyLevel: "off" }), { status: "candidate", reason: "autonomy" }],
    ["autonomy shadow", input({ autonomyLevel: "shadow" }), { status: "candidate", reason: "autonomy", shadow: "active" }],
    ["shadow does not mask a real blocker", input({ autonomyLevel: "shadow", evidenceScore: 1 }), { status: "candidate", reason: "evidence" }],
    ["invalid scope", input({}, { scopeGlob: "/abs/**" }), { status: "candidate", reason: "scope" }],
    ["neither signature nor relevant tools", input({}, { hasSignature: false, signatureTool: null, relevantTools: null, scopeGlob: "src/**" }), { status: "candidate", reason: "trigger" }],
    ["workflow with before_tool only and no signature", input({}, { type: "workflow", hasSignature: false, signatureTool: null, scopeGlob: "src/**" }), { status: "candidate", reason: "trigger" }],
    ["signature tool not hooked, before_tool only", input({}, { signatureTool: "read" }), { status: "candidate", reason: "trigger" }],
    ["no triggers", input({}, { lifecycleTriggers: [] }), { status: "candidate", reason: "trigger" }],
    ["scanner unsafe", input({ scanSafe: false }), { status: "candidate", reason: "security" }],
  ];

  test.each(standardCases)("%s", (_label, tierInput, expected) => {
    expect(decideTier(tierInput)).toEqual(expected);
  });

  // The rc.2 / rc.3 inputs are optional; under standard they change nothing (the knowledge cap and the origin decision
  // marker are `full` concepts — "evidence below 2" stays `evidence` with the marker, the bar is the stored score alone).
  test.each(standardCases)("%s — unchanged with the rc.2 / rc.3 inputs present", (_label, tierInput, expected) => {
    expect(decideTier({ ...tierInput, knowledgeCapsRemaining: { day: 10 }, horizon: null })).toEqual(expected);
    expect(decideTier({ ...tierInput, knowledgeCapsRemaining: { day: 0 }, horizon: "durable" })).toEqual(expected);
    expect(decideTier({ ...tierInput, knowledgeCapsRemaining: { day: 10 }, horizon: "durable", originDecisionMarker: true })).toEqual(expected);
  });

  test("workflow rows activate through relevant_tools and a reachable trigger", () => {
    expect(
      decideTier(input({ knowledgeKind: "convention" }, { type: "workflow", hasSignature: false, signatureTool: null, scopeGlob: "src/**", lifecycleTriggers: ["before_model"] }))
    ).toMatchObject({ status: "active" });
    expect(decideTier(input({}, { hasSignature: false, signatureTool: null, scopeGlob: "src/**" }))).toMatchObject({ status: "active" });
  });

  test("isReachableTrigger", () => {
    expect(isReachableTrigger({ type: "pitfall", hasSignature: false, lifecycleTriggers: ["before_tool"] })).toBe(true);
    expect(isReachableTrigger({ type: "workflow", hasSignature: false, lifecycleTriggers: ["before_tool"] })).toBe(false);
    expect(isReachableTrigger({ type: "workflow", hasSignature: false, lifecycleTriggers: ["before_tool", "before_model"] })).toBe(true);
    expect(isReachableTrigger({ type: "workflow", hasSignature: true, signatureTool: "read|grep", lifecycleTriggers: ["before_tool"] })).toBe(false);
    expect(isReachableTrigger({ type: "workflow", hasSignature: true, signatureTool: "edit|read", lifecycleTriggers: ["before_tool"] })).toBe(true);
    expect(isReachableTrigger({ type: "workflow", hasSignature: true, signatureTool: "mcp:github/*", lifecycleTriggers: ["before_tool"] })).toBe(true);
    expect(isReachableTrigger({ type: "workflow", hasSignature: true, signatureTool: "*", lifecycleTriggers: ["before_tool"] })).toBe(true);
  });

  test("isReachableTrigger resolves tool globs exactly like the validator's V11 and the PreToolUse matcher", () => {
    const reaches = (glob: string) => isReachableTrigger({ type: "workflow", hasSignature: true, signatureTool: glob, lifecycleTriggers: ["before_tool"] });
    const viaValidator = (glob: string) => toolGlobFamilies(glob).some((family) => (PRE_TOOL_HOOKED_FAMILIES as readonly string[]).includes(family));
    // Prefix / infix / suffix globs that the runtime matcher resolves to a hooked family.
    for (const glob of ["wr*", "*sh", "ba*sh", "ba*", "b*", "e*|read", "bash*", "mcp", "mcp:server/*", "*"]) {
      expect(reaches(glob), glob).toBe(true);
      expect(viaValidator(glob), glob).toBe(true);
    }
    // Globs that only resolve to families the hook does not deliver (or to nothing at all).
    for (const glob of ["read|grep", "gr*", "re*", "*ob", "powershell", ""]) {
      expect(reaches(glob), glob).toBe(false);
      expect(viaValidator(glob), glob).toBe(false);
    }
    // The same signature therefore activates through decideTier instead of sticking as candidate(trigger).
    expect(decideTier(input({}, { signatureTool: "wr*" }))).toMatchObject({ status: "active" });
    expect(decideTier(input({}, { signatureTool: "gr*" }))).toEqual({ status: "candidate", reason: "trigger" });
  });

  test("baseTtlDays / tierTtlDays / addDays", () => {
    expect(baseTtlDays("correction")).toBe(30);
    expect(baseTtlDays("failure_resolution")).toBe(30);
    expect(baseTtlDays("convention")).toBe(7);
    expect(baseTtlDays("decision")).toBe(7);
    expect(baseTtlDays(null)).toBe(7);
    expect(addDays("2026-11-08T00:00:00.000Z", 1.5)).toBe("2026-11-09T12:00:00.000Z");
    // 0.6.0-rc.2: a task horizon beats everything, informational types get 30 days, the rest keep baseTtlDays(kind).
    expect(TASK_TTL_DAYS).toBe(7);
    expect(KNOWLEDGE_TTL_DAYS).toBe(30);
    expect(tierTtlDays("correction", "task", "pitfall")).toBe(7);
    expect(tierTtlDays("decision", "task", "decision")).toBe(7);
    expect(tierTtlDays("decision", "durable", "decision")).toBe(30);
    expect(tierTtlDays("decision", null, "architecture_constraint")).toBe(30);
    expect(tierTtlDays(null, undefined, "decision")).toBe(30);
    expect(tierTtlDays("convention", "durable", "architecture_constraint")).toBe(30);
    expect(tierTtlDays("correction", null, "pitfall")).toBe(30);
    expect(tierTtlDays("failure_resolution", "durable", "pitfall")).toBe(30);
    expect(tierTtlDays("convention", "durable", "workflow")).toBe(7);
    expect(tierTtlDays("convention", null, "policy")).toBe(7);
    expect(tierTtlDays(null, null, "pitfall")).toBe(7);
  });

  describe("autonomy_level full (0.6.0-rc.2 design §1): activation without the review gate", () => {
    function full(overrides: Partial<DecideTierInput> = {}, memory: Partial<DecideTierInput["memory"]> = {}): DecideTierInput {
      return input({ autonomyLevel: "full", knowledgeCapsRemaining: { day: 10 }, ...overrides }, memory);
    }
    /** A decision-marker fact: informational type, evidence 0, no signature, no tools, a session_start trigger. */
    function decision(overrides: Partial<DecideTierInput> = {}, memory: Partial<DecideTierInput["memory"]> = {}): DecideTierInput {
      return full(
        { evidenceScore: 0, knowledgeKind: "decision", ...overrides },
        { type: "decision", hasSignature: false, signatureTool: null, relevantTools: null, lifecycleTriggers: ["session_start"], ...memory }
      );
    }
    /** 0.6.0-rc.3 §1.1: a rule row born from a decision-only episode — evidence_score 0, the decision marker on its origin. */
    function marked(overrides: Partial<DecideTierInput> = {}, memory: Partial<DecideTierInput["memory"]> = {}): DecideTierInput {
      return full({ evidenceScore: 0, originDecisionMarker: true, ...overrides }, memory);
    }
    const ACTIVE_30 = { status: "active", ttlExpiresAt: "2026-12-08T00:00:00.000Z", revalidateAfter: "2026-11-23T00:00:00.000Z" };
    const ACTIVE_7 = { status: "active", ttlExpiresAt: "2026-11-15T00:00:00.000Z", revalidateAfter: "2026-11-11T12:00:00.000Z" };

    test("full is the default level; the review-gate assertions above pin standard explicitly", () => {
      expect(DEFAULT_CONFIG.autonomy_level).toBe("full");
      expect(input().autonomyLevel).toBe("standard");
    });

    test("decision / architecture_constraint activate with evidence 0 and a 30-day TTL when the knowledge cap allows", () => {
      expect(decideTier(decision())).toEqual(ACTIVE_30);
      expect(decideTier(decision({}, { type: "architecture_constraint", lifecycleTriggers: ["before_model"], scopeGlob: "src/**" }))).toEqual(ACTIVE_30);
      // Neither evidence, trigger reachability nor the pitfall activation caps gate them: the decision marker is the evidence.
      expect(decideTier(decision({ capsRemaining: { episode: 0, day: 0 } }, { lifecycleTriggers: ["session_start"] }))).toEqual(ACTIVE_30);
      // … but a row with no lifecycle trigger at all could never surface, so it stays a candidate.
      expect(decideTier(decision({}, { lifecycleTriggers: [] }))).toEqual({ status: "candidate", reason: "trigger" });
      expect(decideTier(decision({ knowledgeCapsRemaining: { day: 1 } }))).toEqual(ACTIVE_30);
    });

    test("knowledge_cap: an exhausted budget, or none given (a caller that does not track it cannot activate informational rows)", () => {
      expect(decideTier(decision({ knowledgeCapsRemaining: { day: 0 } }))).toEqual({ status: "candidate", reason: "knowledge_cap" });
      expect(decideTier(decision({ knowledgeCapsRemaining: { day: -1 } }, { type: "architecture_constraint" }))).toEqual({ status: "candidate", reason: "knowledge_cap" });
      expect(decideTier(decision({ knowledgeCapsRemaining: undefined }))).toEqual({ status: "candidate", reason: "knowledge_cap" });
      // The pitfall caps are not consulted for informational rows, and the knowledge cap is not consulted for pitfalls.
      expect(decideTier(decision({ knowledgeCapsRemaining: { day: 0 }, capsRemaining: { episode: 3, day: 10 } }))).toEqual({ status: "candidate", reason: "knowledge_cap" });
      expect(decideTier(full({ knowledgeCapsRemaining: { day: 0 } }))).toEqual(ACTIVE_30);
      // Under standard the budget changes nothing: informational rows wait for review there.
      expect(decideTier(input({ knowledgeCapsRemaining: { day: 10 }, evidenceScore: 0, knowledgeKind: "decision" }, { type: "decision", lifecycleTriggers: ["session_start"] }))).toEqual({ status: "candidate", reason: "type" });
    });

    test("a policy activates at advise without a proposal; a repo-wide row without a signature activates", () => {
      expect(decideTier(full({}, { type: "policy" }))).toEqual(ACTIVE_30);
      expect(decideTier(full({ knowledgeKind: "convention" }, { type: "policy", hasSignature: false, signatureTool: null }))).toEqual(ACTIVE_7);
      expect(decideTier(full({}, { hasSignature: false, signatureTool: null }))).toEqual(ACTIVE_30);
      expect(decideTier(full({ knowledgeKind: "convention" }, { type: "workflow", hasSignature: false, signatureTool: null, lifecycleTriggers: ["before_model"] }))).toEqual(ACTIVE_7);
      expect(decideTier(decision({}, { scopeGlob: "**/*" }))).toEqual(ACTIVE_30);
      // The same rows under standard: the proposals of the review gate.
      expect(decideTier(input({}, { type: "policy" }))).toEqual({ status: "candidate", reason: "type", proposal: "activate_policy" });
      expect(decideTier(input({}, { hasSignature: false, signatureTool: null }))).toEqual({ status: "candidate", reason: "scope", proposal: "activate_global" });
    });

    test("a pitfall activates at evidence 1 under full but not under standard; evidence 0 stays candidate under both", () => {
      expect(FULL_ACTIVATION_MIN_EVIDENCE).toBe(1);
      expect(ACTIVATION_MIN_EVIDENCE).toBe(2);
      expect(decideTier(full({ evidenceScore: 1 }))).toEqual(ACTIVE_30);
      expect(decideTier(input({ evidenceScore: 1 }))).toEqual({ status: "candidate", reason: "evidence" });
      expect(decideTier(full({ evidenceScore: 0 }))).toEqual({ status: "candidate", reason: "evidence" });
      expect(decideTier(full({ evidenceScore: 0.5 }))).toEqual({ status: "candidate", reason: "evidence" });
      expect(decideTier(input({ evidenceScore: 0 }))).toEqual({ status: "candidate", reason: "evidence" });
      expect(decideTier(full({ evidenceScore: 1, knowledgeKind: "convention" }, { type: "workflow", hasSignature: false, signatureTool: null, lifecycleTriggers: ["before_model"] }))).toEqual(ACTIVE_7);
    });

    test("0.6.0-rc.3 §1.1: a decision marker on the origin episode counts FULL_DECISION_MARKER_EVIDENCE toward the full bar, and nowhere else", () => {
      expect(FULL_DECISION_MARKER_EVIDENCE).toBe(1);
      // evidence_score 0 + the marker reaches the bar for every rule type; the TTL is still the kind's (correction 30 d, convention 7 d).
      expect(decideTier(marked())).toEqual(ACTIVE_30);
      expect(decideTier(marked({ knowledgeKind: "convention" }))).toEqual(ACTIVE_7);
      expect(decideTier(marked({ knowledgeKind: "convention" }, { type: "policy" }))).toEqual(ACTIVE_7);
      expect(
        decideTier(marked({ knowledgeKind: "convention" }, { type: "workflow", hasSignature: false, signatureTool: null, lifecycleTriggers: ["before_model"] }))
      ).toEqual(ACTIVE_7);
      // Omitted and explicit false are the rc.2 answers: a boolean marker, not a weight that could be passed as a number.
      expect(decideTier(full({ evidenceScore: 0 }))).toEqual({ status: "candidate", reason: "evidence" });
      expect(decideTier(full({ evidenceScore: 0, originDecisionMarker: false }))).toEqual({ status: "candidate", reason: "evidence" });
      // Informational rows never had an evidence requirement: the marker does not bypass their knowledge cap.
      expect(decideTier(decision({ originDecisionMarker: true }))).toEqual(ACTIVE_30);
      expect(decideTier(decision({ originDecisionMarker: true, knowledgeCapsRemaining: { day: 0 } }))).toEqual({
        status: "candidate",
        reason: "knowledge_cap",
      });
      // Under standard the bar stays evidence_score ≥ 2 whatever the origin episode carried: 0 and 1 both stay candidate.
      expect(decideTier(input({ evidenceScore: 0, originDecisionMarker: true }))).toEqual({ status: "candidate", reason: "evidence" });
      expect(decideTier(input({ evidenceScore: 1, originDecisionMarker: true }))).toEqual({ status: "candidate", reason: "evidence" });
    });

    test.each<[string, DecideTierInput, Record<string, unknown>]>([
      ["replacement row", full({ isReplacementRow: true }), { status: "candidate", reason: "replacement" }],
      ["replacement decision", decision({ isReplacementRow: true }), { status: "candidate", reason: "replacement" }],
      ["invalid scope", full({}, { scopeGlob: "/abs/**" }), { status: "candidate", reason: "scope" }],
      ["invalid scope on a decision", decision({}, { scopeGlob: "../x/**" }), { status: "candidate", reason: "scope" }],
      ["scanner unsafe", full({ scanSafe: false }), { status: "candidate", reason: "security" }],
      ["scanner unsafe decision", decision({ scanSafe: false }), { status: "candidate", reason: "security" }],
      ["confidence below 0.7", full({}, { confidence: 0.69 }), { status: "candidate", reason: "confidence" }],
      ["confidence below 0.7 on a decision", decision({}, { confidence: 0.69 }), { status: "candidate", reason: "confidence" }],
      ["episode cap exhausted", full({ capsRemaining: { episode: 0, day: 10 } }), { status: "candidate", reason: "cap" }],
      ["daily cap exhausted", full({ capsRemaining: { episode: 3, day: 0 } }), { status: "candidate", reason: "cap" }],
      ["a policy counts against the activation caps", full({ capsRemaining: { episode: 3, day: 0 } }, { type: "policy" }), { status: "candidate", reason: "cap" }],
      ["neither signature nor relevant tools", full({}, { hasSignature: false, signatureTool: null, relevantTools: null }), { status: "candidate", reason: "trigger" }],
      ["policy with neither signature nor relevant tools", full({}, { type: "policy", hasSignature: false, signatureTool: null, relevantTools: null }), { status: "candidate", reason: "trigger" }],
      ["signature tool not hooked, before_tool only", full({}, { signatureTool: "read" }), { status: "candidate", reason: "trigger" }],
      ["workflow with before_tool only and no signature", full({}, { type: "workflow", hasSignature: false, signatureTool: null }), { status: "candidate", reason: "trigger" }],
      ["no triggers", full({}, { lifecycleTriggers: [] }), { status: "candidate", reason: "trigger" }],
      // 0.6.0-rc.3 §1.1: with evidence 0 the origin decision marker clears the evidence step and nothing else.
      ["replacement row with the origin marker", marked({ isReplacementRow: true }), { status: "candidate", reason: "replacement" }],
      ["invalid scope with the origin marker", marked({}, { scopeGlob: "/abs/**" }), { status: "candidate", reason: "scope" }],
      ["scanner unsafe with the origin marker", marked({ scanSafe: false }), { status: "candidate", reason: "security" }],
      ["confidence below 0.7 with the origin marker", marked({}, { confidence: 0.69 }), { status: "candidate", reason: "confidence" }],
      [
        "neither signature nor relevant tools with the origin marker",
        marked({}, { hasSignature: false, signatureTool: null, relevantTools: null }),
        { status: "candidate", reason: "trigger" },
      ],
      ["signature tool not hooked with the origin marker", marked({}, { signatureTool: "read" }), { status: "candidate", reason: "trigger" }],
      ["no triggers with the origin marker", marked({}, { lifecycleTriggers: [] }), { status: "candidate", reason: "trigger" }],
      ["episode cap exhausted with the origin marker", marked({ capsRemaining: { episode: 0, day: 10 } }), { status: "candidate", reason: "cap" }],
      ["daily cap exhausted with the origin marker", marked({ capsRemaining: { episode: 3, day: 0 } }), { status: "candidate", reason: "cap" }],
    ])("still candidate under full: %s", (_label, tierInput, expected) => {
      expect(decideTier(tierInput)).toEqual(expected);
    });

    test("order: scope → scanner → confidence → the type-specific checks", () => {
      expect(decideTier(full({ scanSafe: false, evidenceScore: 0 }, { scopeGlob: "/abs/**", confidence: 0.1 }))).toEqual({ status: "candidate", reason: "scope" });
      expect(decideTier(full({ scanSafe: false, evidenceScore: 0 }, { confidence: 0.1 }))).toEqual({ status: "candidate", reason: "security" });
      expect(decideTier(full({ evidenceScore: 0, capsRemaining: { episode: 0, day: 0 } }, { confidence: 0.1, lifecycleTriggers: [] }))).toEqual({ status: "candidate", reason: "confidence" });
      expect(decideTier(full({ evidenceScore: 0, capsRemaining: { episode: 0, day: 0 } }, { lifecycleTriggers: [] }))).toEqual({ status: "candidate", reason: "trigger" });
      expect(decideTier(full({ evidenceScore: 0, capsRemaining: { episode: 0, day: 0 } }))).toEqual({ status: "candidate", reason: "evidence" });
      expect(decideTier(full({ capsRemaining: { episode: 0, day: 0 } }))).toEqual({ status: "candidate", reason: "cap" });
      expect(decideTier(decision({ knowledgeCapsRemaining: { day: 0 }, scanSafe: false }, { confidence: 0.1 }))).toEqual({ status: "candidate", reason: "security" });
      expect(decideTier(decision({ knowledgeCapsRemaining: { day: 0 } }, { confidence: 0.1 }))).toEqual({ status: "candidate", reason: "confidence" });
      // 0.6.0-rc.3 §1.1: the same order with evidence 0 and the origin marker — the marker moves only the evidence step,
      // so the row that was `evidence` above is `cap` here and active once the caps allow.
      expect(decideTier(marked({ scanSafe: false }, { scopeGlob: "/abs/**", confidence: 0.1 }))).toEqual({ status: "candidate", reason: "scope" });
      expect(decideTier(marked({ scanSafe: false }, { confidence: 0.1 }))).toEqual({ status: "candidate", reason: "security" });
      expect(decideTier(marked({ capsRemaining: { episode: 0, day: 0 } }, { confidence: 0.1, lifecycleTriggers: [] }))).toEqual({
        status: "candidate",
        reason: "confidence",
      });
      expect(decideTier(marked({ capsRemaining: { episode: 0, day: 0 } }, { lifecycleTriggers: [] }))).toEqual({ status: "candidate", reason: "trigger" });
      expect(decideTier(marked({ capsRemaining: { episode: 0, day: 0 } }))).toEqual({ status: "candidate", reason: "cap" });
      expect(decideTier(marked())).toEqual(ACTIVE_30);
    });

    test("the full path never opens a proposal, never reports type / autonomy and never reports shadow", () => {
      const rows = [
        full({}, { type: "policy" }),
        full({}, { hasSignature: false, signatureTool: null }),
        decision(),
        decision({ knowledgeCapsRemaining: { day: 0 } }),
        full({ evidenceScore: 0 }),
        full({ scanSafe: false }),
        full({}, { lifecycleTriggers: [] }),
        marked(),
        marked({ capsRemaining: { episode: 0, day: 0 } }),
      ];
      for (const tierInput of rows) {
        const result = decideTier(tierInput);
        expect(result).not.toHaveProperty("proposal");
        expect(result).not.toHaveProperty("shadow");
        expect(result.reason).not.toBe("type");
        expect(result.reason).not.toBe("autonomy");
      }
    });

    test("TTL by horizon and type: task 7 days whatever the type, decision / architecture_constraint 30 days, else baseTtlDays(kind)", () => {
      expect(decideTier(full({ horizon: "task" }))).toEqual(ACTIVE_7);
      expect(decideTier(decision({ horizon: "task" }))).toEqual(ACTIVE_7);
      expect(decideTier(decision({ horizon: "task" }, { type: "architecture_constraint" }))).toEqual(ACTIVE_7);
      expect(decideTier(decision({ horizon: "durable" }))).toEqual(ACTIVE_30);
      expect(decideTier(decision({ horizon: null }))).toEqual(ACTIVE_30);
      expect(decideTier(decision({ knowledgeKind: "convention" }))).toEqual(ACTIVE_30);
      expect(decideTier(full({ horizon: "durable" }))).toEqual(ACTIVE_30);
      expect(decideTier(full({ horizon: null, knowledgeKind: "failure_resolution" }))).toEqual(ACTIVE_30);
      expect(decideTier(full({ knowledgeKind: "convention" }))).toEqual(ACTIVE_7);
      expect(decideTier(full({ knowledgeKind: null }, { type: "policy" }))).toEqual(ACTIVE_7);
      // Design §2 is level-agnostic: a task-horizon pitfall gets 7 days under standard too; with the horizon unknown
      // standard keeps its old TTL.
      expect(decideTier(input({ horizon: "task" }))).toEqual(ACTIVE_7);
      expect(decideTier(input({ horizon: "durable" }))).toEqual(ACTIVE_30);
      expect(decideTier(input({ horizon: null }))).toEqual(ACTIVE_30);
    });

    test("shadow and off keep today's meaning: shadow is a dry run of standard, off never activates", () => {
      expect(decideTier(input({ autonomyLevel: "shadow", knowledgeCapsRemaining: { day: 10 } }))).toEqual({ status: "candidate", reason: "autonomy", shadow: "active" });
      expect(decideTier(input({ autonomyLevel: "shadow", knowledgeCapsRemaining: { day: 10 }, evidenceScore: 1 }))).toEqual({ status: "candidate", reason: "evidence" });
      expect(decideTier(input({ autonomyLevel: "shadow", knowledgeCapsRemaining: { day: 10 }, evidenceScore: 0, knowledgeKind: "decision" }, { type: "decision", lifecycleTriggers: ["session_start"] }))).toEqual({ status: "candidate", reason: "type" });
      expect(decideTier(input({ autonomyLevel: "off", knowledgeCapsRemaining: { day: 10 } }))).toEqual({ status: "candidate", reason: "autonomy" });
      expect(decideTier(input({ autonomyLevel: "off", knowledgeCapsRemaining: { day: 10 } }, { type: "policy" }))).toEqual({ status: "candidate", reason: "type", proposal: "activate_policy" });
      // 0.6.0-rc.3 §1.1: the origin marker is a `full` input — shadow reports the real blocker (never `shadow: active`), off stays off.
      expect(decideTier(input({ autonomyLevel: "shadow", evidenceScore: 0, originDecisionMarker: true }))).toEqual({ status: "candidate", reason: "evidence" });
      expect(decideTier(input({ autonomyLevel: "shadow", evidenceScore: 1, originDecisionMarker: true }))).toEqual({ status: "candidate", reason: "evidence" });
      expect(decideTier(input({ autonomyLevel: "off", evidenceScore: 0, originDecisionMarker: true }))).toEqual({ status: "candidate", reason: "autonomy" });
    });
  });
});
