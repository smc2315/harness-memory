# SQLite Schema and Migration Infrastructure

## Overview

This directory contains the SQLite schema definition and migration infrastructure for the Project Memory Layer MVP.

## Schema Design

### Core Principles

1. **UUID Primary IDs**: All tables use TEXT PRIMARY KEY for UUID identifiers
2. **Content-Hash Deduplication**: `memories` table enforces UNIQUE constraint on `content_hash`
3. **Idempotent Migrations**: All CREATE statements use `IF NOT EXISTS` clause
4. **Version Tracking**: `PRAGMA user_version` tracks the current schema migration level
5. **Foreign Key Relationships**: Proper cascading deletes and referential integrity

### Tables

#### `memories` (Core Memory Storage)
- `id` (TEXT PRIMARY KEY): UUID identifier
- `content_hash` (TEXT NOT NULL UNIQUE): SHA256 hash for deduplication
- `type` (TEXT NOT NULL): One of `policy`, `workflow`, `pitfall`, `architecture_constraint`, `decision`
- `summary` (TEXT NOT NULL): Brief summary of the memory
- `details` (TEXT NOT NULL): Full details/content
- `scope_glob` (TEXT NOT NULL): Glob pattern for scope matching (e.g., `src/**/*.ts`)
- `lifecycle_triggers` (TEXT NOT NULL): JSON array of trigger types
- `confidence` (REAL NOT NULL): 0.0-1.0 confidence score
- `importance` (REAL NOT NULL): 0.0-1.0 importance score
- `status` (TEXT NOT NULL): One of `candidate`, `active`, `stale`, `superseded`
- `supersedes_memory_id` (TEXT): Optional reference to superseded memory
- `created_at` (TEXT NOT NULL): ISO 8601 creation timestamp
- `updated_at` (TEXT NOT NULL): ISO 8601 last update timestamp
- `last_verified_at` (TEXT): ISO 8601 last verification timestamp

**Indexes**:
- `idx_memories_scope_glob`: For scope-based queries
- `idx_memories_status`: For status filtering
- `idx_memories_created_at`: For temporal queries

#### `evidence` (Supporting Evidence)
- `id` (TEXT PRIMARY KEY): UUID identifier
- `memory_id` (TEXT NOT NULL): Foreign key to memories
- `source_kind` (TEXT NOT NULL): One of `session`, `task`, `file`, `manual_note`
- `source_ref` (TEXT NOT NULL): Reference to source (e.g., file path, session ID)
- `excerpt` (TEXT NOT NULL): Relevant excerpt from source
- `created_at` (TEXT NOT NULL): ISO 8601 creation timestamp

**Indexes**:
- `idx_evidence_memory_id`: For memory lookups
- `idx_evidence_created_at`: For temporal queries

#### `policy_rules` (Enforceable Rules)
- `id` (TEXT PRIMARY KEY): UUID identifier
- `memory_id` (TEXT): Optional foreign key to memories
- `rule_code` (TEXT NOT NULL UNIQUE): Unique rule identifier
- `severity` (TEXT NOT NULL): One of `info`, `warning`
- `trigger_kind` (TEXT NOT NULL): One of `session_start`, `before_model`, `before_tool`, `after_tool`
- `scope_glob` (TEXT NOT NULL): Glob pattern for scope matching
- `message` (TEXT NOT NULL): Rule message/description
- `created_at` (TEXT NOT NULL): ISO 8601 creation timestamp
- `updated_at` (TEXT NOT NULL): ISO 8601 last update timestamp

**Indexes**:
- `idx_policy_rules_scope_glob`: For scope-based queries
- `idx_policy_rules_trigger_kind`: For trigger-based queries
- `idx_policy_rules_memory_id`: For memory lookups

#### `activation_logs` (Audit Trail)
- `id` (TEXT PRIMARY KEY): UUID identifier
- `session_id` (TEXT NOT NULL): Session identifier
- `lifecycle_trigger` (TEXT NOT NULL): One of `session_start`, `before_model`, `before_tool`, `after_tool`
- `scope_ref` (TEXT NOT NULL): Scope reference (e.g., file path)
- `activated_memory_ids` (TEXT NOT NULL): JSON array of activated memory IDs
- `suppressed_memory_ids` (TEXT NOT NULL): JSON array of suppressed memory IDs
- `reason` (TEXT NOT NULL): Reason for activation/suppression
- `created_at` (TEXT NOT NULL): ISO 8601 creation timestamp

**Indexes**:
- `idx_activation_logs_session_id`: For session lookups
- `idx_activation_logs_created_at`: For temporal queries
- `idx_activation_logs_lifecycle_trigger`: For trigger-based queries

## Migration Strategy

### Version Tracking

Migrations are tracked using SQLite's built-in `PRAGMA user_version` integer. Each migration file is named `NNN_description.sql` where `NNN` is the version number.

### Idempotency

All migrations are idempotent:
- All CREATE statements use `IF NOT EXISTS`
- Migrations are only applied if the current version is less than the migration version
- Running migrations multiple times produces the same result

### Current Migrations

**Migration 001**: Initial schema
- Creates all four MVP tables
- Creates all indexes
- Establishes foreign key relationships
- Sets `PRAGMA user_version` to the applied migration version

## Usage

### Running Migrations

```bash
bun run db:migrate --db path/to/database.sqlite
```

### Inspecting Database

```bash
bun run db:inspect --db path/to/database.sqlite
```

## Design Notes

### Content-Hash Deduplication

The `memories` table uses a UNIQUE constraint on `content_hash` to prevent duplicate memories with identical content. This allows:
- Efficient deduplication during memory insertion
- Automatic conflict detection
- Supersession tracking via `supersedes_memory_id`

### Scope Globbing

The `scope_glob` field uses glob patterns (e.g., `src/**/*.ts`, `docs/**/*.md`) to match files and scopes. This enables:
- Efficient scope-based memory activation
- Flexible scope matching without regex complexity
- Clear, human-readable scope definitions

### Lifecycle Triggers

Memories and rules are activated at specific lifecycle points:
- `session_start`: At the beginning of a session
- `before_model`: Before calling the model
- `before_tool`: Before using a tool
- `after_tool`: After tool execution

### Budget Constraints

The activation system enforces:
- Maximum 10 memories per activation
- Maximum 8KB total payload per activation
- Tracked in `activation_logs` for audit trail

## Future Migrations

Future migrations should:
1. Follow the naming convention `NNN_description.sql`
2. Use `IF NOT EXISTS` for all CREATE statements
3. Include comments explaining the changes
4. Be tested for idempotency
5. Update this README with schema changes
