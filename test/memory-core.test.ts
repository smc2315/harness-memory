import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { Database as SqlJsDatabase } from "sql.js";

import { semanticKey } from "../src/core/ids";
import {
  DuplicateMemoryContentError,
  InvalidMemoryTransitionError,
  MemoryNotFoundError,
  MemoryRepository,
  createMemoryIdentityKey,
  createRevivedMemoryId,
  type CreateMemoryInput,
  type UpdateMemoryInput,
} from "../src/memory";
import { transitionMemory } from "../src/promotion";
import { createTestDb } from "./helpers/create-test-db";
import { T0, autoMemory, humanMemory, isoPlus } from "./helpers/memory-fixtures";

describe("MemoryRepository", () => {
  let db: SqlJsDatabase;
  let repository: MemoryRepository;

  beforeEach(async () => {
    db = await createTestDb();
    repository = new MemoryRepository(db, { clock: () => T0 });
  });

  afterEach(() => {
    db.close();
  });

  test("creates and reads a memory with normalized lifecycle triggers and v0.6 defaults", () => {
    const created = repository.create({
      type: "policy",
      summary: "Prefer explicit adapters",
      details: "Keep repository and adapter boundaries thin.",
      scopeGlob: "src/**/*.ts",
      lifecycleTriggers: ["before_model", "session_start"],
      confidence: 0.9,
      importance: 0.8,
      status: "active",
      authority: "human",
      sourceKind: "manual",
      createdAt: "2026-03-28T00:00:00.000Z",
      updatedAt: "2026-03-28T00:00:00.000Z",
    });

    expect(created.lifecycleTriggers).toEqual(["session_start", "before_model"]);
    expect(created.authority).toBe("human");
    expect(created.sourceKind).toBe("manual");
    expect(created.enforcement).toBe("advise");
    expect(created.knowledgeKind).toBeNull();
    expect(created.triggerSignature).toBeNull();
    expect(created.signatureKey).toBe("");
    expect(created.semanticKey).toBe(semanticKey("policy", "src/**/*.ts", "", "Prefer explicit adapters"));
    expect(created.aliases).toEqual([]);
    expect(created.failureClasses).toEqual([]);
    expect(created.evidenceScore).toBe(0);
    expect(created.evidenceCount).toBe(0);
    expect(created.distinctSessionCount).toBe(0);
    expect(created.fireCount).toBe(0);
    expect(created.overrideCount).toBe(0);
    expect(created.contested).toBe(0);
    expect(created.needsScope).toBe(0);
    expect(created.importUnconfirmed).toBe(0);
    expect(created.statusReason).toBeNull();
    expect(created.supersededByMemoryId).toBeNull();
    expect(created.openProposalId).toBeNull();
    expect(created.lastFiredAt).toBeNull();
    expect(created.revalidateAfter).toBeNull();
    expect(repository.getById(created.id)).toEqual(created);
    expect(repository.getByContentHash(created.contentHash)?.id).toBe(created.id);
    expect(repository.getBySemanticKey(created.semanticKey!)?.id).toBe(created.id);
  });

  test("round-trips every v0.6 input field", () => {
    const created = repository.create(
      autoMemory({
        summary: "Run pm test before pushing",
        triggerSignature: { tool: "bash", target: "command", pattern_kind: "cmd", pattern: "pm test", negate: false },
        signatureKey: "bash|command|cmd|pm test",
        aliases: ["테스트", "unit tests", "테스트"],
        failureClasses: ["exit_1", "timeout"],
        knowledgeKind: "failure_resolution",
        enforcement: "soft_deny",
        sourceRef: "episode:ep-42",
        ttlExpiresAt: isoPlus(T0, { days: 30 }),
        revalidateAfter: isoPlus(T0, { days: 15 }),
        importUnconfirmed: 1,
        needsScope: 1,
        relevantTools: ["bash"],
        policySubtype: "hard",
        promotionSource: "auto",
        validationCount: 2,
      })
    );

    expect(created.authority).toBe("auto");
    expect(created.sourceKind).toBe("extraction");
    expect(created.triggerSignature).toEqual({ tool: "bash", target: "command", pattern_kind: "cmd", pattern: "pm test" });
    expect(created.signatureKey).toBe("bash|command|cmd|pm test");
    expect(created.semanticKey).toBe(semanticKey("pitfall", "**/*", "bash|command|cmd|pm test", "Run pm test before pushing"));
    expect(created.aliases).toEqual(["unit tests", "테스트"]);
    expect(created.failureClasses).toEqual(["exit_1", "timeout"]);
    expect(created.knowledgeKind).toBe("failure_resolution");
    expect(created.enforcement).toBe("soft_deny");
    expect(created.sourceRef).toBe("episode:ep-42");
    expect(created.ttlExpiresAt).toBe(isoPlus(T0, { days: 30 }));
    expect(created.revalidateAfter).toBe(isoPlus(T0, { days: 15 }));
    expect(created.importUnconfirmed).toBe(1);
    expect(created.needsScope).toBe(1);
    expect(created.policySubtype).toBe("hard");
    expect(created.promotionSource).toBe("auto");
    expect(created.validationCount).toBe(2);
    expect(repository.getById(created.id)).toEqual(created);
  });

  test("derives a structural signature key when the caller omits it", () => {
    const created = repository.create(
      autoMemory({
        triggerSignature: { tool: "edit|write", target: "path", pattern_kind: "glob", pattern: "src/**/*.sql", negate: true },
      })
    );

    expect(created.signatureKey).toBe("edit|write|path|glob|src/**/*.sql|!");
    expect(created.triggerSignature?.negate).toBe(true);
  });

  test("requires authority and sourceKind at runtime (spec G3) and validates enum inputs", () => {
    const base = humanMemory();
    const withoutAuthority = { ...base } as Partial<CreateMemoryInput>;
    delete withoutAuthority.authority;
    const withoutSourceKind = { ...base } as Partial<CreateMemoryInput>;
    delete withoutSourceKind.sourceKind;

    expect(() => repository.create(withoutAuthority as CreateMemoryInput)).toThrow(/authority is required/);
    expect(() => repository.create(withoutSourceKind as CreateMemoryInput)).toThrow(/sourceKind is required/);
    expect(() => repository.create(humanMemory({ enforcement: "block" as unknown as "deny" }))).toThrow(/enforcement/);
    expect(() => repository.create(humanMemory({ knowledgeKind: "lore" as unknown as "manual" }))).toThrow(/knowledgeKind/);
    expect(repository.list()).toHaveLength(0);
  });

  test("uses the injected clock for created_at and updated_at", () => {
    const created = repository.create(humanMemory({ createdAt: undefined, updatedAt: undefined }));

    expect(created.createdAt).toBe(T0);
    expect(created.updatedAt).toBe(T0);
  });

  test("lists memories in deterministic order and supports filters", () => {
    const candidate = repository.create(
      autoMemory({
        type: "workflow",
        summary: "Run migrations before inspect",
        details: "Initialize the db before repository smoke tests.",
        scopeGlob: "src/db/**/*.ts",
        lifecycleTriggers: ["session_start"],
        createdAt: "2026-03-28T00:00:00.000Z",
        updatedAt: "2026-03-28T00:00:00.000Z",
      })
    );
    const active = repository.create(
      humanMemory({
        summary: "Prefer explicit adapters",
        details: "Keep repository and adapter boundaries thin.",
        createdAt: "2026-03-28T01:00:00.000Z",
        updatedAt: "2026-03-28T01:00:00.000Z",
      })
    );

    expect(repository.list().map((memory) => memory.id)).toEqual([active.id, candidate.id]);
    expect(repository.list({ status: "active" }).map((memory) => memory.id)).toEqual([active.id]);
    expect(repository.list({ type: ["workflow"] }).map((memory) => memory.id)).toEqual([candidate.id]);
    expect(repository.list({ authority: "auto" }).map((memory) => memory.id)).toEqual([candidate.id]);
    expect(repository.list({ sourceKind: ["manual"] }).map((memory) => memory.id)).toEqual([active.id]);
    expect(repository.list({ knowledgeKind: "correction" }).map((memory) => memory.id)).toEqual([candidate.id]);
    expect(repository.list({ scopeGlob: "src/db/**/*.ts" }).map((memory) => memory.id)).toEqual([candidate.id]);
    expect(repository.list({ createdBefore: "2026-03-28T00:30:00.000Z" }).map((memory) => memory.id)).toEqual([candidate.id]);
    expect(repository.list({ limit: 1 }).map((memory) => memory.id)).toEqual([active.id]);
    expect(repository.list({ limit: 1, offset: 1 }).map((memory) => memory.id)).toEqual([candidate.id]);
    expect(repository.countByStatus()).toEqual({ candidate: 1, active: 1, stale: 0, superseded: 0, rejected: 0 });
  });

  test("filters by TTL expiry and revalidation due dates", () => {
    const expiring = repository.create(autoMemory({ status: "active", ttlExpiresAt: isoPlus(T0, { days: 1 }), revalidateAfter: T0 }));
    repository.create(autoMemory({ status: "active", ttlExpiresAt: isoPlus(T0, { days: 20 }), revalidateAfter: isoPlus(T0, { days: 10 }) }));
    repository.create(humanMemory());

    expect(repository.list({ ttlExpiredBefore: isoPlus(T0, { days: 2 }) }).map((m) => m.id)).toEqual([expiring.id]);
    expect(repository.list({ revalidateDueBefore: isoPlus(T0, { days: 1 }) }).map((m) => m.id)).toEqual([expiring.id]);
  });

  test("updates content and recomputes identity and semantic keys", () => {
    const original = repository.create(
      humanMemory({
        type: "decision",
        summary: "Use sql.js for local-first persistence",
        details: "Keep SQLite embedded and inspectable.",
        lifecycleTriggers: ["session_start"],
      })
    );

    const updated = repository.update(original.id, {
      details: "Keep SQLite embedded, inspectable, and WAL-friendly.",
      summary: "Use sql.js for persistence",
      updatedAt: "2026-03-28T02:00:00.000Z",
      lastVerifiedAt: "2026-03-28T02:05:00.000Z",
      aliases: ["sqlite"],
    });

    expect(updated).not.toBeNull();
    expect(updated?.status).toBe("active");
    expect(updated?.lastVerifiedAt).toBe("2026-03-28T02:05:00.000Z");
    expect(updated?.updatedAt).toBe("2026-03-28T02:00:00.000Z");
    expect(updated?.details).toContain("WAL-friendly");
    expect(updated?.aliases).toEqual(["sqlite"]);
    expect(updated?.identityKey).toBe(
      createMemoryIdentityKey({
        type: "decision",
        summary: "Use sql.js for persistence",
        details: "Keep SQLite embedded, inspectable, and WAL-friendly.",
        scopeGlob: "src/**/*.ts",
        lifecycleTriggers: ["session_start"],
      })
    );
    expect(updated?.semanticKey).toBe(semanticKey("decision", "src/**/*.ts", "", "Use sql.js for persistence"));
    expect(updated?.identityKey).not.toBe(original.identityKey);
  });

  test("update rejects status and authority (they go through transitionMemory / setAuthority)", () => {
    const memory = repository.create(humanMemory());

    expect(() => repository.update(memory.id, { status: "stale" } as unknown as UpdateMemoryInput)).toThrow(
      InvalidMemoryTransitionError
    );
    expect(() => repository.update(memory.id, { status: "stale" } as unknown as UpdateMemoryInput)).toThrow(
      /transitionMemory/
    );
    expect(() => repository.update(memory.id, { authority: "auto" } as unknown as UpdateMemoryInput)).toThrow(
      /setAuthority/
    );
    expect(repository.getById(memory.id)).toEqual(memory);
    expect(repository.update("missing", { summary: "x" })).toBeNull();
  });

  test("update refuses to collide with another live row", () => {
    const first = repository.create(humanMemory({ summary: "First summary" }));
    const second = repository.create(humanMemory({ summary: "Second summary" }));

    expect(() => repository.update(second.id, { summary: "First summary" })).toThrow(DuplicateMemoryContentError);
    expect(repository.getById(second.id)).toEqual(second);
    expect(repository.getById(first.id)).toEqual(first);
  });

  test("createOrGet returns the live twin and create keeps strict duplicate errors", () => {
    const input = humanMemory({
      summary: "Prefer explicit adapters",
      details: "Keep repository and adapter boundaries thin.",
      lifecycleTriggers: ["before_model", "session_start"],
    });
    const first = repository.createOrGet(input);
    const duplicate = repository.createOrGet({ ...input, lifecycleTriggers: ["session_start", "before_model"] });

    expect(first.isNew).toBe(true);
    expect(duplicate.isNew).toBe(false);
    expect(duplicate.memory.id).toBe(first.memory.id);
    expect(repository.list().length).toBe(1);

    let error: unknown;
    try {
      repository.create(input);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(DuplicateMemoryContentError);
    expect((error as DuplicateMemoryContentError).matchedBy).toBe("identity_key");
    expect((error as DuplicateMemoryContentError).existingMemoryId).toBe(first.memory.id);
  });

  test("createOrGet returns the live semantic twin when only the details differ", () => {
    const first = repository.createOrGet(humanMemory({ summary: "Same claim", details: "Details A." }));
    const twin = repository.createOrGet(humanMemory({ summary: "Same claim", details: "Details B." }));

    expect(twin.isNew).toBe(false);
    expect(twin.memory.id).toBe(first.memory.id);
  });

  test("a live semantic twin (same type/scope/summary, different details) is a duplicate", () => {
    const first = repository.create(humanMemory({ summary: "Same claim", details: "Details A." }));

    let error: unknown;
    try {
      repository.create(humanMemory({ summary: "same claim.", details: "Details B." }));
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(DuplicateMemoryContentError);
    expect((error as DuplicateMemoryContentError).matchedBy).toBe("semantic_key");
    expect((error as DuplicateMemoryContentError).existingMemoryId).toBe(first.id);
  });

  test("allows same text when scope differs", () => {
    const first = repository.create(humanMemory({ summary: "Prefer explicit adapters", details: "Thin boundaries.", scopeGlob: "src/core/**/*.ts" }));
    const second = repository.create(humanMemory({ summary: "Prefer explicit adapters", details: "Thin boundaries.", scopeGlob: "src/db/**/*.ts" }));

    expect(first.id).not.toBe(second.id);
    expect(first.contentHash).toBe(second.contentHash);
    expect(repository.list({ status: "active" })).toHaveLength(2);
  });

  test("duplicate detection ignores terminal rows; reviveTerminal creates a deterministic new row (R5)", () => {
    const input = autoMemory({ summary: "Never force-push main" });
    const original = repository.create(input);
    transitionMemory(db, { memoryId: original.id, to: "rejected", actor: "human", reason: "test", now: T0 });

    expect(repository.getByIdentityKey(original.identityKey!)).toBeNull();
    expect(repository.getByIdentityKey(original.identityKey!, { live: false })?.id).toBe(original.id);
    expect(repository.getBySemanticKey(original.semanticKey!)).toBeNull();

    let error: unknown;
    try {
      repository.create(input);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(DuplicateMemoryContentError);
    expect((error as DuplicateMemoryContentError).matchedBy).toBe("terminal_twin");

    const revived = repository.create({ ...input, reviveTerminal: true });

    expect(revived.id).toBe(createRevivedMemoryId(original.identityKey!, 1));
    expect(revived.id).not.toBe(original.id);
    expect(revived.identityKey).toBe(original.identityKey);
    expect(revived.status).toBe("candidate");
    expect(repository.getByIdentityKey(original.identityKey!)?.id).toBe(revived.id);
    expect(repository.getByIdentityKey(original.identityKey!, { live: false })?.id).toBe(revived.id);
    expect(repository.list({ status: "rejected" })).toHaveLength(1);

    transitionMemory(db, { memoryId: revived.id, to: "rejected", actor: "human", reason: "again", now: T0 });
    const third = repository.create({ ...input, reviveTerminal: true });
    expect(third.id).toBe(createRevivedMemoryId(original.identityKey!, 2));
  });

  test("an explicit id wins over the deterministic one", () => {
    const created = repository.create(humanMemory({ id: "mem_custom_001" }));

    expect(created.id).toBe("mem_custom_001");
  });

  test("creates memory with relevantTools and reads them back", () => {
    const created = repository.create(humanMemory({ type: "pitfall", lifecycleTriggers: ["before_tool"], relevantTools: ["bash", "edit"] }));

    expect(created.relevantTools).toEqual(["bash", "edit"]);
    expect(repository.getById(created.id)?.relevantTools).toEqual(["bash", "edit"]);
    expect(repository.create(humanMemory()).relevantTools).toBeNull();
    expect(repository.update(created.id, { relevantTools: ["bash", "read", "edit"] })?.relevantTools).toEqual(["bash", "edit", "read"]);
  });

  test("embeddings and summary embeddings round-trip independently", () => {
    const created = repository.create(humanMemory());
    repository.updateEmbedding(created.id, new Float32Array([0.4, 0.5, 0.6]));
    repository.updateEmbeddingSummary(created.id, new Float32Array([0.1, 0.2, 0.3]));

    const fetched = repository.getById(created.id);
    expect(fetched?.embedding?.[0]).toBeCloseTo(0.4);
    expect(fetched?.embeddingSummary?.[0]).toBeCloseTo(0.1);
    expect(repository.listWithEmbeddings().map((memory) => memory.id)).toEqual([created.id]);

    const other = repository.create(humanMemory());
    repository.updateEmbeddingSummary(other.id, new Float32Array([0.7]));
    expect(repository.getById(other.id)?.embedding).toBeNull();
    expect(repository.getById(other.id)?.embeddingSummary?.[0]).toBeCloseTo(0.7);
  });

  test("legacy rows without optional JSON columns read with defaults", () => {
    const id = "legacy-no-tools";
    db.run(
      `INSERT INTO memories (id, content_hash, identity_key, type, summary, details, scope_glob, lifecycle_triggers, confidence, importance, status, activation_class, created_at, updated_at, authority, source_kind)
       VALUES ('${id}', 'hash1', 'key1', 'policy', 'Legacy policy', 'Old details', '**/*', '["before_model"]', 0.5, 0.5, 'active', 'scoped', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 'human', 'legacy')`
    );
    const fetched = repository.getById(id);

    expect(fetched?.relevantTools).toBeNull();
    expect(fetched?.semanticKey).toBeNull();
    expect(fetched?.aliases).toEqual([]);
    expect(fetched?.failureClasses).toEqual([]);
    expect(fetched?.signatureKey).toBe("");
    expect(fetched?.sourceKind).toBe("legacy");
  });

  test("update keeps a NULL semantic key NULL (post-migrate merge losers stay out of the unique index)", () => {
    const id = "legacy-null-semantic";
    db.run(
      `INSERT INTO memories (id, content_hash, identity_key, type, summary, details, scope_glob, lifecycle_triggers, confidence, importance, status, activation_class, created_at, updated_at, authority, source_kind)
       VALUES ('${id}', 'hash2', 'key2', 'policy', 'Legacy policy two', 'Old details', '**/*', '["before_model"]', 0.5, 0.5, 'active', 'scoped', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 'human', 'legacy')`
    );

    expect(repository.update(id, { details: "New details" })?.semanticKey).toBeNull();
  });

  describe("focused mutators", () => {
    test("updateDerived writes counters and optional confidence without touching updated_at by default", () => {
      const memory = repository.create(autoMemory({ confidence: 0.6 }));
      const updated = repository.updateDerived(memory.id, { evidenceScore: 3.5, evidenceCount: 2, distinctSessionCount: 2, confidence: 0.85 });

      expect(updated.evidenceScore).toBe(3.5);
      expect(updated.evidenceCount).toBe(2);
      expect(updated.distinctSessionCount).toBe(2);
      expect(updated.confidence).toBe(0.85);
      expect(updated.updatedAt).toBe(memory.updatedAt);
      expect(repository.updateDerived(memory.id, { evidenceScore: 4, evidenceCount: 3, distinctSessionCount: 2 }).confidence).toBe(0.85);
      expect(() => repository.updateDerived("missing", { evidenceScore: 0, evidenceCount: 0, distinctSessionCount: 0 })).toThrow(MemoryNotFoundError);
    });

    test("recordFire accumulates counters and keeps the latest fire time", () => {
      const memory = repository.create(autoMemory({ status: "active" }));
      const later = isoPlus(T0, { hours: 2 });
      const earlier = isoPlus(T0, { hours: 1 });

      const first = repository.recordFire(memory.id, { at: later, count: 2, overrideDelta: 1 });
      expect(first.fireCount).toBe(2);
      expect(first.overrideCount).toBe(1);
      expect(first.lastFiredAt).toBe(later);

      const second = repository.recordFire(memory.id, { at: earlier });
      expect(second.fireCount).toBe(3);
      expect(second.overrideCount).toBe(1);
      expect(second.lastFiredAt).toBe(later);
      expect(second.updatedAt).toBe(memory.updatedAt);
    });

    test("setEnforcement, setAliases and setFlags", () => {
      const memory = repository.create(humanMemory());

      expect(repository.setEnforcement(memory.id, "confirm", isoPlus(T0, { minutes: 1 })).enforcement).toBe("confirm");
      expect(repository.getById(memory.id)?.updatedAt).toBe(isoPlus(T0, { minutes: 1 }));
      expect(() => repository.setEnforcement(memory.id, "block" as unknown as "deny")).toThrow(/enforcement/);

      expect(repository.setAliases(memory.id, ["b", "a", "a", " "]).aliases).toEqual(["a", "b"]);

      const flagged = repository.setFlags(memory.id, { contested: 1, openProposalId: "prop-1" });
      expect(flagged.contested).toBe(1);
      expect(flagged.openProposalId).toBe("prop-1");
      expect(flagged.needsScope).toBe(0);

      const cleared = repository.setFlags(memory.id, { openProposalId: null, needsScope: 1 });
      expect(cleared.contested).toBe(1);
      expect(cleared.openProposalId).toBeNull();
      expect(cleared.needsScope).toBe(1);
    });

    test("setScope recomputes identity and semantic keys and rejects live collisions", () => {
      const memory = repository.create(humanMemory({ summary: "Scoped claim", scopeGlob: "src/a/**" }));
      const moved = repository.setScope(memory.id, {
        scopeGlob: "src/b/**",
        lifecycleTriggers: ["before_tool", "before_model"],
        triggerSignature: { tool: "bash", target: "command", pattern_kind: "cmd", pattern: "pm test" },
        signatureKey: "bash|command|cmd|pm test",
        activationClass: "event",
      });

      expect(moved.scopeGlob).toBe("src/b/**");
      expect(moved.lifecycleTriggers).toEqual(["before_model", "before_tool"]);
      expect(moved.activationClass).toBe("event");
      expect(moved.triggerSignature?.pattern).toBe("pm test");
      expect(moved.signatureKey).toBe("bash|command|cmd|pm test");
      expect(moved.identityKey).toBe(
        createMemoryIdentityKey({
          type: memory.type,
          summary: memory.summary,
          details: memory.details,
          scopeGlob: "src/b/**",
          lifecycleTriggers: ["before_model", "before_tool"],
        })
      );
      expect(moved.semanticKey).toBe(semanticKey("policy", "src/b/**", "bash|command|cmd|pm test", "Scoped claim"));

      const cleared = repository.setScope(memory.id, { scopeGlob: "src/b/**", triggerSignature: null });
      expect(cleared.triggerSignature).toBeNull();
      expect(cleared.signatureKey).toBe("");

      const other = repository.create(humanMemory({ summary: "Scoped claim", scopeGlob: "src/c/**" }));
      expect(() => repository.setScope(other.id, { scopeGlob: "src/b/**" })).toThrow(DuplicateMemoryContentError);
      expect(repository.getById(other.id)?.scopeGlob).toBe("src/c/**");
    });

    test("setAuthority human clears TTL columns and marks the promotion manual", () => {
      const memory = repository.create(
        autoMemory({ status: "active", promotionSource: "auto", ttlExpiresAt: isoPlus(T0, { days: 7 }), revalidateAfter: isoPlus(T0, { days: 3 }) })
      );
      const human = repository.setAuthority(memory.id, "human", isoPlus(T0, { minutes: 5 }));

      expect(human.authority).toBe("human");
      expect(human.promotionSource).toBe("manual");
      expect(human.ttlExpiresAt).toBeNull();
      expect(human.revalidateAfter).toBeNull();
      expect(human.updatedAt).toBe(isoPlus(T0, { minutes: 5 }));

      const auto = repository.setAuthority(memory.id, "auto");
      expect(auto.authority).toBe("auto");
      expect(auto.promotionSource).toBe("manual");
    });

    test("setTtl writes TTL, revalidation, validation count and last_verified_at", () => {
      const memory = repository.create(autoMemory({ status: "active" }));
      const updated = repository.setTtl(memory.id, {
        ttlExpiresAt: isoPlus(T0, { days: 14 }),
        revalidateAfter: isoPlus(T0, { days: 7 }),
        validationCount: 1,
        lastVerifiedAt: isoPlus(T0, { hours: 1 }),
        updatedAt: isoPlus(T0, { hours: 1 }),
      });

      expect(updated.ttlExpiresAt).toBe(isoPlus(T0, { days: 14 }));
      expect(updated.revalidateAfter).toBe(isoPlus(T0, { days: 7 }));
      expect(updated.validationCount).toBe(1);
      expect(updated.lastVerifiedAt).toBe(isoPlus(T0, { hours: 1 }));
      expect(updated.updatedAt).toBe(isoPlus(T0, { hours: 1 }));

      const cleared = repository.setTtl(memory.id, { ttlExpiresAt: null, revalidateAfter: null });
      expect(cleared.ttlExpiresAt).toBeNull();
      expect(cleared.validationCount).toBe(1);
    });
  });

  test("lineage helpers follow supersedes_memory_id", () => {
    const root = repository.create(humanMemory({ summary: "Root" }));
    const child = repository.create(humanMemory({ summary: "Child", supersedesMemoryId: root.id }));
    transitionMemory(db, { memoryId: root.id, to: "superseded", actor: "human", reason: "replaced", now: T0, replacementId: child.id });

    const lineage = repository.getLineage(child.id);
    expect(lineage.root.id).toBe(root.id);
    expect(lineage.ancestors.map((memory) => memory.id)).toEqual([root.id]);
    expect(repository.getLineage(root.id).descendants.map((memory) => memory.id)).toEqual([child.id]);
    expect(repository.getHistory(child.id).map((entry) => entry.relation)).toEqual(["ancestor", "focus"]);
    expect(repository.listLineageConflicts([root.id, child.id])).toHaveLength(1);
  });

  test("evidence notes round-trip", () => {
    const memory = repository.create(humanMemory());
    const evidence = repository.createEvidence({
      memoryId: memory.id,
      sourceKind: "manual_note",
      sourceRef: "memory:reject",
      excerpt: "Low value",
      createdAt: T0,
    });

    expect(repository.listEvidence(memory.id)).toEqual([evidence]);
    expect(() => repository.listEvidence("missing")).toThrow(MemoryNotFoundError);
  });
});
