/**
 * Shared fixtures for the A2 test files (memory repository, db repositories, transitions, revalidate).
 * Every input carries the REQUIRED `authority` / `sourceKind` and a fixed clock so no test reads wall time.
 */

import type { Database as SqlJsDatabase } from "sql.js";

import { EPISODE_SCHEMA, type EpisodeDescriptor } from "../../src/core/episode-types";
import { EpisodeRepository } from "../../src/db/repositories/episodes";
import type { CreateMemoryInput } from "../../src/memory";

export const T0 = "2026-11-08T00:00:00.000Z";

export interface IsoOffset {
  days?: number;
  hours?: number;
  minutes?: number;
  seconds?: number;
}

export function isoPlus(base: string, offset: IsoOffset): string {
  const ms =
    (offset.days ?? 0) * 24 * 60 * 60 * 1000 +
    (offset.hours ?? 0) * 60 * 60 * 1000 +
    (offset.minutes ?? 0) * 60 * 1000 +
    (offset.seconds ?? 0) * 1000;

  return new Date(Date.parse(base) + ms).toISOString();
}

let memoryCounter = 0;

/** A human / manual memory input (what memory:add, import and CLI fixtures write). */
export function humanMemory(overrides: Partial<CreateMemoryInput> = {}): CreateMemoryInput {
  memoryCounter += 1;

  return {
    type: "policy",
    summary: `Human memory ${String(memoryCounter)}`,
    details: `Details for human memory ${String(memoryCounter)}.`,
    scopeGlob: "src/**/*.ts",
    lifecycleTriggers: ["before_model"],
    status: "active",
    authority: "human",
    sourceKind: "manual",
    knowledgeKind: "manual",
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

/** An extraction-born auto candidate (what reconcile step 4 writes). */
export function autoMemory(overrides: Partial<CreateMemoryInput> = {}): CreateMemoryInput {
  memoryCounter += 1;

  return {
    type: "pitfall",
    summary: `Auto memory ${String(memoryCounter)}`,
    details: `Details for auto memory ${String(memoryCounter)}.`,
    scopeGlob: "**/*",
    lifecycleTriggers: ["before_tool"],
    status: "candidate",
    authority: "auto",
    sourceKind: "extraction",
    knowledgeKind: "correction",
    sourceRef: "episode:ep-1",
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

let episodeCounter = 0;

export function episodeDescriptor(overrides: Partial<EpisodeDescriptor> = {}): EpisodeDescriptor {
  episodeCounter += 1;
  const n = String(episodeCounter).padStart(3, "0");

  return {
    schema: EPISODE_SCHEMA,
    id: `ep-${n}`,
    host: "claude-code",
    session_id: `session-${n}`,
    session_key: `key-${n}`,
    turn_key: `turn-${n}`,
    segment: 0,
    started_at: T0,
    closed_at: isoPlus(T0, { minutes: 1 }),
    close_reason: "stop",
    ledger_ref: `ledger/claude-code-key-${n}.jsonl#0-1024`,
    correction_for: null,
    context_ref: null,
    scope_refs: ["src/a.ts"],
    tools: ["bash"],
    failure_signatures: [],
    flags: {},
    fired: [],
    evidence_weight: 1,
    event_count: 3,
    prompt_text: "run the tests",
    last_assistant_message: "done",
    ...overrides,
  };
}

/** Inserts a queued episode row and returns its descriptor. */
export function insertEpisode(
  db: SqlJsDatabase,
  overrides: Partial<EpisodeDescriptor> = {},
  now: string = T0
): EpisodeDescriptor {
  const descriptor = episodeDescriptor(overrides);
  new EpisodeRepository(db).insertIfAbsent(descriptor, now);

  return descriptor;
}
