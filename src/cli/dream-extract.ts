/**
 * CLI: dream:extract
 *
 * Reads unprocessed `conversation-batch` evidence events from the DB,
 * calls the LLM via OpenCode SDK for structured memory extraction,
 * and applies the results (create/reinforce/supersede/stale).
 *
 * Usage:
 *   npx harness-memory dream:extract [--db <path>] [--limit <n>] [--dry-run] [--skip-gates]
 */

import { existsSync, readFileSync, writeFileSync } from "fs";
import { dirname, resolve } from "path";

import { EmbeddingService, cosineSimilarity } from "../activation/embeddings";
import { openSqlJsDatabase, saveSqlJsDatabase } from "../db/sqlite";
import { DreamRepository } from "../dream";
import type { DreamEvidenceEventRecord } from "../dream/types";
import {
  buildExtractionUserPrompt,
  callLlmForExtraction,
  executeExtractionActions,
  parseExtractionResponse,
} from "../dream/llm-extract";
import { MemoryRepository } from "../memory";

// ---------------------------------------------------------------------------
// Scheduler gates (exported for plugin use)
// ---------------------------------------------------------------------------

export interface GateState {
  lastExtractAt: string | null;
  sessionsSinceLastExtract: number;
  lockPid: number | null;
}

export const DEFAULT_MIN_EVIDENCE = 3;
export const DEFAULT_MIN_HOURS = 1;
export const DEFAULT_MIN_SESSIONS = 2;

export function getGateStatePath(dbPath: string): string {
  return resolve(dirname(dbPath), ".dream-extract-state.json");
}

export function readGateState(dbPath: string): GateState {
  const statePath = getGateStatePath(dbPath);

  if (!existsSync(statePath)) {
    return { lastExtractAt: null, sessionsSinceLastExtract: 0, lockPid: null };
  }

  try {
    const raw = readFileSync(statePath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<GateState>;
    return {
      lastExtractAt: parsed.lastExtractAt ?? null,
      sessionsSinceLastExtract: parsed.sessionsSinceLastExtract ?? 0,
      lockPid: parsed.lockPid ?? null,
    };
  } catch {
    return { lastExtractAt: null, sessionsSinceLastExtract: 0, lockPid: null };
  }
}

export function writeGateState(dbPath: string, state: GateState): void {
  const statePath = getGateStatePath(dbPath);
  writeFileSync(statePath, JSON.stringify(state, null, 2), "utf-8");
}

export function incrementSessionCount(dbPath: string): void {
  const state = readGateState(dbPath);
  state.sessionsSinceLastExtract += 1;
  writeGateState(dbPath, state);
}

export function checkGates(
  pendingCount: number,
  state: GateState,
  minEvidence: number = DEFAULT_MIN_EVIDENCE,
  minHours: number = DEFAULT_MIN_HOURS,
  minSessions: number = DEFAULT_MIN_SESSIONS,
): { pass: boolean; reason?: string } {
  // Gate 1: Minimum evidence count
  if (pendingCount < minEvidence) {
    return {
      pass: false,
      reason: `Not enough evidence: ${pendingCount} < ${minEvidence} minimum`,
    };
  }

  // Gate 2: Time since last extraction
  if (state.lastExtractAt !== null) {
    const hoursSinceLastExtract =
      (Date.now() - Date.parse(state.lastExtractAt)) / (1000 * 60 * 60);

    if (hoursSinceLastExtract < minHours) {
      return {
        pass: false,
        reason: `Too soon: ${hoursSinceLastExtract.toFixed(1)}h since last extract (min ${minHours}h)`,
      };
    }
  }

  // Gate 3: Minimum sessions since last extraction
  if (state.sessionsSinceLastExtract < minSessions) {
    return {
      pass: false,
      reason: `Not enough sessions: ${state.sessionsSinceLastExtract} < ${minSessions} minimum`,
    };
  }

  // Gate 4: Lock (prevent concurrent execution)
  if (state.lockPid !== null) {
    try {
      process.kill(state.lockPid, 0);
      return { pass: false, reason: `Locked by PID ${state.lockPid}` };
    } catch {
      // Process is dead — stale lock, ignore
    }
  }

  return { pass: true };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface CliOptions {
  dbPath: string;
  limit: number;
  dryRun: boolean;
  skipGates: boolean;
  minEvidence: number;
  minHours: number;
  json: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  let dbPath = ".harness-memory/memory.sqlite";
  let limit = 10;
  let dryRun = false;
  let skipGates = false;
  let minEvidence = DEFAULT_MIN_EVIDENCE;
  let minHours = DEFAULT_MIN_HOURS;
  let json = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--db" && index + 1 < argv.length) {
      dbPath = argv[index + 1];
      index += 1;
    } else if (arg === "--limit" && index + 1 < argv.length) {
      limit = Number(argv[index + 1]);
      index += 1;
    } else if (arg === "--min-evidence" && index + 1 < argv.length) {
      minEvidence = Number(argv[index + 1]);
      index += 1;
    } else if (arg === "--min-hours" && index + 1 < argv.length) {
      minHours = Number(argv[index + 1]);
      index += 1;
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--skip-gates") {
      skipGates = true;
    } else if (arg === "--json") {
      json = true;
    }
  }

  return { dbPath, limit, dryRun, skipGates, minEvidence, minHours, json };
}

/**
 * Build the extraction prompt (exported for testing).
 */
export function buildExtractionPrompt(
  batches: readonly DreamEvidenceEventRecord[],
  existingMemories: Array<{ type: string; summary: string }>,
  dbPath: string,
): string {
  return buildExtractionUserPrompt(
    batches,
    existingMemories.map((m) => ({ id: "", type: m.type, summary: m.summary, status: "active" })),
  );
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const db = await openSqlJsDatabase(options.dbPath, { requireExists: true });

  try {
    const dreamRepo = new DreamRepository(db);
    const memoryRepo = new MemoryRepository(db);

    // Find unprocessed conversation-batch evidence events.
    const allEvents = dreamRepo.listEvidenceEvents({ limit: options.limit * 10 });
    const pendingBatches = allEvents.filter(
      (event) =>
        event.toolName === "conversation-batch" && event.status === "pending",
    );

    if (pendingBatches.length === 0) {
      if (options.json) {
        console.log(JSON.stringify({ extracted: 0, message: "No pending conversation batches" }));
      } else {
        console.log("No pending conversation batches to process.");
      }

      return;
    }

    // Check scheduler gates
    if (!options.skipGates) {
      const gateState = readGateState(options.dbPath);
      const gateResult = checkGates(
        pendingBatches.length,
        gateState,
        options.minEvidence,
        options.minHours,
      );

      if (!gateResult.pass) {
        if (options.json) {
          console.log(JSON.stringify({ extracted: 0, gateBlocked: true, reason: gateResult.reason }));
        } else {
          console.log(`Gate blocked: ${gateResult.reason}`);
        }

        return;
      }
    }

    // Load existing memories for dedup context
    const existingMemories = memoryRepo
      .list({})
      .filter((m) => m.status === "active" || m.status === "candidate")
      .map((m) => ({ id: m.id, type: m.type, summary: m.summary, status: m.status }));

    const batchesToProcess = pendingBatches.slice(0, options.limit);

    if (options.dryRun) {
      const prompt = buildExtractionUserPrompt(batchesToProcess, existingMemories);
      console.log("=== DRY RUN — Prompt that would be sent to LLM ===\n");
      console.log(prompt);
      console.log(`\n=== ${batchesToProcess.length} batch(es) would be processed ===`);
      return;
    }

    // Acquire lock
    const gateState = readGateState(options.dbPath);
    gateState.lockPid = process.pid;
    writeGateState(options.dbPath, gateState);

    console.log(`Processing ${batchesToProcess.length} conversation batch(es) via OpenCode SDK...`);

    try {
      // Call LLM via SDK
      const extractionResult = await callLlmForExtraction(batchesToProcess, existingMemories);

      console.log(`LLM returned ${extractionResult.facts.length} fact(s).`);

      // Execute actions
      let embeddingService: EmbeddingService | undefined;

      try {
        embeddingService = new EmbeddingService();
        await embeddingService.warmup();
      } catch {
        // Embedding not available — skip dedup
      }

      const actionResults = await executeExtractionActions(extractionResult.facts, {
        memoryRepository: memoryRepo,
        embeddingService,
        cosineSimilarity,
      });

      // Mark batches as consumed
      const dreamRun = dreamRepo.createDreamRun({
        trigger: "manual",
        windowStart: batchesToProcess[0].createdAt,
        windowEnd: batchesToProcess[batchesToProcess.length - 1].createdAt,
        evidenceCount: batchesToProcess.length,
        summary: `dream:extract — ${actionResults.filter((r) => !r.skipped).length} actions applied`,
      });

      dreamRepo.markEvidenceEventsConsumed(
        batchesToProcess.map((b) => b.id),
        dreamRun.id,
      );

      saveSqlJsDatabase(db, options.dbPath);

      // Report results
      const applied = actionResults.filter((r) => !r.skipped);
      const skipped = actionResults.filter((r) => r.skipped);

      if (options.json) {
        console.log(JSON.stringify({ applied, skipped, batchCount: batchesToProcess.length }));
      } else {
        for (const result of applied) {
          console.log(`  ✓ [${result.action}] ${result.summary}`);
        }

        for (const result of skipped) {
          console.log(`  ✗ [${result.action}] ${result.summary} — ${result.reason}`);
        }

        console.log(`\nDone. ${applied.length} applied, ${skipped.length} skipped.`);
        console.log("Run `npx harness-memory memory:list --status candidate` to review.");
      }
    } finally {
      // Release lock and update timestamp
      const finalState = readGateState(options.dbPath);
      finalState.lockPid = null;
      finalState.lastExtractAt = new Date().toISOString();
      writeGateState(options.dbPath, finalState);
    }
  } finally {
    db.close();
  }
}

// Guard: only run when executed directly, not when imported for testing.
const isDirectExecution =
  process.argv[1] !== undefined &&
  (process.argv[1].includes("dream-extract") || process.argv[1].includes("dream:extract"));

if (isDirectExecution) {
  await main();
}
