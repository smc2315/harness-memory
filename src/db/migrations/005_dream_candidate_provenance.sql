-- Migration 005: Add durable provenance linkage between dream evidence and candidate memories
-- Timestamp: 2026-03-30
-- Description: Preserve why a candidate exists across review and history surfaces

CREATE TABLE IF NOT EXISTS dream_memory_evidence_links (
  evidence_event_id TEXT NOT NULL,
  memory_id TEXT NOT NULL,
  dream_run_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (evidence_event_id, memory_id),
  FOREIGN KEY (evidence_event_id) REFERENCES dream_evidence_events(id) ON DELETE CASCADE,
  FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE CASCADE,
  FOREIGN KEY (dream_run_id) REFERENCES dream_runs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_dream_memory_links_memory_id ON dream_memory_evidence_links(memory_id);
CREATE INDEX IF NOT EXISTS idx_dream_memory_links_run_id ON dream_memory_evidence_links(dream_run_id);
