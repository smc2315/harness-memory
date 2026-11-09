/**
 * TTL / revalidation math for authority='auto' rows (spec §5.7 step 5, §5.8 (2)(4), §6.4, §12 D4).
 *
 * - ttlDays(v) = min(90, 7 · 2^v) with v = validation_count = evidence_count − 1
 * - baseTtlDays(kind) = 30 for correction / failure_resolution, else 7
 * - a reinforce never shrinks a TTL: ttl_expires_at = max(existing, now + max(ttlDays(v), baseTtlDays(kind)))
 * - a fire extends it: ttl_expires_at = max(existing, last_fired_at + 14 d)
 * - human rows carry no TTL and are never touched here.
 */

import type { Database as SqlJsDatabase } from "sql.js";

import type { Authority, KnowledgeKind } from "../core/vocabulary";
import { MemoryRepository, type MemoryRecord } from "../memory/repository";

export const TTL_BASE_DAYS = 7;
export const TTL_MAX_DAYS = 90;
export const CORRECTION_TTL_DAYS = 30;
export const FIRE_TTL_EXTENSION_DAYS = 14;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function ttlDays(validationCount: number): number {
  const v = Math.max(0, Math.floor(validationCount));

  return Math.min(TTL_MAX_DAYS, TTL_BASE_DAYS * 2 ** v);
}

export function baseTtlDays(kind: KnowledgeKind | null | undefined): number {
  return kind === "correction" || kind === "failure_resolution" ? CORRECTION_TTL_DAYS : TTL_BASE_DAYS;
}

/** §6.4: human 1.0; auto 0.65 (never revalidated), 0.8 (once), 0.95 (twice or more). */
export function trustMultiplier(authority: Authority, validationCount: number): number {
  if (authority === "human") {
    return 1;
  }

  if (validationCount <= 0) {
    return 0.65;
  }

  return validationCount === 1 ? 0.8 : 0.95;
}

export function addDays(iso: string, days: number): string {
  return new Date(Date.parse(iso) + days * MS_PER_DAY).toISOString();
}

export function laterIso(left: string | null, right: string): string {
  if (left === null) {
    return right;
  }

  return Date.parse(right) > Date.parse(left) ? right : left;
}

export function midpointIso(start: string, end: string): string {
  return new Date(Math.round((Date.parse(start) + Date.parse(end)) / 2)).toISOString();
}

export interface RevalidationPlan {
  validationCount: number;
  /** Days granted by this revalidation (before the max with the existing TTL). */
  days: number;
  ttlExpiresAt: string;
  revalidateAfter: string;
}

/** Pure part of revalidateMemory: what the TTL columns become for an auto row reinforced at `now`. */
export function computeRevalidation(
  memory: Pick<MemoryRecord, "evidenceCount" | "knowledgeKind" | "ttlExpiresAt" | "revalidateAfter">,
  now: string
): RevalidationPlan {
  const validationCount = Math.max(0, memory.evidenceCount - 1);
  const days = Math.max(ttlDays(validationCount), baseTtlDays(memory.knowledgeKind));
  const ttlExpiresAt = laterIso(memory.ttlExpiresAt, addDays(now, days));
  const revalidateAfter = laterIso(memory.revalidateAfter, midpointIso(now, ttlExpiresAt));

  return { validationCount, days, ttlExpiresAt, revalidateAfter };
}

export type RevalidateSkipReason = "not_found" | "human" | "status";

export interface RevalidateResult {
  applied: boolean;
  skipped: RevalidateSkipReason | null;
  memory: MemoryRecord | null;
}

export interface RevalidateOptions {
  now: string;
  /** closed_at of the reinforcing episode: becomes last_verified_at. */
  closedAt: string;
}

/**
 * §5.7 step 5 for an authority='auto' row in status active or stale: validation_count = evidence_count − 1,
 * ttl_expires_at = max(existing, now + max(ttlDays(v), baseTtlDays(kind))), revalidate_after moves to the
 * midpoint of now and the TTL (never earlier than before), last_verified_at = closedAt. The caller decides
 * whether a stale(ttl_expired) row goes back to active (transitionMemory, actor auto_rule).
 */
export function revalidateMemory(db: SqlJsDatabase, memoryId: string, options: RevalidateOptions): RevalidateResult {
  const repository = new MemoryRepository(db, { clock: () => options.now });
  const memory = repository.getById(memoryId);

  if (memory === null) {
    return { applied: false, skipped: "not_found", memory: null };
  }

  if (memory.authority !== "auto") {
    return { applied: false, skipped: "human", memory };
  }

  if (memory.status !== "active" && memory.status !== "stale") {
    return { applied: false, skipped: "status", memory };
  }

  const plan = computeRevalidation(memory, options.now);
  const updated = repository.setTtl(memory.id, {
    ttlExpiresAt: plan.ttlExpiresAt,
    revalidateAfter: plan.revalidateAfter,
    validationCount: plan.validationCount,
    lastVerifiedAt: options.closedAt,
    updatedAt: options.now,
  });

  return { applied: true, skipped: null, memory: updated };
}

export interface ExtendTtlOnFireOptions {
  lastFiredAt: string;
}

/**
 * §5.8 (4): an auto active row that fired is "in use": ttl_expires_at = max(existing, last_fired_at + 14 d).
 * revalidate_after follows to the midpoint of the fire and the new TTL (never earlier than before).
 * `applied` is false when nothing changed.
 */
export function extendTtlOnFire(db: SqlJsDatabase, memoryId: string, options: ExtendTtlOnFireOptions): RevalidateResult {
  const repository = new MemoryRepository(db, { clock: () => options.lastFiredAt });
  const memory = repository.getById(memoryId);

  if (memory === null) {
    return { applied: false, skipped: "not_found", memory: null };
  }

  if (memory.authority !== "auto") {
    return { applied: false, skipped: "human", memory };
  }

  if (memory.status !== "active") {
    return { applied: false, skipped: "status", memory };
  }

  const ttlExpiresAt = laterIso(memory.ttlExpiresAt, addDays(options.lastFiredAt, FIRE_TTL_EXTENSION_DAYS));

  if (ttlExpiresAt === memory.ttlExpiresAt) {
    return { applied: false, skipped: null, memory };
  }

  const revalidateAfter = laterIso(memory.revalidateAfter, midpointIso(options.lastFiredAt, ttlExpiresAt));
  const updated = repository.setTtl(memory.id, {
    ttlExpiresAt,
    revalidateAfter,
  });

  return { applied: true, skipped: null, memory: updated };
}
