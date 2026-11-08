/**
 * transitionMemory — the single writer of `memories.status` (spec §4.7, §7.1, §12 R4).
 *
 * Edge table (from → to by actor; "auto only" = the row must have authority='auto'):
 *
 *   candidate → active      human | auto_rule (auto only)
 *   candidate → rejected    human | expiry (auto only) | migration
 *   active    → stale       human | import | expiry (auto only) | auto_rule (auto only)
 *   candidate|active|stale → superseded   human | import ; auto_rule only from active (auto only)
 *   stale     → active      human | auto_rule (auto only, status_reason = 'ttl_expired')
 *   superseded → active     human (restore)
 *
 * Invariant: an actor in {auto_rule, expiry} touching an authority='human' row throws
 * AuthorityViolationError before anything is written, whatever the edge. Every applied transition
 * writes a `memory_transitions` row. This file and the migrations are the only places allowed to
 * run `UPDATE memories SET status = …` (grep invariant in §4.7); MemoryRepository.update() rejects status.
 */

import type { Database as SqlJsDatabase } from "sql.js";

import { AuthorityViolationError } from "../core/errors";
import type { Authority, MemoryStatus, StatusReason, TransitionActor } from "../core/vocabulary";
import { TransitionRepository } from "../db/repositories/transitions";
import {
  InvalidMemoryTransitionError,
  MemoryNotFoundError,
  MemoryRepository,
  type MemoryRecord,
} from "../memory/repository";

export interface TransitionEdge {
  from: MemoryStatus;
  to: MemoryStatus;
  actor: TransitionActor;
  /** The target row must be authority='auto'. */
  autoOnly: boolean;
  /** The row's current status_reason must equal this (checked when the caller supplies it). */
  requireStatusReason?: StatusReason;
}

export const TRANSITION_EDGES: readonly TransitionEdge[] = [
  { from: "candidate", to: "active", actor: "human", autoOnly: false },
  { from: "candidate", to: "active", actor: "auto_rule", autoOnly: true },
  { from: "candidate", to: "rejected", actor: "human", autoOnly: false },
  { from: "candidate", to: "rejected", actor: "expiry", autoOnly: true },
  { from: "candidate", to: "rejected", actor: "migration", autoOnly: false },
  { from: "active", to: "stale", actor: "human", autoOnly: false },
  { from: "active", to: "stale", actor: "import", autoOnly: false },
  { from: "active", to: "stale", actor: "expiry", autoOnly: true },
  { from: "active", to: "stale", actor: "auto_rule", autoOnly: true },
  { from: "candidate", to: "superseded", actor: "human", autoOnly: false },
  { from: "active", to: "superseded", actor: "human", autoOnly: false },
  { from: "stale", to: "superseded", actor: "human", autoOnly: false },
  { from: "candidate", to: "superseded", actor: "import", autoOnly: false },
  { from: "active", to: "superseded", actor: "import", autoOnly: false },
  { from: "stale", to: "superseded", actor: "import", autoOnly: false },
  { from: "active", to: "superseded", actor: "auto_rule", autoOnly: true },
  { from: "stale", to: "active", actor: "human", autoOnly: false },
  { from: "stale", to: "active", actor: "auto_rule", autoOnly: true, requireStatusReason: "ttl_expired" },
  { from: "superseded", to: "active", actor: "human", autoOnly: false },
];

export interface TransitionContext {
  /** The row's current status_reason; when given, edges with `requireStatusReason` are checked against it. */
  statusReason?: string | null;
}

export interface TransitionInput {
  memoryId: string;
  to: MemoryStatus;
  actor: TransitionActor;
  /** Free-text reason stored in memory_transitions.reason (e.g. 'decideTier', 'ttl_expired', 'cli:promote'). */
  reason: string;
  now: string;
  proposalId?: string | null;
  runId?: string | null;
  /** Required in practice for `superseded`: the row that replaces this one (merge survivor / supersede replacement). */
  replacementId?: string | null;
  /** memories.status_reason; defaults per actor (human, auto_rule, expiry → expiry|ttl_expired, import → import|import_sync, migration). */
  statusReason?: StatusReason | null;
}

export function isActorBoundByAuthority(actor: TransitionActor): boolean {
  return actor === "auto_rule" || actor === "expiry";
}

export function findTransitionEdge(
  from: MemoryStatus,
  to: MemoryStatus,
  actor: TransitionActor
): TransitionEdge | null {
  return TRANSITION_EDGES.find((edge) => edge.from === from && edge.to === to && edge.actor === actor) ?? null;
}

/** Pure edge-table check (used by transitionMemory, the CLI and tests). */
export function isAllowedTransition(
  from: MemoryStatus,
  to: MemoryStatus,
  actor: TransitionActor,
  authority: Authority,
  context: TransitionContext = {}
): boolean {
  if (from === to) {
    return false;
  }

  if (isActorBoundByAuthority(actor) && authority === "human") {
    return false;
  }

  const edge = findTransitionEdge(from, to, actor);

  if (edge === null) {
    return false;
  }

  if (edge.autoOnly && authority !== "auto") {
    return false;
  }

  if (
    edge.requireStatusReason !== undefined &&
    context.statusReason !== undefined &&
    context.statusReason !== edge.requireStatusReason
  ) {
    return false;
  }

  return true;
}

export function defaultStatusReason(to: MemoryStatus, actor: TransitionActor): StatusReason {
  switch (actor) {
    case "human":
      return "human";
    case "auto_rule":
      return "auto_rule";
    case "expiry":
      return to === "stale" ? "ttl_expired" : "expiry";
    case "import":
      return to === "stale" ? "import_sync" : "import";
    case "migration":
      return "migration";
  }
}

/**
 * Applies one status transition with its side effects and records it in memory_transitions.
 *
 * Side effects by edge:
 * - → superseded: superseded_by_memory_id = replacementId.
 * - → active: last_verified_at = now; superseded → active clears superseded_by_memory_id;
 *   by `human` (promote / restore) the row becomes authority='human', promotion_source='manual' and
 *   loses ttl_expires_at / revalidate_after; by `auto_rule` promotion_source='auto' (TTL is set by the
 *   caller from decideTier).
 * - status_reason = input.statusReason ?? defaultStatusReason(to, actor); updated_at = now.
 */
export function transitionMemory(db: SqlJsDatabase, input: TransitionInput): MemoryRecord {
  const repository = new MemoryRepository(db, { clock: () => input.now });
  const memory = repository.getById(input.memoryId);

  if (memory === null) {
    throw new MemoryNotFoundError(input.memoryId);
  }

  const from = memory.status;
  const { to, actor } = input;

  if (isActorBoundByAuthority(actor) && memory.authority === "human") {
    throw new AuthorityViolationError(memory.id, actor, `transition ${from} -> ${to}`);
  }

  if (from === to) {
    throw new InvalidMemoryTransitionError(`Memory ${memory.id} is already ${to}`);
  }

  if (!isAllowedTransition(from, to, actor, memory.authority, { statusReason: memory.statusReason })) {
    throw new InvalidMemoryTransitionError(
      `Transition ${from} -> ${to} by ${actor} is not allowed for ${memory.authority} memory ${memory.id}` +
        (memory.statusReason !== null ? ` (status_reason ${memory.statusReason})` : "")
    );
  }

  const replacementId = input.replacementId ?? null;

  if (to === "superseded" && replacementId === memory.id) {
    throw new InvalidMemoryTransitionError(`Memory ${memory.id} cannot supersede itself`);
  }

  const statusReason = input.statusReason ?? defaultStatusReason(to, actor);
  const sets = ["status = $status", "status_reason = $statusReason", "updated_at = $now"];

  if (to === "superseded") {
    sets.push("superseded_by_memory_id = $replacementId");
  }

  if (to === "active") {
    sets.push("last_verified_at = $now");

    if (from === "superseded") {
      sets.push("superseded_by_memory_id = NULL");
    }

    if (actor === "human") {
      sets.push("authority = 'human'", "promotion_source = 'manual'", "ttl_expires_at = NULL", "revalidate_after = NULL");
    } else if (actor === "auto_rule") {
      sets.push("promotion_source = 'auto'");
    }
  }

  db.run(`UPDATE memories SET ${sets.join(", ")} WHERE id = $id`, {
    $id: memory.id,
    $status: to,
    $statusReason: statusReason,
    $now: input.now,
    $replacementId: replacementId,
  });

  new TransitionRepository(db).insert({
    memoryId: memory.id,
    fromStatus: from,
    toStatus: to,
    actor,
    proposalId: input.proposalId ?? null,
    extractionRunId: input.runId ?? null,
    reason: input.reason,
    createdAt: input.now,
  });

  const updated = repository.getById(memory.id);

  if (updated === null) {
    throw new MemoryNotFoundError(memory.id);
  }

  return updated;
}
