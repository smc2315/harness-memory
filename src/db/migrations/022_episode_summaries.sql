-- Migration 022: per-episode recall summaries (v0.6 A′ recall layer).
-- Timestamp: 2026-11-08
--
-- Two nullable columns on `episodes` instead of a side table: a summary is 1:1 with its episode, is read
-- together with the episode's tools / scope refs / failure signatures by the snapshot builder and
-- `hm recall`, and disappears with the row — a table would only add a join and orphan handling.
--   summary       ≤ 400 chars, one line. 'extracted' = the extractor's episode_summary (replaces a derived
--                 one), 'derived' = the deterministic summary the worker builds from the descriptor and the
--                 ledger lines (skipped / waiting / dead episodes and extractions without a summary).
--   summary_kind  which of the two produced `summary`; NULL while `summary` is NULL.
-- The partial index serves the recall snapshot query (newest N episodes that have a summary).

ALTER TABLE episodes ADD COLUMN summary TEXT;
ALTER TABLE episodes ADD COLUMN summary_kind TEXT CHECK(summary_kind IS NULL OR summary_kind IN ('extracted', 'derived'));

CREATE INDEX IF NOT EXISTS idx_episodes_recall ON episodes(closed_at DESC, id ASC) WHERE summary IS NOT NULL;

PRAGMA user_version = 22;
