/**
 * s03 — (§13.1 s03) writing `.env` meets the human hard policy: PreToolUse → `ask` with a reason and a
 * systemMessage, a `fired` line with the compiled signature key; the recorded `reinforce` of the human
 * row only moves counters (the auto path never changes a human row's status or authority).
 */

import { defineScenario } from "../scenario";
import { humanRow, pathSignature } from "./seeds";

export const s03 = defineScenario({
  id: "s03",
  title: ".env write hits the confirm policy → ask; extraction leaves the human row untouched",
  asserts: ["13.1:s03", "13.1:human-untouched"],
  async run(run) {
    const [policy] = await run.seed([
      humanRow({
        id: "seed-env-policy",
        type: "policy",
        summary: "Never write secrets into .env files from the agent",
        details: "Secrets go through the vault CLI; .env edits need a human.",
        signature: pathSignature("write|edit", "**/.env*"),
        lifecycleTriggers: ["before_tool", "before_model"],
        enforcement: "confirm",
        policySubtype: "hard",
        importance: 0.9,
        confidence: 0.95,
      }),
    ]);

    const turn = await run.turn("A", "s03-env-write.jsonl", { compareFired: true });
    run.checkTurn(turn);
    const pre = turn.calls.find((call) => call.event === "pre-tool");
    run.equal("s03: PreToolUse Write .env → ask", pre?.result?.decision, "ask");
    run.equal("s03: effective enforcement confirm, delivered before the call", [pre?.result?.enforcement, pre?.result?.delivery], ["confirm", "before"]);
    run.equal("s03: the policy is the activated item", pre?.result?.activated, [policy!.id]);
    run.check("s03: stdout carries permissionDecision ask + reason", pre?.stdout?.hookSpecificOutput?.permissionDecision === "ask" && (pre?.stdout?.hookSpecificOutput?.permissionDecisionReason?.length ?? 0) > 0);
    run.check("s03: a systemMessage names the fired policy", typeof pre?.stdout?.systemMessage === "string" && pre.stdout.systemMessage.includes("confirm"));
    run.check("s03: the reason stays within 600 chars", (pre?.result?.reason?.length ?? 0) <= 600);

    const extractAt = run.now();
    const result = await run.extract({ outputs: "s03.outputs.json" });
    run.checkWorker(result, "extract", { processed: 1, statuses: ["ok"] });
    run.equal("reinforce created nothing", run.createdFor("A", "p31"), []);
    const after = await run.memory("seed-env-policy");
    run.equal("human row keeps status/authority/enforcement", [after?.status, after?.authority, after?.enforcement], ["active", "human", "confirm"]);
    run.equal("human row gained evidence counters only", [after?.evidenceCount, after?.ttlExpiresAt], [1, null]);
    run.equal("human confidence untouched by the auto path", after?.confidence, 0.95);
    run.check("last_verified_at moved to the episode close", after?.lastVerifiedAt !== null && after !== null && Date.parse(after.lastVerifiedAt!) <= Date.parse(extractAt));
  },
});
