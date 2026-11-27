-- Migration 024: knowledge_kind follows the episode signals (0.6.0-rc.3, full autonomy).
-- Timestamp: 2026-11-27
--
-- A knowledge_kind of correction / failure_resolution is a claim about the episode: a correction happened, or a tool
-- failed and was fixed. The extractor put those labels on rows born from decision-only episodes, and it is the label
-- that drives baseTtlDays (30 d instead of 7), the revalidate proposal at TTL, rule 2 of enforcementDefault
-- (before_tool.auto_enforcement) and the A′ ladder predicate (docs/redesign/full-autonomy-0.6.0-rc.3.md §1.2).
-- normalizeFact applies the same rule to every new fact (relabel `kind_without_signal`); this statement applies it once
-- to the rows already stored:
--   relabelled   auto rows with knowledge_kind IN ('correction', 'failure_resolution') that have at least one evidence
--                provenance row (origin / reinforce) and no evidence episode carrying "correction":1, "remember":1,
--                "failure":1 or a non-null correction_for → 'convention'.
--   untouched    human rows; rows without provenance (legacy, imports); rows with any signal episode; every other
--                column — a ttl_expires_at already set on an active row is not shortened, because the relabel changes
--                what happens at expiry, not when.
-- flags_json is JSON.stringify output, so the compact '"correction":1' form is stable (as correctionEpisodeSql relies on).

UPDATE memories SET knowledge_kind = 'convention'
WHERE authority = 'auto' AND knowledge_kind IN ('correction', 'failure_resolution')
  AND EXISTS (SELECT 1 FROM memory_provenance p WHERE p.memory_id = memories.id AND p.relation IN ('origin', 'reinforce'))
  AND NOT EXISTS (
    SELECT 1 FROM memory_provenance p JOIN episodes e ON e.id = p.episode_id
    WHERE p.memory_id = memories.id AND p.relation IN ('origin', 'reinforce')
      AND (e.correction_for IS NOT NULL OR e.flags_json LIKE '%"correction":1%' OR e.flags_json LIKE '%"remember":1%' OR e.flags_json LIKE '%"failure":1%'));

PRAGMA user_version = 24;
