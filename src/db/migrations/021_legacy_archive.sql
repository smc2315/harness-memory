-- Migration 021: archive the v0.5 dream pipeline tables; drop the never-populated topic_summaries.
-- Timestamp: 2026-11-08 (v0.6 redesign, spec §4.5)
--
-- No rows are deleted. Unconsumed legacy evidence is marked discarded instead of re-extracted:
-- it has no tool set or scope refs, so no fact from it could pass V3/V4, and re-extraction would
-- burn up to a day's LLM budget on upgrade. legacy_* tables are read by dream/legacy-reader.ts for
-- `memory:history` during one release and dropped in 0.7. `evidence` stays for manual notes.

PRAGMA foreign_keys = OFF;

ALTER TABLE dream_evidence_events RENAME TO legacy_dream_evidence_events;
ALTER TABLE dream_runs RENAME TO legacy_dream_runs;
ALTER TABLE dream_memory_evidence_links RENAME TO legacy_dream_memory_evidence_links;

UPDATE legacy_dream_evidence_events
   SET status = 'discarded',
       discarded_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 WHERE status IN ('pending', 'retained', 'grouped', 'latent');

DROP TABLE IF EXISTS topic_summaries;

PRAGMA foreign_keys = ON;

PRAGMA user_version = 21;
