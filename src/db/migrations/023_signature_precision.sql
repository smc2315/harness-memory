-- Migration 023: signature precision, side effect and horizon on memories (0.6.0-rc.2, full autonomy).
-- Timestamp: 2026-11-26
--
-- Three nullable columns, written once by the worker when a fact is created (docs/redesign/full-autonomy-0.6.0-rc.2.md §2):
--   signature_precision  'mistake_exact' when the compiled trigger signature matched no tool_ok line of the source
--                        episode other than the cited mistaken call; 'noun' when it also matched a legitimate call
--                        (the pattern names the operation, not the mistake). NULL without a signature, and for every
--                        row created before this migration — the enforcement rules treat NULL as 'noun', so no
--                        existing row can be born or escalated to soft_deny by the new rule without a re-extraction.
--   side_effect          'write' when the matched call creates, modifies, deletes or transitions data in a shared
--                        system (extractor-emitted, default 'read'); NULL for existing rows.
--   horizon              'task' marks knowledge about the current task's state (7-day TTL, never above advise);
--                        'durable' is the default for new rows; NULL for existing rows (treated as durable).

ALTER TABLE memories ADD COLUMN signature_precision TEXT CHECK(signature_precision IS NULL OR signature_precision IN ('mistake_exact', 'noun'));
ALTER TABLE memories ADD COLUMN side_effect TEXT CHECK(side_effect IS NULL OR side_effect IN ('read', 'write'));
ALTER TABLE memories ADD COLUMN horizon TEXT CHECK(horizon IS NULL OR horizon IN ('durable', 'task'));

PRAGMA user_version = 23;
