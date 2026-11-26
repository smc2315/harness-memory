/**
 * The autonomy ladder (A′, docs/redesign/positioning-2026-11.md §8; 0.6.0-rc.2 docs/redesign/full-autonomy-0.6.0-rc.2.md
 * §3–§4): auto-learned rules are born at `advise` (`before_tool.auto_enforcement`) and climb to `soft_deny`
 * deterministically — no model call — when another session reinforces them. The live run in
 * docs/redesign/phase-e-notes.md §4b showed why a rule must not block on its first evidence: one correction had
 * produced a soft_deny whose signature also matched the fix.
 *
 * Escalation fires inside the reconciler's reinforce step (also for a `create` that collapsed into its twin, i.e.
 * a new failure → resolution or correction episode citing the row) when every condition holds:
 *   - before_tool.auto_escalation.enabled, autonomy_level `standard` or `full` (`shadow` keeps auto rows at advise,
 *     `off` never activates them in the first place);
 *   - the row is auto, active, at `advise`, a pitfall with a compiled trigger signature whose signature_precision is
 *     `mistake_exact` (null — a row from before migration 023 — counts as `noun`), knowledge_kind ∈ {correction,
 *     failure_resolution} — the predicate §7.3 used for the old soft_deny default — and a durable horizon (a `task`
 *     row never exceeds advise, design §2);
 *   - its evidence now spans ≥ before_tool.auto_escalation.sessions distinct sessions (memories.distinct_session_count,
 *     recomputed from provenance in the same savepoint).
 *
 * Why the two rc.2 gates (dogfood, 17 days): the ladder had climbed once, because distinct_session_count counted
 * re-extractions and a session resumed for 17 days never became "another session". It now counts distinct
 * (session_id, 4-hour block of episode.started_at) pairs (src/db/repositories/provenance.ts), so the same fact coming
 * back hours later in the same session is reinforcement — climbing is observable. The precision gate is what keeps
 * the fires-heavy rows down: the five most-fired rules carried noun-level signatures (a host, a table, a tool name)
 * that also match the legitimate operation; however often such a row is reinforced it stays at advise.
 *
 * The way down stays the consolidator's override downgrade (src/dream/consolidate.ts: ≥ 3 overrides with
 * evidence_score < 3 → advise, audit event `enforcement_downgrade`). The two must not ping-pong: once a row was
 * downgraded by overrides it is re-escalated only by a reinforce from a session that began after the downgrade
 * (no episode of that session predates the audit row) — the session whose overrides caused the downgrade cannot
 * climb the row back up by itself, however many times it reinforces.
 *
 * Human rows are never touched (authority check before anything is written). The escalation is recorded as a
 * `memory_transitions` row with from = to = active, actor auto_rule, reason `auto_escalation…`, plus an
 * `enforcement_escalation` audit entry, and counted in the reconcile report (`escalated`).
 */

import type { Database as SqlJsDatabase } from "sql.js";

import { compileSignature } from "../activation/signature";
import type { HarnessConfig } from "../core/config";
import { createDeterministicId } from "../core/ids";
import type { Authority, AutonomyLevel, Enforcement, Horizon, KnowledgeKind, MemoryStatus, MemoryType, SignaturePrecision } from "../core/vocabulary";
import { TransitionRepository } from "../db/repositories/transitions";
import { selectOne } from "../db/sql";
import { MemoryRepository, type MemoryRecord } from "../memory/repository";

export const ESCALATION_FROM: Enforcement = "advise";
export const ESCALATION_TARGET: Enforcement = "soft_deny";
/** Prefix of the memory_transitions.reason written for an escalation (`auto_escalation: advise → soft_deny (2 sessions)`). */
export const ESCALATION_TRANSITION_REASON = "auto_escalation";
/** audit_log.event_type written by src/dream/consolidate.ts when overrides drop a row to advise. */
export const OVERRIDE_DOWNGRADE_EVENT = "enforcement_downgrade";
export const ESCALATION_AUDIT_EVENT = "enforcement_escalation";
const ESCALATION_KNOWLEDGE_KINDS: ReadonlySet<KnowledgeKind> = new Set(["correction", "failure_resolution"]);
/** Levels under which the ladder runs: `shadow` is a dry run of standard (auto rows stay at advise), `off` activates nothing. */
export const ESCALATION_AUTONOMY_LEVELS: readonly AutonomyLevel[] = ["standard", "full"];

export type EscalationSkipReason =
  | "disabled"
  | "autonomy"
  | "human"
  | "status"
  | "enforcement"
  | "type"
  | "signature"
  /** 0.6.0-rc.2: signature_precision is not `mistake_exact` (null, i.e. unknown / before migration 023, included). */
  | "precision"
  | "knowledge_kind"
  /** 0.6.0-rc.2: horizon `task` never exceeds advise. */
  | "horizon"
  | "sessions"
  | "override_downgraded";

export interface EscalationCandidate {
  authority: Authority;
  status: MemoryStatus;
  enforcement: Enforcement;
  type: MemoryType;
  knowledgeKind: KnowledgeKind | null;
  /** The stored signature compiles (the snapshot would carry it). */
  hasSignature: boolean;
  /** 0.6.0-rc.2 (migration 023): only `mistake_exact` climbs; null (unknown / before 023) counts as `noun`. */
  signaturePrecision: SignaturePrecision | null;
  /** 0.6.0-rc.2: a `task` row never exceeds advise; null = unknown = durable. */
  horizon: Horizon | null;
  distinctSessionCount: number;
}

export interface DecideEscalationInput {
  memory: EscalationCandidate;
  config: Pick<HarnessConfig, "before_tool" | "autonomy_level">;
  /** created_at of the latest override downgrade of this row, null when it was never downgraded. */
  downgradedAt: string | null;
  /** The reinforcing session began after `downgradedAt` (ignored when `downgradedAt` is null). */
  reinforcingSessionIsNew: boolean;
}

export type EscalationDecision = { escalate: true; sessions: number } | { escalate: false; reason: EscalationSkipReason; detail: string };

/** Pure ladder decision; `escalateOnReinforce` feeds it the row after recomputeDerived. */
export function decideEscalation(input: DecideEscalationInput): EscalationDecision {
  const { memory, config } = input;
  const skip = (reason: EscalationSkipReason, detail: string): EscalationDecision => ({ escalate: false, reason, detail });
  if (!config.before_tool.auto_escalation.enabled) return skip("disabled", "before_tool.auto_escalation.enabled = false");
  if (!ESCALATION_AUTONOMY_LEVELS.includes(config.autonomy_level)) return skip("autonomy", `autonomy_level ${config.autonomy_level}`);
  if (memory.authority !== "auto") return skip("human", "human rows are never escalated by the automatic path");
  if (memory.status !== "active") return skip("status", `status ${memory.status}`);
  if (memory.enforcement !== ESCALATION_FROM) return skip("enforcement", `enforcement ${memory.enforcement}`);
  if (memory.type !== "pitfall") return skip("type", `type ${memory.type}`);
  if (!memory.hasSignature) return skip("signature", "no compiled trigger signature");
  if (memory.signaturePrecision !== "mistake_exact") return skip("precision", `signature_precision ${memory.signaturePrecision ?? "null"} (only mistake_exact climbs)`);
  if (memory.knowledgeKind === null || !ESCALATION_KNOWLEDGE_KINDS.has(memory.knowledgeKind)) return skip("knowledge_kind", `knowledge_kind ${memory.knowledgeKind ?? "null"}`);
  if (memory.horizon === "task") return skip("horizon", "horizon task never exceeds advise");
  const needed = Math.max(1, config.before_tool.auto_escalation.sessions);
  if (memory.distinctSessionCount < needed) return skip("sessions", `${String(memory.distinctSessionCount)}/${String(needed)} sessions`);
  if (input.downgradedAt !== null && !input.reinforcingSessionIsNew) return skip("override_downgraded", `downgraded by overrides at ${input.downgradedAt}; the reinforcing session predates it`);
  return { escalate: true, sessions: memory.distinctSessionCount };
}

/** created_at of the newest `enforcement_downgrade` audit row naming this memory, or null (audit rows are kept `retention.audit_days`). */
export function latestOverrideDowngradeAt(db: SqlJsDatabase, memoryId: string): string | null {
  const row = selectOne(
    db,
    `SELECT created_at FROM audit_log WHERE event_type = $event AND instr(details_json, $needle) > 0 ORDER BY created_at DESC LIMIT 1`,
    { $event: OVERRIDE_DOWNGRADE_EVENT, $needle: JSON.stringify({ memoryId }).slice(1, -1) }
  );
  return row === null ? null : String(row.created_at);
}

/** True when any recorded episode of `sessionId` started before `iso` — the session was already running then. */
export function sessionPredates(db: SqlJsDatabase, sessionId: string, iso: string): boolean {
  const row = selectOne(db, "SELECT 1 AS hit FROM episodes WHERE session_id = $sessionId AND started_at < $iso LIMIT 1", { $sessionId: sessionId, $iso: iso });
  return row !== null;
}

export function hasCompiledSignature(memory: Pick<MemoryRecord, "triggerSignature" | "signatureKey">): boolean {
  return memory.triggerSignature !== null && memory.signatureKey.length > 0 && compileSignature(memory.triggerSignature).ok;
}

export interface EscalateInput {
  memoryId: string;
  /** Session of the reinforcing episode. */
  sessionId: string;
  runId: string | null;
  config: Pick<HarnessConfig, "before_tool" | "autonomy_level">;
  now: string;
}

export interface EscalateResult {
  applied: boolean;
  decision: EscalationDecision;
  memory: MemoryRecord | null;
}

/**
 * Applies the ladder to one row after a reinforce landed on it (same savepoint as the provenance insert and
 * recomputeDerived). Writes enforcement, the history transition and the audit entry only when the decision is yes.
 */
export function escalateOnReinforce(db: SqlJsDatabase, input: EscalateInput): EscalateResult {
  const repository = new MemoryRepository(db, { clock: () => input.now });
  const memory = repository.getById(input.memoryId);
  if (memory === null) return { applied: false, decision: { escalate: false, reason: "status", detail: "row missing" }, memory: null };
  const downgradedAt = memory.authority === "auto" ? latestOverrideDowngradeAt(db, memory.id) : null;
  const decision = decideEscalation({
    memory: {
      authority: memory.authority,
      status: memory.status,
      enforcement: memory.enforcement,
      type: memory.type,
      knowledgeKind: memory.knowledgeKind,
      hasSignature: hasCompiledSignature(memory),
      signaturePrecision: memory.signaturePrecision,
      horizon: memory.horizon,
      distinctSessionCount: memory.distinctSessionCount,
    },
    config: input.config,
    downgradedAt,
    reinforcingSessionIsNew: downgradedAt === null ? true : !sessionPredates(db, input.sessionId, downgradedAt),
  });
  if (!decision.escalate) return { applied: false, decision, memory };

  const updated = repository.setEnforcement(memory.id, ESCALATION_TARGET, input.now);
  new TransitionRepository(db).insert({
    memoryId: memory.id,
    fromStatus: memory.status,
    toStatus: memory.status,
    actor: "auto_rule",
    extractionRunId: input.runId,
    reason: `${ESCALATION_TRANSITION_REASON}: ${ESCALATION_FROM} → ${ESCALATION_TARGET} (${String(decision.sessions)} sessions)`,
    createdAt: input.now,
  });
  db.run(
    `INSERT OR IGNORE INTO audit_log (id, event_type, session_id, scope_ref, summary, details_json, created_at)
     VALUES (?, ?, ?, NULL, ?, ?, ?)`,
    [
      createDeterministicId(`audit:${ESCALATION_AUDIT_EVENT}:${input.runId ?? "no-run"}:${memory.id}`),
      ESCALATION_AUDIT_EVENT,
      input.sessionId,
      `auto escalation: ${memory.id} ${ESCALATION_FROM} → ${ESCALATION_TARGET} (${String(decision.sessions)} sessions)`,
      JSON.stringify({ memoryId: memory.id, from: ESCALATION_FROM, to: ESCALATION_TARGET, sessions: decision.sessions, runId: input.runId }),
      input.now,
    ]
  );
  return { applied: true, decision, memory: updated };
}
