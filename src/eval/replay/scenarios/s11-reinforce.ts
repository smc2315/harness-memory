/**
 * s11 — (§13.2 (g), (d)) a reinforce from a second session ten days later raises the TTL and
 * validation_count; re-applying the same run through the worker (episode forced back to queued, raw
 * cache + write_ops present) leaves the SQL export byte-identical.
 */

import { EpisodeRepository } from "../../../db/repositories/episodes";
import { defineScenario } from "../scenario";
import { isoPlus } from "./util";

export const s11 = defineScenario({
  id: "s11",
  title: "reinforce raises TTL and validation_count; the same run twice is a byte-identical noop",
  asserts: ["g", "d"],
  async run(run) {
    const t0 = run.now();
    const learn = await run.turn("A", "s11-reinforce.jsonl", { turnKey: "p111" });
    run.checkTurn(learn);
    const firstAt = run.now();
    const first = await run.extract({ outputs: "s11.outputs.json" });
    run.checkWorker(first, "extract", { processed: 1, statuses: ["ok"] });
    const id = run.createdFor("A", "p111")[0];
    if (id === undefined) {
      run.fail("(g) the correction created a row", "nothing created");
      return;
    }
    const before = await run.memory(id);
    run.equal("(g) initial TTL 30 d, validation_count 0", [before?.ttlExpiresAt, before?.validationCount], [isoPlus(firstAt, { days: 30 }), 0]);

    run.at(isoPlus(t0, { days: 10 }));
    const reinforce = await run.turn("Z", "s11-reinforce.jsonl", { turnKey: "p112" });
    run.checkTurn(reinforce);
    const secondAt = run.now();
    const second = await run.extract({ outputs: "s11.outputs.json" });
    run.checkWorker(second, "reinforce extract", { processed: 1, statuses: ["ok"] });
    run.equal("(g) the run reinforced the learned row", second.processed[0]?.created, []);
    const after = await run.memory(id);
    run.equal("(g) still active", after?.status, "active");
    run.equal("(g) validation_count 1, evidence_count 2, 2 sessions", [after?.validationCount, after?.evidenceCount, after?.distinctSessionCount], [1, 2, 2]);
    run.check("(g) TTL moved forward", after?.ttlExpiresAt !== undefined && before?.ttlExpiresAt !== undefined && Date.parse(after.ttlExpiresAt!) > Date.parse(before.ttlExpiresAt!));
    run.equal("(g) TTL = reinforce time + 30 d", after?.ttlExpiresAt, isoPlus(secondAt, { days: 30 }));
    run.check("(g) revalidate_after moved too", after?.revalidateAfter !== undefined && before?.revalidateAfter !== undefined && Date.parse(after.revalidateAfter!) > Date.parse(before.revalidateAfter!));

    // (d) force the second episode back to the queue: raw cache + write_ops make the re-run a noop. Only the
    // episode's lease bookkeeping (attempt_count / lease_until / next_attempt_at) may move; every memory,
    // provenance, transition, proposal and run row must come out byte-identical.
    const descriptor = reinforce.descriptor;
    if (descriptor === null) return;
    const episodeBefore = await run.read((db) => new EpisodeRepository(db).getById(descriptor.id));
    await run.write("eval:requeue", (db, ctx) => {
      db.run("UPDATE episodes SET status = 'queued', lease_until = NULL, next_attempt_at = ? WHERE id = ?", [ctx.now, descriptor.id]);
      return { id: null, kind: "eval:requeue", noop: false, wrote: true };
    });
    run.requeue(descriptor);
    const exportBefore = await run.export();
    const again = await run.extract({ outputs: "s11.outputs.json" });
    run.checkWorker(again, "re-applied extract");
    run.equal("(d) the episode was processed again", again.processed.map((entry) => entry.episodeId), [descriptor.id]);
    run.equal("(d) the run was served from the raw cache", again.processed.map((entry) => entry.fromCache), [true]);
    run.equal("(d) the re-applied op is a noop", again.processed.map((entry) => entry.op.noop), [true]);
    const exportAfter = await run.export();
    const withoutEpisodes = (dump: string): string => dump.split("\n").filter((line) => !line.startsWith('INSERT INTO "episodes"')).join("\n");
    run.check("(d) SQL export identical after re-applying the run (all tables but the episode lease bookkeeping)", withoutEpisodes(exportBefore.dump) === withoutEpisodes(exportAfter.dump), diffSummary(withoutEpisodes(exportBefore.dump), withoutEpisodes(exportAfter.dump)));
    const episodeAfter = await run.read((db) => new EpisodeRepository(db).getById(descriptor.id));
    const strip = (record: typeof episodeBefore) => (record === null ? null : { ...record, attemptCount: 0, leaseUntil: null, nextAttemptAt: null });
    run.equal("(d) the episode row only moved its lease bookkeeping", strip(episodeAfter), strip(episodeBefore));
    run.equal("(d) episode extracted again, same run id", [episodeAfter?.status, episodeAfter?.extractionRunId], ["extracted", episodeBefore?.extractionRunId ?? null]);
    const unchanged = await run.memory(id);
    run.equal("(d) counters unchanged by the re-run", [unchanged?.validationCount, unchanged?.evidenceCount, unchanged?.ttlExpiresAt], [1, 2, after?.ttlExpiresAt]);
  },
});

function diffSummary(left: string, right: string): string | undefined {
  if (left === right) return undefined;
  const a = left.split("\n");
  const b = right.split("\n");
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    if (a[index] !== b[index]) return `first difference at line ${String(index)}: ${(a[index] ?? "<eof>").slice(0, 160)} | ${(b[index] ?? "<eof>").slice(0, 160)}`;
  }
  return "different length";
}
