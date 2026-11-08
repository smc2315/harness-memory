/**
 * Replay-run helper for the B1 write-path tests (§13.2): builds the episode descriptor from ledger
 * lines, inserts the episode, renders the prompt, validates a recorded extractor output and applies
 * `reconcileRun` inside BEGIN … COMMIT with the same bookkeeping Store.withWriteLock performs
 * (write_ops insert, generation bump, derivePolicyRules). No provider process, no file system.
 */

import type { Database as SqlJsDatabase } from "sql.js";

import { DEFAULT_CONFIG, type HarnessConfig } from "../../src/core/config";
import type { EpisodeDescriptor } from "../../src/core/episode-types";
import type { ExtractionFact, ExtractionOutput } from "../../src/core/extraction-types";
import { extractionRunId, sha256Hex } from "../../src/core/ids";
import type { LedgerLine } from "../../src/core/ledger-types";
import { getDbGeneration, hasWriteOp, insertWriteOp, setDbGeneration } from "../../src/db/meta";
import { EpisodeRepository } from "../../src/db/repositories/episodes";
import { buildEpisodeDescriptor, type BuildEpisodeInput } from "../../src/dream/episode";
import { buildExtractionPrompt, type PromptMemory } from "../../src/dream/extract/prompt";
import { validateRawExtraction } from "../../src/dream/extract/validate";
import type { OffsetLedgerLine } from "../../src/dream/ledger";
import { reconcileRun, type ReconcileWriteOp } from "../../src/dream/reconcile";
import { MemoryRepository } from "../../src/memory/repository";
import { derivePolicyRules } from "../../src/policy/derive";
import { LIVE_STATUSES } from "../../src/core/vocabulary";

export const REPLAY_NOW = "2026-11-08T12:00:00.000Z";

export function descriptorFromLines(
  lines: readonly LedgerLine[],
  overrides: Partial<BuildEpisodeInput> & { sessionId?: string; turnKey?: string } = {}
): EpisodeDescriptor {
  const offsets = lines as readonly OffsetLedgerLine[];
  const first = offsets[0];
  const last = offsets[offsets.length - 1];
  return buildEpisodeDescriptor({
    host: "claude-code",
    sessionId: overrides.sessionId ?? "session-1",
    sessionKey: "k1",
    turnKey: overrides.turnKey ?? lines[0]?.turn_key ?? "t1",
    segment: 0,
    lines,
    byteStart: typeof first?.offset === "number" ? first.offset : 0,
    byteEnd: typeof last?.offset === "number" ? last.offset + last.length : 0,
    ledgerFileName: "claude-code-k1.jsonl",
    closeReason: "stop",
    now: REPLAY_NOW,
    ...overrides,
  });
}

export function factFixture(overrides: Partial<ExtractionFact> = {}): ExtractionFact {
  return {
    action: "create",
    target_memory_id: null,
    type: "pitfall",
    summary: "Run the test suite with pnpm test instead of npm test in this repository.",
    details: "npm test exits with a missing-script error; the scripts are registered for pnpm.",
    scope_glob: "**/*",
    relevant_tools: ["bash"],
    trigger_signature: { tool: "bash", target: "command", pattern_kind: "cmd", pattern: "npm test" },
    lifecycle_triggers: ["before_tool"],
    confidence: 0.85,
    evidence_refs: ["e1001"],
    knowledge_kind: "correction",
    rationale: "The user corrected the package manager.",
    aliases: ["pnpm test", "테스트 실행"],
    ...overrides,
  };
}

export function outputFixture(facts: ExtractionFact[], summary = "The user corrected the test command."): ExtractionOutput {
  return { episode_summary: summary, nothing_to_learn: facts.length === 0, facts };
}

export interface ApplyRunOptions {
  descriptor: EpisodeDescriptor;
  lines: readonly LedgerLine[];
  /** Recorded extractor output (object or raw string). */
  output: ExtractionOutput | string;
  now?: string;
  config?: HarnessConfig;
  existingMemories?: PromptMemory[];
  contextLines?: readonly LedgerLine[] | null;
}

export interface ApplyRunResult {
  op: ReconcileWriteOp;
  runId: string;
  committed: boolean;
}

/** Applies one recorded run like the store does; the second call with the same run is a noop. */
export function applyRun(db: SqlJsDatabase, options: ApplyRunOptions): ApplyRunResult {
  const now = options.now ?? REPLAY_NOW;
  const config = options.config ?? DEFAULT_CONFIG;
  const episodes = new EpisodeRepository(db);
  episodes.insertIfAbsent(options.descriptor, now);
  const record = episodes.getById(options.descriptor.id);
  const correctionFor = record?.correctionFor === null || record?.correctionFor === undefined ? null : episodes.getById(record.correctionFor);

  const built = buildExtractionPrompt({
    descriptor: options.descriptor,
    lines: options.lines,
    contextLines: options.contextLines ?? null,
    existingMemories: options.existingMemories ?? [],
  });
  const raw = typeof options.output === "string" ? options.output : JSON.stringify(options.output);
  const runId = extractionRunId(options.descriptor.id);
  const repository = new MemoryRepository(db, { clock: () => now });
  const existingMemoryIds = new Set(repository.list({ status: LIVE_STATUSES }).map((memory) => memory.id));
  const validated = validateRawExtraction({
    raw,
    descriptor: options.descriptor,
    seqMap: built.seqMap,
    existingMemoryIds,
    nowIso: now,
    correctionForEpisode: correctionFor === null ? null : { scope_refs: correctionFor.scopeRefs, tools: correctionFor.tools },
  });

  db.run("BEGIN");
  let op: ReconcileWriteOp;
  try {
    op = reconcileRun(db, {
      descriptor: options.descriptor,
      runId,
      validated,
      ctx: {
        now,
        config,
        run: { provider: "replay", model: "replay", promptSha256: sha256Hex(built.prompt), inputChars: built.prompt.length, startedAt: now, rawOutputRef: null },
        seqMap: built.seqMap,
        correctionForEpisode: correctionFor,
        paths: null,
        alreadyApplied: (id) => hasWriteOp(db, id),
      },
    });
    if (op.noop && !op.wrote) {
      db.run("ROLLBACK");
      return { op, runId, committed: false };
    }
    if (!op.noop) {
      derivePolicyRules(db, { now });
      const generation = getDbGeneration(db) + 1;
      setDbGeneration(db, generation);
      if (op.id !== null) insertWriteOp(db, op.id, op.kind, generation, now);
    }
    db.run("COMMIT");
  } catch (error) {
    db.run("ROLLBACK");
    throw error;
  }
  return { op, runId, committed: true };
}
