-- Migration 015: Replace deferred lifecycle with retained/latent evidence states
-- Timestamp: 2026-04-06
-- Description: Structural transition P0 — remove regex front-gate, add evidence
--   retention pipeline with retained/grouped/materialized/latent states.
--
-- State machine:
--   pending → retained (noise filter passed)
--   retained → grouped (structural grouping assigned)
--   grouped → materialized (Tier 1/2 candidate created)
--   grouped → latent (Tier 3, no candidate, 14-day TTL)
--   any → discarded (noise, TTL, or explicit discard)
--
-- Migration mapping:
--   pending → pending (unchanged)
--   deferred → latent (deferred evidence becomes latent with TTL)
--   consumed → consumed (historical rows preserved)
--   discarded → discarded (unchanged)

PRAGMA foreign_keys = OFF;

CREATE TABLE IF NOT EXISTS dream_evidence_events_new (
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
  type_guess TEXT NOT NULL CHECK(type_guess IN ('policy', 'workflow', 'pitfall', 'architecture_constraint', 'decision')),
  salience REAL NOT NULL CHECK(salience >= 0 AND salience <= 1),
  novelty REAL NOT NULL CHECK(novelty >= 0 AND novelty <= 1),
  salience_boost REAL NOT NULL DEFAULT 0,
  contradiction_signal INTEGER NOT NULL CHECK(contradiction_signal IN (0, 1)),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'retained', 'grouped', 'materialized', 'latent', 'consumed', 'discarded')),
  retry_count INTEGER NOT NULL DEFAULT 0,
  next_review_at TEXT,
  last_reviewed_at TEXT,
  dream_run_id TEXT,
  created_at TEXT NOT NULL,
  consumed_at TEXT,
  discarded_at TEXT,
  FOREIGN KEY (dream_run_id) REFERENCES dream_runs(id) ON DELETE SET NULL
);

INSERT INTO dream_evidence_events_new (
  id,
  session_id,
  call_id,
  tool_name,
  scope_ref,
  source_ref,
  title,
  excerpt,
  args_json,
  metadata_json,
  topic_guess,
  type_guess,
  salience,
  novelty,
  salience_boost,
  contradiction_signal,
  status,
  retry_count,
  next_review_at,
  last_reviewed_at,
  dream_run_id,
  created_at,
  consumed_at,
  discarded_at
)
SELECT
  id,
  session_id,
  call_id,
  tool_name,
  scope_ref,
  source_ref,
  title,
  excerpt,
  args_json,
  metadata_json,
  topic_guess,
  type_guess,
  salience,
  novelty,
  salience_boost,
  contradiction_signal,
  -- Map deferred → latent; all others unchanged
  CASE WHEN status = 'deferred' THEN 'latent' ELSE status END,
  retry_count,
  -- Clear next_review_at for latent (no longer uses backoff scheduling)
  CASE WHEN status = 'deferred' THEN NULL ELSE next_review_at END,
  last_reviewed_at,
  dream_run_id,
  created_at,
  consumed_at,
  -- Set discarded_at for latent rows that had no discard timestamp
  CASE WHEN status = 'deferred' THEN NULL ELSE discarded_at END
FROM dream_evidence_events;

DROP TABLE dream_evidence_events;
ALTER TABLE dream_evidence_events_new RENAME TO dream_evidence_events;

CREATE INDEX IF NOT EXISTS idx_dream_evidence_events_session_id ON dream_evidence_events(session_id);
CREATE INDEX IF NOT EXISTS idx_dream_evidence_events_status ON dream_evidence_events(status);
CREATE INDEX IF NOT EXISTS idx_dream_evidence_events_created_at ON dream_evidence_events(created_at);
CREATE INDEX IF NOT EXISTS idx_dream_evidence_events_topic_guess ON dream_evidence_events(topic_guess);
CREATE INDEX IF NOT EXISTS idx_dream_evidence_events_next_review_at ON dream_evidence_events(next_review_at);

PRAGMA foreign_keys = ON;

PRAGMA user_version = 15;
