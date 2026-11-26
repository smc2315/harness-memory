import { describe, expect, test } from "vitest";

import { BARE_CORRECTION_WEIGHT, EVIDENCE_WEIGHT_CAP, EVIDENCE_WEIGHTS, computeEvidenceWeight } from "../src/core/episode-types";
import { episodeId } from "../src/core/ids";
import type { LedgerLine } from "../src/core/ledger-types";
import {
  buildEpisodeDescriptor,
  classifyFiredOutcome,
  isEligibleForExtraction,
  renderContextRef,
  type BuildEpisodeInput,
} from "../src/dream/episode";
import type { OffsetLedgerLine } from "../src/dream/ledger";
import { assistantLine, firedLine, loadLedgerFixture, promptLine, toolFailLine, toolOkLine } from "./helpers/ledger-fixture";

const NOW = "2026-11-08T23:59:59.000Z";

function turnLines(fixture: string, turnKey: string): OffsetLedgerLine[] {
  return loadLedgerFixture(fixture).lines.filter((line) => line.turn_key === turnKey);
}

function build(lines: readonly LedgerLine[], overrides: Partial<BuildEpisodeInput> = {}) {
  const offsets = lines as readonly OffsetLedgerLine[];
  const first = offsets[0];
  const last = offsets[offsets.length - 1];
  return buildEpisodeDescriptor({
    host: "claude-code",
    sessionId: "session-1",
    sessionKey: "k1",
    turnKey: lines[0]?.turn_key ?? "t1",
    segment: 0,
    lines,
    byteStart: typeof first?.offset === "number" ? first.offset : 0,
    byteEnd: typeof last?.offset === "number" ? last.offset + last.length : 0,
    ledgerFileName: "claude-code-k1.jsonl",
    closeReason: "stop",
    now: NOW,
    ...overrides,
  });
}

describe("buildEpisodeDescriptor", () => {
  test("s01: a turn with only a correction prompt has flags.correction=1 and evidence_weight 1 — a bare cue, no corrected turn (rc.2 §5)", () => {
    const lines = turnLines("s01-correction-only.jsonl", "p1");
    const descriptor = build(lines);
    expect(descriptor.flags).toEqual({ correction: 1 });
    expect(descriptor.evidence_weight).toBe(BARE_CORRECTION_WEIGHT);
    expect(descriptor.evidence_weight).toBe(1);
    expect(descriptor.tools).toEqual([]);
    expect(descriptor.scope_refs).toEqual([]);
    expect(descriptor.failure_signatures).toEqual([]);
    expect(descriptor.fired).toEqual([]);
    expect(descriptor.event_count).toBe(2);
    expect(descriptor.prompt_text).toContain("pnpm test");
    expect(descriptor.last_assistant_message).toContain("pnpm test");
    expect(descriptor.id).toBe(episodeId("claude-code", "session-1", "p1", 0));
    expect(descriptor.ledger_ref).toBe(`ledger/claude-code-k1.jsonl#${lines[0]!.offset}-${lines[1]!.offset + lines[1]!.length}`);
    expect(descriptor.started_at).toBe("2026-11-08T10:00:01.000Z");
    expect(descriptor.closed_at).toBe(NOW);
    expect(descriptor.correction_for).toBeNull();
    expect(descriptor.context_ref).toBeNull();
    expect(descriptor.schema).toBe("episode.v1");
    expect(isEligibleForExtraction(descriptor)).toEqual({ eligible: true, reason: "evidence" });
  });

  test("s02: failure resolved by the pnpm equivalent, not by the ls in between", () => {
    const descriptor = build(turnLines("s02-fail-then-resolve.jsonl", "p2"));
    expect(descriptor.failure_signatures).toEqual([
      { sig: "bash|exit_1|pm test", class: "exit_1", tool: "bash", scope_ref: null, program_token: "pm test", failed_seq: 2002, resolved_seq: 2004 },
    ]);
    expect(descriptor.flags).toEqual({ failure: 1, resolution: 1 });
    expect(descriptor.evidence_weight).toBe(2);
    expect(descriptor.tools).toEqual(["bash"]);
    expect(descriptor.event_count).toBe(5);
  });

  test("s07: PowerShell failure resolved after an edit; scope refs and tools collected", () => {
    const descriptor = build(turnLines("s07-powershell-fail.jsonl", "p7"));
    expect(descriptor.failure_signatures[0]).toMatchObject({ sig: "bash|exit_1|pm build", failed_seq: 7002, resolved_seq: 7004 });
    expect(descriptor.scope_refs).toEqual(["src/index.ts"]);
    expect(descriptor.tools).toEqual(["bash", "edit"]);
    expect(descriptor.evidence_weight).toBe(2);
  });

  test("an unresolved failure weighs 1; bare correction + remember + three resolutions are capped at 10", () => {
    const bare = build([promptLine("run it", { seq: 1 }), toolFailLine("npm test", "Exit code 1", { seq: 2, program_token: "pm test", failure_class: "exit_1" })]);
    expect(bare.flags).toEqual({ failure: 1 });
    expect(bare.evidence_weight).toBe(1);

    const heavy = build([
      promptLine("no, remember to use pnpm", { seq: 1, correction: 1, remember: 1 }),
      toolFailLine("npm test", "Exit code 1", { seq: 2, program_token: "pm test", failure_class: "exit_1" }),
      toolOkLine("pnpm test", { seq: 3, program_token: "pm test" }),
      toolFailLine("npm run lint", "Exit code 1", { seq: 4, program_token: "pm lint", failure_class: "exit_1" }),
      toolOkLine("pnpm lint", { seq: 5, program_token: "pm lint" }),
      toolFailLine("npm run build", "Exit code 1", { seq: 6, program_token: "pm build", failure_class: "exit_1" }),
      toolOkLine("pnpm build", { seq: 7, program_token: "pm build" }),
    ]);
    expect(heavy.flags).toEqual({ correction: 1, remember: 1, failure: 1, resolution: 1 });
    expect(heavy.evidence_weight).toBe(EVIDENCE_WEIGHT_CAP);
  });

  test("flags are re-derived from the text when the prompt line flags are 0; the regex alone is a bare cue (1)", () => {
    const descriptor = build([promptLine("don't do that, use pnpm", { seq: 1 })]);
    expect(descriptor.flags.correction).toBe(1);
    expect(descriptor.evidence_weight).toBe(1);
  });

  test("a decision marker in the last assistant message makes a weight-0 turn eligible", () => {
    const descriptor = build([promptLine("which runner?", { seq: 1 }), assistantLine("We'll use vitest for all packages.", { seq: 2 })]);
    expect(descriptor.flags).toEqual({ decision: 1 });
    expect(descriptor.evidence_weight).toBe(0);
    expect(isEligibleForExtraction(descriptor)).toEqual({ eligible: true, reason: "decision" });
  });

  test("a read-only turn has no signal", () => {
    const descriptor = build([promptLine("show me the config", { seq: 1 }), toolOkLine("cat package.json", { seq: 2, scope_refs: ["package.json"] }), assistantLine("Here it is.", { seq: 3 })]);
    expect(descriptor.evidence_weight).toBe(0);
    expect(descriptor.flags).toEqual({});
    expect(isEligibleForExtraction(descriptor)).toEqual({ eligible: false, reason: "no_signal" });
    expect(isEligibleForExtraction({ host: "import", evidence_weight: 0, flags: {}, close_reason: "import", event_count: 1 })).toEqual({ eligible: true, reason: "import" });
  });

  test("subagent lines are excluded unless includeAgentLines is set", () => {
    const lines = [promptLine("go", { seq: 1 }), toolOkLine("src/sub.ts", { seq: 2, tool: "edit", scope_refs: ["src/sub.ts"], agent_id: "agent-1" }), assistantLine("done", { seq: 3 })];
    const excluded = build(lines);
    expect(excluded.tools).toEqual([]);
    expect(excluded.scope_refs).toEqual([]);
    expect(excluded.event_count).toBe(2);
    const included = build(lines, { includeAgentLines: true });
    expect(included.tools).toEqual(["edit"]);
    expect(included.event_count).toBe(3);
  });

  test("correction_for carries the corrected episode's tool lines as uncitable context, and only then does the correction weigh 2", () => {
    const corrected = turnLines("s02-fail-then-resolve.jsonl", "p2");
    const lines = turnLines("s01-correction-only.jsonl", "p1");
    const descriptor = build(lines, { correctionFor: "episode-prev", contextLines: corrected });
    expect(descriptor.correction_for).toBe("episode-prev");
    expect(descriptor.context_ref).toContain("(prev) tool_fail bash(bash): npm test — exit_1:");
    expect(descriptor.context_ref).toContain("(prev) tool_ok bash(bash): pnpm test — resolves bash|exit_1|pm test");
    expect(descriptor.context_ref).not.toContain("e2002");
    expect(descriptor.flags.correction).toBe(1);
    // rc.2 §5: a correction of a previous turn that ran tools is the full correction signal.
    expect(descriptor.evidence_weight).toBe(EVIDENCE_WEIGHTS.correction);

    expect(build(lines, { contextLines: corrected }).context_ref).toBeNull();
    // Context without correction_for is not a correction of that turn: bare cue.
    expect(build(lines, { contextLines: corrected }).evidence_weight).toBe(1);
    // A pre-rendered context (import / replay) stands for the corrected turn's tool lines.
    const prerendered = build(lines, { correctionFor: "episode-prev", contextRef: "pre-rendered" });
    expect(prerendered.context_ref).toBe("pre-rendered");
    expect(prerendered.evidence_weight).toBe(2);
    // correction_for whose corrected turn had no tool line (or whose lines are unknown) stays a bare cue.
    expect(build(lines, { correctionFor: "episode-prev", contextLines: [promptLine("earlier", { seq: 1 }), assistantLine("talk only", { seq: 2 })] }).evidence_weight).toBe(1);
    expect(build(lines, { correctionFor: "episode-prev", contextLines: null }).evidence_weight).toBe(1);
    expect(build(lines, { correctionFor: "episode-prev" }).evidence_weight).toBe(1);
  });

  test("scope refs are unioned in first-appearance order and capped at 50", () => {
    const lines: LedgerLine[] = [promptLine("edit everything", { seq: 1 })];
    for (let i = 0; i < 70; i += 1) {
      lines.push(toolOkLine(`src/f${i}.ts`, { seq: 2 + i, tool: "edit", scope_refs: [`src/f${i}.ts`, "src/shared.ts"] }));
    }
    const descriptor = build(lines);
    expect(descriptor.scope_refs).toHaveLength(50);
    expect(descriptor.scope_refs.slice(0, 3)).toEqual(["src/f0.ts", "src/shared.ts", "src/f1.ts"]);
  });

  test("the same signature failing twice is one entry; a failure after a resolution is a new entry", () => {
    const twice = build([
      promptLine("x", { seq: 1 }),
      toolFailLine("npm test", "Exit code 1", { seq: 2, program_token: "pm test", failure_class: "exit_1" }),
      toolFailLine("npm test", "Exit code 1", { seq: 3, program_token: "pm test", failure_class: "exit_1" }),
      toolOkLine("pnpm test", { seq: 4, program_token: "pm test" }),
    ]);
    expect(twice.failure_signatures).toHaveLength(1);
    expect(twice.failure_signatures[0]).toMatchObject({ failed_seq: 2, resolved_seq: 4 });

    const regression = build([
      promptLine("x", { seq: 1 }),
      toolFailLine("npm test", "Exit code 1", { seq: 2, program_token: "pm test", failure_class: "exit_1" }),
      toolOkLine("npm test", { seq: 3, program_token: "pm test" }),
      toolFailLine("npm test", "Exit code 1", { seq: 4, program_token: "pm test", failure_class: "exit_1" }),
    ]);
    expect(regression.failure_signatures.map((entry) => [entry.failed_seq, entry.resolved_seq])).toEqual([
      [2, 3],
      [4, null],
    ]);
    expect(regression.evidence_weight).toBe(3);
  });

  test("ledgerRef override for import episodes", () => {
    const descriptor = build([promptLine("- Never commit .env files", { seq: 1, turn_key: "import-1" })], {
      host: "import",
      ledgerRef: "import:docs/CLAUDE.md",
      closeReason: "import",
    });
    expect(descriptor.ledger_ref).toBe("import:docs/CLAUDE.md");
    expect(descriptor.close_reason).toBe("import");
  });
});

describe("computeEvidenceWeight (rc.2 §5)", () => {
  test("the correction flag adds 2 only when the correction references a tool-bearing previous turn, else 1", () => {
    expect(computeEvidenceWeight({ correction: 1 }, [])).toBe(1);
    expect(computeEvidenceWeight({ correction: 1 }, [], {})).toBe(1);
    expect(computeEvidenceWeight({ correction: 1 }, [], { correctionReferencesPreviousTurn: false })).toBe(1);
    expect(computeEvidenceWeight({ correction: 1 }, [], { correctionReferencesPreviousTurn: true })).toBe(2);
    // The option only concerns the correction flag: remember and failures are unchanged.
    expect(computeEvidenceWeight({ remember: 1 }, [{ resolved_seq: null }], { correctionReferencesPreviousTurn: true })).toBe(4);
    expect(computeEvidenceWeight({ correction: 1, remember: 1 }, [{ resolved_seq: 5 }])).toBe(6);
    expect(computeEvidenceWeight({ correction: 1, remember: 1 }, [{ resolved_seq: 5 }], { correctionReferencesPreviousTurn: true })).toBe(7);
  });
});

describe("isEligibleForExtraction (§5.3, rc.2 §5 interrupted closes)", () => {
  const corrected = turnLines("s02-fail-then-resolve.jsonl", "p2");

  test("an interrupted close with the prompt plus at most one event is no_signal whatever its flags", () => {
    const cueOnly = build([promptLine("no, don't do that", { seq: 1, correction: 1 })], { closeReason: "interrupted" });
    expect(cueOnly.event_count).toBe(1);
    expect(cueOnly.flags).toEqual({ correction: 1 });
    expect(cueOnly.evidence_weight).toBe(1);
    expect(isEligibleForExtraction(cueOnly)).toEqual({ eligible: false, reason: "no_signal" });

    const promptAndFailure = build([promptLine("run the build", { seq: 1 }), toolFailLine("npm run build", "Exit code 1", { seq: 2, program_token: "pm build", failure_class: "exit_1" })], { closeReason: "interrupted" });
    expect(promptAndFailure.event_count).toBe(2);
    expect(promptAndFailure.evidence_weight).toBe(1);
    expect(isEligibleForExtraction(promptAndFailure)).toEqual({ eligible: false, reason: "no_signal" });

    // Even a full correction of a tool-bearing turn, or a remember cue, is noise when the user interrupted at once.
    const fullCorrection = build([promptLine("use pnpm instead", { seq: 1, correction: 1, remember: 1 })], { closeReason: "interrupted", correctionFor: "episode-prev", contextLines: corrected });
    expect(fullCorrection.evidence_weight).toBe(5);
    expect(isEligibleForExtraction(fullCorrection)).toEqual({ eligible: false, reason: "no_signal" });
    const decision = build([promptLine("which runner?", { seq: 1 }), assistantLine("We'll use vitest for all packages.", { seq: 2 })], { closeReason: "interrupted" });
    expect(decision.flags).toEqual({ decision: 1 });
    expect(isEligibleForExtraction(decision)).toEqual({ eligible: false, reason: "no_signal" });
  });

  test("an interrupted close with three or more events is judged as before", () => {
    const lines = [
      promptLine("run the build", { seq: 1 }),
      toolFailLine("npm run build", "Exit code 1", { seq: 2, program_token: "pm build", failure_class: "exit_1" }),
      assistantLine("Investigating the failure.", { seq: 3 }),
    ];
    const withFailure = build(lines, { closeReason: "interrupted" });
    expect(withFailure.event_count).toBe(3);
    expect(isEligibleForExtraction(withFailure)).toEqual({ eligible: true, reason: "evidence" });

    const readOnly = build([promptLine("show me the config", { seq: 1 }), toolOkLine("cat package.json", { seq: 2 }), assistantLine("Here it is.", { seq: 3 })], { closeReason: "interrupted" });
    expect(isEligibleForExtraction(readOnly)).toEqual({ eligible: false, reason: "no_signal" });
    const decided = build([promptLine("which runner?", { seq: 1 }), toolOkLine("cat package.json", { seq: 2 }), assistantLine("We'll use vitest for all packages.", { seq: 3 })], { closeReason: "interrupted" });
    expect(isEligibleForExtraction(decided)).toEqual({ eligible: true, reason: "decision" });
  });

  test("a stop (or any other close) with a single prompt line is unchanged: a bare cue is still evidence", () => {
    const cueOnly = build([promptLine("no, don't do that", { seq: 1, correction: 1 })]);
    expect(cueOnly.close_reason).toBe("stop");
    expect(cueOnly.event_count).toBe(1);
    expect(isEligibleForExtraction(cueOnly)).toEqual({ eligible: true, reason: "evidence" });
    for (const closeReason of ["precompact", "session_end", "idle"] as const) {
      expect(isEligibleForExtraction(build([promptLine("remember: seed first", { seq: 1, remember: 1 })], { closeReason }))).toEqual({ eligible: true, reason: "evidence" });
    }
    // Import episodes qualify whatever their shape.
    expect(isEligibleForExtraction({ host: "import", evidence_weight: 0, flags: {}, close_reason: "interrupted", event_count: 1 })).toEqual({ eligible: true, reason: "import" });
  });
});

describe("fired outcomes (§9.3 B)", () => {
  test("s04: override when the same signature re-runs ok, heed when another tool runs first, none otherwise", () => {
    const descriptor = build(turnLines("s04-soft-deny-override.jsonl", "p4"));
    expect(descriptor.fired).toEqual([
      { memory_id: "mem-a", enforcement: "soft_deny", outcome: "override", tool: "bash" },
      { memory_id: "mem-b", enforcement: "soft_deny", outcome: "heed", tool: "bash" },
      { memory_id: "mem-c", enforcement: "advise", outcome: "none", tool: "bash" },
      { memory_id: "mem-d", enforcement: "soft_deny", outcome: "none", tool: "bash" },
    ]);
    expect(descriptor.tools).toEqual(["bash", "edit"]);
  });

  test("a soft_deny with no later tool call is none; a different command for the same tool is heed", () => {
    const noTool = [firedLine(["m"], { seq: 1, signature_keys: ["bash|command|cmd|pm test"] }), assistantLine("stopped", { seq: 2 })];
    expect(classifyFiredOutcome(noTool, 0)).toBe("none");
    const otherCommand = [firedLine(["m"], { seq: 1, signature_keys: ["bash|command|cmd|pm test"] }), toolOkLine("git status", { seq: 2, program_token: "git" })];
    expect(classifyFiredOutcome(otherCommand, 0)).toBe("heed");
    const noKeys = [firedLine(["m"], { seq: 1 }), toolOkLine("git status", { seq: 2 })];
    expect(classifyFiredOutcome(noKeys, 0)).toBe("override");
    const pathSignature = [
      firedLine(["m"], { seq: 1, tool: "edit", signature_keys: ["edit|path|glob|**/.env*"] }),
      toolOkLine(".env", { seq: 2, tool: "edit", shell_dialect: null, scope_refs: [".env"] }),
    ];
    expect(classifyFiredOutcome(pathSignature, 0)).toBe("override");
    expect(classifyFiredOutcome([promptLine("x", { seq: 1 })], 0)).toBe("none");
  });
});

describe("renderContextRef", () => {
  test("keeps the last 12 tool lines and ignores other kinds", () => {
    const lines: LedgerLine[] = [promptLine("x", { seq: 0 })];
    for (let i = 1; i <= 15; i += 1) lines.push(toolOkLine(`cmd-${i}`, { seq: i }));
    lines.push(assistantLine("done", { seq: 99 }));
    const rendered = renderContextRef(lines);
    expect(rendered?.split("\n")).toHaveLength(12);
    expect(rendered).toContain("cmd-4");
    expect(rendered).not.toContain("cmd-3\n");
    expect(renderContextRef([promptLine("x"), assistantLine("y")])).toBeNull();
  });
});
