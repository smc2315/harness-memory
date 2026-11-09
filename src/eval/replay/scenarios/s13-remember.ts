/**
 * s13 — remember-as-human (A′, positioning §8): a "기억해" turn in session A yields a policy fact that cites the
 * remember prompt line and an architecture_constraint fact that cites only the tool line. The first becomes a human-authority rule,
 * active immediately with the hard-policy enforcement (confirm) and no TTL — no candidate, no `hm review`; the
 * second stays on the automatic path (auto candidate behind an `activate_global` proposal). Session B is told about
 * the new rule at SessionStart and `git commit` asks before running; `hm memory:demote` (one human transition)
 * undoes it and session C sees nothing.
 *
 * The recorded output test/fixtures/replay/s13.outputs.json is hand-authored in the shape of the other files
 * (a real `claude -p` run of the same turn produced the policy / `git commit` signature in phase-e-notes §4b).
 */

import type { PromptLine } from "../../../core/ledger-types";
import { ProposalRepository } from "../../../db/repositories/proposals";
import { TransitionRepository } from "../../../db/repositories/transitions";
import type { ReconcileReport } from "../../../dream/reconcile";
import { transitionMemory } from "../../../promotion/transitions";
import { defineScenario } from "../scenario";

export const s13 = defineScenario({
  id: "s13",
  title: "a remember turn yields an immediately active human rule; the next session is told and asked",
  asserts: ["A′:remember", "13.1:human-untouched"],
  async run(run) {
    const turn = await run.turn("A", "s13-remember.jsonl");
    run.checkTurn(turn);
    const descriptor = turn.descriptor;
    if (descriptor === null) return;
    const promptLine = turn.producedLines.find((line): line is PromptLine & { offset: number; length: number } => line.kind === "prompt");
    run.equal("the prompt hook flagged remember (and not correction)", [promptLine?.remember, promptLine?.correction], [1, 0]);
    run.equal("flags = {remember: 1}, evidence_weight 3", [descriptor.flags, descriptor.evidence_weight], [{ remember: 1 }, 3]);

    const result = await run.extract({ outputs: "s13.outputs.json" });
    run.checkWorker(result, "extract", { processed: 1, statuses: ["ok"] });
    const created = run.createdFor("A", "p131");
    run.equal("two rows created (remember policy + tool-only constraint)", created.length, 2);
    const rows = await Promise.all(created.map((id) => run.memory(id)));
    const rule = rows.find((row) => row?.type === "policy") ?? null;
    const workflow = rows.find((row) => row?.type === "architecture_constraint") ?? null;
    if (rule === null || workflow === null) {
      run.fail("both rows exist", rows.map((row) => `${row?.type ?? "null"}/${row?.status ?? "null"}`).join(","));
      return;
    }
    run.equal(
      "(A′) the remembered policy is human / active / remember with the hard-policy enforcement and no TTL",
      [rule.authority, rule.status, rule.statusReason, rule.enforcement, rule.ttlExpiresAt, rule.sourceKind, rule.policySubtype, rule.signatureKey, rule.importUnconfirmed],
      ["human", "active", "remember", "confirm", null, "extraction", "hard", "bash|command|cmd|git commit", 0]
    );
    run.equal("(A′) the fact citing only the tool line follows the automatic path", [workflow.authority, workflow.status, workflow.enforcement], ["auto", "candidate", "advise"]);
    await run.read((db) => {
      run.equal("no status transition is invented for the remembered row (born active)", new TransitionRepository(db).listForMemory(rule.id), []);
      run.equal("the constraint waits for a human (activate_global proposal)", new ProposalRepository(db).listOpen({ targetId: workflow.id }).map((proposal) => proposal.kind), ["activate_global"]);
    });
    const report = (result.processed[0]?.op as { report?: ReconcileReport } | undefined)?.report;
    run.equal("the reconcile report lists the remembered row and no automatic activation", [report?.remembered, report?.activated, report?.escalated], [[rule.id], [], []]);

    // Session B: the notice, then the rule asks before the commit; the lint command it asks for is untouched.
    run.advance({ minutes: 5 });
    const start = await run.sessionStart("B");
    const notice = start.result?.systemMessage ?? "";
    run.check(
      "SessionStart names the new rule with the one-command undo",
      notice.includes("1 rule from your request is active") && notice.includes("Run pnpm lint before every git commit") && notice.includes(`hm memory:demote ${rule.id.slice(0, 8)}`),
      notice
    );
    await run.prompt("B", "commit the change", { promptId: "b1" });
    const commit = await run.preTool("B", { tool: "Bash", command: 'git commit -m "lint before commit"' });
    run.equal("`git commit` in session B → ask (confirm) by the remembered policy", [commit.result?.decision, commit.result?.enforcement, commit.result?.activated], ["ask", "confirm", [rule.id]]);
    run.check("stdout carries permissionDecision ask with the policy as reason", commit.stdout?.hookSpecificOutput?.permissionDecision === "ask" && (commit.stdout?.hookSpecificOutput?.permissionDecisionReason ?? "").includes("pnpm lint"));
    const lint = await run.preTool("B", { tool: "Bash", command: "pnpm lint" });
    run.equal("`pnpm lint` fires nothing", [lint.result?.decision, lint.result?.activated], ["none", []]);
    await run.stop("B", "Linted and committed.");

    // Undo: hm memory:demote is one human transition (active → stale); the next session hears and sees nothing.
    await run.write("eval:memory:demote", (db, ctx) => {
      transitionMemory(db, { memoryId: rule.id, to: "stale", actor: "human", reason: "cli:memory:demote", now: ctx.now });
      return { id: null, kind: "eval:memory:demote", noop: false, wrote: true };
    });
    const demoted = await run.memory(rule.id);
    run.equal("hm memory:demote reverts the rule in one transition", [demoted?.status, demoted?.statusReason, demoted?.authority], ["stale", "human", "human"]);
    const startC = await run.sessionStart("C");
    run.check("session C gets no remember notice", !(startC.result?.systemMessage ?? "").includes("from your request"), startC.result?.systemMessage ?? "");
    await run.prompt("C", "commit again", { promptId: "c1" });
    const commitC = await run.preTool("C", { tool: "Bash", command: 'git commit -m "again"' });
    run.equal("`git commit` in session C fires nothing", [commitC.result?.decision, commitC.result?.activated], ["none", []]);
    await run.stop("C", "Committed.");
  },
});
