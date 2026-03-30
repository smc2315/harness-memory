import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { Database as SqlJsDatabase } from "sql.js";

import {
  DuplicateMemoryContentError,
  MemoryRepository,
} from "../src/memory";
import { createTestDb } from "./helpers/create-test-db";

describe("MemoryRepository", () => {
  let db: SqlJsDatabase;
  let repository: MemoryRepository;

  beforeEach(async () => {
    db = await createTestDb();
    repository = new MemoryRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  test("creates and reads a memory with normalized lifecycle triggers", () => {
    const created = repository.create({
      type: "policy",
      summary: "Prefer explicit adapters",
      details: "Keep repository and adapter boundaries thin.",
      scopeGlob: "src/**/*.ts",
      lifecycleTriggers: ["before_model", "session_start"],
      confidence: 0.9,
      importance: 0.8,
      status: "active",
      createdAt: "2026-03-28T00:00:00.000Z",
      updatedAt: "2026-03-28T00:00:00.000Z",
    });

    expect(created.lifecycleTriggers).toEqual([
      "session_start",
      "before_model",
    ]);
    expect(repository.getById(created.id)).toEqual(created);
    expect(repository.getByContentHash(created.contentHash)?.id).toBe(created.id);
  });

  test("lists memories in deterministic order and supports filters", () => {
    const candidate = repository.create({
      type: "workflow",
      summary: "Run migrations before inspect",
      details: "Initialize the db before repository smoke tests.",
      scopeGlob: "src/db/**/*.ts",
      lifecycleTriggers: ["session_start"],
      status: "candidate",
      createdAt: "2026-03-28T00:00:00.000Z",
      updatedAt: "2026-03-28T00:00:00.000Z",
    });
    const active = repository.create({
      type: "policy",
      summary: "Prefer explicit adapters",
      details: "Keep repository and adapter boundaries thin.",
      scopeGlob: "src/**/*.ts",
      lifecycleTriggers: ["before_model"],
      status: "active",
      createdAt: "2026-03-28T01:00:00.000Z",
      updatedAt: "2026-03-28T01:00:00.000Z",
    });

    expect(repository.list().map((memory) => memory.id)).toEqual([
      active.id,
      candidate.id,
    ]);
    expect(
      repository.list({ status: "active" }).map((memory) => memory.id)
    ).toEqual([active.id]);
    expect(repository.list({ type: ["workflow"] }).map((memory) => memory.id)).toEqual([
      candidate.id,
    ]);
  });

  test("updates memory details and status transitions", () => {
    const original = repository.create({
      type: "decision",
      summary: "Use sql.js for local-first persistence",
      details: "Keep SQLite embedded and inspectable.",
      scopeGlob: "src/**/*.ts",
      lifecycleTriggers: ["session_start"],
      status: "candidate",
      createdAt: "2026-03-28T00:00:00.000Z",
      updatedAt: "2026-03-28T00:00:00.000Z",
    });

    const updated = repository.update(original.id, {
      details: "Keep SQLite embedded, inspectable, and WAL-friendly.",
      status: "stale",
      updatedAt: "2026-03-28T02:00:00.000Z",
      lastVerifiedAt: "2026-03-28T02:05:00.000Z",
    });

    expect(updated).not.toBeNull();
    expect(updated?.status).toBe("stale");
    expect(updated?.lastVerifiedAt).toBe("2026-03-28T02:05:00.000Z");
    expect(updated?.details).toContain("WAL-friendly");
  });

  test("returns existing memory on repeated promotion and preserves strict create errors", () => {
    const first = repository.createOrGet({
      type: "policy",
      summary: "Prefer explicit adapters",
      details: "Keep repository and adapter boundaries thin.",
      scopeGlob: "src/**/*.ts",
      lifecycleTriggers: ["before_model", "session_start"],
      status: "active",
      createdAt: "2026-03-28T00:00:00.000Z",
      updatedAt: "2026-03-28T00:00:00.000Z",
    });
    const duplicate = repository.createOrGet({
      type: "policy",
      summary: "Prefer explicit adapters",
      details: "Keep repository and adapter boundaries thin.",
      scopeGlob: "src/**/*.ts",
      lifecycleTriggers: ["session_start", "before_model"],
      status: "active",
      createdAt: "2026-03-28T00:05:00.000Z",
      updatedAt: "2026-03-28T00:05:00.000Z",
    });

    expect(first.isNew).toBe(true);
    expect(duplicate.isNew).toBe(false);
    expect(duplicate.memory.id).toBe(first.memory.id);
    expect(repository.list().length).toBe(1);

    expect(() =>
      repository.create({
        type: "policy",
        summary: "Prefer explicit adapters",
        details: "Keep repository and adapter boundaries thin.",
        scopeGlob: "src/**/*.ts",
        lifecycleTriggers: ["session_start", "before_model"],
        status: "active",
      })
    ).toThrow(DuplicateMemoryContentError);
  });

  test("allows same text when scope differs", () => {
    const first = repository.create({
      type: "policy",
      summary: "Prefer explicit adapters",
      details: "Keep repository and adapter boundaries thin.",
      scopeGlob: "src/core/**/*.ts",
      lifecycleTriggers: ["before_model"],
      status: "active",
      createdAt: "2026-03-28T00:00:00.000Z",
      updatedAt: "2026-03-28T00:00:00.000Z",
    });
    const second = repository.create({
      type: "policy",
      summary: "Prefer explicit adapters",
      details: "Keep repository and adapter boundaries thin.",
      scopeGlob: "src/db/**/*.ts",
      lifecycleTriggers: ["before_model"],
      status: "active",
      createdAt: "2026-03-28T00:05:00.000Z",
      updatedAt: "2026-03-28T00:05:00.000Z",
    });

    expect(first.id).not.toBe(second.id);
    expect(repository.list({ status: "active" })).toHaveLength(2);
  });

  test("rejects candidate memory with a real rejected status", () => {
    const candidate = repository.create({
      type: "pitfall",
      summary: "Temporary candidate",
      details: "This should be rejected after review.",
      scopeGlob: "src/**/*.ts",
      lifecycleTriggers: ["before_tool"],
      status: "candidate",
      createdAt: "2026-03-28T00:00:00.000Z",
      updatedAt: "2026-03-28T00:00:00.000Z",
    });

    const result = repository.rejectMemory({
      memoryId: candidate.id,
      reason: "Low-value one-off note",
      updatedAt: "2026-03-28T02:00:00.000Z",
      lastVerifiedAt: "2026-03-28T02:00:00.000Z",
    });

    expect(result.memory.status).toBe("rejected");
    expect(result.evidence?.sourceRef).toBe("memory:reject");
    expect(repository.list({ status: "candidate" })).toHaveLength(0);
    expect(repository.list({ status: "rejected" })).toHaveLength(1);
  });
});
