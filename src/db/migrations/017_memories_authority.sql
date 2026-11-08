-- Migration 017: rebuild `memories` with authority, enforcement, trigger signatures and derived counters.
-- Timestamp: 2026-11-08 (v0.6 redesign, spec §4.1)
--
-- Must run on a fresh connection WITHOUT a surrounding transaction: `PRAGMA foreign_keys` is a no-op
-- inside a transaction, and dropping `memories` with foreign keys ON would cascade-delete `evidence`
-- (001) and `dream_memory_evidence_links` (005). The migrator writes memory.sqlite.bak-v<N> first.
--
-- `identity_key` loses its table-wide UNIQUE constraint: a superseded row and its replacement share
-- the key, so uniqueness is enforced only across live statuses by a partial index below.
-- `authority` has NO default on purpose: every inserter must say whether a row is human or auto.

PRAGMA foreign_keys = OFF;

CREATE TABLE IF NOT EXISTS memories_new (
  id TEXT PRIMARY KEY,
  content_hash TEXT NOT NULL,
  identity_key TEXT,
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
  activation_class TEXT NOT NULL DEFAULT 'scoped',
  embedding BLOB DEFAULT NULL,
  relevant_tools_json TEXT DEFAULT NULL,
  promotion_source TEXT NOT NULL DEFAULT 'manual',
  ttl_expires_at TEXT DEFAULT NULL,
  validation_count INTEGER NOT NULL DEFAULT 0,
  policy_subtype TEXT DEFAULT NULL,
  embedding_summary BLOB DEFAULT NULL,
  -- v0.6 columns -------------------------------------------------------------------------------
  semantic_key TEXT,                                   -- sha256(type|scope_glob|signature_key|normalize(summary))
  trigger_signature_json TEXT,                         -- §4.6 TriggerSignature or NULL
  signature_key TEXT NOT NULL DEFAULT '',              -- serialized canonical form of the signature ('' = none)
  knowledge_kind TEXT CHECK(knowledge_kind IN ('correction', 'failure_resolution', 'convention', 'decision', 'import', 'manual')),
  failure_classes_json TEXT,                           -- JSON array of failure classes this memory addresses
  status_reason TEXT,                                  -- e.g. ttl_expired, expiry, cap, human
  superseded_by_memory_id TEXT,
  source_ref TEXT,                                     -- 'episode:<id>' | 'import:<file>#L<n>' | 'cli'
  revalidate_after TEXT,
  last_fired_at TEXT,
  open_proposal_id TEXT,
  authority TEXT NOT NULL CHECK(authority IN ('human', 'auto')),
  enforcement TEXT NOT NULL DEFAULT 'advise' CHECK(enforcement IN ('advise', 'confirm', 'soft_deny', 'deny')),
  source_kind TEXT NOT NULL CHECK(source_kind IN ('manual', 'import', 'extraction', 'legacy')),
  evidence_score REAL NOT NULL DEFAULT 0,
  evidence_count INTEGER NOT NULL DEFAULT 0,
  distinct_session_count INTEGER NOT NULL DEFAULT 0,
  fire_count INTEGER NOT NULL DEFAULT 0,
  override_count INTEGER NOT NULL DEFAULT 0,
  contested INTEGER NOT NULL DEFAULT 0,
  needs_scope INTEGER NOT NULL DEFAULT 0,
  import_unconfirmed INTEGER NOT NULL DEFAULT 0,
  aliases_json TEXT NOT NULL DEFAULT '[]',             -- extractor-provided synonyms (incl. other languages) for lexical recall
  FOREIGN KEY (supersedes_memory_id) REFERENCES memories(id)
);

INSERT INTO memories_new (
  id, content_hash, identity_key, type, summary, details, scope_glob, lifecycle_triggers,
  confidence, importance, status, supersedes_memory_id, created_at, updated_at, last_verified_at,
  activation_class, embedding, relevant_tools_json, promotion_source, ttl_expires_at,
  validation_count, policy_subtype, embedding_summary,
  authority, source_kind, knowledge_kind
)
SELECT
  id, content_hash, identity_key, type, summary, details, scope_glob, lifecycle_triggers,
  confidence, importance, status, supersedes_memory_id, created_at, updated_at, last_verified_at,
  activation_class, embedding, relevant_tools_json, promotion_source, ttl_expires_at,
  validation_count, policy_subtype, embedding_summary,
  -- Provenance cannot be told apart by shape (LLM rows and memory:add rows look alike), so decide by
  -- state: a candidate was never approved by anyone (auto); an active row that was not auto-promoted
  -- was promoted by a person (human). A human candidate misfiled as auto is one `memory:promote` away.
  CASE WHEN promotion_source = 'auto' OR status = 'candidate' THEN 'auto' ELSE 'human' END,
  'manual',
  CASE WHEN promotion_source = 'auto' OR status = 'candidate' THEN NULL ELSE 'manual' END
FROM memories;

DROP TABLE memories;
ALTER TABLE memories_new RENAME TO memories;

CREATE INDEX IF NOT EXISTS idx_memories_scope_glob ON memories(scope_glob);
CREATE INDEX IF NOT EXISTS idx_memories_status ON memories(status);
CREATE INDEX IF NOT EXISTS idx_memories_created_at ON memories(created_at);
CREATE INDEX IF NOT EXISTS idx_memories_content_hash ON memories(content_hash);
CREATE INDEX IF NOT EXISTS idx_memories_activation_class ON memories(activation_class);
CREATE INDEX IF NOT EXISTS idx_memories_status_authority ON memories(status, authority);
CREATE INDEX IF NOT EXISTS idx_memories_semantic_key ON memories(semantic_key);
CREATE UNIQUE INDEX IF NOT EXISTS ux_memories_identity_live
  ON memories(identity_key) WHERE identity_key IS NOT NULL AND status IN ('candidate', 'active', 'stale');
CREATE UNIQUE INDEX IF NOT EXISTS ux_memories_semantic_live
  ON memories(semantic_key) WHERE semantic_key IS NOT NULL AND status IN ('candidate', 'active', 'stale');

-- Rows written by v0.5 `install.ts` from CLAUDE.md-style bullets: global baseline policies.
UPDATE memories
   SET source_kind = 'import', source_ref = 'import:legacy', knowledge_kind = 'import'
 WHERE type = 'policy' AND scope_glob = '**' AND activation_class = 'baseline';

-- R2 victims (v0.5 LLM extraction hardcoded scope **/* and trigger ["before_model"]): found by shape,
-- not by link, because llm-extract rows carry no evidence links. 019 opens a fix_scope proposal for each.
UPDATE memories
   SET source_kind = 'legacy', needs_scope = 1
 WHERE scope_glob IN ('**', '**/*')
   AND lifecycle_triggers = '["before_model"]'
   AND activation_class <> 'baseline'
   AND status IN ('candidate', 'active');

PRAGMA foreign_keys = ON;

PRAGMA user_version = 17;
