/**
 * s09 — lifecycle (§13.2 (k) and §13.1 s09 stale suppression): a learned correction row (TTL 30 d →
 * revalidate proposal → stale when the proposal expires), a bare-failure candidate (rejected(expiry) at
 * 45 d), a seeded auto convention row (fired once → TTL extended to last_fired + 14 d, then stale(ttl_expired));
 * the hooks suppress a TTL-expired row before the dream and no longer see it afterwards.
 */

import { ProposalRepository } from "../../../db/repositories/proposals";
import { TransitionRepository } from "../../../db/repositories/transitions";
import { defineScenario } from "../scenario";
import { autoRow, cmdSignature } from "./seeds";
import { isoPlus, suppressionKindOf } from "./util";

export const s09 = defineScenario({
  id: "s09",
  title: "TTL / revalidate / candidate expiry paths and stale suppression in the hooks",
  asserts: ["k", "13.1:s09"],
  async run(run) {
    const t0 = run.now();
    const [convention] = await run.seed([
      autoRow({
        id: "seed-convention",
        summary: "Rebase onto origin before pushing; force pushes are rejected by the branch protection.",
        signature: cmdSignature("git push --force"),
        knowledgeKind: "convention",
        enforcement: "advise",
        ttlExpiresAt: isoPlus(t0, { days: 7 }),
      }),
    ]);

    const correctionTurn = await run.turn("A", "s09-lifecycle.jsonl", { turnKey: "p91" });
    run.checkTurn(correctionTurn);
    const failureTurn = await run.turn("B", "s09-lifecycle.jsonl", { turnKey: "p92" });
    run.checkTurn(failureTurn);
    const extractAt = run.now();
    const extracted = await run.extract({ outputs: "s09.outputs.json" });
    run.checkWorker(extracted, "extract", { processed: 2, statuses: ["ok", "ok"] });
    const correctionId = run.createdFor("A", "p91")[0];
    const candidateId = run.createdFor("B", "p92")[0];
    if (correctionId === undefined || candidateId === undefined) {
      run.fail("(k) both episodes created a row", `${String(correctionId)} / ${String(candidateId)}`);
      return;
    }
    run.equal("(k) the correction row activated with a 30 d TTL", [(await run.memory(correctionId))?.status, (await run.memory(correctionId))?.ttlExpiresAt], ["active", isoPlus(extractAt, { days: 30 })]);
    run.equal("(k) the bare failure stays a candidate", (await run.memory(candidateId))?.status, "candidate");

    // +1 h: both rows fire in a third session (the convention row as advise, the correction row as soft_deny).
    run.at(isoPlus(t0, { hours: 1 }));
    await run.prompt("C", "push the branch", { promptId: "c1" });
    const push = await run.preTool("C", { tool: "Bash", command: "git push --force origin main" });
    run.equal("advise convention row fires (context only)", [push.result?.decision, push.result?.activated], ["none", [convention!.id]]);
    const tests = await run.preTool("C", { tool: "Bash", command: "npm test" });
    run.equal("the learned correction row fires with deny", [tests.result?.decision, tests.result?.activated], ["deny", [correctionId]]);
    await run.stop("C", "Pushed after a rebase.");

    // +8 d: the convention row reached its TTL but fired a week ago → extended to last_fired + 14 d instead of staled (§5.8).
    const dream8 = await run.dream({ at: isoPlus(t0, { days: 8 }) });
    run.checkWorker(dream8, "dream +8d");
    run.equal("(k) a recently fired row is extended, not staled", [dream8.dream?.ttlExtended, dream8.dream?.staled], [[convention!.id], []]);
    const extended = await run.memory(convention!.id);
    run.equal("(k) TTL = last_fired_at + 14 d", extended?.ttlExpiresAt, isoPlus(extended?.lastFiredAt ?? t0, { days: 14 }));

    // +20 d: the snapshot still lists the row, its TTL has passed → the hook suppresses it (ttl_expired).
    run.at(isoPlus(t0, { days: 20 }));
    await run.prompt("C", "push again", { promptId: "c2" });
    const expiredPre = await run.preTool("C", { tool: "Bash", command: "git push --force origin main" });
    run.equal("s09: a TTL-expired row does not fire", expiredPre.result?.activated, []);
    run.equal("s09: suppression kind ttl_expired", suppressionKindOf(expiredPre, convention!.id), "ttl_expired");
    await run.stop("C", "Done.");

    // +31 d: convention → stale(ttl_expired); correction row at its TTL → revalidate proposal, still active.
    const dream31 = await run.dream({ at: isoPlus(t0, { days: 31 }) });
    run.checkWorker(dream31, "dream +31d");
    run.equal("(k) convention row staled at TTL", dream31.dream?.staled, [convention!.id]);
    run.equal("(k) convention status stale / ttl_expired", [(await run.memory(convention!.id))?.status, (await run.memory(convention!.id))?.statusReason], ["stale", "ttl_expired"]);
    run.equal("(k) one revalidate proposal for the correction row", dream31.dream?.revalidateProposals.length, 1);
    const proposalId = dream31.dream?.revalidateProposals[0];
    await run.read((db) => {
      const proposal = proposalId === undefined ? null : new ProposalRepository(db).getById(proposalId);
      run.equal("(k) proposal targets the correction row and expires in 30 d", [proposal?.kind, proposal?.targetMemoryId, proposal?.expiresAt], ["revalidate", correctionId, isoPlus(t0, { days: 61 })]);
    });
    run.equal("(k) the correction row stays active while the proposal is open", (await run.memory(correctionId))?.status, "active");

    // After the rebuild the stale row is gone from the snapshot.
    await run.prompt("D", "push once more", { promptId: "d1" });
    const stalePre = await run.preTool("D", { tool: "Bash", command: "git push --force origin main" });
    run.equal("s09: a stale row never fires", stalePre.result?.activated, []);
    run.equal("s09: the stale row is not in the snapshot at all", suppressionKindOf(stalePre, convention!.id), null);
    await run.stop("D", "Done.");

    // +46 d: the never-activated candidate is rejected(expiry); the open proposal keeps the correction row active.
    const dream46 = await run.dream({ at: isoPlus(t0, { days: 46 }) });
    run.checkWorker(dream46, "dream +46d");
    run.equal("(k) candidate rejected after 45 d", dream46.dream?.rejectedCandidates, [candidateId]);
    run.equal("(k) candidate status rejected / expiry", [(await run.memory(candidateId))?.status, (await run.memory(candidateId))?.statusReason], ["rejected", "expiry"]);
    run.equal("(k) no second revalidate proposal", dream46.dream?.revalidateProposals, []);

    // +62 d: the revalidate proposal expires → stale(ttl_expired).
    const dream62 = await run.dream({ at: isoPlus(t0, { days: 62 }) });
    run.checkWorker(dream62, "dream +62d");
    run.equal("(k) the proposal expired", dream62.dream?.expiredProposals, proposalId === undefined ? [] : [proposalId]);
    run.equal("(k) correction row staled by the proposal expiry", dream62.dream?.staledByExpiry, [correctionId]);
    const finalRow = await run.memory(correctionId);
    run.equal("(k) correction row stale / ttl_expired", [finalRow?.status, finalRow?.statusReason], ["stale", "ttl_expired"]);
    await run.read((db) => {
      const transitions = new TransitionRepository(db).listForMemory(correctionId);
      run.equal("(k) transitions: auto activation then expiry stale", transitions.map((row) => [row.toStatus, row.actor]), [["active", "auto_rule"], ["stale", "expiry"]]);
    });
  },
});
