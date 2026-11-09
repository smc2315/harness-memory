-- Migration 018: episodes (turn segments = extraction queue), extraction_runs, write_ops, meta.
-- Timestamp: 2026-11-08 (v0.6 redesign, spec §4.2)

CREATE TABLE IF NOT EXISTS episodes (
  id TEXT PRIMARY KEY,                                 -- createDeterministicId('episode:' + host + ':' + session_id + ':' + turn_key + ':' + segment)
  host TEXT NOT NULL CHECK(host IN ('claude-code', 'codex', 'opencode', 'import')),
  session_id TEXT NOT NULL,
  turn_key TEXT NOT NULL,
  segment INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL,
  closed_at TEXT NOT NULL,
  close_reason TEXT NOT NULL CHECK(close_reason IN ('stop', 'precompact', 'session_end', 'idle', 'interrupted', 'import')),
  ledger_ref TEXT NOT NULL,                            -- 'ledger/<file>#<byte_start>-<byte_end>' | 'import:<path>'
  correction_for TEXT,                                 -- previous episode this turn corrects
  context_ref TEXT,                                    -- last <=12 tool lines of that episode (context only, never citable)
  scope_refs_json TEXT NOT NULL DEFAULT '[]',
  tools_json TEXT NOT NULL DEFAULT '[]',
  failure_signatures_json TEXT NOT NULL DEFAULT '[]',
  flags_json TEXT NOT NULL DEFAULT '{}',
  fired_json TEXT NOT NULL DEFAULT '[]',
  evidence_weight REAL NOT NULL DEFAULT 0,
  event_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued', 'leased', 'extracted', 'skipped', 'failed', 'dead')),
  skip_reason TEXT,
  lease_until TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  last_error TEXT,
  extraction_run_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_episodes_status_next ON episodes(status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_episodes_session ON episodes(host, session_id, closed_at);

CREATE TABLE IF NOT EXISTS extraction_runs (
  id TEXT PRIMARY KEY,                                 -- createDeterministicId('run:' + episode_id + ':' + extractor_version)
  episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK(provider IN ('claude', 'codex', 'opencode', 'replay')),
  model TEXT,
  extractor_version TEXT NOT NULL,
  prompt_sha256 TEXT NOT NULL,
  input_chars INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  duration_ms INTEGER,
  status TEXT NOT NULL CHECK(status IN ('started', 'ok', 'invalid_output', 'suspect', 'timeout', 'provider_error', 'no_provider', 'nested_refusal', 'not_logged_in')),
  facts_total INTEGER NOT NULL DEFAULT 0,
  facts_accepted INTEGER NOT NULL DEFAULT 0,
  raw_output_ref TEXT,
  error TEXT,
  outcomes_json TEXT NOT NULL DEFAULT '[]'             -- per fact: {ordinal, action, outcome, memory_id?, proposal_id?, rejection?, relabel?}
);

CREATE INDEX IF NOT EXISTS idx_extraction_runs_episode ON extraction_runs(episode_id);
CREATE INDEX IF NOT EXISTS idx_extraction_runs_started ON extraction_runs(started_at);

-- Idempotency ledger for writers: run id | 'decision:<proposal_id>:<decided_at>' | 'import:<file_sha256>' | 'dream:<started_at ISO>'
CREATE TABLE IF NOT EXISTS write_ops (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  generation INTEGER NOT NULL,
  applied_at TEXT NOT NULL
);

-- db_generation, extractor_version, semantic_key_backfill, last_dream_at, last_probe_at, last_probe_result, installed_version
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT OR IGNORE INTO meta (key, value) VALUES ('db_generation', '0');

PRAGMA user_version = 18;
