/**
 * s12 — (§13.1 s12 budget) thirteen rows match `npm test`: the hook injects at most 3 items / 2,048 bytes
 * with the per-type quotas and reports the rest as suppressed; SessionStart injects only startup rows,
 * never before_tool-only pitfalls or policies.
 */

import { defineScenario } from "../scenario";
import { autoRow, cmdSignature, humanRow } from "./seeds";
import { suppressionKinds, utf8Bytes } from "./util";

export const s12 = defineScenario({
  id: "s12",
  title: "before_tool budget and quotas; startup never injects before_tool-only rows",
  asserts: ["13.1:s12", "13.1:startup"],
  async run(run) {
    const pitfalls = Array.from({ length: 8 }, (_unused, index) =>
      autoRow({
        id: `pitfall-${String(index + 1)}`,
        summary: `Pitfall number ${String(index + 1)}: the npm test script of this repository needs the pnpm workspace (${["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta"][index]!}).`,
        signature: cmdSignature("npm test"),
      })
    );
    const policies = Array.from({ length: 3 }, (_unused, index) =>
      humanRow({
        id: `policy-${String(index + 1)}`,
        type: "policy",
        summary: `Policy ${String(index + 1)}: ask before running the npm test suite on this machine (${["one", "two", "three"][index]!}).`,
        signature: cmdSignature("npm test"),
        lifecycleTriggers: ["before_tool"],
        enforcement: "confirm",
        policySubtype: "hard",
      })
    );
    const workflows = Array.from({ length: 2 }, (_unused, index) =>
      humanRow({
        id: `workflow-${String(index + 1)}`,
        type: "workflow",
        summary: `Workflow ${String(index + 1)}: seed the database before the npm test suite (${["first", "second"][index]!}).`,
        signature: cmdSignature("npm test"),
        lifecycleTriggers: ["before_tool"],
        enforcement: "advise",
      })
    );
    const startup = [
      humanRow({ id: "startup-workflow", type: "workflow", summary: "Start every session by reading docs/redesign/implementation-plan.md.", lifecycleTriggers: ["session_start", "before_model"], signature: null }),
      humanRow({ id: "startup-decision", type: "decision", summary: "We decided to ship v0.6 with the Claude Code host only.", lifecycleTriggers: ["session_start", "before_model"], signature: null }),
    ];
    await run.seed([...pitfalls, ...policies, ...workflows, ...startup]);

    const turn = await run.turn("A", "s12-budget.jsonl");
    run.checkTurn(turn);
    const start = turn.calls.find((call) => call.event === "session-start");
    run.equal("startup injects the two session_start rows only", [...(start?.result?.activated ?? [])].sort(), ["startup-decision", "startup-workflow"]);
    run.check("startup never includes a before_tool-only row", (start?.result?.activated ?? []).every((id) => !id.startsWith("pitfall-") && !id.startsWith("policy-") && !id.startsWith("workflow-")));
    run.check("startup context stays within 5 items / 3 KB", (start?.result?.activated.length ?? 0) <= 5 && utf8Bytes(start?.result?.additionalContext) <= 3_072);

    const pre = turn.calls.find((call) => call.event === "pre-tool");
    const activated = pre?.result?.activated ?? [];
    run.check("s12: at most 3 items fire for `npm test`", activated.length > 0 && activated.length <= 3, activated.join(","));
    run.check("s12: additionalContext within 2,048 bytes", utf8Bytes(pre?.result?.additionalContext) <= 2_048);
    run.check("s12: reason within 600 chars", (pre?.result?.reason?.length ?? 0) <= 600);
    run.check("s12: the ladder decided ask or deny", pre?.result?.decision === "ask" || pre?.result?.decision === "deny");
    const kinds = pre === undefined ? [] : suppressionKinds(pre);
    run.check("s12: the other matching rows are reported as suppressed", (pre?.result?.suppressed ?? 0) >= 13 - activated.length, `suppressed=${String(pre?.result?.suppressed)}`);
    run.check("s12: quota / budget suppressions present", kinds.includes("type_balance_limit") || kinds.includes("budget_limit"), kinds.join(","));
    run.check("s12: per-type quota — at most 2 pitfalls, 2 policies, 1 workflow", activated.filter((id) => id.startsWith("pitfall-")).length <= 2 && activated.filter((id) => id.startsWith("policy-")).length <= 2 && activated.filter((id) => id.startsWith("workflow-")).length <= 1);
    const fired = turn.producedLines.filter((line) => line.kind === "fired");
    run.equal("s12: exactly one fired line lists the injected ids", fired.map((line) => (line.kind === "fired" ? [...line.memory_ids].sort() : null)), [[...activated].sort()]);

    const result = await run.extract();
    run.checkWorker(result, "extract", { processed: 0 });
    run.equal("a signal-less turn is skipped", result.skipped.length, 1);
  },
});
