-- Migration 002: Add dream evidence and run history tables
-- Timestamp: 2026-03-29
-- Description: Append-only evidence events and dream run tracking

CREATE TABLE IF NOT EXISTS dream_runs (
  id TEXT PRIMARY KEY,
  trigger TEXT NOT NULL CHECK(trigger IN ('manual', 'precompact', 'task_end', 'session_end', 'idle')),
  status TEXT NOT NULL CHECK(status IN ('started', 'completed', 'failed')),
  window_start TEXT NOT NULL,
  window_end TEXT NOT NULL,
  evidence_count INTEGER NOT NULL DEFAULT 0,
  candidate_count INTEGER NOT NULL DEFAULT 0,
  summary TEXT NOT NULL,
  created_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_dream_runs_created_at ON dream_runs(created_at);
CREATE INDEX IF NOT EXISTS idx_dream_runs_trigger ON dream_runs(trigger);
CREATE INDEX IF NOT EXISTS idx_dream_runs_status ON dream_runs(status);

CREATE TABLE IF NOT EXISTS dream_evidence_events (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  call_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  scope_ref TEXT NOT NULL,
  source_ref TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  excerpt TEXT NOT NULL,
  args_json TEXT NOT NULL,
  metadata_json TEXT,
  topic_guess TEXT NOT NULL,
  type_guess TEXT NOT NULL CHECK(type_guess IN ('workflow', 'pitfall')),
  salience REAL NOT NULL CHECK(salience >= 0 AND salience <= 1),
  novelty REAL NOT NULL CHECK(novelty >= 0 AND novelty <= 1),
  contradiction_signal INTEGER NOT NULL CHECK(contradiction_signal IN (0, 1)),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'consumed', 'discarded')),
  dream_run_id TEXT,
  created_at TEXT NOT NULL,
  consumed_at TEXT,
  FOREIGN KEY (dream_run_id) REFERENCES dream_runs(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_dream_evidence_events_session_id ON dream_evidence_events(session_id);
CREATE INDEX IF NOT EXISTS idx_dream_evidence_events_status ON dream_evidence_events(status);
CREATE INDEX IF NOT EXISTS idx_dream_evidence_events_created_at ON dream_evidence_events(created_at);
CREATE INDEX IF NOT EXISTS idx_dream_evidence_events_topic_guess ON dream_evidence_events(topic_guess);
