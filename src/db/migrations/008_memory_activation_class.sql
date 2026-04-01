-- Migration 008: Add activation_class column to memories table
-- Valid values: 'baseline', 'startup', 'scoped', 'event'
-- Default: 'scoped' (backward-compatible with existing memories)

ALTER TABLE memories ADD COLUMN activation_class TEXT NOT NULL DEFAULT 'scoped';

CREATE INDEX IF NOT EXISTS idx_memories_activation_class ON memories(activation_class);

PRAGMA user_version = 8;
