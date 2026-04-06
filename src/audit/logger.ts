/**
 * Structured audit logger for operational analysis.
 *
 * Records every significant system decision to the `audit_log` SQLite table
 * so operators can analyze activation quality, search performance, extraction
 * accuracy, and dedup effectiveness after the fact.
 *
 * Usage:
 *   const logger = new AuditLogger(db);
 *   logger.logActivation({ ... });
 *   logger.logVectorSearch({ ... });
 */

import type { Database as SqlJsDatabase } from "sql.js";
import { createDeterministicId } from "../memory";

// ---------------------------------------------------------------------------
// Event types & payloads
// ---------------------------------------------------------------------------

export type AuditEventType =
  | "activation"
  | "vector_search"
  | "buffer_push"
  | "buffer_flush"
  | "extraction"
  | "extraction_action"
  | "dedup"
  | "gate_check"
  | "session_summary_generated"
  | "session_summary_skipped"
  | "auto_promotion_cycle"
  | "review_digest_shown";

export interface AuditActivationDetails {
  trigger: string;
  scopeRef: string;
  queryTokens: string[];
  /** Activation mode used (startup/default/temporal/cross_session). */
  activationMode: string;
  /** Query classification from classifyQueryType() (default/temporal/cross_session). */
  queryType: string;
  /** Whether startup pack memories were injected (first turn of session). */
  startupPackInjected: boolean;
  candidateCount: number;
  activatedCount: number;
  suppressedCount: number;
  activated: Array<{ id: string; type: string; summary: string; score: number }>;
  suppressed: Array<{ id: string; kind: string; reason: string }>;
  budgetUsedBytes: number;
  budgetMaxBytes: number;
  durationMs: number;
}

export interface AuditVectorSearchDetails {
  queryText: string;
  topK: number;
  results: Array<{ id: string; summary: string; score: number }>;
  durationMs: number;
}

export interface AuditBufferPushDetails {
  role: "user" | "tool";
  textPreview: string;
  bufferSize: number;
}

export interface AuditBufferFlushDetails {
  entryCount: number;
  evidenceEventId?: string;
}

export interface AuditExtractionDetails {
  batchCount: number;
  factsExtracted: number;
  actionsApplied: number;
  actionsSkipped: number;
  durationMs: number;
}

export interface AuditExtractionActionDetails {
  action: string;
  summary: string;
  targetMemoryId?: string;
  memoryId?: string;
  skipped: boolean;
  reason?: string;
}

export interface AuditDedupDetails {
  newSummary: string;
  maxSimilarity: number;
  mostSimilarId: string;
  mostSimilarSummary: string;
  threshold: number;
  skipped: boolean;
}

export interface AuditGateCheckDetails {
  gate: string;
  passed: boolean;
  reason?: string;
  pendingCount?: number;
  hoursSinceLastExtract?: number;
}

// ---------------------------------------------------------------------------
// Shadow validation detail types (observability layer)
// ---------------------------------------------------------------------------

export interface AuditSessionSummaryGeneratedDetails {
  sessionId: string;
  eventCount: number;
  toolNames: string[];
  typeDistribution: Record<string, number>;
  summaryShortLength: number;
  summaryMediumLength: number;
  embeddingGenerated: boolean;
}

export interface AuditSessionSummarySkippedDetails {
  sessionId: string;
  reason: string;
  eventCount?: number;
}

export interface AuditAutoPromotionCycleDetails {
  promotedCount: number;
  expiredCount: number;
  skippedCount: number;
  promoted: Array<{ id: string; type: string; summary: string; confidence: number }>;
  expired: Array<{ id: string; type: string; summary: string; ageDays: number }>;
}

export interface AuditReviewDigestShownDetails {
  candidateCount: number;
  recentAutoPromotionCount: number;
  typeBreakdown: Record<string, number>;
}

// ---------------------------------------------------------------------------
// AuditLogger
// ---------------------------------------------------------------------------

export class AuditLogger {
  private db: SqlJsDatabase;
  private enabled: boolean;

  constructor(db: SqlJsDatabase, enabled: boolean = true) {
    this.db = db;
    this.enabled = enabled;
  }

  logActivation(
    sessionId: string | undefined,
    scopeRef: string,
    details: AuditActivationDetails,
  ): void {
    this.write(
      "activation",
      sessionId,
      scopeRef,
      `Activated ${details.activatedCount}/${details.candidateCount} memories in ${details.durationMs}ms`,
      details,
    );
  }

  logVectorSearch(
    sessionId: string | undefined,
    scopeRef: string,
    details: AuditVectorSearchDetails,
  ): void {
    this.write(
      "vector_search",
      sessionId,
      scopeRef,
      `Vector search: ${details.results.length} results for "${details.queryText.slice(0, 50)}" in ${details.durationMs}ms`,
      details,
    );
  }

  logBufferPush(
    sessionId: string,
    details: AuditBufferPushDetails,
  ): void {
    this.write(
      "buffer_push",
      sessionId,
      undefined,
      `Buffer push [${details.role}]: ${details.textPreview.slice(0, 80)} (size=${details.bufferSize})`,
      details,
    );
  }

  logBufferFlush(
    sessionId: string,
    details: AuditBufferFlushDetails,
  ): void {
    this.write(
      "buffer_flush",
      sessionId,
      undefined,
      `Buffer flushed: ${details.entryCount} entries`,
      details,
    );
  }

  logExtraction(
    details: AuditExtractionDetails,
  ): void {
    this.write(
      "extraction",
      undefined,
      undefined,
      `Extraction: ${details.factsExtracted} facts, ${details.actionsApplied} applied, ${details.actionsSkipped} skipped in ${details.durationMs}ms`,
      details,
    );
  }

  logExtractionAction(
    details: AuditExtractionActionDetails,
  ): void {
    const status = details.skipped ? `skipped: ${details.reason}` : "applied";
    this.write(
      "extraction_action",
      undefined,
      undefined,
      `[${details.action}] ${details.summary} — ${status}`,
      details,
    );
  }

  logDedup(
    details: AuditDedupDetails,
  ): void {
    const status = details.skipped ? "REJECTED (duplicate)" : "PASSED";
    this.write(
      "dedup",
      undefined,
      undefined,
      `Dedup ${status}: "${details.newSummary.slice(0, 60)}" vs "${details.mostSimilarSummary.slice(0, 60)}" (sim=${details.maxSimilarity.toFixed(3)})`,
      details,
    );
  }

  logGateCheck(
    details: AuditGateCheckDetails,
  ): void {
    const status = details.passed ? "PASSED" : `BLOCKED: ${details.reason}`;
    this.write(
      "gate_check",
      undefined,
      undefined,
      `Gate [${details.gate}]: ${status}`,
      details,
    );
  }

  // -------------------------------------------------------------------------
  // Shadow validation methods (observability layer)
  // -------------------------------------------------------------------------

  logSessionSummaryGenerated(
    sessionId: string,
    details: AuditSessionSummaryGeneratedDetails,
  ): void {
    this.write(
      "session_summary_generated",
      sessionId,
      undefined,
      `Session summary generated: ${details.eventCount} events, ${details.toolNames.length} tools, embedding=${details.embeddingGenerated}`,
      details,
    );
  }

  logSessionSummarySkipped(
    sessionId: string,
    details: AuditSessionSummarySkippedDetails,
  ): void {
    this.write(
      "session_summary_skipped",
      sessionId,
      undefined,
      `Session summary skipped: ${details.reason}`,
      details,
    );
  }

  logAutoPromotionCycle(
    details: AuditAutoPromotionCycleDetails,
  ): void {
    this.write(
      "auto_promotion_cycle",
      undefined,
      undefined,
      `Auto-promotion: ${details.promotedCount} promoted, ${details.expiredCount} expired, ${details.skippedCount} skipped`,
      details,
    );
  }

  logReviewDigestShown(
    sessionId: string,
    details: AuditReviewDigestShownDetails,
  ): void {
    this.write(
      "review_digest_shown",
      sessionId,
      undefined,
      `Review digest shown: ${details.candidateCount} candidates, ${details.recentAutoPromotionCount} recent auto-promotions`,
      details,
    );
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private write(
    eventType: AuditEventType,
    sessionId: string | undefined,
    scopeRef: string | undefined,
    summary: string,
    details: unknown,
  ): void {
    if (!this.enabled) {
      return;
    }

    try {
      const id = createDeterministicId(
        `audit-${eventType}-${Date.now()}-${Math.random()}`,
      );

      this.db.run(
        `INSERT INTO audit_log (id, event_type, session_id, scope_ref, summary, details_json, created_at)
         VALUES ($id, $eventType, $sessionId, $scopeRef, $summary, $detailsJson, $createdAt)`,
        {
          $id: id,
          $eventType: eventType,
          $sessionId: sessionId ?? null,
          $scopeRef: scopeRef ?? null,
          $summary: summary,
          $detailsJson: JSON.stringify(details),
          $createdAt: new Date().toISOString(),
        },
      );
    } catch {
      // Audit logging is non-critical — never fail the main operation.
    }
  }
}
