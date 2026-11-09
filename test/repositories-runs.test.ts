import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { Database as SqlJsDatabase } from "sql.js";

import { extractionRunId } from "../src/core/ids";
import { EXTRACTOR_VERSION } from "../src/core/extraction-types";
import { ExtractionRunRepository } from "../src/db/repositories";
import { createTestDb } from "./helpers/create-test-db";
import { T0, insertEpisode, isoPlus } from "./helpers/memory-fixtures";

describe("ExtractionRunRepository", () => {
  let db: SqlJsDatabase;
  let runs: ExtractionRunRepository;

  beforeEach(async () => {
    db = await createTestDb();
    runs = new ExtractionRunRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  test("start and finish round-trip, duration is derived when omitted", () => {
    const episode = insertEpisode(db);
    const id = extractionRunId(episode.id);
    const started = runs.start({
      id,
      episodeId: episode.id,
      provider: "replay",
      extractorVersion: EXTRACTOR_VERSION,
      promptSha256: "abc",
      inputChars: 1234,
      startedAt: T0,
    });

    expect(started.status).toBe("started");
    expect(started.model).toBeNull();
    expect(started.outcomes).toEqual([]);
    expect(started.finishedAt).toBeNull();

    const finished = runs.finish(id, {
      status: "ok",
      finishedAt: isoPlus(T0, { seconds: 3 }),
      factsTotal: 2,
      factsAccepted: 1,
      rawOutputRef: `raw/${id}.json`,
      model: "claude-x",
      outcomes: [
        { ordinal: 0, action: "create", outcome: "created", memory_id: "mem-1" },
        { ordinal: 1, action: "reinforce", outcome: "rejected", rejection: "evidence_ref" },
      ],
    });

    expect(finished.status).toBe("ok");
    expect(finished.durationMs).toBe(3000);
    expect(finished.factsTotal).toBe(2);
    expect(finished.factsAccepted).toBe(1);
    expect(finished.rawOutputRef).toBe(`raw/${id}.json`);
    expect(finished.model).toBe("claude-x");
    expect(finished.outcomes).toHaveLength(2);
    expect(finished.outcomes[1].rejection).toBe("evidence_ref");
    expect(runs.getById(id)).toEqual(finished);
    expect(runs.listForEpisode(episode.id)).toEqual([finished]);
    expect(runs.latest()?.id).toBe(id);
  });

  test("start upserts a retried run id and resets the previous attempt", () => {
    const episode = insertEpisode(db);
    const id = extractionRunId(episode.id);
    const base = { id, episodeId: episode.id, provider: "claude" as const, extractorVersion: EXTRACTOR_VERSION, promptSha256: "p1", inputChars: 10 };

    runs.start({ ...base, startedAt: T0 });
    runs.finish(id, { status: "timeout", finishedAt: isoPlus(T0, { minutes: 2 }), error: "killed after 120 s", durationMs: 120000 });
    expect(runs.getById(id)?.status).toBe("timeout");

    const retried = runs.start({ ...base, promptSha256: "p2", startedAt: isoPlus(T0, { hours: 1 }) });
    expect(retried.status).toBe("started");
    expect(retried.promptSha256).toBe("p2");
    expect(retried.error).toBeNull();
    expect(retried.finishedAt).toBeNull();
    expect(retried.durationMs).toBeNull();
    expect(runs.listRecent(10)).toHaveLength(1);
    expect(() => runs.finish("missing", { status: "ok", finishedAt: T0 })).toThrow(/not found/);
  });

  test("countSince honours the window, provider and correction exclusion", () => {
    const plain = insertEpisode(db);
    const correction = insertEpisode(db, { correction_for: plain.id, flags: { correction: 1 } });
    const flagged = insertEpisode(db, { flags: { correction: 1 } });
    const start = isoPlus(T0, { hours: 1 });

    runs.start({ id: "r-old", episodeId: plain.id, provider: "claude", extractorVersion: "v", promptSha256: "a", inputChars: 1, startedAt: T0 });
    runs.start({ id: "r-plain", episodeId: plain.id, provider: "claude", extractorVersion: "v2", promptSha256: "b", inputChars: 1, startedAt: isoPlus(start, { minutes: 1 }) });
    runs.start({ id: "r-corr", episodeId: correction.id, provider: "claude", extractorVersion: "v", promptSha256: "c", inputChars: 1, startedAt: isoPlus(start, { minutes: 2 }) });
    runs.start({ id: "r-flag", episodeId: flagged.id, provider: "codex", extractorVersion: "v", promptSha256: "d", inputChars: 1, startedAt: isoPlus(start, { minutes: 3 }) });
    runs.finish("r-plain", { status: "ok", finishedAt: isoPlus(start, { minutes: 2 }) });

    expect(runs.countSince(T0)).toBe(4);
    expect(runs.countSince(start)).toBe(3);
    expect(runs.countSince(start, { excludeCorrection: true })).toBe(1);
    expect(runs.countSince(start, { provider: "codex" })).toBe(1);
    expect(runs.countSince(start, { statuses: ["ok"] })).toBe(1);
    expect(runs.countSince(start, { statuses: ["started"], excludeCorrection: true })).toBe(0);
    expect(runs.listRecent(2).map((run) => run.id)).toEqual(["r-flag", "r-corr"]);
  });
});
