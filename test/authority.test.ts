import { describe, expect, test } from "vitest";

import { toolGlobFamilies } from "../src/activation/tool-vocabulary";
import { DEFAULT_CONFIG, type HarnessConfig } from "../src/core/config";
import { PRE_TOOL_HOOKED_FAMILIES } from "../src/core/vocabulary";
import {
  addDays,
  baseTtlDays,
  decideTier,
  enforcementDefault,
  isReachableTrigger,
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

describe("decideTier (§7.4)", () => {
  const NOW = "2026-11-08T00:00:00.000Z";
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

  test.each<[string, DecideTierInput, Record<string, unknown>]>([
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
  ])("%s", (_label, tierInput, expected) => {
    expect(decideTier(tierInput)).toEqual(expected);
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

  test("baseTtlDays / addDays", () => {
    expect(baseTtlDays("correction")).toBe(30);
    expect(baseTtlDays("failure_resolution")).toBe(30);
    expect(baseTtlDays("convention")).toBe(7);
    expect(baseTtlDays("decision")).toBe(7);
    expect(baseTtlDays(null)).toBe(7);
    expect(addDays("2026-11-08T00:00:00.000Z", 1.5)).toBe("2026-11-09T12:00:00.000Z");
  });
});
