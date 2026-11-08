/**
 * Data fix-ups that run once after the SQL migrations reach 21, in the same writer session (spec §4.1).
 *
 * (1) Reject DreamWorker template candidates: `status = 'candidate'` rows linked from
 *     `legacy_dream_memory_evidence_links` (only DreamWorker candidates ever had those links).
 *     They become `rejected` / `status_reason = 'migration'` with a `memory_transitions` row
 *     (`actor = 'migration'`, reason `dreamworker_template`). Runs first so a template is never keyed.
 * (2) Backfill `semantic_key` for live rows (`candidate | active | stale`) with
 *     `semanticKey(type, scope_glob, signature_key, summary)`. When two live rows collide the oldest
 *     keeps the key, the newer one stays NULL (the partial unique index must hold) and a `merge`
 *     proposal is opened (`created_by = 'migration'`, target = oldest, candidate = newer, 30 days).
 *
 * Idempotent through `meta.semantic_key_backfill = '1'`. Raw SQL on purpose: migration code is the
 * one place allowed to bypass `transitionMemory`, so this module depends on nothing above `src/db`.
 */

import { randomUUID } from "node:crypto";
import type { Database as SqlJsDatabase } from "sql.js";

import { semanticKey } from "../core/ids";
import { LIVE_STATUSES } from "../core/vocabulary";
import type { FileLogger } from "./db-file";
import { getMeta, setMeta } from "./meta";
import { selectAll, tableExists } from "./sql";

export const SEMANTIC_KEY_BACKFILL_META_KEY = "semantic_key_backfill";
export const MERGE_PROPOSAL_DAYS = 30;
export const MERGE_PROPOSAL_CONFIDENCE = 0.5;
export const MERGE_PROPOSAL_RATIONALE =
  "semantic_key collision after upgrade: same type, scope, signature and normalized summary; keep the older row";
export const TEMPLATE_CANDIDATE_REASON = "dreamworker_template";
const SAVEPOINT = "hm_post_migrate";

export interface PostMigrateOptions {
  /** ISO timestamp stamped on proposals, transitions and updated rows. */
  now: string;
  logger?: Pick<FileLogger, "log">;
}

export interface PostMigrateReport {
  semanticKeysBackfilled: number;
  mergeProposalsOpened: number;
  templateCandidatesRejected: number;
  /** True when the meta flag was already set and nothing was done. */
  alreadyApplied: boolean;
}

function liveStatusList(): string {
  return LIVE_STATUSES.map((status) => `'${status}'`).join(", ");
}

function addDays(iso: string, days: number): string {
  return new Date(Date.parse(iso) + days * 86_400_000).toISOString();
}

function rejectTemplateCandidates(db: SqlJsDatabase, now: string): number {
  if (!tableExists(db, "legacy_dream_memory_evidence_links")) {
    return 0;
  }
  const rows = selectAll(
    db,
    `SELECT id FROM memories
      WHERE status = 'candidate'
        AND id IN (SELECT memory_id FROM legacy_dream_memory_evidence_links)
      ORDER BY created_at, id`
  );
  for (const row of rows) {
    const memoryId = String(row.id);
    db.run(
      `UPDATE memories SET status = 'rejected', status_reason = 'migration', updated_at = ?
        WHERE id = ? AND status = 'candidate'`,
      [now, memoryId]
    );
    db.run(
      `INSERT INTO memory_transitions (id, memory_id, from_status, to_status, actor, proposal_id, extraction_run_id, reason, created_at)
       VALUES (?, ?, 'candidate', 'rejected', 'migration', NULL, NULL, ?, ?)`,
      [randomUUID(), memoryId, TEMPLATE_CANDIDATE_REASON, now]
    );
  }
  return rows.length;
}

function openMergeProposal(db: SqlJsDatabase, targetId: string, candidateId: string, now: string): boolean {
  const existing = selectAll(
    db,
    `SELECT id FROM proposals
      WHERE kind = 'merge' AND target_memory_id = ? AND candidate_memory_id = ? AND status = 'open'`,
    [targetId, candidateId]
  );
  if (existing.length > 0) {
    return false;
  }
  db.run(
    `INSERT INTO proposals (id, kind, target_memory_id, candidate_memory_id, rationale, confidence, created_by,
                            support_count, support_sessions, status, created_at, expires_at)
     VALUES (?, 'merge', ?, ?, ?, ?, 'migration', 0, 0, 'open', ?, ?)`,
    [randomUUID(), targetId, candidateId, MERGE_PROPOSAL_RATIONALE, MERGE_PROPOSAL_CONFIDENCE, now, addDays(now, MERGE_PROPOSAL_DAYS)]
  );
  return true;
}

function backfillSemanticKeys(db: SqlJsDatabase, now: string): { backfilled: number; merges: number } {
  const owners = new Map<string, string>();
  for (const row of selectAll(
    db,
    `SELECT semantic_key, id FROM memories
      WHERE semantic_key IS NOT NULL AND status IN (${liveStatusList()})
      ORDER BY created_at, id`
  )) {
    const key = String(row.semantic_key);
    if (!owners.has(key)) {
      owners.set(key, String(row.id));
    }
  }

  const pending = selectAll(
    db,
    `SELECT id, type, scope_glob, signature_key, summary FROM memories
      WHERE semantic_key IS NULL AND status IN (${liveStatusList()})
      ORDER BY created_at, id`
  );

  let backfilled = 0;
  let merges = 0;
  for (const row of pending) {
    const id = String(row.id);
    const key = semanticKey(String(row.type), String(row.scope_glob), String(row.signature_key ?? ""), String(row.summary));
    const owner = owners.get(key);
    if (owner === undefined) {
      db.run("UPDATE memories SET semantic_key = ? WHERE id = ?", [key, id]);
      owners.set(key, id);
      backfilled += 1;
      continue;
    }
    if (openMergeProposal(db, owner, id, now)) {
      merges += 1;
    }
  }
  return { backfilled, merges };
}

export function runPostMigrate(db: SqlJsDatabase, options: PostMigrateOptions): PostMigrateReport {
  if (getMeta(db, SEMANTIC_KEY_BACKFILL_META_KEY) === "1") {
    return { semanticKeysBackfilled: 0, mergeProposalsOpened: 0, templateCandidatesRejected: 0, alreadyApplied: true };
  }

  db.run(`SAVEPOINT ${SAVEPOINT}`);
  try {
    const templateCandidatesRejected = rejectTemplateCandidates(db, options.now);
    const { backfilled, merges } = backfillSemanticKeys(db, options.now);
    setMeta(db, SEMANTIC_KEY_BACKFILL_META_KEY, "1");
    db.run(`RELEASE ${SAVEPOINT}`);
    options.logger?.log(
      `post-migrate: ${backfilled} semantic keys backfilled, ${merges} merge proposals opened, ${templateCandidatesRejected} template candidates rejected`
    );
    return {
      semanticKeysBackfilled: backfilled,
      mergeProposalsOpened: merges,
      templateCandidatesRejected,
      alreadyApplied: false,
    };
  } catch (error) {
    db.run(`ROLLBACK TO ${SAVEPOINT}`);
    db.run(`RELEASE ${SAVEPOINT}`);
    throw error;
  }
}
