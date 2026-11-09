-- Migration 019: proposals, proposal_support, memory_provenance, memory_transitions; fix_scope proposals.
-- Timestamp: 2026-11-08 (v0.6 redesign, spec §4.3)

CREATE TABLE IF NOT EXISTS proposals (
  id TEXT PRIMARY KEY,                                 -- randomUUID(): a deterministic id would collide on re-proposal after reject/expire
  kind TEXT NOT NULL CHECK(kind IN ('supersede', 'stale', 'activate_policy', 'activate_global', 'fix_scope', 'fix_signature', 'revalidate', 'merge')),
  target_memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  candidate_memory_id TEXT REFERENCES memories(id) ON DELETE CASCADE,
  rationale TEXT NOT NULL,
  confidence REAL NOT NULL,
  created_by TEXT NOT NULL CHECK(created_by IN ('extractor', 'consolidator', 'migration', 'import')),
  support_count INTEGER NOT NULL DEFAULT 0,            -- derived from proposal_support
  support_sessions INTEGER NOT NULL DEFAULT 0,         -- derived from proposal_support
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'accepted', 'rejected', 'expired')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  decided_at TEXT,
  decided_by TEXT CHECK(decided_by IN ('human', 'auto_rule', 'expiry')),
  decision_note TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_proposals_open
  ON proposals(kind, target_memory_id, COALESCE(candidate_memory_id, '')) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_proposals_target ON proposals(target_memory_id);
CREATE INDEX IF NOT EXISTS idx_proposals_status_expires ON proposals(status, expires_at);

CREATE TABLE IF NOT EXISTS proposal_support (
  proposal_id TEXT NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
  episode_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  extraction_run_id TEXT,
  confidence REAL NOT NULL,
  created_at TEXT NOT NULL,
  has_human_signal INTEGER NOT NULL DEFAULT 0,         -- episode flags.correction OR flags.remember
  deterministic INTEGER NOT NULL DEFAULT 0,            -- the signature command ran tool_ok in the same turn with no failure
  PRIMARY KEY (proposal_id, episode_id)
);

CREATE TABLE IF NOT EXISTS memory_provenance (
  memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  episode_id TEXT NOT NULL,
  event_seq INTEGER NOT NULL,                          -- e<seq> cited by the extractor; 0 for import/manual rows
  relation TEXT NOT NULL CHECK(relation IN ('origin', 'reinforce', 'contradict', 'import')),
  confidence REAL NOT NULL,                            -- fact.confidence: the only source of derived confidence
  excerpt TEXT NOT NULL DEFAULT '' CHECK(length(excerpt) <= 500),
  extraction_run_id TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (memory_id, episode_id, event_seq, relation)
);

CREATE INDEX IF NOT EXISTS idx_memory_provenance_episode ON memory_provenance(episode_id);

CREATE TABLE IF NOT EXISTS memory_transitions (
  id TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  from_status TEXT NOT NULL,
  to_status TEXT NOT NULL,
  actor TEXT NOT NULL CHECK(actor IN ('human', 'auto_rule', 'expiry', 'import', 'migration')),
  proposal_id TEXT,
  extraction_run_id TEXT,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memory_transitions_memory ON memory_transitions(memory_id, created_at);

-- One fix_scope proposal per R2 victim flagged by 017 (needs_scope = 1); expires in 90 days.
INSERT INTO proposals (id, kind, target_memory_id, rationale, confidence, created_by, status, created_at, expires_at)
SELECT lower(hex(randomblob(16))), 'fix_scope', id,
       'v0.5 stored scope **/* and trigger before_model only; set scope, trigger and signature',
       0.5, 'migration', 'open',
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+90 days')
  FROM memories
 WHERE needs_scope = 1;

PRAGMA user_version = 19;
