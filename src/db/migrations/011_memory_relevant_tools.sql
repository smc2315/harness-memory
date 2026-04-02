-- Migration 011: Add relevant_tools_json to memories table.
--
-- Stores a JSON array of tool names that a memory is relevant for.
-- Used by the activation engine to filter memories during before_tool
-- and after_tool lifecycle triggers based on the active tool.
--
-- NULL means "relevant to all tools" (backward-compatible default).
-- Example: '["bash","edit"]' means only activate when bash or edit is used.

ALTER TABLE memories ADD COLUMN relevant_tools_json TEXT DEFAULT NULL;

PRAGMA user_version = 11;
