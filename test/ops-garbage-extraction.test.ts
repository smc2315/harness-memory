/**
 * Operations suite (spec §13.4): the garbage extractor outputs of test/fixtures/extraction run through the
 * REAL worker (queue file → lock sessions → replay provider → validation → reconcile): non-JSON, forty
 * facts and hallucinated refs are suspect runs that create nothing and back off; a catastrophic regex is
 * rejected while the linear one is stored and matched within budget; a single-token command signature is
 * unreachable or dropped.
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { matchSignature } from "../src/activation/signature";
import { DEFAULT_CONFIG, type HarnessConfig } from "../src/core/config";
import type { EpisodeDescriptor } from "../src/core/episode-types";
import type { ExtractionOutput } from "../src/core/extraction-types";
import { extractionRunId } from "../src/core/ids";
import type { LedgerLine } from "../src/core/ledger-types";
import { ledgerFile, queueFile, rawFile, resolvePaths, stateDirectories, type HarnessPaths } from "../src/core/paths";
import { hasWriteOp } from "../src/db/meta";
import { EpisodeRepository } from "../src/db/repositories/episodes";
import { ExtractionRunRepository } from "../src/db/repositories/runs";
import { buildEpisodeDescriptor } from "../src/dream/episode";
import { buildExtractionPrompt } from "../src/dream/extract/prompt";
import { createReplayProvider } from "../src/dream/extract/providers/replay";
import { appendLedgerLine } from "../src/dream/ledger";
import { composeStore, runWorker, silentWorkerLogger } from "../src/dream/worker";
import { materializeOutput, refResolver } from "../src/eval/replay/fixtures";
import { MemoryRepository } from "../src/memory/repository";
import { loadExtractionFixture, loadLedgerFixture, promptLine, toolFailLine, toolOkLine, withOffsets } from "./helpers/ledger-fixture";

const NOW = "2026-11-08T15:00:00.000Z";
const s02 = loadLedgerFixture("s02-fail-then-resolve.jsonl").lines.filter((line) => line.turn_key === "p2");

let root: string;
let paths: HarnessPaths;
let config: HarnessConfig;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "hm-ops-garbage-"));
  paths = resolvePaths(root);
  for (const dir of stateDirectories(paths)) mkdirSync(dir, { recursive: true });
  config = structuredClone(DEFAULT_CONFIG);
  writeFileSync(paths.config, JSON.stringify(config), "utf8");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

const clock = () => NOW;

/** Writes the lines into a session ledger and queues the descriptor the stop hook would have produced. */
function queueEpisode(lines: readonly LedgerLine[], sessionKey = "k1"): EpisodeDescriptor {
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
  });
  writeFileSync(queueFile(paths, descriptor.id), JSON.stringify(descriptor));
  return descriptor;
}

/**
 * The fixtures cite the fixture seqs (`e2002`); the worker's prompt decides the citable ids, so the refs
 * are translated through the real prompt builder exactly like eval:replay does.
 */
function recordedAnswer(raw: string, descriptor: EpisodeDescriptor, lines: readonly LedgerLine[]): ExtractionOutput | string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return raw;
  }
  const built = buildExtractionPrompt({ descriptor, lines, existingMemories: [] });
  const refMap = new Map<number, string>();
  for (const [ref, line] of built.seqMap) refMap.set(line.seq, ref);
  const identity = new Map(lines.map((line) => [line.seq, line.seq]));
  return materializeOutput(parsed as ExtractionOutput, { refOf: refResolver(identity, refMap), created: new Map() });
}

async function extract(descriptor: EpisodeDescriptor, lines: readonly LedgerLine[], fixture: string) {
  const store = composeStore({ paths, config, logger: silentWorkerLogger, clock });
  const provider = createReplayProvider({ answers: { [descriptor.id]: recordedAnswer(loadExtractionFixture(fixture), descriptor, lines) } });
  const result = await runWorker({ paths, config, store, command: "extract", provider, clock, logger: silentWorkerLogger, workerLockWaitMs: 100, dbLockWaitMs: 5_000 });
  return { result, store };
}

describe("suspect runs create nothing and back off", () => {
  // Non-JSON output is classified `invalid_output` (nothing parseable to judge); runaway and hallucinating
  // outputs parse but trip the circuit breaker → `suspect`. Both are failed runs with the same backoff.
  for (const [fixture, status] of [
    ["garbage-not-json.txt", "invalid_output"],
    ["forty-facts.json", "suspect"],
    ["hallucinated-refs.json", "suspect"],
  ] as const) {
    test(`${fixture} → run status ${status}, episode failed with a 1 h backoff, zero memories, raw kept for inspection`, async () => {
      const descriptor = queueEpisode(s02);
      const { result, store } = await extract(descriptor, s02, fixture);
      expect(result.exitCode).toBe(0);
      expect(result.errors).toEqual([]);
      expect(result.processed).toHaveLength(1);
      expect(result.processed[0]!.status).toBe(status);
      expect(result.processed[0]!.created).toEqual([]);
      const runId = extractionRunId(descriptor.id);
      await store.read((db) => {
        expect(new MemoryRepository(db).list({})).toEqual([]);
        const episode = new EpisodeRepository(db).getById(descriptor.id)!;
        expect(episode.status).toBe("failed");
        expect(episode.attemptCount).toBe(1);
        expect(episode.nextAttemptAt).toBe("2026-11-08T16:00:00.000Z");
        const run = new ExtractionRunRepository(db).getById(runId)!;
        expect(run.status).toBe(status);
        expect(run.factsAccepted ?? 0).toBe(0);
        expect(hasWriteOp(db, runId)).toBe(false);
      });
      // The suspect raw output is kept under raw/<run>.<attempt>.json, never as the reusable cache.
      expect(existsSync(rawFile(paths, runId))).toBe(false);
      expect(readdirSync(paths.rawDir).filter((name) => name.startsWith(runId))).toEqual([`${runId}.1.json`]);
      expect(readdirSync(paths.queueDir)).toEqual([]);
    });
  }
});

describe("partially bad outputs", () => {
  test("catastrophic-regex.json: both unsafe regexes are rejected (regex_unsafe), the linear one is stored and matches a 4 KB command within budget", async () => {
    const descriptor = queueEpisode(s02);
    const { result, store } = await extract(descriptor, s02, "catastrophic-regex.json");
    expect(result.processed[0]!.status).toBe("ok");
    expect(result.processed[0]!.created).toHaveLength(1);
    await store.read((db) => {
      const run = new ExtractionRunRepository(db).getById(extractionRunId(descriptor.id))!;
      expect(run.outcomes.filter((outcome) => outcome.rejection === "regex_unsafe")).toHaveLength(2);
      expect(run.factsTotal).toBe(3);
      expect(run.factsAccepted).toBe(1);
      const memory = new MemoryRepository(db).getById(result.processed[0]!.created[0]!)!;
      expect(memory.triggerSignature?.pattern_kind).toBe("regex");
      expect(memory.triggerSignature?.pattern).toBe("^npm\\s+(run\\s+)?test\\b");
      expect(memory.status).toBe("active");
    });
    const snapshot = JSON.parse(readFileSync(paths.snapshotActive, "utf8")) as { memories: Array<{ id: string; signature: { regex_source: string; pattern_kind: string } | null }> };
    const row = snapshot.memories.find((entry) => entry.id === result.processed[0]!.created[0]!)!;
    expect(row.signature?.pattern_kind).toBe("regex");
    const compiled = { tool: "bash", target: "command" as const, pattern_kind: "regex" as const, pattern: row.signature!.regex_source, negate: false, tokens: null, regex_source: row.signature!.regex_source, signature_key: "x" };
    const started = performance.now();
    expect(matchSignature(compiled, `npm test ${"a".repeat(4000)}`, "bash")).toBe(true);
    expect(matchSignature(compiled, `pnpm ${"a".repeat(4000)}`, "bash")).toBe(false);
    expect(performance.now() - started).toBeLessThan(50);
  });

  test("single-token-signature.json: before_tool-only → trigger_unreachable; with before_model the signature is dropped and the pitfall survives scope-only", async () => {
    // The second fact is scoped to src/**, so the episode must touch a src file.
    const lines: LedgerLine[] = [
      promptLine("run the tests for src", { seq: 2001, turn_key: "p2" }),
      toolFailLine("npm test src/index.test.ts", 'Exit code 1\nnpm ERR! Missing script: "test"', { seq: 2002, turn_key: "p2", program_token: "pm test", scope_refs: ["src/index.test.ts"], exit_code: 1, failure_class: "exit_1" }),
      toolOkLine("pnpm test src/index.test.ts", { seq: 2004, turn_key: "p2", program_token: "pm test", scope_refs: ["src/index.test.ts"], resolution_of: "bash|exit_1|src/index.test.ts" }),
    ];
    const descriptor = queueEpisode(lines, "k2");
    const { result, store } = await extract(descriptor, lines, "single-token-signature.json");
    expect(result.processed[0]!.status).toBe("ok");
    expect(result.processed[0]!.created).toHaveLength(1);
    await store.read((db) => {
      const run = new ExtractionRunRepository(db).getById(extractionRunId(descriptor.id))!;
      expect(run.outcomes.find((outcome) => outcome.ordinal === 0)).toMatchObject({ outcome: "rejected", rejection: "trigger_unreachable" });
      const created = run.outcomes.find((outcome) => outcome.ordinal === 1);
      expect(created?.relabel).toContain("signature_dropped");
      const memory = new MemoryRepository(db).getById(result.processed[0]!.created[0]!)!;
      expect(memory.triggerSignature).toBeNull();
      expect(memory.lifecycleTriggers).toContain("before_model");
      expect(memory.scopeGlob).toBe("src/**");
      expect(memory.type).toBe("pitfall");
    });
  });
});
