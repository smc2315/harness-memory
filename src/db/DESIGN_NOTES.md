# Task 4: SQLite Schema and Migration Design - Design Notes

## Overview

This document captures the architectural decisions and design rationale for the SQLite schema and migration infrastructure for the Project Memory Layer MVP.

## Key Design Decisions

### 1. UUID Primary IDs via TEXT

**Decision**: All tables use `TEXT PRIMARY KEY` for UUID identifiers instead of auto-increment integers.

**Rationale**:
- Deterministic, collision-free IDs without central sequence management
- Supports distributed generation and offline-first scenarios
- Aligns with MVP requirement for UUID primary IDs
- Enables portable database exports and merges
- No dependency on database-specific auto-increment behavior

**Implementation**:
- All primary keys are TEXT type
- UUIDs generated externally (v4 or v5 recommended)
- No database-level ID generation

### 2. Content-Hash Deduplication

**Decision**: `memories` table enforces `UNIQUE` constraint on `content_hash` column.

**Rationale**:
- Prevents duplicate memories with identical content
- Deterministic dedup without semantic similarity or ML
- Efficient database-level enforcement
- Supports intentional supersession via `supersedes_memory_id`
- Enables conflict detection at insertion time

**Implementation**:
- SHA256 hash of memory content (summary + details)
- UNIQUE constraint prevents duplicate inserts
- Repeated promotion of same content returns existing memory or updates it
- Audit trail preserved: old records remain queryable with status=stale/superseded

### 3. Migration Versioning Strategy

**Decision**: Use SQLite's built-in `PRAGMA user_version` for migration version tracking.

**Rationale**:
- Matches the explicit MVP requirement from the plan
- Avoids creating a non-MVP metadata table
- Keeps migration state inside SQLite's native schema version field
- Simple integer versioning is sufficient for the MVP
- Easy to inspect from both CLI and external SQLite tooling

**Implementation**:
- Migration runner reads current version via `PRAGMA user_version`
- Migration runner sets version via `PRAGMA user_version = N`
- All CREATE statements use `IF NOT EXISTS` for idempotency
- Migrations only applied if current version < migration version

### 4. Lifecycle Trigger Constraints

**Decision**: Both `activation_logs` and `policy_rules` enforce CHECK constraints on trigger types.

**Rationale**:
- Fail-fast validation at database level
- Prevents invalid trigger values from being stored
- Supported triggers: `session_start`, `before_model`, `before_tool`, `after_tool`
- Aligns with MVP lifecycle model

**Implementation**:
- CHECK constraints on trigger_kind and lifecycle_trigger columns
- Enum-like validation without separate lookup table
- Database prevents invalid states

### 5. Status Transition Model

**Decision**: Memories support four statuses: `candidate`, `active`, `stale`, `superseded`.

**Rationale**:
- Supports memory lifecycle management
- `candidate`: newly promoted, awaiting verification
- `active`: verified and ready for activation
- `stale`: no longer relevant, but kept for audit trail
- `superseded`: replaced by newer memory, linked via `supersedes_memory_id`
- Preserves history while supporting lifecycle management

**Implementation**:
- `status` column with CHECK constraint
- `supersedes_memory_id` foreign key for lineage tracking
- Stale/superseded records remain queryable for audit trail
- Activation engine filters by status

### 6. Evidence Linking

**Decision**: `evidence` table links to `memories` via foreign key with CASCADE delete.

**Rationale**:
- Enables audit trail of why memories were created/updated
- Supports four source kinds: `session`, `task`, `file`, `manual_note`
- CASCADE delete ensures referential integrity
- Traceability without bloating memory records

**Implementation**:
- Foreign key with ON DELETE CASCADE
- Separate table allows multiple evidence records per memory
- Source_kind constrains evidence origin
- Source_ref stores reference (file path, session ID, etc.)
- Excerpt stores relevant excerpt from source

### 7. Policy Rule Separation

**Decision**: `policy_rules` table separate from `memories` for enforceable rules.

**Rationale**:
- Keeps advisory memory distinct from enforcement
- Optional `memory_id` link allows rules to reference memories
- Severity levels: `info`, `warning` (no hard blocks in MVP)
- Supports future hard-block enforcement without schema changes
- Clear separation of concerns

**Implementation**:
- Separate table with own lifecycle
- Optional foreign key to memories
- Unique rule_code for rule identity
- Trigger-based activation (session_start, before_model, before_tool, after_tool)

### 8. Indexing Strategy

**Decision**: 11 indexes total across 4 tables for query optimization.

**Rationale**:
- Supports deterministic activation queries without full table scans
- Primary indexes: scope_glob, status, lifecycle_trigger, session_id
- Temporal indexes: created_at for audit queries
- Balances query performance with write overhead

**Implementation**:
- `idx_memories_scope_glob`: For scope-based memory queries
- `idx_memories_status`: For status filtering
- `idx_memories_created_at`: For temporal queries
- `idx_evidence_memory_id`: For memory lookups
- `idx_evidence_created_at`: For temporal queries
- `idx_policy_rules_scope_glob`: For scope-based rule queries
- `idx_policy_rules_trigger_kind`: For trigger-based rule queries
- `idx_policy_rules_memory_id`: For memory lookups
- `idx_activation_logs_session_id`: For session lookups
- `idx_activation_logs_created_at`: For temporal queries
- `idx_activation_logs_lifecycle_trigger`: For trigger-based queries

## Schema Compliance

### MVP Requirements Met

✅ **No vector storage tables**: Schema contains only memories, evidence, policy_rules, activation_logs
✅ **No graph tables**: No graph-specific structures
✅ **No speculative future entities**: Only MVP tables included
✅ **Migration versioning**: `PRAGMA user_version` tracks applied migrations
✅ **UUID primary IDs**: All tables use TEXT PRIMARY KEY
✅ **Content-hash dedup**: UNIQUE constraint on memories.content_hash
✅ **All data model fields**: Every field from the agreed data model is present
✅ **Lifecycle triggers**: Properly constrained in activation_logs and policy_rules
✅ **Memory status transitions**: candidate, active, stale, superseded supported
✅ **Evidence source kinds**: session, task, file, manual_note supported
✅ **Policy severity levels**: info, warning supported
✅ **Confidence/importance ranges**: 0.0-1.0 validated with CHECK constraints
✅ **Foreign key relationships**: CASCADE/SET NULL as appropriate

## Idempotency

All migrations are idempotent:
- All CREATE statements use `IF NOT EXISTS`
- Migration runner checks current version before applying
- Running migrations multiple times produces the same result
- Verified: Second run is a no-op

## Activation Budget Support

The schema supports the activation budget constraints:
- Maximum 10 memories per activation
- Maximum 8KB total payload per activation
- Tracked in activation_logs for audit trail
- Enforced at application level (not database level)

## Future Extensibility

The schema is designed for future migrations:
1. New tables can be added in migration 002, 003, etc.
2. Existing tables can be extended with new columns
3. New indexes can be added without schema changes
4. Migration versioning supports unlimited future migrations
5. Backward compatibility maintained via IF NOT EXISTS clauses

## Type Safety

TypeScript interfaces in `src/db/schema/types.ts` provide:
- Type-safe database operations
- Enum types for constrained fields
- Activation budget constants
- Memory defaults
- IDE autocomplete support

## Performance Considerations

1. **Scope Globbing**: Indexed for efficient scope-based queries
2. **Status Filtering**: Indexed for quick active/stale/superseded filtering
3. **Temporal Queries**: Indexed on created_at for audit trail queries
4. **Session Lookups**: Indexed on session_id for activation log queries
5. **Foreign Key Lookups**: Indexed on memory_id for evidence and policy rule queries

## Audit Trail

The schema preserves complete audit trail:
- `created_at` and `updated_at` on all records
- `last_verified_at` on memories for freshness tracking
- `activation_logs` tracks all memory activations and suppressions
- `evidence` links memories to their supporting sources
- `supersedes_memory_id` tracks memory lineage

## Constraints and Validation

Database-level constraints ensure data integrity:
- Type constraints on enum fields
- Range constraints on confidence/importance (0.0-1.0)
- Uniqueness constraints on content_hash and rule_code
- Foreign key constraints with CASCADE/SET NULL
- NOT NULL constraints on required fields

## Migration Infrastructure

The migration system provides:
- `bun run db:migrate --db <path>`: Apply pending migrations
- `bun run db:inspect --db <path>`: Inspect schema and data
- Automatic database initialization
- Version tracking and idempotency
- Clear error messages and logging
