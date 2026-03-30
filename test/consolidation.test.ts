import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { Database as SqlJsDatabase } from "sql.js";

import { MemoryRepository } from "../src/memory";
import { createTestDb } from "./helpers/create-test-db";

describe("MemoryRepository consolidation", () => {
  let db: SqlJsDatabase;
  let repository: MemoryRepository;

  beforeEach(async () => {
    db = await createTestDb();
    repository = new MemoryRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  function createMemory(input: {
    id: string;
    summary: string;
    details: string;
    status?: "candidate" | "active" | "stale" | "superseded";
    supersedesMemoryId?: string | null;
    createdAt: string;
    updatedAt?: string;
  }) {
    return repository.create({
      id: input.id,
      type: "policy",
      summary: input.summary,
      details: input.details,
      scopeGlob: "src/**/*.ts",
      lifecycleTriggers: ["before_model"],
      confidence: 0.9,
      importance: 0.8,
      status: input.status ?? "candidate",
      supersedesMemoryId: input.supersedesMemoryId,
      createdAt: input.createdAt,
      updatedAt: input.updatedAt ?? input.createdAt,
    });
  }

  test("merges a duplicate source into the surviving target", () => {
    const target = createMemory({
      id: "mem_merge_target",
      summary: "Keep repository adapters thin",
      details: "Use small boundaries for memory repository adapters.",
      status: "active",
      createdAt: "2026-03-29T00:00:00.000Z",
    });
    const source = createMemory({
      id: "mem_merge_source",
      summary: "Thin repository adapters help consolidation",
      details: "Duplicate reminder to keep repository adapters focused.",
      status: "active",
      createdAt: "2026-03-29T00:05:00.000Z",
    });

    const merged = repository.mergeMemories({
      sourceMemoryId: source.id,
      targetMemoryId: target.id,
      targetUpdate: {
        details: "Use small boundaries for memory repository adapters after merge.",
      },
      updatedAt: "2026-03-29T00:10:00.000Z",
    });

    expect(merged.target.id).toBe(target.id);
    expect(merged.target.status).toBe("active");
    expect(merged.target.details).toContain("after merge");
    expect(merged.source.status).toBe("superseded");
    expect(merged.source.supersedesMemoryId).toBe(target.id);
    expect(merged.source.updatedAt).toBe("2026-03-29T00:10:00.000Z");
  });

  test("supersedes a previous memory with an active replacement", () => {
    const previous = createMemory({
      id: "mem_supersede_previous",
      summary: "Prefer session logs for evidence",
      details: "Use session logs when justifying a policy memory.",
      status: "active",
      createdAt: "2026-03-29T01:00:00.000Z",
    });
    const replacement = createMemory({
      id: "mem_supersede_replacement",
      summary: "Prefer task logs for evidence",
      details: "Use task logs when they are more specific than session logs.",
      createdAt: "2026-03-29T01:10:00.000Z",
    });

    const result = repository.supersedeMemory({
      previousMemoryId: previous.id,
      replacementMemoryId: replacement.id,
      updatedAt: "2026-03-29T01:20:00.000Z",
    });
    const history = repository.getHistory(replacement.id);

    expect(result.previous.status).toBe("superseded");
    expect(result.replacement.status).toBe("active");
    expect(result.replacement.supersedesMemoryId).toBe(previous.id);
    expect(history.map((entry) => [entry.relation, entry.memory.id])).toEqual([
      ["ancestor", previous.id],
      ["focus", replacement.id],
    ]);
  });

  test("marks an old memory stale when a fresh replacement takes over", () => {
    const previous = createMemory({
      id: "mem_stale_previous",
      summary: "Run inspect after every schema tweak",
      details: "Inspect the sqlite file after every schema tweak.",
      status: "active",
      createdAt: "2026-03-29T02:00:00.000Z",
    });
    const replacement = createMemory({
      id: "mem_stale_replacement",
      summary: "Run inspect after material schema tweaks",
      details: "Inspect the sqlite file after meaningful schema changes only.",
      createdAt: "2026-03-29T02:10:00.000Z",
    });

    const result = repository.markMemoryStale({
      previousMemoryId: previous.id,
      replacementMemoryId: replacement.id,
      updatedAt: "2026-03-29T02:20:00.000Z",
    });

    expect(result.previous.status).toBe("stale");
    expect(result.replacement.status).toBe("active");
    expect(result.replacement.supersedesMemoryId).toBe(previous.id);
    expect(result.replacement.updatedAt).toBe("2026-03-29T02:20:00.000Z");
  });

  test("rejects a candidate memory into a real rejected state", () => {
    const memory = createMemory({
      id: "mem_reject_candidate",
      summary: "Auto-promote every duplicate memory",
      details: "Promote duplicates immediately without review.",
      status: "candidate",
      createdAt: "2026-03-29T03:00:00.000Z",
    });

    const rejected = repository.rejectMemory({
      memoryId: memory.id,
      reason: "Rejected during QA because duplicates still need review.",
      sourceRef: "qa/consolidation",
      updatedAt: "2026-03-29T03:10:00.000Z",
      lastVerifiedAt: "2026-03-29T03:15:00.000Z",
    });

    expect(rejected.memory.status).toBe("rejected");
    expect(rejected.memory.lastVerifiedAt).toBe("2026-03-29T03:15:00.000Z");
    expect(rejected.evidence).not.toBeNull();
    expect(rejected.evidence?.sourceKind).toBe("manual_note");
    expect(rejected.evidence?.sourceRef).toBe("qa/consolidation");
  });

  test("attaches lineage evidence to history entries", () => {
    const previous = createMemory({
      id: "mem_history_previous",
      summary: "Prefer visible conflict markers in CLI output",
      details: "Conflict markers should be obvious in text output.",
      status: "active",
      createdAt: "2026-03-29T04:00:00.000Z",
    });
    const replacement = createMemory({
      id: "mem_history_replacement",
      summary: "Prefer visible conflict markers in text and JSON output",
      details: "Conflict markers should be obvious in text and JSON output.",
      createdAt: "2026-03-29T04:10:00.000Z",
    });

    repository.createEvidence({
      memoryId: previous.id,
      sourceKind: "task",
      sourceRef: "task/T9",
      excerpt: "Original evidence",
      createdAt: "2026-03-29T04:01:00.000Z",
    });
    repository.createEvidence({
      memoryId: replacement.id,
      sourceKind: "file",
      sourceRef: "src/cli/memory-why.ts",
      excerpt: "Replacement evidence",
      createdAt: "2026-03-29T04:11:00.000Z",
    });
    repository.supersedeMemory({
      previousMemoryId: previous.id,
      replacementMemoryId: replacement.id,
      updatedAt: "2026-03-29T04:12:00.000Z",
    });

    const history = repository.getHistory(replacement.id);

    expect(
      history.map((entry) => ({
        id: entry.memory.id,
        evidence: entry.evidence.map((evidence) => evidence.excerpt),
      }))
    ).toEqual([
      {
        id: previous.id,
        evidence: ["Original evidence"],
      },
      {
        id: replacement.id,
        evidence: ["Replacement evidence"],
      },
    ]);
  });
});
