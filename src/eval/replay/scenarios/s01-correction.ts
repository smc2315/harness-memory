/**
 * s01 — a correction-only turn (§13.2 (a), (j), (k) activation; (d) worker-level idempotency).
 * Hooks: SessionStart → UserPromptSubmit (Korean + English correction) → Stop. Worker: the recorded
 * pitfall activates as auto / advise (A′: auto rules are born at `before_tool.auto_enforcement` = advise and
 * climb to soft_deny only on a second session's reinforce, see s11) without any AuthorityViolationError.
 */

import { EpisodeRepository } from "../../../db/repositories/episodes";
import { ExtractionRunRepository } from "../../../db/repositories/runs";
import { TransitionRepository } from "../../../db/repositories/transitions";
import { derivedRulesConsistent } from "../../../policy/derive";
import { defineScenario } from "../scenario";
import { isoPlus } from "./util";

export const s01 = defineScenario({
  id: "s01",
  title: "correction-only turn → active auto advise pitfall (the ladder starts at advise)",
  asserts: ["a", "j", "k", "d"],
  async run(run) {
    const turn = await run.turn("A", "s01-correction-only.jsonl");
    run.checkTurn(turn);
    const descriptor = turn.descriptor;
    if (descriptor === null) return;
    run.equal("(j) a correction-only turn carries evidence_weight 2", descriptor.evidence_weight, 2);
    run.equal("(j) flags = {correction: 1}", descriptor.flags, { correction: 1 });
    run.equal("stop asked for a worker extract", turn.calls.find((call) => call.event === "stop")?.spawned, ["extract"]);
    const promptLine = turn.producedLines.find((line) => line.kind === "prompt");
    run.equal("the prompt hook flagged the correction", promptLine?.kind === "prompt" ? promptLine.correction : null, 1);

    const extractAt = run.now();
    const result = await run.extract({ outputs: "s01.outputs.json" });
    run.checkWorker(result, "extract", { processed: 1, statuses: ["ok"] });
    const id = run.createdFor("A", "p1")[0];
    if (id === undefined) {
      run.fail("(a) one memory created", "nothing created");
      return;
    }
    const memory = await run.memory(id);
    run.check("(a) the row exists", memory !== null);
    if (memory === null) return;
    run.equal("(a) status active", memory.status, "active");
    run.equal("(a) authority auto", memory.authority, "auto");
    run.equal("(a) enforcement advise (A′: born at before_tool.auto_enforcement, not soft_deny)", memory.enforcement, "advise");
    run.equal("(a) type pitfall with the canonical cmd key", [memory.type, memory.signatureKey], ["pitfall", "bash|command|cmd|npm test"]);
    run.equal("(a) evidence_score 2 / evidence_count 1 / validation_count 0", [memory.evidenceScore, memory.evidenceCount, memory.validationCount], [2, 1, 0]);
    run.equal("(a) TTL 30 d for a correction row", memory.ttlExpiresAt, isoPlus(extractAt, { days: 30 }));
    run.equal("(a) aliases indexed", memory.aliases, ["pnpm test", "테스트 실행"]);

    await run.read((db) => {
      const transitions = new TransitionRepository(db).listForMemory(id);
      run.equal("(k) exactly one candidate→active transition by auto_rule", transitions.map((row) => [row.fromStatus, row.toStatus, row.actor]), [["candidate", "active", "auto_rule"]]);
      const episode = new EpisodeRepository(db).getById(descriptor.id);
      run.equal("episode marked extracted", episode?.status, "extracted");
      const runs = new ExtractionRunRepository(db).listForEpisode(descriptor.id);
      run.equal("one ok extraction run with 1/1 facts", runs.map((row) => [row.status, row.factsTotal, row.factsAccepted]), [["ok", 1, 1]]);
      run.check("policy_rules derived invariant holds after the write", derivedRulesConsistent(db));
    });

    // (d) the same run again: the queue file is re-created, the worker finds the episode extracted → noop, bytes untouched.
    const before = await run.export();
    run.requeue(descriptor);
    const again = await run.extract({ outputs: "s01.outputs.json" });
    run.checkWorker(again, "second extract", { processed: 0 });
    run.equal("(d) nothing inserted on the second pass", again.inserted, 0);
    const after = await run.export();
    run.check("(d) export bytes identical after re-applying the same run", before.dump === after.dump && Buffer.compare(before.bytes, after.bytes) === 0);
    run.equal("(d) still exactly one active row", (await run.memories({ status: "active" })).length, 1);
  },
});
