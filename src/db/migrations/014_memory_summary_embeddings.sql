-- Migration 014: Add summary-only embedding for dual-index retrieval.
--
-- Stores a separate embedding of just the summary text, enabling
-- max(full_similarity, summary_similarity) scoring during retrieval.
-- Short queries match better against summary-only embeddings.
--
-- NULL means no summary embedding stored yet (backward-compatible).

ALTER TABLE memories ADD COLUMN embedding_summary BLOB DEFAULT NULL;

PRAGMA user_version = 14;
