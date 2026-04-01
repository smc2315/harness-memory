-- Migration 009: Add embedding column for vector search
-- Stores Float32Array as BLOB (384 dimensions x 4 bytes = 1536 bytes per memory)

ALTER TABLE memories ADD COLUMN embedding BLOB DEFAULT NULL;

PRAGMA user_version = 9;
