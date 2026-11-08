/**
 * s04 — soft_deny outcomes within one turn (§9.3 B through the real hooks): the first `npm test` is
 * denied and retried (override), `git push --force` is denied and the agent edits a file first (heed),
 * an advise row only adds context (none), the same-turn retry of `npm test` passes (already fired) and
 * fails. The worker rolls the outcomes up into fire_count / override_count.
 */

import { defineScenario } from "../scenario";
import { autoRow, cmdSignature } from "./seeds";

export const s04 = defineScenario({
  id: "s04",
  title: "soft_deny override / heed / advise outcomes and the fire roll-up",
  asserts: ["9.3:B", "13.1:soft_deny"],
  async run(run) {
    await run.seed([
      autoRow({ id: "mem-a", summary: "Run the suite with pnpm test; npm test has no script in this repository.", signature: cmdSignature("npm test") }),
      autoRow({ id: "mem-b", summary: "Never force-push to shared branches; rebase onto origin first.", signature: cmdSignature("git push --force") }),
      autoRow({ id: "mem-c", summary: "Removing dist also removes the generated migrations; rebuild afterwards.", signature: cmdSignature("rm -rf dist"), enforcement: "advise" }),
    ]);

    const turn = await run.turn("A", "s04-soft-deny-override.jsonl", { compareFired: true });
    run.checkTurn(turn);
    // PreToolUse order: npm test (deny) · git push (deny) · edit · git push retry (already fired) · rm -rf dist (advise) · npm test retry (already fired)
    const pre = turn.calls.filter((call) => call.event === "pre-tool");
    run.equal("six PreToolUse calls were replayed", pre.length, 6);
    run.equal("npm test → deny (soft_deny)", [pre[0]?.result?.decision, pre[0]?.result?.enforcement, pre[0]?.result?.activated], ["deny", "soft_deny", ["mem-a"]]);
    run.equal("git push --force → deny (soft_deny)", [pre[1]?.result?.decision, pre[1]?.result?.activated], ["deny", ["mem-b"]]);
    run.equal("edit src/index.ts → nothing fires", [pre[2]?.result?.decision, pre[2]?.result?.activated], ["none", []]);
    run.equal("git push --force retry in the same turn passes (already fired)", [pre[3]?.result?.decision, pre[3]?.result?.activated], ["none", []]);
    run.equal("rm -rf dist → advise: no permission decision, context only", [pre[4]?.result?.decision, pre[4]?.result?.delivery, pre[4]?.result?.activated], ["none", "with_result", ["mem-c"]]);
    run.check("advise stdout has additionalContext and no permissionDecision", pre[4]?.stdout?.hookSpecificOutput?.permissionDecision === undefined && (pre[4]?.stdout?.hookSpecificOutput?.additionalContext?.length ?? 0) > 0);
    run.equal("same-turn retry of npm test passes (already fired)", [pre[5]?.result?.decision, pre[5]?.result?.activated], ["none", []]);
    run.check("the retries report already_fired", JSON.stringify(pre[3]?.result?.detail.suppressed ?? []).includes("already_fired") && JSON.stringify(pre[5]?.result?.detail.suppressed ?? []).includes("already_fired"));

    const descriptor = turn.descriptor;
    if (descriptor === null) return;
    run.equal(
      "(§9.3 B) fired outcomes: override / heed / none",
      descriptor.fired.map((entry) => [entry.memory_id, entry.enforcement, entry.outcome]),
      [
        ["mem-a", "soft_deny", "override"],
        ["mem-b", "soft_deny", "heed"],
        ["mem-c", "advise", "none"],
      ]
    );
    run.equal("the unresolved failure makes the turn eligible (evidence 1)", descriptor.evidence_weight, 1);

    const result = await run.extract({ outputs: "s04.outputs.json" });
    run.checkWorker(result, "extract", { processed: 1, statuses: ["ok"] });
    const rows = await Promise.all(["mem-a", "mem-b", "mem-c"].map((id) => run.memory(id)));
    run.equal(
      "fire roll-up: fire_count / override_count / last_fired_at",
      rows.map((row) => [row?.fireCount, row?.overrideCount, row?.lastFiredAt]),
      [
        [1, 1, descriptor.closed_at],
        [1, 0, descriptor.closed_at],
        [1, 0, descriptor.closed_at],
      ]
    );
    // The same queue file again must not roll up twice.
    run.requeue(descriptor);
    await run.extract({ outputs: "s04.outputs.json" });
    const again = await run.memory("mem-a");
    run.equal("roll-up is idempotent", [again?.fireCount, again?.overrideCount], [1, 1]);
  },
});
