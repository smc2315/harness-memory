-- Migration 001: Create MVP tables
-- Timestamp: 2026-03-28
-- Description: Initial schema for project memory layer MVP

-- memories table: Core memory storage with dedup via content_hash
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  content_hash TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL CHECK(type IN ('policy', 'workflow', 'pitfall', 'architecture_constraint', 'decision')),
  summary TEXT NOT NULL,
  details TEXT NOT NULL,
  scope_glob TEXT NOT NULL,
  lifecycle_triggers TEXT NOT NULL,
  confidence REAL NOT NULL CHECK(confidence >= 0 AND confidence <= 1),
  importance REAL NOT NULL CHECK(importance >= 0 AND importance <= 1),
  status TEXT NOT NULL DEFAULT 'candidate' CHECK(status IN ('candidate', 'active', 'stale', 'superseded')),
  supersedes_memory_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_verified_at TEXT,
  FOREIGN KEY (supersedes_memory_id) REFERENCES memories(id)
);

-- Index for scope_glob queries
CREATE INDEX IF NOT EXISTS idx_memories_scope_glob ON memories(scope_glob);
CREATE INDEX IF NOT EXISTS idx_memories_status ON memories(status);
CREATE INDEX IF NOT EXISTS idx_memories_created_at ON memories(created_at);

-- evidence table: Links memories to their supporting evidence
CREATE TABLE IF NOT EXISTS evidence (
  id TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK(source_kind IN ('session', 'task', 'file', 'manual_note')),
  source_ref TEXT NOT NULL,
  excerpt TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE CASCADE
);

-- Index for memory_id lookups
CREATE INDEX IF NOT EXISTS idx_evidence_memory_id ON evidence(memory_id);
CREATE INDEX IF NOT EXISTS idx_evidence_created_at ON evidence(created_at);

-- policy_rules table: Enforceable rules linked to memories
CREATE TABLE IF NOT EXISTS policy_rules (
  id TEXT PRIMARY KEY,
  memory_id TEXT,
  rule_code TEXT NOT NULL UNIQUE,
  severity TEXT NOT NULL CHECK(severity IN ('info', 'warning')),
  trigger_kind TEXT NOT NULL CHECK(trigger_kind IN ('session_start', 'before_model', 'before_tool', 'after_tool')),
  scope_glob TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE SET NULL
);

-- Index for scope_glob and trigger_kind queries
CREATE INDEX IF NOT EXISTS idx_policy_rules_scope_glob ON policy_rules(scope_glob);
CREATE INDEX IF NOT EXISTS idx_policy_rules_trigger_kind ON policy_rules(trigger_kind);
CREATE INDEX IF NOT EXISTS idx_policy_rules_memory_id ON policy_rules(memory_id);

-- activation_logs table: Audit trail of memory activations
CREATE TABLE IF NOT EXISTS activation_logs (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  lifecycle_trigger TEXT NOT NULL CHECK(lifecycle_trigger IN ('session_start', 'before_model', 'before_tool', 'after_tool')),
  scope_ref TEXT NOT NULL,
  activated_memory_ids TEXT NOT NULL,
  suppressed_memory_ids TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Index for session_id and created_at queries
CREATE INDEX IF NOT EXISTS idx_activation_logs_session_id ON activation_logs(session_id);
CREATE INDEX IF NOT EXISTS idx_activation_logs_created_at ON activation_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_activation_logs_lifecycle_trigger ON activation_logs(lifecycle_trigger);
