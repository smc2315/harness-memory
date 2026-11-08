import { describe, expect, test } from "vitest";

import { EXTRACTION_LIMITS } from "../src/core/extraction-types";
import type { LedgerLine } from "../src/core/ledger-types";
import { buildEpisodeDescriptor } from "../src/dream/episode";
import { buildExtractionPrompt, renderEventLine, type PromptMemory } from "../src/dream/extract/prompt";
import type { OffsetLedgerLine } from "../src/dream/ledger";
import { assistantLine, loadLedgerFixture, promptLine, toolFailLine, toolOkLine } from "./helpers/ledger-fixture";

const NOW = "2026-11-08T23:00:00.000Z";

function descriptorFor(lines: readonly LedgerLine[], turnKey: string, correctionFor: string | null = null, contextLines: readonly LedgerLine[] | null = null) {
  const offsets = lines as readonly OffsetLedgerLine[];
  const first = offsets[0];
  const last = offsets[offsets.length - 1];
  return buildEpisodeDescriptor({
    host: "claude-code",
    sessionId: "s",
    sessionKey: "k",
    turnKey,
    segment: 0,
    lines,
    byteStart: typeof first?.offset === "number" ? first.offset : 0,
    byteEnd: typeof last?.offset === "number" ? last.offset + last.length : 0,
    ledgerFileName: "claude-code-k.jsonl",
    closeReason: "stop",
    now: NOW,
    correctionFor,
    contextLines,
  });
}

function fixtureTurn(name: string, turnKey: string): OffsetLedgerLine[] {
  return loadLedgerFixture(name).lines.filter((line) => line.turn_key === turnKey);
}

const memory: PromptMemory = {
  id: "mem-1",
  type: "pitfall",
  status: "active",
  authority: "auto",
  scopeGlob: "**/*",
  signatureKey: "bash|command|cmd|pm test",
  summary: "Use pnpm test; npm test fails because the scripts are defined for pnpm.",
};

describe("buildExtractionPrompt (§5.4)", () => {
  const lines = fixtureTurn("s02-fail-then-resolve.jsonl", "p2");
  const descriptor = descriptorFor(lines, "p2");

  test("renders the header, numbered events, failures in full, memories, vocabulary and rules", () => {
    const { prompt, seqMap, droppedLines } = buildExtractionPrompt({ descriptor, lines, existingMemories: [memory] });
    expect(droppedLines).toBe(0);
    expect(prompt).toContain("# Episode");
    expect(prompt).toContain("host: claude-code | close_reason: stop | evidence_weight: 2");
    expect(prompt).toContain("flags: failure, resolution");
    expect(prompt).toContain("tools used: bash");
    expect(prompt).toContain("e2001 [prompt] correction=0 remember=0\n    run the tests");
    expect(prompt).toContain("e2002 [tool_fail] bash(bash) class=exit_1 sig=bash|exit_1|pm test");
    expect(prompt).toContain('Missing script: "test"');
    expect(prompt).toContain("e2003 [tool_ok] bash(bash): ls → package.json pnpm-lock.yaml src");
    expect(prompt).toContain("e2004 [tool_ok] bash(bash) resolves=bash|exit_1|pm test");
    expect(prompt).toContain("Test Files  3 passed (3)");
    expect(prompt).toContain("e2005 [assistant] Tests pass with pnpm test");
    expect(prompt).toContain("# Last assistant message\nTests pass with pnpm test");
    expect(prompt).toContain("[M:mem-1] [pitfall] [active/auto] scope=**/* sig=bash|command|cmd|pm test — Use pnpm test;");
    expect(prompt).toContain("# Canonical tool vocabulary");
    expect(prompt).toContain('"pm <script>"');
    expect(prompt).toContain("confidence = P(true AND lasting AND right scope). Omit facts below 0.6.");
    expect(prompt).toContain('use scope_glob "**/*"');
    expect(prompt).toContain("action \"reinforce\"");
    expect(prompt).toContain("Never use \"from now on\"");
    expect(prompt).toContain("aliases: up to 8");
    expect(prompt).toContain("# Output");
    expect(prompt).not.toContain("Korean");
    expect([...seqMap.keys()]).toEqual(["e2001", "e2002", "e2003", "e2004", "e2005"]);
    expect(seqMap.get("e2002")?.kind).toBe("tool_fail");
  });

  test("context lines are marked not citable and never enter the seqMap", () => {
    const corrected = fixtureTurn("s07-powershell-fail.jsonl", "p7");
    const correction = fixtureTurn("s01-correction-only.jsonl", "p1");
    const correctionDescriptor = descriptorFor(correction, "p1", "episode-prev", corrected);
    const { prompt, seqMap } = buildExtractionPrompt({ descriptor: correctionDescriptor, lines: correction, contextLines: corrected });
    expect(prompt).toContain("# Previous turn (context only — NOT citable, no e<seq> ids)");
    expect(prompt).toContain("(prev) tool_fail bash(powershell): & npm.cmd run build — exit_1:");
    expect(prompt).toContain("corrects a previous episode: yes");
    expect(prompt).toContain("flags: correction");
    expect(seqMap.has("e7002")).toBe(false);
    expect(seqMap.has("e1001")).toBe(true);
  });

  test("falls back to descriptor.context_ref when no context lines are passed", () => {
    const correction = fixtureTurn("s01-correction-only.jsonl", "p1");
    const withRef = { ...descriptorFor(correction, "p1", "episode-prev"), context_ref: "(prev) tool_fail bash(bash): npm test — exit_1: boom" };
    const { prompt } = buildExtractionPrompt({ descriptor: withRef, lines: correction });
    expect(prompt).toContain("(prev) tool_fail bash(bash): npm test — exit_1: boom");
  });

  test("a Korean prompt asks for Korean aliases", () => {
    const correction = fixtureTurn("s01-correction-only.jsonl", "p1");
    const { prompt } = buildExtractionPrompt({ descriptor: descriptorFor(correction, "p1"), lines: correction });
    expect(prompt).toContain("The user wrote in Korean: include Korean aliases alongside English ones.");
  });

  test("existing memories are capped at EXTRACTION_LIMITS.existing_memories", () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ ...memory, id: `mem-${i}` }));
    const { prompt } = buildExtractionPrompt({ descriptor, lines, existingMemories: many });
    expect(prompt.match(/\[M:mem-\d+\]/g)).toHaveLength(EXTRACTION_LIMITS.existing_memories);
    expect(buildExtractionPrompt({ descriptor, lines }).prompt).toContain("# Existing memories (scope intersects this episode)\n(none)");
  });

  test("subagent lines are not rendered", () => {
    const withAgent = [...lines, toolOkLine("sub", { seq: 2999, turn_key: "p2", agent_id: "agent-1" })];
    const { prompt, seqMap } = buildExtractionPrompt({ descriptor, lines: withAgent });
    expect(seqMap.has("e2999")).toBe(false);
    expect(prompt).not.toContain("e2999");
  });

  test("renderEventLine shapes", () => {
    expect(renderEventLine(promptLine("hello", { seq: 5, correction: 1 }))).toBe("e5 [prompt] correction=1 remember=0\n    hello");
    expect(renderEventLine(assistantLine("a\nb", { seq: 6 }))).toBe("e6 [assistant] a b");
    expect(renderEventLine(toolOkLine("ls", { seq: 7 }))).toBe("e7 [tool_ok] bash(bash): ls → ok");
    expect(renderEventLine(toolOkLine("src/a.ts", { seq: 8, tool: "edit", shell_dialect: null }))).toBe("e8 [tool_ok] edit: src/a.ts → ok");
  });
});

describe("hard cap (24,000 chars)", () => {
  test("drops the oldest non-failure lines first and keeps the prompt, failure and resolution citable", () => {
    const lines: LedgerLine[] = [promptLine("make everything pass", { seq: 1, turn_key: "big" })];
    for (let i = 0; i < 120; i += 1) {
      lines.push(toolOkLine(`cat src/file-${i}.ts ${"x".repeat(400)}`, { seq: 10 + i, turn_key: "big", scope_refs: [`src/file-${i}.ts`], output_head: "y".repeat(100) }));
    }
    lines.push(toolFailLine("npm test", `Exit code 1\n${"error line\n".repeat(40)}`, { seq: 500, turn_key: "big", program_token: "pm test", failure_class: "exit_1" }));
    lines.push(toolOkLine("pnpm test", { seq: 501, turn_key: "big", program_token: "pm test", resolution_of: "bash|exit_1|pm test", output_head: "passed" }));
    lines.push(assistantLine("All green.", { seq: 502, turn_key: "big" }));
    const descriptor = descriptorFor(lines, "big");
    const { prompt, seqMap, droppedLines } = buildExtractionPrompt({ descriptor, lines, existingMemories: [memory] });
    expect(prompt.length).toBeLessThanOrEqual(EXTRACTION_LIMITS.prompt_chars);
    expect(droppedLines).toBeGreaterThan(0);
    expect(seqMap.has("e1")).toBe(true);
    expect(seqMap.has("e500")).toBe(true);
    expect(seqMap.has("e501")).toBe(true);
    expect(seqMap.has("e10")).toBe(false);
    expect(seqMap.has("e129")).toBe(true);
    expect(prompt).toContain("[M:mem-1]");
    expect(seqMap.size).toBe(lines.length - droppedLines);
  });

  test("when every line is protected the memories and context go before failures", () => {
    const lines: LedgerLine[] = [promptLine("fix", { seq: 1, turn_key: "fails" })];
    for (let i = 0; i < 40; i += 1) {
      lines.push(toolFailLine(`npm run step-${i}`, `Exit code 1\n${"boom ".repeat(200)}`, { seq: 10 + i, turn_key: "fails", program_token: `pm step-${i}`, failure_class: "exit_1" }));
    }
    const descriptor = descriptorFor(lines, "fails");
    const many = Array.from({ length: 40 }, (_, i) => ({ ...memory, id: `mem-${i}` }));
    const { prompt, seqMap } = buildExtractionPrompt({ descriptor, lines, existingMemories: many });
    expect(prompt.length).toBeLessThanOrEqual(EXTRACTION_LIMITS.prompt_chars);
    expect(seqMap.has("e1")).toBe(true);
    expect(prompt.match(/\[M:mem-\d+\]/g) ?? []).not.toHaveLength(40);
  });
});
