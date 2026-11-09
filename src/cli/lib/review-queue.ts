/**
 * The review queue (spec §11): what a person is asked to look at, in the spec's order —
 * proposals on human memories → `revalidate` → policy candidates (`activate_policy`) → global candidates
 * (`activate_global`) → `fix_scope` / `fix_signature` → `merge` → remaining proposals (auto targets) →
 * unconfirmed imports → human candidates → noisy auto activations (`override_count > 0`).
 * Shared by `hm review` (interactive / --json / --accept-all-kind) and `memory:stats` (review load).
 */

import type { Database as SqlJsDatabase } from "sql.js";

import type { ProposalKind } from "../../core/vocabulary";
import { ProposalRepository, type ProposalRecord } from "../../db/repositories/proposals";
import { MemoryRepository, type MemoryRecord } from "../../memory/repository";
import { memoryToJson, type MemoryJson, clip } from "./memory-render";
import { shortId } from "./lookup";

export const REVIEW_GROUPS = [
  "human_target",
  "revalidate",
  "activate_policy",
  "activate_global",
  "fix",
  "merge",
  "other_proposal",
  "import",
  "human_candidate",
  "noisy_auto",
] as const;
export type ReviewGroup = (typeof REVIEW_GROUPS)[number];

export const REVIEW_GROUP_TITLES: Readonly<Record<ReviewGroup, string>> = {
  human_target: "proposals on human memories",
  revalidate: "revalidate (TTL) proposals",
  activate_policy: "policy candidates",
  activate_global: "global candidates",
  fix: "scope / signature fixes",
  merge: "merge proposals",
  other_proposal: "other proposals (auto targets)",
  import: "unconfirmed imports",
  human_candidate: "human candidates",
  noisy_auto: "noisy auto activations (override_count > 0)",
};

export interface ReviewItem {
  /** Stable key used by `--json` consumers: `proposal:<id>` or `memory:<id>`. */
  key: string;
  group: ReviewGroup;
  kind: "proposal" | "memory";
  proposal: ProposalRecord | null;
  /** The memory the decision is about: the proposal target, or the row itself. */
  memory: MemoryRecord;
  /** Replacement / merge partner of a proposal, when it has one. */
  candidate: MemoryRecord | null;
  /** One-line explanation shown in the prompt. */
  reason: string;
  createdAt: string;
}

export interface ReviewItemJson {
  key: string;
  group: ReviewGroup;
  kind: "proposal" | "memory";
  reason: string;
  created_at: string;
  proposal: ProposalRecord | null;
  memory: MemoryJson;
  candidate: MemoryJson | null;
}

function proposalGroup(proposal: ProposalRecord, target: MemoryRecord): ReviewGroup {
  if (target.authority === "human") return "human_target";
  switch (proposal.kind) {
    case "revalidate":
      return "revalidate";
    case "activate_policy":
      return "activate_policy";
    case "activate_global":
      return "activate_global";
    case "fix_scope":
    case "fix_signature":
      return "fix";
    case "merge":
      return "merge";
    case "supersede":
    case "stale":
      return "other_proposal";
  }
}

function proposalReason(proposal: ProposalRecord, candidate: MemoryRecord | null): string {
  const support = `support ${String(proposal.supportCount)} episode(s) / ${String(proposal.supportSessions)} session(s)`;
  const base = clip(proposal.rationale.split("\n@payload ")[0] ?? proposal.rationale, 140);
  const replacement = candidate === null ? "" : ` → ${shortId(candidate.id)} "${clip(candidate.summary, 60)}"`;
  return `${proposal.kind}${replacement}: ${base} (${support}, expires ${proposal.expiresAt.slice(0, 10)})`;
}

/** Every pending review item in the spec's order (groups, then oldest first). */
export function collectReviewItems(db: SqlJsDatabase): ReviewItem[] {
  const repository = new MemoryRepository(db);
  const proposals = new ProposalRepository(db);
  const items: ReviewItem[] = [];

  for (const proposal of proposals.listOpen()) {
    const target = repository.getById(proposal.targetMemoryId);
    if (target === null) continue;
    const candidate = proposal.candidateMemoryId === null ? null : repository.getById(proposal.candidateMemoryId);
    items.push({
      key: `proposal:${proposal.id}`,
      group: proposalGroup(proposal, target),
      kind: "proposal",
      proposal,
      memory: target,
      candidate,
      reason: proposalReason(proposal, candidate),
      createdAt: proposal.createdAt,
    });
  }

  for (const memory of repository.list({ importUnconfirmed: 1, status: ["candidate", "active", "stale"] })) {
    items.push({
      key: `memory:${memory.id}`,
      group: "import",
      kind: "memory",
      proposal: null,
      memory,
      candidate: null,
      reason: `imported with --yes from ${memory.sourceRef ?? "an import file"}; confirm to lift the advise cap`,
      createdAt: memory.createdAt,
    });
  }

  for (const memory of repository.list({ authority: "human", status: "candidate" })) {
    if (memory.importUnconfirmed === 1) continue;
    items.push({
      key: `memory:${memory.id}`,
      group: "human_candidate",
      kind: "memory",
      proposal: null,
      memory,
      candidate: null,
      reason: `human candidate (${memory.sourceKind}); promote to activate or reject`,
      createdAt: memory.createdAt,
    });
  }

  for (const memory of repository.list({ authority: "auto", status: "active" })) {
    if (memory.overrideCount <= 0) continue;
    items.push({
      key: `memory:${memory.id}`,
      group: "noisy_auto",
      kind: "memory",
      proposal: null,
      memory,
      candidate: null,
      reason: `fired ${String(memory.fireCount)}×, overridden ${String(memory.overrideCount)}× (${memory.enforcement}); keep, demote or take ownership`,
      createdAt: memory.createdAt,
    });
  }

  const order = new Map<ReviewGroup, number>(REVIEW_GROUPS.map((group, index) => [group, index]));
  return items.sort((left, right) => {
    const groupDelta = (order.get(left.group) ?? 99) - (order.get(right.group) ?? 99);
    if (groupDelta !== 0) return groupDelta;
    const timeDelta = left.createdAt.localeCompare(right.createdAt);
    return timeDelta !== 0 ? timeDelta : left.key.localeCompare(right.key);
  });
}

export function reviewItemToJson(item: ReviewItem): ReviewItemJson {
  return {
    key: item.key,
    group: item.group,
    kind: item.kind,
    reason: item.reason,
    created_at: item.createdAt,
    proposal: item.proposal,
    memory: memoryToJson(item.memory),
    candidate: item.candidate === null ? null : memoryToJson(item.candidate),
  };
}

export function countByGroup(items: readonly ReviewItem[]): Record<ReviewGroup, number> {
  const counts = Object.fromEntries(REVIEW_GROUPS.map((group) => [group, 0])) as Record<ReviewGroup, number>;
  for (const item of items) counts[item.group] += 1;
  return counts;
}

/** Items `--accept-all-kind <kind>` applies to: a proposal kind, or `import` for the unconfirmed import rows. */
export function itemsOfKind(items: readonly ReviewItem[], kind: ProposalKind | "import"): ReviewItem[] {
  if (kind === "import") return items.filter((item) => item.group === "import");
  return items.filter((item) => item.proposal !== null && item.proposal.kind === kind);
}

/** Heading + description lines for one item in text mode. */
export function renderReviewItem(item: ReviewItem, index: number, total: number): string[] {
  const memory = item.memory;
  const lines = [
    `[${String(index + 1)}/${String(total)}] ${REVIEW_GROUP_TITLES[item.group]}`,
    `  memory ${shortId(memory.id)} ${memory.status}/${memory.authority} ${memory.type} ${memory.enforcement} scope ${clip(memory.scopeGlob, 30)}`,
    `    ${clip(memory.summary, 120)}`,
    `  ${item.kind === "proposal" && item.proposal !== null ? `proposal ${shortId(item.proposal.id)} ` : ""}${item.reason}`,
  ];
  if (item.candidate !== null) {
    lines.push(`  candidate ${shortId(item.candidate.id)} ${item.candidate.status}/${item.candidate.authority}: ${clip(item.candidate.summary, 110)}`);
  }
  return lines;
}
