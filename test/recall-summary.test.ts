/**
 * Deterministic recall summaries (A′ recall layer, `src/dream/recall-summary.ts`): a failure → resolution
 * turn and a plain correction turn from the ledger fixtures, truncation rules (prompt 160 / total 400 chars,
 * ≤ 3 files, ≤ 3 failures), control-character stripping, agent-line exclusion and the descriptor-only fallback.
 */

import { describe, expect, test } from "vitest";

import type { LedgerLine } from "../src/core/ledger-types";
import { buildEpisodeDescriptor, type BuildEpisodeInput } from "../src/dream/episode";
import { RECALL_PROMPT_CHARS, RECALL_SUMMARY_MAX_CHARS, buildRecallSummary, normalizeRecallSummary } from "../src/dream/recall-summary";
import { assistantLine, loadLedgerFixture, promptLine, toolFailLine, toolOkLine } from "./helpers/ledger-fixture";

const NOW = "2026-11-08T12:00:00.000Z";
const s02 = loadLedgerFixture("s02-fail-then-resolve.jsonl").lines.filter((line) => line.turn_key === "p2");
const s01 = loadLedgerFixture("s01-correction-only.jsonl").lines.filter((line) => line.turn_key === "p1");

function descriptorOf(lines: readonly LedgerLine[], overrides: Partial<BuildEpisodeInput> = {}) {
  return buildEpisodeDescriptor({
    host: "claude-code",
    sessionId: "session-1",
    sessionKey: "k1",
    turnKey: lines[0]?.turn_key ?? "t1",
    segment: 0,
    lines,
    byteStart: 0,
    byteEnd: 4096,
    ledgerFileName: "claude-code-k1.jsonl",
    closeReason: "stop",
    now: NOW,
    ...overrides,
  });
}

describe("buildRecallSummary", () => {
  test("a failure → resolution turn names the prompt, the failure with its program token and outcome, and the tool counts", () => {
    const descriptor = descriptorOf(s02);
    const summary = buildRecallSummary(descriptor, s02);
    expect(summary).toBe('"run the tests" | failed exit_1 pm test → resolved | tools bash×3');
    expect(summary.length).toBeLessThanOrEqual(RECALL_SUMMARY_MAX_CHARS);
    // Deterministic: the same input always yields the same string.
    expect(buildRecallSummary(descriptor, s02)).toBe(summary);
  });

  test("a plain correction turn without tool calls is the prompt plus its flag tag", () => {
    const descriptor = descriptorOf(s01);
    expect(descriptor.flags.correction).toBe(1);
    expect(buildRecallSummary(descriptor, s01)).toBe('"아니, npm test 쓰지 말고 pnpm test 로 돌려. Don\'t use npm test here." [correction]');
  });

  test("without ledger lines the descriptor alone is used: tools without counts, remember / decision tags", () => {
    const descriptor = descriptorOf(s02);
    expect(buildRecallSummary({ ...descriptor, flags: { remember: 1, decision: 1 } })).toBe('"run the tests" [remember, decision] | failed exit_1 pm test → resolved | tools bash');
    // No prompt text anywhere → the tag still tells what kind of turn it was.
    expect(buildRecallSummary({ ...descriptor, prompt_text: null, flags: { correction: 1 }, failure_signatures: [], tools: [], scope_refs: [] })).toBe("(no prompt) [correction]");
    expect(buildRecallSummary({ ...descriptor, prompt_text: null, flags: {}, failure_signatures: [], tools: [], scope_refs: [] })).toBe("(empty episode)");
  });

  test("truncates the prompt to 160 chars and the whole summary to 400, caps files at 3 and failures at 3", () => {
    const longPrompt = `fix ${"the flaky integration suite ".repeat(20)}now`;
    const lines: LedgerLine[] = [
      promptLine(longPrompt, { turn_key: "t9" }),
      ...Array.from({ length: 6 }, (_, index) =>
        toolFailLine(`cmd-${String(index)}`, "boom", { turn_key: "t9", program_token: `prog${String(index)}`, failure_class: index % 2 === 0 ? "exit_1" : "enoent", scope_refs: [`src/dir${String(index)}/file${String(index)}.ts`] })
      ),
      ...Array.from({ length: 10 }, (_, index) => toolOkLine(`ok-${String(index)}`, { turn_key: "t9", tool: "edit", scope_refs: [`src/more/${String(index)}.ts`] })),
    ];
    const descriptor = descriptorOf(lines);
    const summary = buildRecallSummary(descriptor, lines);
    expect(summary.length).toBeLessThanOrEqual(RECALL_SUMMARY_MAX_CHARS);
    const promptPart = summary.slice(0, summary.indexOf('" |') + 1);
    expect(promptPart.length).toBeLessThanOrEqual(RECALL_PROMPT_CHARS + 2);
    expect(promptPart.endsWith('…"')).toBe(true);
    expect(summary).toContain("+3 more");
    expect(summary).toContain("→ unresolved");
    expect(summary).toMatch(/files src\/dir0\/file0\.ts, src\/dir1\/file1\.ts, src\/dir2\/file2\.ts, \+13/);
    expect(summary).toContain("tools edit×10 bash×6");
  });

  test("strips control characters and collapses whitespace; agent lines do not count as the episode's tools", () => {
    const lines: LedgerLine[] = [
      promptLine("fix\u001b[31m the\u001b[0m\n\n  build\tplease", { turn_key: "t2" }),
      toolOkLine("ls", { turn_key: "t2", agent_id: "agent-7" }),
      toolOkLine("pnpm build", { turn_key: "t2", program_token: "pm build" }),
    ];
    const descriptor = descriptorOf(lines);
    const summary = buildRecallSummary(descriptor, lines);
    expect(summary).toBe('"fix the build please" | tools bash×1');
    expect(summary).not.toMatch(/[\u0000-\u001f]/);
  });

  test("import episodes are labelled as such and the storage normalizer caps at 400 one-line chars", () => {
    // "Never …" trips the correction detector in the descriptor builder; the import path never sets flags.
    const descriptor = { ...descriptorOf([promptLine("Never run npm test here; use pnpm test.", { turn_key: "i1" })]), host: "import" as const, flags: {} };
    expect(buildRecallSummary(descriptor)).toBe('import: "Never run npm test here; use pnpm test."');
    const normalized = normalizeRecallSummary(`a\n${"b".repeat(500)}\u0007`);
    expect(normalized).toHaveLength(RECALL_SUMMARY_MAX_CHARS);
    expect(normalized.startsWith("a b")).toBe(true);
    expect(normalized.endsWith("…")).toBe(true);
    expect(buildRecallSummary(descriptorOf([assistantLine("only an answer", { turn_key: "a1" })]))).toBe("(empty episode)");
  });
});
