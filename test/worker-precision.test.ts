/**
 * Signature precision through the real worker (0.6.0-rc.2 design §2; review findings V1 / V2): the label a row is
 * born with is judged over every `tool_ok` line of the episode — those the prompt dropped for the character cap
 * included, so the fresh path and the raw-cache path agree — and, for a correction_for episode, over the corrected
 * turn's tool lines. Temp `.harness-memory`, replay / fake providers, no model.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { DEFAULT_CONFIG, type HarnessConfig } from "../src/core/config";
import type { EpisodeDescriptor } from "../src/core/episode-types";
import type { ExtractionFact } from "../src/core/extraction-types";
import { extractionRunId } from "../src/core/ids";
import type { LedgerLine } from "../src/core/ledger-types";
import { ledgerFile, queueFile, rawFile, resolvePaths, stateDirectories, type HarnessPaths } from "../src/core/paths";
import { ExtractionRunRepository } from "../src/db/repositories/runs";
import { buildEpisodeDescriptor } from "../src/dream/episode";
import { buildExtractionPrompt, eventIdMap } from "../src/dream/extract/prompt";
import { createReplayProvider, type ExtractionProvider } from "../src/dream/extract/providers";
import { appendLedgerLine } from "../src/dream/ledger";
import { composeStore, runWorker, silentWorkerLogger, type WorkerOptions } from "../src/dream/worker";
import { MemoryRepository, type MemoryRecord } from "../src/memory/repository";
import { assistantLine, promptLine, toolFailLine, toolOkLine, withOffsets } from "./helpers/ledger-fixture";
import { factFixture, outputFixture } from "./helpers/replay-run";

const NOW = "2026-11-26T09:00:00.000Z";

let root: string;
let paths: HarnessPaths;
let config: HarnessConfig;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "hm-precision-"));
  paths = resolvePaths(root);
  for (const dir of stateDirectories(paths)) mkdirSync(dir, { recursive: true });
  config = structuredClone(DEFAULT_CONFIG);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const clock = () => NOW;

/** Appends the lines to the session ledger and writes the queue file the stop hook would have written. */
function queueEpisode(
  lines: readonly LedgerLine[],
  options: { correctionFor?: EpisodeDescriptor | null; contextLines?: readonly LedgerLine[] | null } = {},
  sessionKey = "k1"
): EpisodeDescriptor {
  const file = ledgerFile(paths, "claude-code", sessionKey);
  const existing = existsSync(file) ? readFileSync(file).byteLength : 0;
  for (const line of lines) appendLedgerLine(file, line);
  const offsets = withOffsets(lines, existing);
  const last = offsets[offsets.length - 1]!;
  const descriptor = buildEpisodeDescriptor({
    host: "claude-code",
    sessionId: `session-${sessionKey}`,
    sessionKey,
    turnKey: lines[0]!.turn_key,
    segment: 0,
    lines,
    byteStart: existing,
    byteEnd: last.offset + last.length,
    ledgerFileName: `claude-code-${sessionKey}.jsonl`,
    closeReason: "stop",
    now: NOW,
    correctionFor: options.correctionFor?.id ?? null,
    contextLines: options.contextLines ?? null,
  });
  writeFileSync(queueFile(paths, descriptor.id), JSON.stringify(descriptor));
  return descriptor;
}

function worker(overrides: Partial<WorkerOptions> = {}) {
  const store = composeStore({ paths, config, logger: silentWorkerLogger, clock });
  return runWorker({ paths, config, store, command: "extract", clock, logger: silentWorkerLogger, workerLockWaitMs: 50, dbLockWaitMs: 2_000, ...overrides });
}

async function readMemory(id: string, episodeId: string): Promise<{ memory: MemoryRecord | null; inputChars: number | null }> {
  const store = composeStore({ paths, config, logger: silentWorkerLogger, clock });
  return store.read((db) => ({
    memory: new MemoryRepository(db).getById(id),
    inputChars: new ExtractionRunRepository(db).getById(extractionRunId(episodeId))?.inputChars ?? null,
  }));
}

/** A provider that must not be called: the raw cache serves the episode. */
function silentProvider(): ExtractionProvider & { calls: number } {
  const provider = {
    name: "claude" as const,
    calls: 0,
    probe: () => Promise.resolve("ok" as const),
    extract: () => {
      provider.calls += 1;
      return Promise.resolve({ status: "provider_error" as const, raw: "", error: "the raw cache should have served this episode" });
    },
  };
  return provider;
}

const toolLines = (lines: readonly LedgerLine[]): LedgerLine[] => lines.filter((line) => line.kind === "tool_ok" || line.kind === "tool_fail");

const write = (pattern: string): ExtractionFact["trigger_signature"] => ({ tool: "bash", target: "command", pattern_kind: "cmd", pattern, side_effect: "write" });

describe("V1: precision over every line of the episode, on the fresh and the raw-cache path", () => {
  // A legitimate push early, eighty routine reads (enough to overflow the 24k cap on their own), a failure fixed by
  // switching managers and a silent push to the wrong remote late. The cap drops the oldest routine lines first — the
  // early push among them — so the rendered map no longer holds the sibling that makes `git push` a noun.
  const BASE = 7000;
  const lines: LedgerLine[] = [
    promptLine("ship the feature branch and run the suite", { seq: BASE + 1, turn_key: "p70" }),
    toolOkLine("git push origin feature", { seq: BASE + 2, turn_key: "p70", program_token: "git push" }),
    ...Array.from({ length: 80 }, (_, i) =>
      toolOkLine(`cat src/module-${String(i)}.ts ${"x".repeat(300)}`, { seq: BASE + 10 + i, turn_key: "p70", scope_refs: [`src/module-${String(i)}.ts`], program_token: "cat", output_head: "y".repeat(150) })
    ),
    toolFailLine("npm test", `Exit code 1\n${'npm ERR! Missing script: "test"\n'.repeat(8)}`, { seq: BASE + 100, turn_key: "p70", program_token: "pm test", failure_class: "exit_1" }),
    toolOkLine("pnpm test", { seq: BASE + 101, turn_key: "p70", program_token: "pm test", resolution_of: "bash|exit_1|pm test", output_head: "Test Files 3 passed" }),
    toolOkLine("git push upstream main", { seq: BASE + 102, turn_key: "p70", program_token: "git push" }),
    assistantLine("Pushed and the tests pass.", { seq: BASE + 103, turn_key: "p70" }),
  ];
  const every = eventIdMap(lines);
  const refOf = (seq: number): string => [...every.entries()].find(([, line]) => line.seq === seq)![0];
  const siblingRef = refOf(BASE + 2);
  const failureRef = refOf(BASE + 100);
  const latePushRef = refOf(BASE + 102);
  const wrongRemote = outputFixture(
    [
      factFixture({
        summary: "Push to origin only; a push to upstream is silently ignored by CI, which deploys from origin.",
        details: "The upstream remote is a read-only mirror.",
        trigger_signature: write("git push"),
        evidence_refs: [latePushRef, failureRef],
        knowledge_kind: "failure_resolution",
        aliases: ["push", "remote"],
      }),
    ],
    "A push went to the wrong remote; the suite runs with pnpm."
  );

  test("fresh path: the worker renders the capped prompt, yet the row is born noun / advise (never soft_deny on `git push`)", async () => {
    const descriptor = queueEpisode(lines);
    const built = buildExtractionPrompt({ descriptor, lines, existingMemories: [] });
    expect(built.droppedLines).toBeGreaterThan(0);
    expect(built.seqMap.has(siblingRef)).toBe(false);
    expect(built.seqMap.has(latePushRef)).toBe(true);
    expect(built.seqMap.has(failureRef)).toBe(true);
    // The silent-write rule would otherwise fire: evidence 2 (a resolved failure), side_effect write, failure_resolution.
    expect(descriptor.evidence_weight).toBe(2);

    const provider = createReplayProvider({ answers: { [descriptor.id]: wrongRemote } });
    const result = await worker({ provider });
    expect(result.errors).toEqual([]);
    expect(result.processed).toHaveLength(1);
    expect(result.processed[0]).toMatchObject({ episodeId: descriptor.id, status: "ok", fromCache: false, created: [expect.any(String)] });
    const { memory, inputChars } = await readMemory(result.processed[0]!.created[0]!, descriptor.id);
    // The worker rendered exactly this prompt (same drops) …
    expect(inputChars).toBe(built.prompt.length);
    // … and still judged precision over the dropped sibling.
    expect(memory).toMatchObject({ type: "pitfall", signatureKey: "bash|command|cmd|git push", signaturePrecision: "noun", sideEffect: "write", enforcement: "advise" });
  });

  test("raw-cache path: the same output served from raw/ gets the same label", async () => {
    const descriptor = queueEpisode(lines);
    writeFileSync(rawFile(paths, extractionRunId(descriptor.id)), JSON.stringify(wrongRemote));
    const provider = silentProvider();
    const result = await worker({ provider });
    expect(result.errors).toEqual([]);
    expect(provider.calls).toBe(0);
    expect(result.processed[0]).toMatchObject({ episodeId: descriptor.id, status: "ok", fromCache: true, created: [expect.any(String)] });
    const { memory } = await readMemory(result.processed[0]!.created[0]!, descriptor.id);
    expect(memory).toMatchObject({ signaturePrecision: "noun", sideEffect: "write", enforcement: "advise" });
  });
});

describe("V2: a correction_for episode judges precision over the corrected turn's tool lines", () => {
  // p50 pushed to both remotes; p51 is the user's prompt-only correction of it.
  const correctedLines: LedgerLine[] = [
    promptLine("push the branch", { seq: 5001, turn_key: "p50" }),
    toolOkLine("git push origin main", { seq: 5002, turn_key: "p50", program_token: "git push" }),
    toolOkLine("git push upstream main", { seq: 5003, turn_key: "p50", program_token: "git push" }),
    assistantLine("Pushed to origin and upstream.", { seq: 5004, turn_key: "p50" }),
  ];
  const correctingLines: LedgerLine[] = [
    promptLine("아니, upstream 말고 origin 으로만 push 해", { seq: 5101, turn_key: "p51", correction: 1 }),
    assistantLine("Understood: pushes go to origin only.", { seq: 5102, turn_key: "p51" }),
  ];
  const remoteFact = (pattern: string): ExtractionFact =>
    factFixture({
      summary: "Push to origin only; upstream is a read-only mirror and a push there is ignored by CI.",
      details: "The upstream remote is a mirror.",
      trigger_signature: write(pattern),
      evidence_refs: ["e1"],
      knowledge_kind: "correction",
      aliases: ["push", "remote"],
    });

  async function correctionRun(pattern: string): Promise<MemoryRecord | null> {
    const corrected = queueEpisode(correctedLines);
    const correcting = queueEpisode(correctingLines, { correctionFor: corrected, contextLines: toolLines(correctedLines) });
    expect(correcting.correction_for).toBe(corrected.id);
    // A correction of a turn that ran tools weighs 2: with a vacuous mistake_exact the row would be born at soft_deny.
    expect(correcting.evidence_weight).toBe(2);
    const provider = createReplayProvider({
      answers: { [correcting.id]: outputFixture([remoteFact(pattern)], "The user corrected the push remote."), [corrected.id]: outputFixture([], "A routine push.") },
    });
    const result = await worker({ provider });
    expect(result.errors).toEqual([]);
    const processed = result.processed.find((entry) => entry.episodeId === correcting.id);
    expect(processed).toMatchObject({ status: "ok", created: [expect.any(String)] });
    return (await readMemory(processed!.created[0]!, correcting.id)).memory;
  }

  test("an operation-level pattern (`git push`) covers both pushes of the corrected turn: noun, born at advise", async () => {
    const memory = await correctionRun("git push");
    expect(memory).toMatchObject({ type: "pitfall", signatureKey: "bash|command|cmd|git push", signaturePrecision: "noun", sideEffect: "write", enforcement: "advise" });
  });

  test("the exact token the user named (`git push upstream`) hits one call only: mistake_exact, and the silent-write rule may fire", async () => {
    const memory = await correctionRun("git push upstream");
    expect(memory).toMatchObject({ type: "pitfall", signatureKey: "bash|command|cmd|git push upstream", signaturePrecision: "mistake_exact", sideEffect: "write", enforcement: "soft_deny" });
  });
});
