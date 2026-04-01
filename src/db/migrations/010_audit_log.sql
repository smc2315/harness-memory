-- Migration 010: Audit log table for structured operational logging.
--
-- Records every significant system decision so operators can analyze:
--   - Which memories were activated and why
--   - Vector search quality (scores, rankings)
--   - Buffer flush / evidence creation events
--   - LLM extraction results and dedup decisions
--   - Scheduler gate evaluations

CREATE TABLE IF NOT EXISTS audit_log (
  id            TEXT    PRIMARY KEY,
  event_type    TEXT    NOT NULL,  -- activation, vector_search, buffer_flush, extraction, dedup, gate_check
  session_id    TEXT,
  scope_ref     TEXT,
  summary       TEXT    NOT NULL,  -- human-readable one-liner
  details_json  TEXT    NOT NULL DEFAULT '{}',  -- structured event-specific data
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_audit_log_event_type ON audit_log(event_type);
CREATE INDEX IF NOT EXISTS idx_audit_log_created_at ON audit_log(created_at);
CREATE INDEX IF NOT EXISTS idx_audit_log_session_id ON audit_log(session_id);
