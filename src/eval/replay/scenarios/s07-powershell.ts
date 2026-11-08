/**
 * s07 — PowerShell failure → edit → PowerShell fix (§5.1 capture under the powershell dialect): the hooks
 * compute `pm build` as the program token for `& npm.cmd run build`, the failure signature and the
 * resolution; the learned `npm run build` pitfall then fires on a PowerShell call in another session.
 */

import { defineScenario } from "../scenario";

export const s07 = defineScenario({
  id: "s07",
  title: "PowerShell fail → fix is captured and the learned pitfall fires under PowerShell",
  asserts: ["13.1:powershell", "5.1:failure_sig", "i"],
  async run(run) {
    const turn = await run.turn("A", "s07-powershell-fail.jsonl");
    run.checkTurn(turn);
    const descriptor = turn.descriptor;
    if (descriptor === null) return;
    run.equal("fail → resolve gives evidence_weight 2", descriptor.evidence_weight, 2);
    run.equal("failure signature uses the canonical program token", descriptor.failure_signatures.map((entry) => [entry.sig, entry.program_token, entry.resolved_seq !== null]), [["bash|exit_1|pm build", "pm build", true]]);
    run.equal("tools and files of the turn", [descriptor.tools, descriptor.scope_refs], [["bash", "edit"], ["src/index.ts"]]);

    const result = await run.extract({ outputs: "s07.outputs.json" });
    run.checkWorker(result, "extract", { processed: 1, statuses: ["ok"] });
    const id = run.createdFor("A", "p7")[0];
    if (id === undefined) {
      run.fail("a pitfall was learned", "nothing created");
      return;
    }
    const memory = await run.memory(id);
    run.equal("(i) the learned row is an active pitfall born at advise (A′ ladder)", [memory?.type, memory?.status, memory?.enforcement], ["pitfall", "active", "advise"]);
    run.equal("the signature key names the manager that failed (npm build)", memory?.signatureKey, "bash|command|cmd|npm build");
    run.equal("failure classes recorded for after_tool hints", memory?.failureClasses, ["exit_1"]);

    run.advance({ minutes: 10 });
    await run.prompt("B", "build again", { promptId: "p7b" });
    const ps = await run.preTool("B", { tool: "PowerShell", command: "npm run build" });
    run.equal("PowerShell `npm run build` → the learned pitfall fires as advise (context, decision none)", [ps.result?.decision, ps.result?.enforcement, ps.result?.activated], ["none", "advise", [id]]);
    const bash = await run.preTool("B", { tool: "Bash", command: "pnpm build" });
    run.equal("`pnpm build` (the fix) does not fire", [bash.result?.decision, bash.result?.activated], ["none", []]);
  },
});
