import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { Database as SqlJsDatabase } from "sql.js";

import { AuthorityViolationError } from "../src/core/errors";
import {
  AUTHORITIES,
  MEMORY_STATUSES,
  TRANSITION_ACTORS,
  type Authority,
  type MemoryStatus,
  type TransitionActor,
} from "../src/core/vocabulary";
import { TransitionRepository } from "../src/db/repositories";
import {
  InvalidMemoryTransitionError,
  MemoryNotFoundError,
  MemoryRepository,
  type UpdateMemoryInput,
} from "../src/memory";
import { TRANSITION_EDGES, defaultStatusReason, isAllowedTransition, transitionMemory } from "../src/promotion";
import { createTestDb } from "./helpers/create-test-db";
import { T0, autoMemory, humanMemory, isoPlus } from "./helpers/memory-fixtures";

type EdgeKey = `${MemoryStatus}>${MemoryStatus}:${TransitionActor}`;

function key(from: MemoryStatus, to: MemoryStatus, actor: TransitionActor): EdgeKey {
  return `${from}>${to}:${actor}`;
}

/** Spec §4.7 edge table, written out by hand (independently of TRANSITION_EDGES). */
const ALLOWED_FOR_AUTO = new Set<EdgeKey>([
  key("candidate", "active", "human"),
  key("candidate", "active", "auto_rule"),
  key("candidate", "rejected", "human"),
  key("candidate", "rejected", "expiry"),
  key("candidate", "rejected", "migration"),
  key("active", "stale", "human"),
  key("active", "stale", "import"),
  key("active", "stale", "expiry"),
  key("active", "stale", "auto_rule"),
  key("candidate", "superseded", "human"),
  key("active", "superseded", "human"),
  key("stale", "superseded", "human"),
  key("candidate", "superseded", "import"),
  key("active", "superseded", "import"),
  key("stale", "superseded", "import"),
  key("active", "superseded", "auto_rule"),
  key("stale", "active", "human"),
  key("stale", "active", "auto_rule"),
  key("superseded", "active", "human"),
]);

const ALLOWED_FOR_HUMAN = new Set<EdgeKey>(
  [...ALLOWED_FOR_AUTO].filter((edge) => !edge.endsWith(":auto_rule") && !edge.endsWith(":expiry"))
);

describe("isAllowedTransition (spec §4.7 edge table)", () => {
  test("matches the hand-written table for every (from, to, actor, authority)", () => {
    for (const authority of AUTHORITIES) {
      const expected = authority === "auto" ? ALLOWED_FOR_AUTO : ALLOWED_FOR_HUMAN;

      for (const from of MEMORY_STATUSES) {
        for (const to of MEMORY_STATUSES) {
          for (const actor of TRANSITION_ACTORS) {
            const allowed = isAllowedTransition(from, to, actor, authority);
            expect(allowed, `${from} -> ${to} by ${actor} on ${authority}`).toBe(expected.has(key(from, to, actor)));
          }
        }
      }
    }

    expect(TRANSITION_EDGES).toHaveLength(ALLOWED_FOR_AUTO.size);
  });

  test("stale -> active by auto_rule requires status_reason ttl_expired when the reason is known", () => {
    expect(isAllowedTransition("stale", "active", "auto_rule", "auto")).toBe(true);
    expect(isAllowedTransition("stale", "active", "auto_rule", "auto", { statusReason: "ttl_expired" })).toBe(true);
    expect(isAllowedTransition("stale", "active", "auto_rule", "auto", { statusReason: "human" })).toBe(false);
    expect(isAllowedTransition("stale", "active", "auto_rule", "auto", { statusReason: null })).toBe(false);
    expect(isAllowedTransition("stale", "active", "human", "auto", { statusReason: null })).toBe(true);
  });

  test("defaultStatusReason follows the actor", () => {
    expect(defaultStatusReason("active", "human")).toBe("human");
    expect(defaultStatusReason("active", "auto_rule")).toBe("auto_rule");
    expect(defaultStatusReason("rejected", "expiry")).toBe("expiry");
    expect(defaultStatusReason("stale", "expiry")).toBe("ttl_expired");
    expect(defaultStatusReason("stale", "import")).toBe("import_sync");
    expect(defaultStatusReason("superseded", "import")).toBe("import");
    expect(defaultStatusReason("rejected", "migration")).toBe("migration");
  });
});

describe("transitionMemory", () => {
  let db: SqlJsDatabase;
  let memories: MemoryRepository;
  let transitions: TransitionRepository;
  const now = isoPlus(T0, { hours: 1 });

  beforeEach(async () => {
    db = await createTestDb();
    memories = new MemoryRepository(db, { clock: () => T0 });
    transitions = new TransitionRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  test("human promote makes the row human, clears TTL columns and records the transition", () => {
    const candidate = memories.create(
      autoMemory({ ttlExpiresAt: isoPlus(T0, { days: 7 }), revalidateAfter: isoPlus(T0, { days: 3 }), promotionSource: "auto" })
    );

    const promoted = transitionMemory(db, {
      memoryId: candidate.id,
      to: "active",
      actor: "human",
      reason: "cli:memory:promote",
      now,
      proposalId: "prop-1",
      runId: "run-1",
    });

    expect(promoted.status).toBe("active");
    expect(promoted.authority).toBe("human");
    expect(promoted.promotionSource).toBe("manual");
    expect(promoted.ttlExpiresAt).toBeNull();
    expect(promoted.revalidateAfter).toBeNull();
    expect(promoted.statusReason).toBe("human");
    expect(promoted.lastVerifiedAt).toBe(now);
    expect(promoted.updatedAt).toBe(now);
    expect(memories.getById(candidate.id)).toEqual(promoted);

    const history = transitions.listForMemory(candidate.id);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      memoryId: candidate.id,
      fromStatus: "candidate",
      toStatus: "active",
      actor: "human",
      proposalId: "prop-1",
      extractionRunId: "run-1",
      reason: "cli:memory:promote",
      createdAt: now,
    });
  });

  test("auto_rule promote keeps authority auto and marks promotion_source auto", () => {
    const candidate = memories.create(autoMemory());
    const promoted = transitionMemory(db, { memoryId: candidate.id, to: "active", actor: "auto_rule", reason: "decideTier", now, runId: "run-2" });

    expect(promoted.status).toBe("active");
    expect(promoted.authority).toBe("auto");
    expect(promoted.promotionSource).toBe("auto");
    expect(promoted.statusReason).toBe("auto_rule");
    expect(promoted.lastVerifiedAt).toBe(now);
  });

  test("expiry and auto_rule on a human row throw AuthorityViolationError and write nothing (R4)", () => {
    const humanCandidate = memories.create(humanMemory({ status: "candidate", createdAt: "2026-01-01T00:00:00.000Z" }));
    const humanActive = memories.create(humanMemory({ status: "active" }));
    const replacement = memories.create(autoMemory({ summary: "Replacement" }));

    const attempts: Array<() => unknown> = [
      () => transitionMemory(db, { memoryId: humanCandidate.id, to: "rejected", actor: "expiry", reason: "45d", now }),
      () => transitionMemory(db, { memoryId: humanActive.id, to: "stale", actor: "expiry", reason: "ttl", now }),
      () => transitionMemory(db, { memoryId: humanActive.id, to: "stale", actor: "auto_rule", reason: "2-support", now }),
      () => transitionMemory(db, { memoryId: humanActive.id, to: "superseded", actor: "auto_rule", reason: "2-support", now, replacementId: replacement.id }),
      () => transitionMemory(db, { memoryId: humanCandidate.id, to: "active", actor: "auto_rule", reason: "decideTier", now }),
      // even a nonsensical edge reports the authority violation first
      () => transitionMemory(db, { memoryId: humanActive.id, to: "rejected", actor: "expiry", reason: "x", now }),
    ];

    for (const attempt of attempts) {
      expect(attempt).toThrow(AuthorityViolationError);
    }

    expect(memories.getById(humanCandidate.id)?.status).toBe("candidate");
    expect(memories.getById(humanActive.id)?.status).toBe("active");
    expect(memories.getById(humanActive.id)?.updatedAt).toBe(T0);
    expect(transitions.listForMemory(humanCandidate.id)).toEqual([]);
    expect(transitions.listForMemory(humanActive.id)).toEqual([]);
  });

  test("expiry demotes auto rows with the right status_reason, overridable by the caller", () => {
    const candidate = memories.create(autoMemory());
    const active = memories.create(autoMemory({ status: "active", summary: "Active auto" }));
    const revalidated = memories.create(autoMemory({ status: "active", summary: "Revalidate expired" }));

    expect(transitionMemory(db, { memoryId: candidate.id, to: "rejected", actor: "expiry", reason: "candidate 45 d", now }).statusReason).toBe("expiry");
    expect(transitionMemory(db, { memoryId: active.id, to: "stale", actor: "expiry", reason: "ttl", now }).statusReason).toBe("ttl_expired");
    expect(
      transitionMemory(db, { memoryId: revalidated.id, to: "stale", actor: "expiry", reason: "revalidate proposal expired", now, statusReason: "revalidate_expired" }).statusReason
    ).toBe("revalidate_expired");
    expect(transitions.listForMemory(active.id)[0].actor).toBe("expiry");
  });

  test("auto_rule reinforce reactivates only ttl_expired stale rows", () => {
    const expired = memories.create(autoMemory({ status: "active", summary: "Expired" }));
    transitionMemory(db, { memoryId: expired.id, to: "stale", actor: "expiry", reason: "ttl", now });
    const demoted = memories.create(autoMemory({ status: "active", summary: "Demoted" }));
    transitionMemory(db, { memoryId: demoted.id, to: "stale", actor: "human", reason: "cli:memory:demote", now });

    const revived = transitionMemory(db, { memoryId: expired.id, to: "active", actor: "auto_rule", reason: "reinforce", now: isoPlus(now, { hours: 1 }) });
    expect(revived.status).toBe("active");
    expect(revived.statusReason).toBe("auto_rule");
    expect(revived.authority).toBe("auto");

    expect(() => transitionMemory(db, { memoryId: demoted.id, to: "active", actor: "auto_rule", reason: "reinforce", now })).toThrow(InvalidMemoryTransitionError);
    expect(memories.getById(demoted.id)?.status).toBe("stale");
    expect(transitions.listForMemory(demoted.id)).toHaveLength(1);

    const humanRevived = transitionMemory(db, { memoryId: demoted.id, to: "active", actor: "human", reason: "cli:memory:promote", now });
    expect(humanRevived.status).toBe("active");
    expect(humanRevived.authority).toBe("human");
  });

  test("superseded sets superseded_by_memory_id and restore clears it", () => {
    const old = memories.create(autoMemory({ status: "active", summary: "Old rule" }));
    const replacement = memories.create(autoMemory({ summary: "New rule", supersedesMemoryId: old.id }));

    expect(() =>
      transitionMemory(db, { memoryId: old.id, to: "superseded", actor: "human", reason: "self", now, replacementId: old.id })
    ).toThrow(InvalidMemoryTransitionError);

    const superseded = transitionMemory(db, {
      memoryId: old.id,
      to: "superseded",
      actor: "auto_rule",
      reason: "2-support supersede",
      now,
      replacementId: replacement.id,
      proposalId: "prop-9",
    });
    expect(superseded.status).toBe("superseded");
    expect(superseded.supersededByMemoryId).toBe(replacement.id);
    expect(superseded.statusReason).toBe("auto_rule");

    expect(() => transitionMemory(db, { memoryId: superseded.id, to: "active", actor: "auto_rule", reason: "x", now })).toThrow(InvalidMemoryTransitionError);

    const restored = transitionMemory(db, { memoryId: old.id, to: "active", actor: "human", reason: "cli:memory:restore", now: isoPlus(now, { days: 1 }) });
    expect(restored.status).toBe("active");
    expect(restored.supersededByMemoryId).toBeNull();
    expect(restored.authority).toBe("human");
    expect(restored.statusReason).toBe("human");
    expect(transitions.listForMemory(old.id).map((entry) => entry.toStatus)).toEqual(["superseded", "active"]);
  });

  test("auto_rule may supersede only active auto rows; import may supersede any live row", () => {
    const candidate = memories.create(autoMemory({ summary: "Candidate" }));
    const stale = memories.create(autoMemory({ status: "stale", summary: "Stale" }));
    const humanActive = memories.create(humanMemory({ summary: "Human active" }));
    const replacement = memories.create(humanMemory({ summary: "Import replacement" }));

    expect(() => transitionMemory(db, { memoryId: candidate.id, to: "superseded", actor: "auto_rule", reason: "x", now, replacementId: replacement.id })).toThrow(InvalidMemoryTransitionError);
    expect(() => transitionMemory(db, { memoryId: stale.id, to: "superseded", actor: "auto_rule", reason: "x", now, replacementId: replacement.id })).toThrow(InvalidMemoryTransitionError);

    expect(transitionMemory(db, { memoryId: candidate.id, to: "superseded", actor: "import", reason: "import", now, replacementId: replacement.id }).statusReason).toBe("import");
    expect(transitionMemory(db, { memoryId: stale.id, to: "superseded", actor: "import", reason: "import", now, replacementId: replacement.id }).status).toBe("superseded");
    expect(transitionMemory(db, { memoryId: humanActive.id, to: "stale", actor: "import", reason: "--sync removed bullet", now }).statusReason).toBe("import_sync");
  });

  test("invalid edges, same-status moves and missing rows throw without writing", () => {
    const active = memories.create(humanMemory({ status: "active" }));
    const rejected = memories.create(autoMemory({ summary: "Rejected" }));
    transitionMemory(db, { memoryId: rejected.id, to: "rejected", actor: "human", reason: "no", now });

    expect(() => transitionMemory(db, { memoryId: active.id, to: "rejected", actor: "human", reason: "x", now })).toThrow(InvalidMemoryTransitionError);
    expect(() => transitionMemory(db, { memoryId: active.id, to: "active", actor: "human", reason: "x", now })).toThrow(/already active/);
    expect(() => transitionMemory(db, { memoryId: active.id, to: "candidate", actor: "human", reason: "x", now })).toThrow(InvalidMemoryTransitionError);
    expect(() => transitionMemory(db, { memoryId: rejected.id, to: "active", actor: "human", reason: "x", now })).toThrow(InvalidMemoryTransitionError);
    expect(() => transitionMemory(db, { memoryId: active.id, to: "rejected", actor: "migration", reason: "x", now })).toThrow(InvalidMemoryTransitionError);
    expect(() => transitionMemory(db, { memoryId: "missing", to: "active", actor: "human", reason: "x", now })).toThrow(MemoryNotFoundError);
    expect(transitions.listForMemory(active.id)).toEqual([]);
    expect(memories.getById(active.id)?.status).toBe("active");
  });

  test("migration may reject candidates (post-migrate template candidates)", () => {
    const candidate = memories.create(autoMemory());
    const rejected = transitionMemory(db, { memoryId: candidate.id, to: "rejected", actor: "migration", reason: "dreamworker_template", now });

    expect(rejected.status).toBe("rejected");
    expect(rejected.statusReason).toBe("migration");
  });

  test("MemoryRepository.update refuses status so every change is a transition", () => {
    const memory = memories.create(humanMemory());

    expect(() => memories.update(memory.id, { status: "stale" } as unknown as UpdateMemoryInput)).toThrow(InvalidMemoryTransitionError);
    expect(memories.getById(memory.id)?.status).toBe("active");
  });
});

describe("status write invariant (spec §4.7 grep)", () => {
  test("no src module other than transitions.ts, migrations and db/repositories writes memories.status", () => {
    const root = resolve(__dirname, "..", "src");
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
          walk(full);
        } else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) {
          files.push(full);
        }
      }
    };
    walk(root);

    const pattern = /UPDATE\s+memories\s+SET[^;]*\bstatus\s*=|\.update\([^)]*\bstatus\s*:/;
    // post-migrate.ts is migration code (implementation-plan §3 A1): the one place allowed to bypass transitionMemory.
    const offenders = files
      .filter((file) => {
        const rel = relative(root, file).split("\\").join("/");
        return !(
          rel === "promotion/transitions.ts" ||
          rel === "db/post-migrate.ts" ||
          rel.startsWith("db/migrations/") ||
          rel.startsWith("db/repositories/")
        );
      })
      .filter((file) => pattern.test(readFileSync(file, "utf8")))
      .map((file) => relative(root, file));

    expect(offenders).toEqual([]);
  });
});
