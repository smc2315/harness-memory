-- Migration 016: Add session_summaries and topic_summaries tables
-- Timestamp: 2026-04-06
-- Description: P1 Hierarchical Retrieval — separate retrieval tables
--   for session-level and topic-level summaries.
--
-- Design decisions:
--   - These are NOT MemoryType extensions — they are retrieval artifacts
--   - session_summaries: one per session, heuristic-generated from evidence
--   - topic_summaries: cross-session topic aggregation (skeleton in P1, full in P2)
--   - Embeddings stored as BLOB (384d Float32Array, multilingual-e5-small)

CREATE TABLE IF NOT EXISTS session_summaries (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL UNIQUE,
  summary_short TEXT NOT NULL,
  summary_medium TEXT NOT NULL,
  embedding BLOB,
  source_event_ids TEXT NOT NULL DEFAULT '[]',
  tool_names TEXT NOT NULL DEFAULT '[]',
  type_distribution TEXT NOT NULL DEFAULT '{}',
  event_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS topic_summaries (
  id TEXT PRIMARY KEY,
  canonical_topic TEXT NOT NULL,
  summary_short TEXT NOT NULL,
  summary_medium TEXT NOT NULL,
  embedding BLOB,
  supporting_session_ids TEXT NOT NULL DEFAULT '[]',
  source_event_ids TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_session_summaries_session ON session_summaries(session_id);
CREATE INDEX IF NOT EXISTS idx_session_summaries_updated ON session_summaries(updated_at);
CREATE INDEX IF NOT EXISTS idx_topic_summaries_topic ON topic_summaries(canonical_topic);

PRAGMA user_version = 16;
