/**
 * Read-only access to the archived v0.5 dream tables (`legacy_dream_*`, migration 021) for
 * `memory:history` (spec §4.5). The tables are dropped in 0.7; a database without them yields
 * `available: false` and empty lists instead of an error.
 */

import type { Database as SqlJsDatabase } from "sql.js";

import { selectAll, tableExists } from "../db/sql";

export interface LegacyEvidenceEvent {
  id: string;
  sessionId: string;
  callId: string;
  toolName: string;
  scopeRef: string;
  sourceRef: string;
  title: string;
  excerpt: string;
  topicGuess: string;
  typeGuess: string;
  salience: number;
  novelty: number;
  status: string;
  createdAt: string;
}

export interface LegacyEvidenceLink {
  evidenceEventId: string;
  dreamRunId: string;
  createdAt: string;
  /** Null when the event row was removed. */
  event: LegacyEvidenceEvent | null;
}

export interface LegacyDreamRun {
  id: string;
  trigger: string;
  status: string;
  windowStart: string;
  windowEnd: string;
  evidenceCount: number;
  candidateCount: number;
  summary: string;
  createdAt: string;
  completedAt: string | null;
}

export interface LegacyHistory {
  memoryId: string;
  /** False when the archived tables are absent (fresh install or 0.7+). */
  available: boolean;
  links: LegacyEvidenceLink[];
  runs: LegacyDreamRun[];
}

const LINKS_TABLE = "legacy_dream_memory_evidence_links";
const EVENTS_TABLE = "legacy_dream_evidence_events";
const RUNS_TABLE = "legacy_dream_runs";

function text(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}

function num(value: unknown): number {
  return typeof value === "number" ? value : Number(value ?? 0);
}

export function hasLegacyTables(db: SqlJsDatabase): boolean {
  return tableExists(db, LINKS_TABLE) && tableExists(db, EVENTS_TABLE);
}

/** Evidence links (with their events) and the dream runs that produced a v0.5 memory. */
export function readLegacyHistory(db: SqlJsDatabase, memoryId: string): LegacyHistory {
  if (!hasLegacyTables(db)) return { memoryId, available: false, links: [], runs: [] };

  const links: LegacyEvidenceLink[] = selectAll(
    db,
    `SELECT l.evidence_event_id, l.dream_run_id, l.created_at,
            e.id AS e_id, e.session_id, e.call_id, e.tool_name, e.scope_ref, e.source_ref, e.title, e.excerpt,
            e.topic_guess, e.type_guess, e.salience, e.novelty, e.status, e.created_at AS e_created_at
     FROM ${LINKS_TABLE} l
     LEFT JOIN ${EVENTS_TABLE} e ON e.id = l.evidence_event_id
     WHERE l.memory_id = ?
     ORDER BY l.created_at ASC, l.evidence_event_id ASC`,
    [memoryId]
  ).map((row) => ({
    evidenceEventId: text(row.evidence_event_id),
    dreamRunId: text(row.dream_run_id),
    createdAt: text(row.created_at),
    event:
      row.e_id === null || row.e_id === undefined
        ? null
        : {
            id: text(row.e_id),
            sessionId: text(row.session_id),
            callId: text(row.call_id),
            toolName: text(row.tool_name),
            scopeRef: text(row.scope_ref),
            sourceRef: text(row.source_ref),
            title: text(row.title),
            excerpt: text(row.excerpt),
            topicGuess: text(row.topic_guess),
            typeGuess: text(row.type_guess),
            salience: num(row.salience),
            novelty: num(row.novelty),
            status: text(row.status),
            createdAt: text(row.e_created_at),
          },
  }));

  const runIds = [...new Set(links.map((link) => link.dreamRunId).filter((id) => id.length > 0))];
  const runs: LegacyDreamRun[] = [];
  if (runIds.length > 0 && tableExists(db, RUNS_TABLE)) {
    const placeholders = runIds.map(() => "?").join(", ");
    for (const row of selectAll(db, `SELECT * FROM ${RUNS_TABLE} WHERE id IN (${placeholders}) ORDER BY created_at ASC, id ASC`, runIds)) {
      runs.push({
        id: text(row.id),
        trigger: text(row.trigger),
        status: text(row.status),
        windowStart: text(row.window_start),
        windowEnd: text(row.window_end),
        evidenceCount: num(row.evidence_count),
        candidateCount: num(row.candidate_count),
        summary: text(row.summary),
        createdAt: text(row.created_at),
        completedAt: row.completed_at === null || row.completed_at === undefined ? null : text(row.completed_at),
      });
    }
  }

  return { memoryId, available: true, links, runs };
}

/** Memory ids that still carry archived evidence links (doctor / stats). */
export function countLegacyLinkedMemories(db: SqlJsDatabase): number {
  if (!tableExists(db, LINKS_TABLE)) return 0;
  const rows = selectAll(db, `SELECT COUNT(DISTINCT memory_id) AS n FROM ${LINKS_TABLE}`);
  return rows.length === 0 ? 0 : num(rows[0]!.n);
}
