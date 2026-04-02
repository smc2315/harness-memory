-- Migration 012: Add salience_boost to dream_evidence_events table.
--
-- Allows conversation boundary nudges to elevate the salience of
-- specific evidence events. The boost is added to the aggregate score
-- during dream consolidation.
--
-- Default 0 means no boost (backward-compatible).
-- Typical boost values: 0.1 to 0.3 for milestone moments.

ALTER TABLE dream_evidence_events ADD COLUMN salience_boost REAL NOT NULL DEFAULT 0;

PRAGMA user_version = 12;
