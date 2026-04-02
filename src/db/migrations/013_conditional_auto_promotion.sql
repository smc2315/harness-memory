-- Migration 013: Conditional auto-promotion (B+ model).
--
-- Adds fields for tracking how a memory was promoted, its TTL for
-- auto-promoted memories, revalidation count, and policy subtype.

ALTER TABLE memories ADD COLUMN promotion_source TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE memories ADD COLUMN ttl_expires_at TEXT DEFAULT NULL;
ALTER TABLE memories ADD COLUMN validation_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE memories ADD COLUMN policy_subtype TEXT DEFAULT NULL;
