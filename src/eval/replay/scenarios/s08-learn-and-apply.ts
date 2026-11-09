/**
 * s08 — (§13.2 (i)) six learn-and-apply turns (fail → fix) in six sessions; every recorded fact becomes an
 * active `type=pitfall` row (policy facts are relabelled), each with a distinct canonical signature.
 */

import { defineScenario } from "../scenario";

const TURNS = ["q1", "q2", "q3", "q4", "q5", "q6"];

export const s08 = defineScenario({
  id: "s08",
  title: "six learn-and-apply episodes all yield type=pitfall",
  asserts: ["i"],
  async run(run) {
    for (const [index, turnKey] of TURNS.entries()) {
      const session = String.fromCharCode(65 + index);
      const turn = await run.turn(session, "s08-learn-and-apply.jsonl", { turnKey });
      run.checkTurn(turn, { label: `${turnKey}` });
      run.equal(`${turnKey}: fail → fix recorded (resolution flag)`, turn.descriptor?.flags.resolution, 1);
    }
    const result = await run.extract({ outputs: "s08.outputs.json" });
    run.checkWorker(result, "extract", { processed: 6, statuses: ["ok", "ok", "ok", "ok", "ok", "ok"] });
    const ids = TURNS.map((turnKey, index) => run.createdFor(String.fromCharCode(65 + index), turnKey)[0]);
    run.check("(i) each episode created exactly one row", ids.every((id) => id !== undefined), ids.join(","));
    const rows = await Promise.all(ids.map((id) => (id === undefined ? Promise.resolve(null) : run.memory(id))));
    run.check("(i) every row is type=pitfall", rows.every((row) => row?.type === "pitfall"), rows.map((row) => row?.type ?? "null").join(","));
    run.check("(i) every row is active at advise (A′ ladder start) with a before_tool trigger", rows.every((row) => row?.status === "active" && row.enforcement === "advise" && row.lifecycleTriggers.includes("before_tool")));
    run.equal("(i) six distinct semantic keys", new Set(rows.map((row) => row?.semanticKey)).size, 6);
    run.equal(
      "(i) canonical cmd signatures",
      rows.map((row) => row?.signatureKey),
      ["bash|command|cmd|npm test", "bash|command|cmd|npm build", "bash|command|cmd|yarn lint", "bash|command|cmd|npx vitest run", "bash|command|cmd|npm typecheck", "bash|command|cmd|npm e2e"]
    );
    const relabelled = result.processed.filter((entry) => entry.outcomes >= 0).length;
    run.equal("(i) all six runs processed", relabelled, 6);
  },
});
