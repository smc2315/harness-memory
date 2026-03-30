-- Migration 004: Add rejected memory status
-- Timestamp: 2026-03-30
-- Description: Make candidate rejection a real state transition

PRAGMA foreign_keys = OFF;

CREATE TABLE IF NOT EXISTS memories_new (
  id TEXT PRIMARY KEY,
  content_hash TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL CHECK(type IN ('policy', 'workflow', 'pitfall', 'architecture_constraint', 'decision')),
  summary TEXT NOT NULL,
  details TEXT NOT NULL,
  scope_glob TEXT NOT NULL,
  lifecycle_triggers TEXT NOT NULL,
  confidence REAL NOT NULL CHECK(confidence >= 0 AND confidence <= 1),
  importance REAL NOT NULL CHECK(importance >= 0 AND importance <= 1),
  status TEXT NOT NULL DEFAULT 'candidate' CHECK(status IN ('candidate', 'active', 'stale', 'superseded', 'rejected')),
  supersedes_memory_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_verified_at TEXT,
  FOREIGN KEY (supersedes_memory_id) REFERENCES memories(id)
);

INSERT INTO memories_new (
  id,
  content_hash,
  type,
  summary,
  details,
  scope_glob,
  lifecycle_triggers,
  confidence,
  importance,
  status,
  supersedes_memory_id,
  created_at,
  updated_at,
  last_verified_at
)
SELECT
  id,
  content_hash,
  type,
  summary,
  details,
  scope_glob,
  lifecycle_triggers,
  confidence,
  importance,
  status,
  supersedes_memory_id,
  created_at,
  updated_at,
  last_verified_at
FROM memories;

DROP TABLE memories;
ALTER TABLE memories_new RENAME TO memories;

CREATE INDEX IF NOT EXISTS idx_memories_scope_glob ON memories(scope_glob);
CREATE INDEX IF NOT EXISTS idx_memories_status ON memories(status);
CREATE INDEX IF NOT EXISTS idx_memories_created_at ON memories(created_at);

PRAGMA foreign_keys = ON;
