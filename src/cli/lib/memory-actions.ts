/**
 * Human edits on memories, shared by `memory:*`, `review` and `import` (spec §4.7, §7.1, §11).
 *
 * Every status change goes through `transitionMemory` with actor `human` (or `import` for the import
 * sync / upgrade rules); every content edit by a person also makes the row `authority='human'`
 * (§7.1 "any human edit"). The functions run inside an open lock session (`db` is the store's connection)
 * and throw CliInputError with a hint when the row's status does not allow the requested edge.
 */

import type { Database as SqlJsDatabase } from "sql.js";

import type { HarnessConfig } from "../../core/config";
import { LIVE_STATUSES, type Enforcement, type MemoryStatus } from "../../core/vocabulary";
import { jaccard, summaryTokens } from "../../dream/reconcile";
import { MemoryRepository, type MemoryRecord } from "../../memory/repository";
import { enforcementDefault } from "../../promotion/authority";
import { openOrSupportProposal } from "../../promotion/proposals";
import { transitionMemory } from "../../promotion/transitions";
import { CliInputError } from "./cli-error";
import { shortId } from "./lookup";

/** Normalized-summary Jaccard at which a confirmed import replaces an older live row (spec §11). */
export const IMPORT_UPGRADE_JACCARD = 0.8;

function expectStatus(memory: MemoryRecord, allowed: readonly MemoryStatus[], action: string, hint: string): void {
  if (!allowed.includes(memory.status)) {
    throw new CliInputError(`cannot ${action} memory ${shortId(memory.id)}: status is ${memory.status} (allowed: ${allowed.join(", ")})`, { hint });
  }
}

/** candidate | stale → active by a person; the row becomes human and loses its TTL (transitionMemory does both). */
export function promoteMemory(db: SqlJsDatabase, memory: MemoryRecord, now: string, reason = "cli:memory:promote"): MemoryRecord {
  expectStatus(memory, ["candidate", "stale"], "promote", "superseded rows come back with `hm memory:restore`; rejected facts are re-added with `hm memory:add`");
  return transitionMemory(db, { memoryId: memory.id, to: "active", actor: "human", reason, now });
}

/** active → stale by a person (§4.7 "human: demote"). */
export function demoteMemory(db: SqlJsDatabase, memory: MemoryRecord, now: string, reason = "cli:memory:demote"): MemoryRecord {
  expectStatus(memory, ["active"], "demote", "only active rows are demoted; candidates are rejected with `hm memory:reject`");
  return transitionMemory(db, { memoryId: memory.id, to: "stale", actor: "human", reason, now });
}

/** candidate → rejected by a person; an optional note is kept as a manual evidence row. */
export function rejectMemory(db: SqlJsDatabase, memory: MemoryRecord, now: string, options: { reason?: string; note?: string | null } = {}): MemoryRecord {
  expectStatus(memory, ["candidate"], "reject", "active rows are demoted with `hm memory:demote` (the state machine has no active → rejected edge)");
  const updated = transitionMemory(db, { memoryId: memory.id, to: "rejected", actor: "human", reason: options.reason ?? "cli:memory:reject", now });
  if (options.note !== undefined && options.note !== null && options.note.trim().length > 0) {
    new MemoryRepository(db, { clock: () => now }).createEvidence({
      memoryId: memory.id,
      sourceKind: "manual_note",
      sourceRef: "cli:memory:reject",
      excerpt: options.note.trim().slice(0, 500),
      createdAt: now,
    });
  }
  return updated;
}

/** superseded | stale → active by a person (§4.7 "human restore" / "human promote"). */
export function restoreMemory(db: SqlJsDatabase, memory: MemoryRecord, now: string, reason = "cli:memory:restore"): MemoryRecord {
  expectStatus(memory, ["superseded", "stale"], "restore", "rejected rows are terminal: re-add the fact with `hm memory:add` (it revives the id)");
  return transitionMemory(db, { memoryId: memory.id, to: "active", actor: "human", reason, now });
}

/** Sets the enforcement level; the edit makes an auto row human (§7.1). */
export function enforceMemory(db: SqlJsDatabase, memory: MemoryRecord, level: Enforcement, now: string): MemoryRecord {
  const repository = new MemoryRepository(db, { clock: () => now });
  let updated = repository.setEnforcement(memory.id, level, now);
  if (updated.authority !== "human") updated = repository.setAuthority(memory.id, "human", now);
  return updated;
}

/** Enforcement a confirmed import row gets (§7.3: strong wording + signature → hard_policy, else advise). */
export function confirmedImportEnforcement(memory: MemoryRecord, config: Pick<HarnessConfig, "before_tool">): Enforcement {
  const hasSignature = memory.triggerSignature !== null && memory.signatureKey.length > 0;
  return enforcementDefault({
    type: memory.type,
    authority: "human",
    policySubtype: memory.policySubtype,
    hasSignature,
    specificityOk: hasSignature,
    knowledgeKind: memory.knowledgeKind ?? "import",
    importUnconfirmed: 0,
    config,
    summary: memory.summary,
  });
}

/** Live rows (other than `memory` and its import siblings) whose normalized summary is near-identical (§11 Jaccard ≥ 0.8). */
export function findUpgradeTargets(repository: MemoryRepository, memory: MemoryRecord): MemoryRecord[] {
  const tokens = summaryTokens(memory.summary);
  if (tokens.size === 0) return [];
  const sourceFile = memory.sourceRef === null ? null : memory.sourceRef.split("#")[0];
  return repository
    .list({ status: LIVE_STATUSES })
    .filter((row) => row.id !== memory.id)
    .filter((row) => !(sourceFile !== null && row.sourceRef !== null && row.sourceRef.split("#")[0] === sourceFile))
    .filter((row) => jaccard(tokens, summaryTokens(row.summary)) >= IMPORT_UPGRADE_JACCARD);
}

export interface ConfirmImportResult {
  memory: MemoryRecord;
  enforcement: Enforcement;
  enforcementChanged: boolean;
  /** Older live rows superseded by this confirmed import (§11). */
  superseded: string[];
}

/**
 * The confirmation step of `hm import` / `review`: clears `import_unconfirmed`, recomputes the enforcement
 * with the confirmed-import rules and supersedes near-identical older rows (actor `import`, §11).
 */
export function confirmImportRow(db: SqlJsDatabase, memory: MemoryRecord, options: { config: HarnessConfig; now: string; upgrade?: boolean }): ConfirmImportResult {
  const repository = new MemoryRepository(db, { clock: () => options.now });
  let updated = memory.importUnconfirmed === 1 ? repository.setFlags(memory.id, { importUnconfirmed: 0, updatedAt: options.now }) : memory;
  if (updated.authority !== "human") updated = repository.setAuthority(memory.id, "human", options.now);
  const enforcement = confirmedImportEnforcement(updated, options.config);
  const enforcementChanged = enforcement !== updated.enforcement;
  if (enforcementChanged) updated = repository.setEnforcement(memory.id, enforcement, options.now);

  const superseded: string[] = [];
  if (options.upgrade !== false && updated.status === "active") {
    for (const target of findUpgradeTargets(repository, updated)) {
      transitionMemory(db, {
        memoryId: target.id,
        to: "superseded",
        actor: "import",
        reason: "import:upgraded",
        now: options.now,
        replacementId: updated.id,
        statusReason: "import",
      });
      superseded.push(target.id);
    }
  }
  return { memory: repository.getById(memory.id) ?? updated, enforcement, enforcementChanged, superseded };
}

/** `--yes` imports only propose the replacement of near-identical rows (§11); returns the proposal ids opened or supported. */
export function proposeImportUpgrades(db: SqlJsDatabase, memory: MemoryRecord, options: { config: HarnessConfig; now: string }): string[] {
  const repository = new MemoryRepository(db, { clock: () => options.now });
  const ids: string[] = [];
  for (const target of findUpgradeTargets(repository, memory)) {
    const opened = openOrSupportProposal(db, {
      kind: "supersede",
      targetMemoryId: target.id,
      candidateMemoryId: memory.id,
      rationale: `import --yes: near-identical to imported row ${shortId(memory.id)} (${memory.sourceRef ?? "import"})`,
      confidence: memory.confidence,
      createdBy: "import",
      now: options.now,
      expiresInDays: options.config.retention.proposal_days,
    });
    if (opened.proposalId !== null) ids.push(opened.proposalId);
  }
  return ids;
}

/**
 * Declining an unconfirmed import row: the rows are inserted `active` by the pipeline and the state machine
 * has no active → rejected edge, so a decline is the human demotion active → stale (reason recorded).
 */
export function declineImportRow(db: SqlJsDatabase, memory: MemoryRecord, now: string, reason = "cli:import:declined"): MemoryRecord {
  if (memory.status === "candidate") {
    return transitionMemory(db, { memoryId: memory.id, to: "rejected", actor: "human", reason, now });
  }
  expectStatus(memory, ["active"], "decline", "the row is no longer active; nothing to decline");
  return transitionMemory(db, { memoryId: memory.id, to: "stale", actor: "human", reason, now });
}
