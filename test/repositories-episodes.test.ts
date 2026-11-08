import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { Database as SqlJsDatabase } from "sql.js";

import { sessionKey } from "../src/core/paths";
import {
  EpisodeRepository,
  episodeRecordToDescriptor,
  isCorrectionEpisode,
} from "../src/db/repositories";
import { createTestDb } from "./helpers/create-test-db";
import { T0, episodeDescriptor, insertEpisode, isoPlus } from "./helpers/memory-fixtures";

describe("EpisodeRepository", () => {
  let db: SqlJsDatabase;
  let episodes: EpisodeRepository;

  beforeEach(async () => {
    db = await createTestDb();
    episodes = new EpisodeRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  test("insertIfAbsent is idempotent and round-trips the descriptor", () => {
    const descriptor = episodeDescriptor({
      correction_for: "ep-prev",
      context_ref: "tool_fail bash pm test",
      scope_refs: ["src/a.ts", "src/b.ts"],
      tools: ["bash", "edit"],
      failure_signatures: [
        { sig: "bash|exit_1|src/a.ts", class: "exit_1", tool: "bash", scope_ref: "src/a.ts", program_token: "pm test", failed_seq: 3, resolved_seq: 7 },
      ],
      flags: { correction: 1, failure: 1, resolution: 1 },
      fired: [{ memory_id: "mem-1", enforcement: "soft_deny", outcome: "heed", tool: "bash" }],
      evidence_weight: 4,
      event_count: 9,
    });

    expect(episodes.insertIfAbsent(descriptor, T0)).toBe(true);
    expect(episodes.insertIfAbsent(descriptor, isoPlus(T0, { minutes: 5 }))).toBe(false);

    const record = episodes.getById(descriptor.id);
    expect(record).not.toBeNull();
    expect(record?.status).toBe("queued");
    expect(record?.attemptCount).toBe(0);
    expect(record?.nextAttemptAt).toBe(T0);
    expect(record?.host).toBe("claude-code");
    expect(record?.sessionId).toBe(descriptor.session_id);
    expect(record?.turnKey).toBe(descriptor.turn_key);
    expect(record?.closeReason).toBe("stop");
    expect(record?.ledgerRef).toBe(descriptor.ledger_ref);
    expect(record?.correctionFor).toBe("ep-prev");
    expect(record?.contextRef).toBe("tool_fail bash pm test");
    expect(record?.scopeRefs).toEqual(["src/a.ts", "src/b.ts"]);
    expect(record?.tools).toEqual(["bash", "edit"]);
    expect(record?.failureSignatures).toEqual(descriptor.failure_signatures);
    expect(record?.flags).toEqual({ correction: 1, failure: 1, resolution: 1 });
    expect(record?.fired).toEqual(descriptor.fired);
    expect(record?.evidenceWeight).toBe(4);
    expect(record?.eventCount).toBe(9);
    expect(isCorrectionEpisode(record!)).toBe(true);

    const rebuilt = episodeRecordToDescriptor(record!);
    expect(rebuilt).toEqual({
      ...descriptor,
      session_key: sessionKey("claude-code", descriptor.session_id),
      prompt_text: null,
      last_assistant_message: null,
    });
    expect(episodes.countQueued()).toBe(1);
  });

  test("lease takes correction episodes first, then the oldest, and marks them leased", () => {
    const plainOld = insertEpisode(db, { closed_at: isoPlus(T0, { minutes: 1 }) });
    const correction = insertEpisode(db, { closed_at: isoPlus(T0, { minutes: 5 }), correction_for: plainOld.id, flags: { correction: 1 } });
    const plainMid = insertEpisode(db, { closed_at: isoPlus(T0, { minutes: 3 }) });
    const flagOnly = insertEpisode(db, { closed_at: isoPlus(T0, { minutes: 4 }), flags: { correction: 1 } });
    const now = isoPlus(T0, { minutes: 10 });

    const leased = episodes.lease(3, { leaseSeconds: 180, now });

    expect(leased.map((episode) => episode.id)).toEqual([flagOnly.id, correction.id, plainOld.id]);
    for (const episode of leased) {
      expect(episode.status).toBe("leased");
      expect(episode.leaseUntil).toBe(isoPlus(now, { seconds: 180 }));
      expect(episode.attemptCount).toBe(1);
    }
    expect(episodes.getById(plainMid.id)?.status).toBe("queued");
    expect(episodes.countQueued()).toBe(1);

    const rest = episodes.lease(5, { leaseSeconds: 180, now });
    expect(rest.map((episode) => episode.id)).toEqual([plainMid.id]);
    expect(episodes.lease(5, { leaseSeconds: 180, now })).toEqual([]);
    expect(episodes.lease(0, { leaseSeconds: 180, now })).toEqual([]);
  });

  test("lease honours correctionFirst=false and next_attempt_at", () => {
    const plainOld = insertEpisode(db, { closed_at: isoPlus(T0, { minutes: 1 }) });
    const correction = insertEpisode(db, { closed_at: isoPlus(T0, { minutes: 5 }), correction_for: plainOld.id });
    const deferred = insertEpisode(db, { closed_at: isoPlus(T0, { minutes: 0 }) }, isoPlus(T0, { hours: 2 }));
    const now = isoPlus(T0, { minutes: 10 });

    const leased = episodes.lease(10, { leaseSeconds: 60, now, correctionFirst: false });

    expect(leased.map((episode) => episode.id)).toEqual([plainOld.id, correction.id]);
    expect(episodes.getById(deferred.id)?.status).toBe("queued");

    const later = episodes.lease(10, { leaseSeconds: 60, now: isoPlus(T0, { hours: 3 }) });
    expect(later.map((episode) => episode.id)).toEqual([deferred.id]);
  });

  test("requeue puts a leased episode back to queued without burning the attempt (provider unavailable)", () => {
    const a = insertEpisode(db);
    const now = isoPlus(T0, { minutes: 1 });
    const [leased] = episodes.lease(1, { leaseSeconds: 180, now });
    expect(leased?.attemptCount).toBe(1);

    const retryAt = isoPlus(now, { hours: 24 });
    episodes.requeue(a.id, { nextAttemptAt: retryAt, undoAttempt: true, lastError: "not_logged_in: please run /login" });
    const requeued = episodes.getById(a.id)!;
    expect(requeued.status).toBe("queued");
    expect(requeued.attemptCount).toBe(0);
    expect(requeued.leaseUntil).toBeNull();
    expect(requeued.nextAttemptAt).toBe(retryAt);
    expect(requeued.lastError).toBe("not_logged_in: please run /login");
    expect(episodes.lease(1, { leaseSeconds: 180, now: isoPlus(now, { hours: 1 }) })).toEqual([]);

    // Without undoAttempt the counter is kept, and a null lastError leaves the previous error in place.
    expect(episodes.lease(1, { leaseSeconds: 180, now: retryAt })).toHaveLength(1);
    episodes.requeue(a.id, { nextAttemptAt: isoPlus(retryAt, { hours: 1 }), lastError: null });
    const again = episodes.getById(a.id)!;
    expect(again.status).toBe("queued");
    expect(again.attemptCount).toBe(1);
    expect(again.lastError).toBe("not_logged_in: please run /login");
  });

  test("status transitions: extracted, skipped, failed, dead, lease release and retry requeue", () => {
    const a = insertEpisode(db);
    const b = insertEpisode(db);
    const c = insertEpisode(db);
    const d = insertEpisode(db);
    const now = isoPlus(T0, { minutes: 1 });
    episodes.lease(4, { leaseSeconds: 180, now });

    episodes.markExtracted(a.id, "run-a");
    episodes.markSkipped(b.id, "no_signal");
    episodes.markFailed(c.id, "boom", { retryAt: isoPlus(now, { hours: 1 }) });
    episodes.markFailed(d.id, "x".repeat(5000), { retryAt: null, dead: true });

    const extracted = episodes.getById(a.id);
    expect(extracted?.status).toBe("extracted");
    expect(extracted?.extractionRunId).toBe("run-a");
    expect(extracted?.leaseUntil).toBeNull();

    const skipped = episodes.getById(b.id);
    expect(skipped?.status).toBe("skipped");
    expect(skipped?.skipReason).toBe("no_signal");

    const failed = episodes.getById(c.id);
    expect(failed?.status).toBe("failed");
    expect(failed?.lastError).toBe("boom");
    expect(failed?.nextAttemptAt).toBe(isoPlus(now, { hours: 1 }));
    expect(failed?.leaseUntil).toBeNull();

    const dead = episodes.getById(d.id);
    expect(dead?.status).toBe("dead");
    expect(dead?.lastError?.length).toBe(2000);
    expect(dead?.nextAttemptAt).toBeNull();

    expect(episodes.countByStatus()).toEqual({ queued: 0, leased: 0, extracted: 1, skipped: 1, failed: 1, dead: 1 });
    expect(episodes.listByStatus("failed").map((episode) => episode.id)).toEqual([c.id]);

    expect(episodes.requeueDueFailures(isoPlus(now, { minutes: 30 }))).toBe(0);
    expect(episodes.requeueDueFailures(isoPlus(now, { hours: 1 }))).toBe(1);
    expect(episodes.getById(c.id)?.status).toBe("queued");

    const relased = episodes.lease(1, { leaseSeconds: 60, now: isoPlus(now, { hours: 1 }) });
    expect(relased.map((episode) => episode.id)).toEqual([c.id]);
    expect(relased[0].attemptCount).toBe(2);
    expect(episodes.releaseExpiredLeases(isoPlus(now, { hours: 1, seconds: 30 }))).toBe(0);
    expect(episodes.releaseExpiredLeases(isoPlus(now, { hours: 1, seconds: 60 }))).toBe(1);
    expect(episodes.getById(c.id)?.status).toBe("queued");
    expect(episodes.getById(c.id)?.leaseUntil).toBeNull();
  });

  test("listForSession returns the session's episodes oldest first", () => {
    const first = insertEpisode(db, { session_id: "s-1", closed_at: isoPlus(T0, { minutes: 2 }) });
    const second = insertEpisode(db, { session_id: "s-1", closed_at: isoPlus(T0, { minutes: 1 }) });
    insertEpisode(db, { session_id: "s-2" });

    expect(episodes.listForSession("claude-code", "s-1").map((episode) => episode.id)).toEqual([second.id, first.id]);
    expect(episodes.getById("missing")).toBeNull();
  });
});
