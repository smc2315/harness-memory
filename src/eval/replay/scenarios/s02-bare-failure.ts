/**
 * s02 — (§13.2 (b)) a bare failure yields a candidate; a second session's fail-then-resolve episode
 * reinforces it to active. Also checks the capture path: failure_sig, program_token and resolution_of
 * are computed by the hooks exactly as recorded.
 */

import { defineScenario } from "../scenario";

export const s02 = defineScenario({
  id: "s02",
  title: "bare failure → candidate; a second episode reinforces it to active",
  asserts: ["b"],
  async run(run) {
    const first = await run.turn("A", "s02-bare-failure.jsonl");
    run.checkTurn(first);
    run.equal("(b) a bare failure carries evidence_weight 1", first.descriptor?.evidence_weight, 1);
    run.equal("(b) flags = {failure: 1}", first.descriptor?.flags, { failure: 1 });

    const one = await run.extract({ outputs: "s02.outputs.json" });
    run.checkWorker(one, "first extract", { processed: 1, statuses: ["ok"] });
    const id = run.createdFor("A", "p21")[0];
    if (id === undefined) {
      run.fail("(b) the first episode created a row", "nothing created");
      return;
    }
    const candidate = await run.memory(id);
    run.equal("(b) evidence 1 → candidate", candidate?.status, "candidate");
    run.equal("(b) candidate authority auto", candidate?.authority, "auto");

    run.advance({ hours: 1 });
    const second = await run.turn("B", "s02-fail-then-resolve.jsonl");
    run.checkTurn(second);
    run.equal("(b) fail-then-resolve carries evidence_weight 2", second.descriptor?.evidence_weight, 2);
    run.equal("(b) the resolution was detected by the post-tool hook", second.descriptor?.failure_signatures.map((entry) => [entry.sig, entry.resolved_seq !== null]), [["bash|exit_1|pm test", true]]);

    const two = await run.extract({ outputs: "s02.outputs.json" });
    run.checkWorker(two, "second extract", { processed: 1, statuses: ["ok"] });
    run.equal("(b) the second run reinforced the candidate", two.processed[0]?.activated, [id]);
    const active = await run.memory(id);
    run.equal("(b) second episode → active", active?.status, "active");
    run.equal("(b) evidence_count 2 across 2 sessions", [active?.evidenceCount, active?.distinctSessionCount], [2, 2]);
    run.equal("(b) evidence_score 1 + 2 = 3", active?.evidenceScore, 3);
    run.equal("(b) validation_count 1 after the reinforce", active?.validationCount, 1);
    run.equal("(b) still one live row", (await run.memories({ status: ["candidate", "active"] })).length, 1);
  },
});
