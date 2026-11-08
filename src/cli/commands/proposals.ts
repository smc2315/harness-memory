/**
 * `hm proposals:list [--kind <kind>] [--all]`, `hm proposals:accept <id> | --kind <kind> --all [--note <text>]`,
 * `hm proposals:reject <id> [--note <text>]` (spec §7.5, §11). Decisions run inside one lock session through
 * `decideProposal(db, {decidedBy: 'human'})`, which applies the per-kind side effects via transitionMemory
 * (supersede → replacement active as human, activate_* → promote as human, fix_* → scope applied, merge …),
 * and are recorded as write_ops `decision:<proposalId>:<now>`.
 */

import type { Database as SqlJsDatabase } from "sql.js";

import { EXIT_CODES } from "../../core/errors";
import { PROPOSAL_KINDS, type ProposalKind } from "../../core/vocabulary";
import { ProposalRepository, type ProposalRecord } from "../../db/repositories/proposals";
import { MemoryRepository } from "../../memory/repository";
import { decideProposal, type DecideProposalResult } from "../../promotion/proposals";
import type { CommandContext } from "../context";
import { flagBoolean, flagString, type OptionSpecs } from "../lib/args";
import { CliInputError, guard, usageError } from "../lib/cli-error";
import { readDb, writeDb } from "../lib/db-access";
import { resolveProposal, shortId } from "../lib/lookup";
import { clip, memoryToJson, type MemoryJson } from "../lib/memory-render";
import { parseEnum } from "../lib/options";
import { renderTable } from "../lib/output";

export const proposalsListOptions: OptionSpecs = {
  kind: { type: "string", description: `Only this kind (${PROPOSAL_KINDS.join(" | ")})`, placeholder: "<kind>" },
  all: { type: "boolean", description: "Include decided / expired proposals" },
};

export const proposalsAcceptOptions: OptionSpecs = {
  kind: { type: "string", description: "With --all: accept every open proposal of this kind", placeholder: "<kind>" },
  all: { type: "boolean", description: "Accept every open proposal of --kind" },
  note: { type: "string", description: "Decision note", placeholder: "<text>" },
};

export const proposalsRejectOptions: OptionSpecs = {
  note: { type: "string", description: "Decision note", placeholder: "<text>" },
};

export interface ProposalView {
  proposal: ProposalRecord;
  target: MemoryJson | null;
  candidate: MemoryJson | null;
}

export interface ProposalsListReport {
  open: number;
  proposals: ProposalView[];
}

export function listProposalViews(db: SqlJsDatabase, options: { kind?: ProposalKind; includeDecided: boolean }): ProposalView[] {
  const proposals = new ProposalRepository(db);
  const repository = new MemoryRepository(db);
  const rows = options.includeDecided
    ? [...proposals.listOpen(options.kind === undefined ? {} : { kind: options.kind }), ...proposals.listDecided(options.kind === undefined ? {} : { kind: options.kind })]
    : proposals.listOpen(options.kind === undefined ? {} : { kind: options.kind });
  const toJson = (id: string | null): MemoryJson | null => {
    if (id === null) return null;
    const memory = repository.getById(id);
    return memory === null ? null : memoryToJson(memory);
  };
  return rows.map((proposal) => ({ proposal, target: toJson(proposal.targetMemoryId), candidate: toJson(proposal.candidateMemoryId) }));
}

export function renderProposalTable(views: readonly ProposalView[]): string[] {
  if (views.length === 0) return ["no proposals"];
  return renderTable(
    views.map(({ proposal, target, candidate }) => [
      shortId(proposal.id),
      proposal.kind,
      proposal.status,
      `${shortId(proposal.targetMemoryId)}${target === null ? "" : ` ${target.authority}/${target.status}`}`,
      candidate === null ? "-" : shortId(candidate.id),
      `${String(proposal.supportCount)}/${String(proposal.supportSessions)}`,
      proposal.status === "open" ? proposal.expiresAt.slice(0, 10) : (proposal.decidedAt ?? "").slice(0, 10),
      clip(target?.summary ?? proposal.rationale.split("\n@payload ")[0] ?? "", 60),
    ]),
    ["ID", "KIND", "STATUS", "TARGET", "CANDIDATE", "SUPPORT", proposalsHaveDecided(views) ? "EXPIRES/DECIDED" : "EXPIRES", "TARGET SUMMARY"]
  );
}

function proposalsHaveDecided(views: readonly ProposalView[]): boolean {
  return views.some((view) => view.proposal.status !== "open");
}

export async function runProposalsList(ctx: CommandContext): Promise<number> {
  return guard(ctx, async () => {
    const kindRaw = flagString(ctx.args, "kind");
    const kind = kindRaw === null ? undefined : parseEnum<ProposalKind>(kindRaw, PROPOSAL_KINDS, "--kind");
    const includeDecided = flagBoolean(ctx.args, "all");
    const views = await readDb(ctx, (db) => listProposalViews(db, { kind, includeDecided }));
    const report: ProposalsListReport = { open: views.filter((view) => view.proposal.status === "open").length, proposals: views };
    ctx.out.result(report, () => renderProposalTable(views));
    return EXIT_CODES.ok;
  });
}

export interface DecisionView {
  proposal: ProposalRecord;
  effects: string[];
  memories: MemoryJson[];
}

export interface ProposalsDecisionReport {
  accept: boolean;
  decisions: DecisionView[];
}

function decisionView(result: DecideProposalResult): DecisionView {
  return { proposal: result.proposal, effects: result.effects, memories: result.memories.map(memoryToJson) };
}

export function renderDecisions(report: ProposalsDecisionReport): string[] {
  const verb = report.accept ? "accepted" : "rejected";
  if (report.decisions.length === 0) return [`no open proposals ${verb}`];
  const lines: string[] = [];
  for (const decision of report.decisions) {
    lines.push(`${verb} ${shortId(decision.proposal.id)} ${decision.proposal.kind} on ${shortId(decision.proposal.targetMemoryId)}${decision.effects.length > 0 ? `: ${decision.effects.join(", ")}` : ""}`);
    for (const memory of decision.memories) lines.push(`  ${shortId(memory.id)} → ${memory.status}/${memory.authority} ${memory.enforcement}  ${clip(memory.summary, 70)}`);
  }
  return lines;
}

async function decideOne(ctx: CommandContext, ref: string, accept: boolean, note: string | null): Promise<ProposalsDecisionReport> {
  const { value } = await writeDb<DecideProposalResult>(
    ctx,
    { purpose: `proposals:${accept ? "accept" : "reject"}`, kind: "decision", subject: ref, opId: (result, now) => decisionOpId(result.proposal.id, now) },
    (db, write) => {
      const proposal = resolveProposal(db, ref);
      if (proposal.status !== "open") throw new CliInputError(`proposal ${shortId(proposal.id)} is already ${proposal.status}`, { hint: "`hm proposals:list --all` shows decided proposals" });
      return decideProposal(db, { proposalId: proposal.id, decidedBy: "human", accept, now: write.now, note });
    }
  );
  return { accept, decisions: [decisionView(value)] };
}

async function decideAllOfKind(ctx: CommandContext, kind: ProposalKind, accept: boolean, note: string | null): Promise<ProposalsDecisionReport> {
  const { value } = await writeDb<DecideProposalResult[]>(
    ctx,
    { purpose: `proposals:${accept ? "accept" : "reject"}:all`, kind: "decision", subject: `all:${kind}`, opId: (_decisions, now) => `decision:all:${kind}:${now}` },
    (db, write) => {
      const open = new ProposalRepository(db).listOpen({ kind });
      return open.map((proposal) => decideProposal(db, { proposalId: proposal.id, decidedBy: "human", accept, now: write.now, note }));
    },
    (decisions) => decisions.length === 0
  );
  return { accept, decisions: value.map(decisionView) };
}

export async function runProposalsAccept(ctx: CommandContext): Promise<number> {
  return guard(ctx, async () => {
    const note = flagString(ctx.args, "note");
    const kindRaw = flagString(ctx.args, "kind");
    const all = flagBoolean(ctx.args, "all");
    let report: ProposalsDecisionReport;
    if (all) {
      if (kindRaw === null) throw usageError("--all needs --kind <kind>", `kinds: ${PROPOSAL_KINDS.join(", ")}`);
      report = await decideAllOfKind(ctx, parseEnum<ProposalKind>(kindRaw, PROPOSAL_KINDS, "--kind"), true, note);
    } else {
      const ref = ctx.args.positionals[0];
      if (ref === undefined) throw usageError("missing <id> (or use --kind <kind> --all)");
      report = await decideOne(ctx, ref, true, note);
    }
    ctx.out.result(report, renderDecisions);
    return EXIT_CODES.ok;
  });
}

export async function runProposalsReject(ctx: CommandContext): Promise<number> {
  return guard(ctx, async () => {
    const ref = ctx.args.positionals[0];
    if (ref === undefined) throw usageError("missing <id>");
    const report = await decideOne(ctx, ref, false, flagString(ctx.args, "note"));
    ctx.out.result(report, renderDecisions);
    return EXIT_CODES.ok;
  });
}

/** Decision op id in the form B1 asked for (`decision:<proposalId>:<now>`). */
export function decisionOpId(proposalId: string, now: string): string {
  return `decision:${proposalId}:${now}`;
}
