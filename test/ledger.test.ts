import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, test } from "vitest";

import { LEDGER_LIMITS } from "../src/core/ledger-types";
import {
  appendLedgerLine,
  classifyFailure,
  deriveTailState,
  detectCorrection,
  detectRemember,
  detectResolution,
  failureKeyOf,
  failureSignature,
  firedKey,
  makeSeq,
  parseExitCode,
  parseLedger,
  readLedgerRange,
  readLedgerRangeLines,
  readLedgerTail,
  readLedgerTailLines,
  serializeLine,
} from "../src/dream/ledger";
import {
  assistantLine,
  firedLine,
  loadLedgerFixture,
  markerLine,
  promptLine,
  toolFailLine,
  toolOkLine,
  withOffsets,
} from "./helpers/ledger-fixture";

const tempDirs: string[] = [];

function tempLedger(): string {
  const dir = mkdtempSync(join(tmpdir(), "hm-ledger-"));
  tempDirs.push(dir);
  return join(dir, "ledger", "claude-code-abc.jsonl");
}

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe("serializeLine", () => {
  test("truncates every text field to its LEDGER_LIMITS cap and redacts credentials", () => {
    const line = toolFailLine("x".repeat(600), `Exit code 1\ntoken=abcdefghijkl ${"e".repeat(3000)}`, {
      output_head: `${"h".repeat(5000)} sk-ant-${"a".repeat(30)}`,
      output_tail: "t".repeat(5000),
    });
    const json = JSON.parse(serializeLine(line)) as Record<string, string>;
    expect(json.input_digest).toHaveLength(LEDGER_LIMITS.input_digest);
    expect(json.output_head).toHaveLength(LEDGER_LIMITS.output_head);
    expect(json.output_tail).toHaveLength(LEDGER_LIMITS.output_tail);
    expect(json.error).toHaveLength(LEDGER_LIMITS.error_text);
    expect(json.error).toContain("token=<redacted>");
    expect(json.error.endsWith("…")).toBe(true);
  });

  test("prompt / assistant / fired caps", () => {
    const prompt = JSON.parse(serializeLine(promptLine("p".repeat(9000)))) as { text: string };
    expect(prompt.text).toHaveLength(LEDGER_LIMITS.prompt_text);
    const assistant = JSON.parse(serializeLine(assistantLine("a".repeat(9000)))) as { text: string };
    expect(assistant.text).toHaveLength(LEDGER_LIMITS.assistant_text);
    const fired = JSON.parse(serializeLine(firedLine(["m1"], { target_digest: "d".repeat(500) }))) as { target_digest: string };
    expect(fired.target_digest).toHaveLength(LEDGER_LIMITS.target_digest);
  });

  test("short lines are untouched and keep their fields", () => {
    const line = toolOkLine("pnpm test", { program_token: "pm test", resolution_of: "bash|exit_1|pm test", output_head: "ok" });
    expect(JSON.parse(serializeLine(line))).toEqual(line);
  });

  test("redacts credentials inside prompt text and output", () => {
    const json = JSON.parse(serializeLine(promptLine("use key sk-ant-abcdefghijklmnopqrstuvwxyz0123456789 and password=hunter22 please"))) as { text: string };
    expect(json.text).not.toContain("sk-ant-abcdef");
    expect(json.text).toContain("password=<redacted>");
  });

  test("keeps a line under 32 KB even when arrays are huge", () => {
    const line = toolOkLine("ls", { scope_refs: Array.from({ length: 3000 }, (_, i) => `dir/file-${i}.ts`) });
    const json = serializeLine(line);
    expect(Buffer.byteLength(json, "utf8")).toBeLessThanOrEqual(LEDGER_LIMITS.line_bytes);
    expect((JSON.parse(json) as { scope_refs: string[] }).scope_refs).toHaveLength(50);
  });

  test("multibyte text is truncated by characters, capped by bytes", () => {
    const json = serializeLine(toolOkLine("ls", { output_head: "가".repeat(5000) }));
    expect((JSON.parse(json) as { output_head: string }).output_head).toHaveLength(LEDGER_LIMITS.output_head);
    expect(Buffer.byteLength(json, "utf8")).toBeLessThanOrEqual(LEDGER_LIMITS.line_bytes);
  });
});

describe("appendLedgerLine / readLedgerTail / readLedgerRange", () => {
  test("creates directories, appends one line per call and returns the bytes written", () => {
    const file = tempLedger();
    const first = appendLedgerLine(file, promptLine("hello", { seq: 1 }));
    expect(statSync(file).size).toBe(first);
    appendLedgerLine(file, toolOkLine("ls", { seq: 2 }));
    const text = readFileSync(file, "utf8");
    expect(text.split("\n").filter((row) => row.length > 0)).toHaveLength(2);
    expect(text.endsWith("\n")).toBe(true);
  });

  test("tail and range reads use byte offsets and tolerate torn chunks", () => {
    const file = tempLedger();
    const lines = [promptLine("one", { seq: 1 }), toolOkLine("ls", { seq: 2 }), toolFailLine("npm test", "Exit code 1", { seq: 3 }), assistantLine("done", { seq: 4 })];
    for (const line of lines) appendLedgerLine(file, line);
    const size = statSync(file).size;

    const full = readLedgerTailLines(file, size);
    expect(full.lines.map((line) => line.seq)).toEqual([1, 2, 3, 4]);
    expect(full.badLines).toBe(0);
    expect(full.fileSize).toBe(size);
    expect(full.lines[0]!.offset).toBe(0);
    for (let i = 1; i < full.lines.length; i += 1) {
      expect(full.lines[i]!.offset).toBe(full.lines[i - 1]!.offset + full.lines[i - 1]!.length);
    }

    const tailBytes = full.lines[3]!.length + 15; // the whole last line plus a torn fragment of the third
    const tail = readLedgerTail(file, tailBytes);
    expect(tail.baseOffset).toBe(size - tailBytes);
    const parsedTail = parseLedger(tail.bytes, { baseOffset: tail.baseOffset });
    expect(parsedTail.badLines).toBe(1);
    expect(parsedTail.lines.map((line) => line.seq)).toEqual([4]);
    expect(parsedTail.lines[0]!.offset).toBe(full.lines[3]!.offset);

    const third = full.lines[2]!;
    const range = readLedgerRangeLines(file, third.offset, third.offset + third.length);
    expect(range.lines.map((line) => line.seq)).toEqual([3]);
    expect(range.baseOffset).toBe(third.offset);
    expect(readLedgerRange(file, size + 10, size + 20).bytes.length).toBe(0);
  });

  test("a missing ledger reads as empty", () => {
    const missing = join(tempLedger(), "..", "nope.jsonl");
    expect(readLedgerTail(missing, 1024)).toEqual({ bytes: Buffer.alloc(0), baseOffset: 0, fileSize: 0 });
    expect(readLedgerTailLines(missing, 1024).lines).toEqual([]);
  });
});

describe("parseLedger", () => {
  test("torn first and last lines are counted, the middle survives with offsets", () => {
    const { lines, badLines, raw } = loadLedgerFixture("s05-torn.jsonl");
    expect(badLines).toBe(2);
    expect(lines.map((line) => line.kind)).toEqual(["prompt", "tool_ok"]);
    expect(lines[0]!.offset).toBe(raw.indexOf('{"kind":"prompt"'));
    expect(lines[1]!.offset).toBe(lines[0]!.offset + lines[0]!.length);
    expect(lines[1]!.seq).toBe(5002);
  });

  test("baseOffset shifts offsets; CRLF, blank lines and foreign JSON are tolerated", () => {
    const text = `${serializeLine(markerLine("session_start", { seq: 9 }))}\r\n\n{"not":"a ledger line"}\n${serializeLine(promptLine("x", { seq: 10 }))}`;
    const parsed = parseLedger(text, { baseOffset: 100 });
    expect(parsed.badLines).toBe(1);
    expect(parsed.lines.map((line) => line.seq)).toEqual([9, 10]);
    expect(parsed.lines[0]!.offset).toBe(100);
    const lastOffset = 100 + Buffer.byteLength(text, "utf8") - Buffer.byteLength(serializeLine(promptLine("x", { seq: 10 })), "utf8");
    expect(parsed.lines[1]!.offset).toBe(lastOffset);
  });

  test("withOffsets agrees with parsing the serialized lines", () => {
    const lines = [promptLine("가나다", { seq: 1 }), toolOkLine("ls", { seq: 2 })];
    const offsets = withOffsets(lines, 50);
    const text = lines.map((line) => `${serializeLine(line)}\n`).join("");
    const parsed = parseLedger(text, { baseOffset: 50 });
    expect(parsed.lines.map((line) => [line.offset, line.length])).toEqual(offsets.map((line) => [line.offset, line.length]));
  });
});

describe("deriveTailState (§6.2 step 4)", () => {
  const lines = withOffsets([
    promptLine("first turn", { turn_key: "t0", seq: 1 }),
    firedLine(["mem-x"], { turn_key: "t0", seq: 2 }),
    toolFailLine("npm test", "Exit code 1", { turn_key: "t0", seq: 3, program_token: "pm test", failure_class: "exit_1" }),
    toolOkLine("cat src/old.ts", { turn_key: "t0", seq: 4, scope_refs: ["src/old.ts"], program_token: "cat" }),
    promptLine("second turn", { turn_key: "t1", seq: 5 }),
    firedLine(["mem-y", "mem-z"], { turn_key: "t1", seq: 6, tool: "bash" }),
    toolOkLine("src/a.ts", { turn_key: "t1", seq: 7, tool: "edit", host_tool: "Edit", shell_dialect: null, scope_refs: ["src/a.ts"] }),
    toolFailLine("curl http://x", "timed out", { turn_key: "t1", seq: 8, program_token: "curl", failure_class: "timeout" }),
  ]);
  const secondTurnStart = lines[4]!.offset;

  test("fired keys come from the open turn only, pending failures and last scope ref from the whole tail", () => {
    const state = deriveTailState(lines, { turnStartOffset: secondTurnStart });
    expect([...state.firedKeys].sort()).toEqual(["mem-y|bash", "mem-z|bash"]);
    expect(state.lastScopeRef).toBe("src/a.ts");
    expect([...state.pendingFailures.keys()].sort()).toEqual(["bash|curl", "bash|pm test"]);
    expect(state.pendingFailures.get("bash|pm test")?.failure_sig).toBe("bash|exit_1|pm test");
    expect(state.openTurnHasLines).toBe(true);
  });

  test("an offset past the end means no open-turn lines", () => {
    const last = lines[lines.length - 1]!;
    const state = deriveTailState(lines, { turnStartOffset: last.offset + last.length });
    expect(state.firedKeys.size).toBe(0);
    expect(state.openTurnHasLines).toBe(false);
  });

  test("a success for the same key clears the pending failure, a different key does not", () => {
    const withLs = withOffsets([
      toolFailLine("npm test", "Exit code 1", { seq: 1, program_token: "pm test", failure_class: "exit_1" }),
      toolOkLine("ls", { seq: 2, program_token: "ls" }),
    ]);
    expect(deriveTailState(withLs, { turnStartOffset: 0 }).pendingFailures.has("bash|pm test")).toBe(true);
    const resolved = withOffsets([...withLs, toolOkLine("pnpm test", { seq: 3, program_token: "pm test" })]);
    expect(deriveTailState(resolved, { turnStartOffset: 0 }).pendingFailures.size).toBe(0);
  });

  test("failureKeyOf prefers scope_refs[0] over the program token", () => {
    expect(failureKeyOf({ tool: "bash", scope_refs: ["src/a.ts"], program_token: "cat" })).toBe("bash|src/a.ts");
    expect(failureKeyOf({ tool: "bash", scope_refs: [], program_token: "pm test" })).toBe("bash|pm test");
    expect(failureKeyOf({ tool: "edit", scope_refs: [], program_token: null })).toBe("edit|");
    expect(firedKey("m", "bash")).toBe("m|bash");
  });
});

describe("classifyFailure / failureSignature / parseExitCode", () => {
  test.each([
    [{ isInterrupt: true, error: "Exit code 1" }, "interrupt"],
    [{ exitCode: 2 }, "exit_2"],
    [{ error: "Exit code 127\nbash: foo: command not found" }, "exit_127"],
    [{ error: "exit code: 3" }, "exit_3"],
    [{ error: "spawn foo ENOENT" }, "enoent"],
    [{ error: "bash: foo: command not found" }, "enoent"],
    [{ error: "The term 'foo' is not recognized as the name of a cmdlet" }, "enoent"],
    [{ error: "File does not exist." }, "enoent"],
    [{ error: "EACCES: permission denied, open '/x'" }, "eacces"],
    [{ error: "Command timed out after 120s" }, "timeout"],
    [{ error: "Exit code -1\nkilled" }, "other"],
    [{ error: "something else happened" }, "other"],
    [{}, "other"],
  ])("%j → %s", (input, expected) => {
    expect(classifyFailure(input)).toBe(expected);
  });

  test("parseExitCode reads only the first line", () => {
    expect(parseExitCode("Exit code 1\nExit code 2")).toBe(1);
    expect(parseExitCode("error\nExit code 1")).toBeNull();
    expect(parseExitCode(null)).toBeNull();
  });

  test("failureSignature format", () => {
    expect(failureSignature("bash", "exit_1", "pm test")).toBe("bash|exit_1|pm test");
    expect(failureSignature("edit", "enoent", "src/a.ts")).toBe("edit|enoent|src/a.ts");
    expect(failureSignature("bash", "other", null)).toBe("bash|other|");
  });
});

describe("detectResolution (§5.1)", () => {
  const pending = new Map([
    ["bash|pm test", toolFailLine("npm test", "Exit code 1", { program_token: "pm test", failure_class: "exit_1" })],
    ["edit|src/a.ts", toolFailLine("src/a.ts", "File does not exist.", { tool: "edit", host_tool: "Edit", shell_dialect: null, scope_refs: ["src/a.ts"], failure_class: "enoent" })],
  ]);

  test("npm test fail → ls ok is NOT a resolution; pnpm test ok IS", () => {
    expect(detectResolution(pending, toolOkLine("ls", { program_token: "ls" }))).toBeNull();
    expect(detectResolution(pending, toolOkLine("pnpm test", { program_token: "pm test" }))).toBe("bash|exit_1|pm test");
  });

  test("path-keyed failures resolve on the same path and tool", () => {
    expect(detectResolution(pending, toolOkLine("src/a.ts", { tool: "edit", scope_refs: ["src/a.ts"] }))).toBe("edit|enoent|src/a.ts");
    expect(detectResolution(pending, toolOkLine("cat src/a.ts", { tool: "bash", scope_refs: ["src/a.ts"] }))).toBeNull();
  });
});

describe("detectCorrection / detectRemember", () => {
  test("a failed tool at the end of the previous turn marks the next prompt as a correction", () => {
    const prev = [promptLine("x"), toolFailLine("npm test", "Exit code 1"), assistantLine("it failed"), markerLine("precompact")];
    expect(detectCorrection({ prevTurnLines: prev, text: "ok try again" })).toBe(1);
  });

  test("a successful last tool does not", () => {
    const prev = [promptLine("x"), toolFailLine("npm test", "Exit code 1"), toolOkLine("pnpm test"), assistantLine("fixed")];
    expect(detectCorrection({ prevTurnLines: prev, text: "looks good, continue" })).toBe(0);
  });

  test.each([
    ["don't do that", 1],
    ["No, use pnpm instead", 1],
    ["아니 그게 아니라 pnpm 써", 1],
    ["하지 마", 1],
    ["looks good, continue", 0],
    ["add a test for the parser", 0],
  ])("vocabulary: %s → %s", (text, expected) => {
    expect(detectCorrection({ prevTurnLines: [], text })).toBe(expected);
  });

  test("detectRemember is re-exported", () => {
    expect(detectRemember("remember to run lint")).toBe(true);
    expect(detectRemember("앞으로 pnpm 써")).toBe(true);
    expect(detectRemember("run lint")).toBe(false);
  });
});

describe("makeSeq", () => {
  test("is strictly increasing within a process", () => {
    const a = makeSeq();
    const b = makeSeq();
    const c = makeSeq(1000);
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
    expect(a).toBeGreaterThan(1_000_000_000_000_000);
  });
});
