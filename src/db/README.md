# `src/db` — storage layer (v0.6)

`memory.sqlite` is a sql.js database: the whole file is loaded into memory, changed, and written back
as a whole. Nothing keeps it open between calls, hooks never touch it (they read `snapshot/*`), and
every writer goes through one protocol. Spec: `docs/redesign/spec-v0.6.md` §4, §9.2, §9.4.

## Files

| File | Role |
|---|---|
| `migrations/NNN_*.sql` | Schema, tracked by `PRAGMA user_version` (001–016 are v0.5; 017–021 are the v0.6 redesign, final `user_version = 21`). |
| `migrator.ts` | `runMigrationsOnDb(db, {logger?, target?})` applies pending files on an open connection (no transaction); `runMigrations(dbPath, …)` is the lock-free CLI path with `.bak-v<from>` backup, post-migrate and atomic save. |
| `post-migrate.ts` | `runPostMigrate(db, {now})`: one-time data fix-ups after 021 (reject DreamWorker template candidates, backfill `semantic_key`, open `merge` proposals for live collisions). Idempotent via `meta.semantic_key_backfill`. |
| `locks.ts` | `acquireDirLock(lockDir, {purpose, waitMs, …})`: `mkdirSync` directory lock with `owner.json`, 5 s heartbeat, stale/dead-owner takeover, jittered wait, `LockBusyError`. |
| `store.ts` | `Store.withWriteLock(purpose, waitMs, fn)` = §9.2 steps 1–6; `Store.read(fn)` = lock-free read without migrations; `Store.rebuildSnapshot()`. Hooks (`postMigrate`, `deriveRules`, `buildSnapshot`) are injected by the composition root. |
| `db-file.ts` | Header check, atomic save (`.tmp-<pid>` → fsync → `.prev` → rename with retries), `.prev` recovery (`.corrupt-<ts>`), orphan tmp cleanup. |
| `meta.ts` | `meta` key/value helpers (`db_generation`) and the `write_ops` idempotency ledger. |
| `sql.ts` | prepare/bind/step/free helpers (`selectAll`, `selectOne`, `selectValue`, `selectCount`, `tableExists`, `quickCheck`). |
| `sqlite.ts` | `loadSqlJs()` (cached WASM runtime), plain `openSqlJsDatabase` / `saveSqlJsDatabase` for tooling. |
| `schema/types.ts` | Row interfaces. |
| `repositories/` | Table repositories (episodes, runs, proposals, provenance, transitions, meta, write-ops); owned by the data-layer module. |

## Writer protocol (`Store.withWriteLock`)

```
1 lock      acquireDirLock(locks/db.lock): owner.json {pid, hostname, purpose, started_at, heartbeat_at};
            takeover when heartbeat_at is older than 120 s or the owner pid on this host is dead;
            otherwise jittered 25–250 ms waits until waitMs → LockBusyError (CLI exit 75)
2 load      readFileSync → header "SQLite format 3\0" + PRAGMA quick_check(1);
            damaged → keep as memory.sqlite.corrupt-<ts>, restore memory.sqlite.prev
3 migrate   user_version < 21 → copy to memory.sqlite.bak-v<N> → runMigrationsOnDb → hooks.postMigrate (default runPostMigrate)
4 apply     BEGIN; op = fn(db, ctx)
            op.noop && !op.wrote → ROLLBACK, nothing saved
            op.noop && op.wrote  → quick_check, COMMIT (no derive / generation / write_ops)
            otherwise            → hooks.deriveRules, meta.db_generation += 1, INSERT write_ops(op.id), quick_check, COMMIT
            any exception        → ROLLBACK, rethrow; an op.id already in write_ops → changes rolled back, reported as noop
5 save      db.export() → memory.sqlite.tmp-<pid> → fsync → copy current → .prev → rename
            (5 attempts, 20 ms apart; EPERM/EBUSY → copy fallback + warning)
6 snapshot  hooks.buildSnapshot(db, ctx) when the file was saved (or alwaysSnapshot); finally release the lock
```

`WriteOp = {id: string | null, kind, noop, wrote}`; `WriteContext = {paths, now, generation, userVersion, logger, alreadyApplied(id)}`
where `generation` is the value this write produces. The lock is held for load → apply → save only
(seconds); LLM calls happen outside it (§9.3).

Read-only callers use `store.read(fn)`: no lock, no save, migrations are **not** applied; `ctx.userVersion`,
`ctx.migrationNeeded` and `ctx.newerThanCode` tell the caller whether to refuse. A damaged main file is read
from `.prev` in memory without touching the disk.

## Migrations

- Files run on a fresh connection **without a surrounding transaction**: 017 and 021 toggle
  `PRAGMA foreign_keys`, which is a no-op inside a transaction, and dropping `memories` with foreign keys
  ON would cascade-delete `evidence` and the dream links. Atomicity comes from in-memory application plus
  the tmp → rename save; the `.bak-v<from>` copy is the rollback point (`hm db:rollback`).
- `user_version > 21` → `DatabaseNewerThanCodeError`; nothing is changed, read paths stay usable.
- Legacy fixtures (`test/fixtures/legacy-db/`, real v0.5 installs at versions 9 and 10) are asserted to
  reach 21 with zero row loss in `test/db-migrations-legacy.test.ts`.

## Post-migrate (`runPostMigrate`)

1. `status = 'candidate'` rows linked from `legacy_dream_memory_evidence_links` (only DreamWorker candidates
   ever had links) → `rejected`, `status_reason = 'migration'`, plus a `memory_transitions` row
   (`actor = 'migration'`, reason `dreamworker_template`).
2. `semantic_key = sha256(type|scope_glob|signature_key|normalize(summary))` for live rows
   (`candidate | active | stale`). Collisions: the oldest row keeps the key, the newer stays NULL (the partial
   unique index must hold) and a `merge` proposal is opened (`created_by = 'migration'`, target = oldest,
   candidate = newer, expires in 30 days).

Raw SQL on purpose: migration code is the one place allowed to bypass `transitionMemory`.

## Testing

`test/helpers/create-test-db.ts`: `createTestDb()` (fresh, latest schema, FK on, post-migrated),
`createTestDbAtVersion(n)`, `createTestDbFromFixture(path, {migrate?, postMigrate?})`, `LEGACY_FIXTURES`.
Store tests use a temp `.harness-memory/` via `resolvePaths(tmpRoot)` and an injected clock.
