/**
 * s10 — proposals (§13.2 (e), (f), (h)): a hallucinated propose_supersede against a human row leaves
 * exactly one active row; a 1-support propose_stale changes nothing while 2-session support demotes an
 * auto row; propose → expire → propose opens a fresh proposal. The human row's status and authority never
 * change through the auto path.
 */

import { ProposalRepository } from "../../../db/repositories/proposals";
import { TransitionRepository } from "../../../db/repositories/transitions";
import { defineScenario } from "../scenario";
import { autoRow, humanRow } from "./seeds";
import { isoPlus } from "./util";

export const s10 = defineScenario({
  id: "s10",
  title: "propose_supersede on a human row, propose_stale support counting, propose → expire → propose",
  asserts: ["e", "f", "h", "13.1:human-untouched"],
  async run(run) {
    const t0 = run.now();
    await run.seed([
      humanRow({ id: "seed-human-npm-test", type: "pitfall", summary: "Run npm test before pushing changes.", details: "Team rule.", lifecycleTriggers: ["before_model"], knowledgeKind: "manual", confidence: 0.9 }),
      autoRow({ id: "seed-auto-convention", summary: "Use npm test to run the suite in this repository.", lifecycleTriggers: ["before_model"], knowledgeKind: "convention", enforcement: "advise", signature: null, confidence: 0.8 }),
      autoRow({ id: "seed-auto-convention-2", summary: "Run the linter with npm run lint before committing.", lifecycleTriggers: ["before_model"], knowledgeKind: "convention", enforcement: "advise", signature: null, confidence: 0.8 }),
    ]);

    // (e)
    const supersede = await run.turn("A", "s10-proposals.jsonl", { turnKey: "p101" });
    run.checkTurn(supersede);
    const first = await run.extract({ outputs: "s10.outputs.json" });
    run.checkWorker(first, "extract (e)", { processed: 1, statuses: ["ok"] });
    const active = await run.memories({ status: "active" });
    const claim = active.filter((row) => row.id === "seed-human-npm-test" || row.supersedesMemoryId === "seed-human-npm-test");
    run.equal("(e) exactly one active row for the claim after the hallucinated supersede (the human one)", claim.map((row) => row.id), ["seed-human-npm-test"]);
    run.equal("(e) the other seeded rows are untouched", active.filter((row) => row.id.startsWith("seed-auto")).length, 2);
    const human = await run.memory("seed-human-npm-test");
    run.equal("(e) human row keeps status/authority", [human?.status, human?.authority], ["active", "human"]);
    run.equal("(e) human row is marked contested with an open proposal", [human?.contested, human?.openProposalId !== null], [1, true]);
    await run.read((db) => {
      const proposals = new ProposalRepository(db).listOpen({ kind: "supersede", targetId: "seed-human-npm-test" });
      run.equal("(e) one open supersede proposal with 1 support", proposals.map((proposal) => proposal.supportCount), [1]);
      const candidateId = proposals[0]?.candidateMemoryId ?? null;
      run.check("(e) the replacement row is a candidate", candidateId !== null);
      run.equal("(e) no transition was written for the human row", new TransitionRepository(db).listForMemory("seed-human-npm-test"), []);
    });
    const replacement = (await run.memories({ status: "candidate" }))[0];
    run.equal("(e) replacement candidate is auto and supersedes the human row", [replacement?.authority, replacement?.supersedesMemoryId], ["auto", "seed-human-npm-test"]);

    // (f) one support session does nothing …
    const staleOne = await run.turn("B", "s10-proposals.jsonl", { turnKey: "p102" });
    run.checkTurn(staleOne);
    const second = await run.extract({ outputs: "s10.outputs.json" });
    run.checkWorker(second, "extract (f1)", { processed: 1, statuses: ["ok"] });
    run.equal("(f) 1-support propose_stale leaves the auto row active", (await run.memory("seed-auto-convention"))?.status, "active");
    const openAfterOne = await run.read((db) => new ProposalRepository(db).listOpen({ kind: "stale", targetId: "seed-auto-convention" }));
    run.equal("(f) one open stale proposal with one support session", openAfterOne.map((proposal) => [proposal.supportCount, proposal.supportSessions]), [[1, 1]]);

    // … a second session demotes the row by auto_rule.
    const staleTwo = await run.turn("C", "s10-proposals.jsonl", { turnKey: "p103" });
    run.checkTurn(staleTwo);
    const third = await run.extract({ outputs: "s10.outputs.json" });
    run.checkWorker(third, "extract (f2)", { processed: 1, statuses: ["ok"] });
    const demoted = await run.memory("seed-auto-convention");
    run.equal("(f) 2-session support demotes the auto row to stale", demoted?.status, "stale");
    await run.read((db) => {
      const proposal = openAfterOne[0] === undefined ? null : new ProposalRepository(db).getById(openAfterOne[0].id);
      run.equal("(f) the proposal was accepted by auto_rule with 2 support sessions", [proposal?.status, proposal?.decidedBy, proposal?.supportSessions], ["accepted", "auto_rule", 2]);
      run.equal("(f) the stale transition cites the proposal", new TransitionRepository(db).listForMemory("seed-auto-convention").map((row) => [row.toStatus, row.actor, row.proposalId]), [["stale", "auto_rule", openAfterOne[0]?.id ?? null]]);
    });

    // (h) propose → expire → propose on the second convention row.
    run.at(isoPlus(t0, { hours: 1 }));
    const proposeOne = await run.turn("D", "s10-proposals.jsonl", { turnKey: "p104" });
    run.checkTurn(proposeOne);
    const fourth = await run.extract({ outputs: "s10.outputs.json" });
    run.checkWorker(fourth, "extract (h1)", { processed: 1, statuses: ["ok"] });
    const firstProposal = (await run.read((db) => new ProposalRepository(db).listOpen({ kind: "stale", targetId: "seed-auto-convention-2" })))[0];
    run.check("(h) a stale proposal is open on the second convention row", firstProposal !== undefined);

    const dream = await run.dream({ at: isoPlus(t0, { days: 31 }) });
    run.checkWorker(dream, "dream +31d");
    // The (e) supersede proposal (opened at t0) expires in the same dream; the accepted (f) proposal cannot.
    run.check("(h) the proposal expired after 30 d", firstProposal !== undefined && (dream.dream?.expiredProposals ?? []).includes(firstProposal.id), (dream.dream?.expiredProposals ?? []).join(","));
    run.equal("(h) two open proposals expired (supersede from (e) + stale from (h))", dream.dream?.expiredProposals.length, 2);
    const afterExpiry = await run.memory("seed-auto-convention-2");
    run.equal("(h) the target is untouched by the expiry (active, no open proposal)", [afterExpiry?.status, afterExpiry?.openProposalId, afterExpiry?.contested], ["active", null, 0]);

    run.at(isoPlus(t0, { days: 32 }));
    const proposeTwo = await run.turn("E", "s10-proposals.jsonl", { turnKey: "p105" });
    run.checkTurn(proposeTwo);
    const fifth = await run.extract({ outputs: "s10.outputs.json" });
    run.checkWorker(fifth, "extract (h2)", { processed: 1, statuses: ["ok"] });
    const reopened = await run.read((db) => new ProposalRepository(db).listOpen({ kind: "stale", targetId: "seed-auto-convention-2" }));
    run.equal("(h) a new proposal opened with one support", reopened.map((proposal) => proposal.supportCount), [1]);
    run.check("(h) the new proposal is not the expired one", reopened[0] !== undefined && firstProposal !== undefined && reopened[0].id !== firstProposal.id);

    const finalHuman = await run.memory("seed-human-npm-test");
    run.equal("human row still active / human after every auto step", [finalHuman?.status, finalHuman?.authority], ["active", "human"]);
  },
});
