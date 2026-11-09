/**
 * `hm proposals:list|accept|reject` and `hm review` (spec §7.5, §11): decisions through decideProposal inside
 * one lock session (write_ops `decision:<proposalId>:<now>`), the review queue order, the key semantics
 * (a / r / s / p) replayed with --keys, --accept-all-kind, --json and the non-TTY listing.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import type { ProposalsDecisionReport, ProposalsListReport } from "../src/cli/commands/proposals";
import type { ReviewListReport, ReviewSessionReport } from "../src/cli/commands/review";
import { hasWriteOp } from "../src/db/meta";
import { ProposalRepository } from "../src/db/repositories/proposals";
import { MemoryRepository } from "../src/memory/repository";
import { openOrSupportProposal } from "../src/promotion/proposals";
import { createCliProject, runHm, type CliProject } from "./helpers/cli-run";
import { CLI_NOW, clockOptions, readProject, seedProject } from "./helpers/cli-seed";
import { autoMemory, humanMemory } from "./helpers/memory-fixtures";

let project: CliProject;

beforeEach(() => {
  project = createCliProject();
});

afterEach(() => {
  project.cleanup();
});

interface Seeded {
  humanActive: string;
  policyCandidate: string;
  replacement: string;
  staleProposal: string;
  activateProposal: string;
  supersedeProposal: string;
}

async function seedProposals(): Promise<Seeded> {
  const ids: Partial<Seeded> = {};
  await seedProject(project, (db) => {
    const memories = new MemoryRepository(db, { clock: () => CLI_NOW });
    const humanActive = memories.create(humanMemory({ summary: "Keep the changelog in English", type: "workflow" }));
    const policyCandidate = memories.create(autoMemory({ summary: "Never commit generated files under dist", type: "policy", lifecycleTriggers: ["before_model"] }));
    const replacement = memories.create(autoMemory({ summary: "Keep the changelog and release notes in English", type: "workflow", supersedesMemoryId: humanActive.id }));
    ids.humanActive = humanActive.id;
    ids.policyCandidate = policyCandidate.id;
    ids.replacement = replacement.id;
    ids.staleProposal = openOrSupportProposal(db, { kind: "stale", targetMemoryId: humanActive.id, rationale: "the changelog moved to GitHub releases", confidence: 0.7, createdBy: "extractor", now: CLI_NOW }).proposalId!;
    ids.activateProposal = openOrSupportProposal(db, { kind: "activate_policy", targetMemoryId: policyCandidate.id, rationale: "activate_policy: never commit dist", confidence: 0.8, createdBy: "extractor", now: CLI_NOW }).proposalId!;
    ids.supersedeProposal = openOrSupportProposal(db, { kind: "supersede", targetMemoryId: humanActive.id, candidateMemoryId: replacement.id, rationale: "broader wording", confidence: 0.75, createdBy: "extractor", now: CLI_NOW }).proposalId!;
  });
  return ids as Seeded;
}

describe("hm proposals:*", () => {
  test("lists open proposals, accepts and rejects them through decideProposal with the decision op id", async () => {
    const ids = await seedProposals();

    const list = await runHm(project, ["proposals:list", "--json"]);
    expect(list.code).toBe(0);
    const listed = list.json<ProposalsListReport>();
    expect(listed.open).toBe(3);
    expect(listed.proposals.map((view) => view.proposal.kind).sort()).toEqual(["activate_policy", "stale", "supersede"]);
    const onlyStale = (await runHm(project, ["proposals:list", "--kind", "stale", "--json"])).json<ProposalsListReport>();
    expect(onlyStale.proposals).toHaveLength(1);
    expect((await runHm(project, ["proposals:list"])).stdout).toContain("activate_policy");
    expect((await runHm(project, ["proposals:list", "--kind", "bogus"])).code).toBe(2);

    const accepted = await runHm(project, ["proposals:accept", ids.activateProposal.slice(0, 8), "--json"], clockOptions());
    expect(accepted.code).toBe(0);
    const acceptedReport = accepted.json<ProposalsDecisionReport>();
    expect(acceptedReport.decisions).toHaveLength(1);
    expect(acceptedReport.decisions[0]!.effects).toContain("target:active(human)");
    const policy = await readProject(project, (db) => new MemoryRepository(db).getById(ids.policyCandidate));
    expect(policy).toMatchObject({ status: "active", authority: "human" });
    expect(await readProject(project, (db) => hasWriteOp(db, `decision:${ids.activateProposal}:${CLI_NOW}`))).toBe(true);

    const rejected = await runHm(project, ["proposals:reject", ids.supersedeProposal, "--note", "wording is worse", "--json"], clockOptions());
    expect(rejected.code).toBe(0);
    expect(rejected.json<ProposalsDecisionReport>().decisions[0]!.effects).toContain("replacement:rejected");
    const replacement = await readProject(project, (db) => new MemoryRepository(db).getById(ids.replacement));
    expect(replacement?.status).toBe("rejected");
    const proposal = await readProject(project, (db) => new ProposalRepository(db).getById(ids.supersedeProposal));
    expect(proposal).toMatchObject({ status: "rejected", decidedBy: "human", decisionNote: "wording is worse" });

    const again = await runHm(project, ["proposals:accept", ids.supersedeProposal]);
    expect(again.code).toBe(1);
    expect(again.stderr).toContain("already rejected");

    const withDecided = (await runHm(project, ["proposals:list", "--all", "--json"])).json<ProposalsListReport>();
    expect(withDecided.proposals).toHaveLength(3);
    expect(withDecided.open).toBe(1);
  });

  test("--kind <kind> --all accepts every open proposal of that kind in one session and says so when there is none", async () => {
    const ids = await seedProposals();
    const none = await runHm(project, ["proposals:accept", "--kind", "merge", "--all"], clockOptions());
    expect(none.code).toBe(0);
    expect(none.stdout).toContain("no open proposals accepted");

    const all = await runHm(project, ["proposals:accept", "--kind", "stale", "--all", "--json"], clockOptions());
    expect(all.code).toBe(0);
    expect(all.json<ProposalsDecisionReport>().decisions).toHaveLength(1);
    const target = await readProject(project, (db) => new MemoryRepository(db).getById(ids.humanActive));
    expect(target?.status).toBe("stale");
    expect(await readProject(project, (db) => hasWriteOp(db, `decision:all:stale:${CLI_NOW}`))).toBe(true);

    expect((await runHm(project, ["proposals:accept", "--all"])).code).toBe(2);
    expect((await runHm(project, ["proposals:accept"])).code).toBe(2);
    expect((await runHm(project, ["proposals:reject"])).code).toBe(2);
  });
});

describe("hm review", () => {
  interface ReviewSeed {
    humanActive: string;
    policyCandidate: string;
    importRow: string;
    humanCandidate: string;
    noisyAuto: string;
    staleProposal: string;
    activateProposal: string;
  }

  async function seedReview(): Promise<ReviewSeed> {
    const ids: Partial<ReviewSeed> = {};
    await seedProject(project, (db) => {
      const memories = new MemoryRepository(db, { clock: () => CLI_NOW });
      // created_at order is deliberately scrambled against the expected review order
      const noisy = memories.create(autoMemory({ summary: "Noisy auto pitfall that keeps firing", status: "active", createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z" }));
      memories.recordFire(noisy.id, { at: CLI_NOW, count: 5, overrideDelta: 3 });
      const humanCandidate = memories.create(humanMemory({ summary: "Human candidate waiting for a decision", status: "candidate", createdAt: "2026-11-02T00:00:00.000Z" }));
      const importRow = memories.create(
        humanMemory({ summary: "Imported rule that is still unconfirmed", status: "active", sourceKind: "import", knowledgeKind: "import", importUnconfirmed: 1, sourceRef: "import:CLAUDE.md#L3", createdAt: "2026-11-03T00:00:00.000Z" })
      );
      const humanActive = memories.create(humanMemory({ summary: "Human active row with a stale proposal", createdAt: "2026-11-04T00:00:00.000Z" }));
      const policyCandidate = memories.create(autoMemory({ summary: "Auto policy candidate awaiting activation", type: "policy", lifecycleTriggers: ["before_model"], createdAt: "2026-11-05T00:00:00.000Z" }));
      ids.noisyAuto = noisy.id;
      ids.humanCandidate = humanCandidate.id;
      ids.importRow = importRow.id;
      ids.humanActive = humanActive.id;
      ids.policyCandidate = policyCandidate.id;
      ids.staleProposal = openOrSupportProposal(db, { kind: "stale", targetMemoryId: humanActive.id, rationale: "outdated", confidence: 0.7, createdBy: "extractor", now: CLI_NOW }).proposalId!;
      ids.activateProposal = openOrSupportProposal(db, { kind: "activate_policy", targetMemoryId: policyCandidate.id, rationale: "activate_policy", confidence: 0.8, createdBy: "extractor", now: CLI_NOW }).proposalId!;
    });
    return ids as ReviewSeed;
  }

  test("--json lists the queue in the spec's order; without a terminal the text listing explains how to decide", async () => {
    const ids = await seedReview();
    const listed = await runHm(project, ["review", "--json"]);
    expect(listed.code).toBe(0);
    const report = listed.json<ReviewListReport>();
    expect(report.items.map((item) => item.group)).toEqual(["human_target", "activate_policy", "import", "human_candidate", "noisy_auto"]);
    expect(report.items[0]!.proposal?.id).toBe(ids.staleProposal);
    expect(report.items[2]!.memory.id).toBe(ids.importRow);
    expect(report.counts.human_target).toBe(1);

    const text = await runHm(project, ["review"]);
    expect(text.code).toBe(0);
    expect(text.stdout).toContain("5 item(s) to review");
    expect(text.stdout).toContain("no terminal");
    const empty = createCliProject();
    try {
      await seedProject(empty, () => {});
      const nothing = await runHm(empty, ["review", "--list"]);
      expect(nothing.code).toBe(0);
      expect(nothing.stdout).toContain("nothing to review");
    } finally {
      empty.cleanup();
    }
  });

  test("--keys replays a / r / s / p over the queue with the per-group semantics", async () => {
    const ids = await seedReview();
    // stale proposal on the human row: reject; activate_policy: accept; import: accept (confirm);
    // human candidate: reject; noisy auto: promote = take ownership
    const session = await runHm(project, ["review", "--keys", "r,a,a,r,p", "--json"], clockOptions());
    expect(session.code).toBe(0);
    const report = session.json<ReviewSessionReport>();
    expect(report.mode).toBe("keys");
    expect(report.decided).toHaveLength(5);
    expect(report.skipped).toBe(0);
    expect(report.decided.map((decision) => decision.action)).toEqual(["r", "a", "a", "r", "p"]);

    await readProject(project, (db) => {
      const memories = new MemoryRepository(db);
      const proposals = new ProposalRepository(db);
      expect(proposals.getById(ids.staleProposal)?.status).toBe("rejected");
      expect(memories.getById(ids.humanActive)?.status).toBe("active");
      expect(proposals.getById(ids.activateProposal)?.status).toBe("accepted");
      expect(memories.getById(ids.policyCandidate)).toMatchObject({ status: "active", authority: "human" });
      expect(memories.getById(ids.importRow)).toMatchObject({ importUnconfirmed: 0, enforcement: "advise", status: "active" });
      expect(memories.getById(ids.humanCandidate)?.status).toBe("rejected");
      expect(memories.getById(ids.noisyAuto)).toMatchObject({ authority: "human", status: "active" });
      expect(hasWriteOp(db, `decision:${ids.staleProposal}:${CLI_NOW}`)).toBe(true);
    });

    const afterwards = (await runHm(project, ["review", "--json"])).json<ReviewListReport>();
    expect(afterwards.items).toEqual([]);
  });

  test("s skips, q quits early, keep on a noisy row writes nothing, and bad keys are a usage error", async () => {
    const ids = await seedReview();
    const session = (await runHm(project, ["review", "--keys", "s,q", "--json"], clockOptions())).json<ReviewSessionReport>();
    expect(session).toMatchObject({ decided: [], skipped: 1, quit: true, remaining: 4 });

    const keep = (await runHm(project, ["review", "--keys", "s,s,s,s,a", "--json"], clockOptions())).json<ReviewSessionReport>();
    expect(keep.decided).toHaveLength(1);
    expect(keep.decided[0]).toMatchObject({ group: "noisy_auto", effects: ["kept"] });
    const generation = await readProject(project, (db) => Number(db.exec("SELECT value FROM meta WHERE key = 'db_generation'")[0]!.values[0]![0]));
    expect(generation).toBe(1);
    expect(await readProject(project, (db) => new MemoryRepository(db).getById(ids.noisyAuto)?.authority)).toBe("auto");

    const demote = (await runHm(project, ["review", "--keys", "s,s,s,s,r", "--json"], clockOptions())).json<ReviewSessionReport>();
    expect(demote.decided[0]!.effects).toEqual(["auto:demoted(stale)"]);
    expect(await readProject(project, (db) => new MemoryRepository(db).getById(ids.noisyAuto)?.status)).toBe("stale");

    expect((await runHm(project, ["review", "--keys", "x"])).code).toBe(2);
  });

  test("--accept-all-kind accepts every proposal of a kind or confirms every unconfirmed import", async () => {
    const ids = await seedReview();
    const imports = await runHm(project, ["review", "--accept-all-kind", "import", "--json"], clockOptions());
    expect(imports.code).toBe(0);
    expect(imports.json<ReviewSessionReport>()).toMatchObject({ mode: "accept_all", items: 1 });
    expect(await readProject(project, (db) => new MemoryRepository(db).getById(ids.importRow)?.importUnconfirmed)).toBe(0);

    const policies = await runHm(project, ["review", "--accept-all-kind", "activate_policy"], clockOptions());
    expect(policies.code).toBe(0);
    expect(policies.stdout).toContain("1 decided");
    expect(await readProject(project, (db) => new MemoryRepository(db).getById(ids.policyCandidate)?.status)).toBe("active");

    expect((await runHm(project, ["review", "--accept-all-kind", "bogus"])).code).toBe(2);
  });

  test("r on an unconfirmed import demotes the row to stale (no active → rejected edge exists)", async () => {
    const ids = await seedReview();
    const session = (await runHm(project, ["review", "--keys", "s,s,r,q", "--json"], clockOptions())).json<ReviewSessionReport>();
    expect(session.decided).toHaveLength(1);
    expect(session.decided[0]!.effects).toEqual(["import:declined"]);
    const row = await readProject(project, (db) => new MemoryRepository(db).getById(ids.importRow));
    expect(row).toMatchObject({ status: "stale", statusReason: "human" });
  });
});
