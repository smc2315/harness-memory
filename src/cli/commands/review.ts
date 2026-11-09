/**
 * `hm review [--json] [--list] [--accept-all-kind <kind>] [--keys a,r,s,…]` (spec §11).
 *
 * Interactive on a TTY: items in the spec's order (proposals on human memories → revalidate → policy
 * candidates → global candidates → fix_scope/fix_signature → merge → other proposals → unconfirmed imports →
 * human candidates → noisy auto activations), keys `a`ccept `r`eject `s`kip `t`race `p`romote (`q` quits).
 * Non-interactive: `--json` prints the queue, `--list` prints it as text, `--accept-all-kind <kind>` accepts
 * every open proposal of that kind (or `import` = confirm every unconfirmed import), `--keys` replays a key
 * sequence over the queue (scripts, tests). Every decision is its own lock session through the shared
 * memory-actions (transitionMemory, decideProposal) — nothing writes `status` directly.
 */

import { createInterface } from "node:readline";
import type { Database as SqlJsDatabase } from "sql.js";

import { EXIT_CODES } from "../../core/errors";
import { PROPOSAL_KINDS, type ProposalKind } from "../../core/vocabulary";
import { ProposalRepository } from "../../db/repositories/proposals";
import { MemoryRepository, type MemoryRecord } from "../../memory/repository";
import { decideProposal } from "../../promotion/proposals";
import type { CommandContext } from "../context";
import { flagBoolean, flagString, type OptionSpecs } from "../lib/args";
import { describeDomainError, guard, usageError } from "../lib/cli-error";
import { readDb, writeDb } from "../lib/db-access";
import { shortId } from "../lib/lookup";
import { confirmImportRow, declineImportRow, demoteMemory, promoteMemory, rejectMemory } from "../lib/memory-actions";
import { memoryToJson, type MemoryJson } from "../lib/memory-render";
import { collectReviewItems, countByGroup, itemsOfKind, REVIEW_GROUP_TITLES, renderReviewItem, reviewItemToJson, type ReviewGroup, type ReviewItem, type ReviewItemJson } from "../lib/review-queue";
import { collectMemoryTrace, renderMemoryTrace } from "./memory-history";
import { decisionOpId } from "./proposals";

export const reviewOptions: OptionSpecs = {
  list: { type: "boolean", description: "Print the review queue without prompting" },
  "accept-all-kind": { type: "string", description: `Accept every open proposal of this kind (${PROPOSAL_KINDS.join(" | ")}) or \`import\` to confirm all unconfirmed imports`, placeholder: "<kind>" },
  keys: { type: "string", description: "Comma-separated key sequence applied to the queue in order (a, r, s, p, q); no terminal needed", placeholder: "<a,r,s>" },
};

export const REVIEW_KEYS = ["a", "r", "s", "t", "p", "q"] as const;
export type ReviewKey = (typeof REVIEW_KEYS)[number];

export const REVIEW_PROMPT = "[a]ccept [r]eject [s]kip [t]race [p]romote [q]uit > ";

export interface ReviewDecision {
  key: string;
  group: ReviewGroup;
  action: ReviewKey;
  proposal_id: string | null;
  memory_id: string;
  effects: string[];
  memories: MemoryJson[];
}

export interface ReviewSessionReport {
  mode: "interactive" | "keys" | "accept_all";
  items: number;
  decided: ReviewDecision[];
  skipped: number;
  quit: boolean;
  remaining: number;
}

export interface ReviewListReport {
  items: ReviewItemJson[];
  counts: Record<ReviewGroup, number>;
}

export interface ReviewApplyResult {
  effects: string[];
  memories: MemoryRecord[];
  /** False when the key was a no-op (kept) — nothing to save. */
  wrote: boolean;
}

/**
 * Applies one key to one item inside an open lock session. Items are re-checked against the database because
 * an earlier decision in the same session may have changed them (a merge supersedes its partner, …).
 */
export function applyReviewKey(db: SqlJsDatabase, item: ReviewItem, key: Exclude<ReviewKey, "s" | "t" | "q">, options: { now: string; config: CommandContext["config"] }): ReviewApplyResult {
  const repository = new MemoryRepository(db, { clock: () => options.now });
  const memory = repository.getById(item.memory.id);
  if (memory === null) return { effects: ["memory_missing"], memories: [], wrote: false };

  if (item.kind === "proposal" && item.proposal !== null) {
    const proposal = new ProposalRepository(db).getById(item.proposal.id);
    if (proposal === null || proposal.status !== "open") return { effects: [`proposal_already_${proposal?.status ?? "gone"}`], memories: [], wrote: false };
    if (key === "p" && proposal.kind !== "activate_policy" && proposal.kind !== "activate_global") {
      const promoted = promoteMemory(db, memory, options.now, "cli:review:promote");
      return { effects: ["target:promoted(human)", "proposal:left_open"], memories: [promoted], wrote: true };
    }
    const accept = key === "a" || key === "p";
    const decision = decideProposal(db, { proposalId: proposal.id, decidedBy: "human", accept, now: options.now, note: "hm review" });
    return { effects: [`proposal:${accept ? "accepted" : "rejected"}`, ...decision.effects], memories: decision.memories, wrote: true };
  }

  switch (item.group) {
    case "import": {
      if (key === "r") return { effects: ["import:declined"], memories: [declineImportRow(db, memory, options.now, "cli:review:import_declined")], wrote: true };
      const confirmed = confirmImportRow(db, memory, { config: options.config, now: options.now });
      const effects = ["import:confirmed", `enforcement:${confirmed.enforcement}`];
      for (const id of confirmed.superseded) effects.push(`superseded:${shortId(id)}`);
      return { effects, memories: [confirmed.memory], wrote: true };
    }
    case "human_candidate": {
      if (key === "r") return { effects: ["candidate:rejected"], memories: [rejectMemory(db, memory, options.now, { reason: "cli:review:reject" })], wrote: true };
      return { effects: ["candidate:promoted"], memories: [promoteMemory(db, memory, options.now, "cli:review:promote")], wrote: true };
    }
    case "noisy_auto": {
      if (key === "r") return { effects: ["auto:demoted(stale)"], memories: [demoteMemory(db, memory, options.now, "cli:review:demote")], wrote: true };
      if (key === "p") return { effects: ["authority:human"], memories: [repository.setAuthority(memory.id, "human", options.now)], wrote: true };
      return { effects: ["kept"], memories: [memory], wrote: false };
    }
    default:
      return { effects: ["unsupported_item"], memories: [], wrote: false };
  }
}

async function decideItem(ctx: CommandContext, item: ReviewItem, key: Exclude<ReviewKey, "s" | "t" | "q">): Promise<ReviewDecision> {
  const { value } = await writeDb<ReviewApplyResult>(
    ctx,
    {
      purpose: "review",
      kind: item.kind === "proposal" ? "decision" : "review",
      subject: item.memory.id,
      opId: item.kind === "proposal" && item.proposal !== null ? (_value, now) => decisionOpId(item.proposal!.id, now) : undefined,
    },
    (db, write) => applyReviewKey(db, item, key, { now: write.now, config: ctx.config }),
    (result) => !result.wrote
  );
  return {
    key: item.key,
    group: item.group,
    action: key,
    proposal_id: item.proposal?.id ?? null,
    memory_id: item.memory.id,
    effects: value.effects,
    memories: value.memories.map(memoryToJson),
  };
}

export type ReviewAsk = (item: ReviewItem, index: number, total: number) => Promise<string>;

function parseKey(answer: string): ReviewKey | null {
  const key = answer.trim().toLowerCase().slice(0, 1);
  return (REVIEW_KEYS as readonly string[]).includes(key) ? (key as ReviewKey) : null;
}

/** Drives the queue with `ask` (TTY prompt or a scripted key list); prints each item in text mode. */
export async function runReviewSession(ctx: CommandContext, items: readonly ReviewItem[], ask: ReviewAsk, mode: ReviewSessionReport["mode"]): Promise<ReviewSessionReport> {
  const report: ReviewSessionReport = { mode, items: items.length, decided: [], skipped: 0, quit: false, remaining: 0 };
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]!;
    for (const line of renderReviewItem(item, index, items.length)) ctx.out.line(line);
    let settled = false;
    while (!settled) {
      const key = parseKey(await ask(item, index, items.length));
      if (key === null) {
        ctx.out.line(`  keys: ${REVIEW_KEYS.join(" ")}`);
        continue;
      }
      if (key === "q") {
        report.quit = true;
        report.remaining = items.length - index;
        return report;
      }
      if (key === "s") {
        report.skipped += 1;
        settled = true;
        continue;
      }
      if (key === "t") {
        const traced = await readDb(ctx, (db) => collectMemoryTrace(db, item.memory.id));
        for (const line of renderMemoryTrace(traced.memory, traced.report)) ctx.out.line(`    ${line}`);
        continue;
      }
      try {
        const decision = await decideItem(ctx, item, key);
        report.decided.push(decision);
        ctx.out.line(`  → ${decision.effects.join(", ")}`);
        settled = true;
      } catch (error) {
        const described = describeDomainError(error);
        if (described === null) throw error;
        ctx.out.line(`  ! ${described.message}${described.hint === null ? "" : ` (${described.hint})`}`);
        if (mode !== "interactive") {
          report.skipped += 1;
          settled = true;
        }
      }
    }
  }
  return report;
}

function ttyAsk(): { ask: ReviewAsk; close(): void } {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return {
    ask: () => new Promise<string>((resolve) => rl.question(REVIEW_PROMPT, (answer) => resolve(answer))),
    close: () => rl.close(),
  };
}

function scriptedAsk(keys: readonly string[]): ReviewAsk {
  let position = 0;
  return () => {
    const key = keys[position] ?? "q";
    position += 1;
    return Promise.resolve(key);
  };
}

export function renderReviewList(items: readonly ReviewItem[]): string[] {
  if (items.length === 0) return ["nothing to review"];
  const counts = countByGroup(items);
  const lines = [
    `${String(items.length)} item(s) to review: ${Object.entries(counts)
      .filter(([, count]) => count > 0)
      .map(([group, count]) => `${REVIEW_GROUP_TITLES[group as ReviewGroup]} ${String(count)}`)
      .join(" | ")}`,
  ];
  items.forEach((item, index) => lines.push(...renderReviewItem(item, index, items.length)));
  return lines;
}

export function renderReviewSession(report: ReviewSessionReport): string[] {
  const lines = [`review: ${String(report.decided.length)} decided, ${String(report.skipped)} skipped${report.quit ? `, quit with ${String(report.remaining)} remaining` : ""}`];
  for (const decision of report.decided) lines.push(`  ${decision.action} ${decision.group} ${shortId(decision.memory_id)}: ${decision.effects.join(", ")}`);
  return lines;
}

export async function runReview(ctx: CommandContext): Promise<number> {
  return guard(ctx, async () => {
    const acceptKind = flagString(ctx.args, "accept-all-kind");
    const keysRaw = flagString(ctx.args, "keys");
    const items = await readDb(ctx, (db) => collectReviewItems(db));

    if (acceptKind !== null) {
      const kind = acceptKind.trim();
      if (kind !== "import" && !(PROPOSAL_KINDS as readonly string[]).includes(kind)) {
        throw usageError(`unknown kind '${kind}' for --accept-all-kind`, `use ${PROPOSAL_KINDS.join(", ")} or import`);
      }
      const selected = itemsOfKind(items, kind as ProposalKind | "import");
      const report = await runReviewSession(ctx, selected, () => Promise.resolve("a"), "accept_all");
      ctx.out.result(report, renderReviewSession);
      return EXIT_CODES.ok;
    }

    if (keysRaw !== null) {
      const keys = keysRaw
        .split(",")
        .map((key) => key.trim().toLowerCase())
        .filter((key) => key.length > 0);
      for (const key of keys) {
        if (!(REVIEW_KEYS as readonly string[]).includes(key)) throw usageError(`--keys: '${key}' is not a review key`, `keys: ${REVIEW_KEYS.join(", ")}`);
      }
      const report = await runReviewSession(ctx, items, scriptedAsk(keys), "keys");
      ctx.out.result(report, renderReviewSession);
      return EXIT_CODES.ok;
    }

    if (ctx.json || flagBoolean(ctx.args, "list") || !ctx.isTTY) {
      const report: ReviewListReport = { items: items.map(reviewItemToJson), counts: countByGroup(items) };
      ctx.out.result(report, () => {
        const lines = renderReviewList(items);
        if (!ctx.isTTY && items.length > 0) lines.push("", "no terminal: decide with `hm review --keys …`, `hm review --accept-all-kind <kind>`, `hm proposals:accept|reject <id>` or `hm memory:promote|reject <id>`");
        return lines;
      });
      return EXIT_CODES.ok;
    }

    if (items.length === 0) {
      ctx.out.line("nothing to review");
      return EXIT_CODES.ok;
    }
    const tty = ttyAsk();
    try {
      const report = await runReviewSession(ctx, items, tty.ask, "interactive");
      ctx.out.result(report, renderReviewSession);
    } finally {
      tty.close();
    }
    return EXIT_CODES.ok;
  });
}
