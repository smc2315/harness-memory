# Storage layer design notes

The v0.5 notes (UUID text ids, content-hash dedup, `PRAGMA user_version`, lifecycle trigger CHECKs,
evidence linking, policy-rule separation, index strategy) still describe migrations 001–016 and are kept
at the end of this file. The v0.6 redesign (migrations 017–021, `store.ts`, `locks.ts`, `post-migrate.ts`)
adds the decisions below. Spec references are to `docs/redesign/spec-v0.6.md`.

## v0.6 decisions

### 1. One writer protocol, no resident database

sql.js has no file locking and no shared connection: every process loads the whole file, changes it in
memory and writes the whole file back. v0.5 let a long-lived plugin keep its copy and overwrite everyone
else's writes (defect D1). v0.6 makes `Store.withWriteLock` the only way to write: lock → load → migrate →
apply → save → snapshot, held for seconds, never around an LLM call. Hooks never open SQLite at all; they
read `snapshot/active.v1.json`, which every writer rebuilds after its save (§9.2 step 6).

### 2. Directory lock with heartbeat and takeover

`mkdirSync` is atomic on every platform we support and needs no native module. The holder writes
`owner.json` and refreshes `heartbeat_at` every 5 s on an unref'ed timer. A contender takes over when the
heartbeat is older than 120 s (works across hosts and file shares) or when the owner is on the same host
and `kill(pid, 0)` says it is gone (fast recovery from crashes). Waits are jittered between 25 and 250 ms
so two contenders do not retry in lockstep; the deadline is `waitMs` (CLI 5 s, worker 30 s, hooks never
wait). `release()` re-reads `owner.json` and only removes the directory if it is still ours, so a holder that
was taken over cannot delete the new owner's lock.

The takeover itself must never remove or rename the lock directory: two contenders that both saw the stale
owner would `rmSync` each other's fresh directory and both believe they hold the lock (a silent lost write,
the very defect the lock exists for), and a renamed-away directory lets a third contender `mkdir` the path
while the previous holder still thinks it owns it. The takeover is therefore a compare-and-swap on
`owner.json` inside the directory: `renameSync(owner.json → owner.json.stale-<pid>-<ms>-<n>)` claims the
stale record (only one rename can win), the moved copy must equal the record the stale verdict was based
on — heartbeat included, so a holder that woke up and refreshed is left alone and the copy is moved back —
and the new owner publishes its own `owner.json` with an exclusive create (`wx`). The same exclusive create
stamps a fresh `mkdir`; a contender whose directory or record disappears under it competes again instead
of failing with ENOENT. Two more guards close the remaining sub-millisecond windows: the heartbeat never
re-stamps an `owner.json` that carries another identity, and `Store.withWriteLock` calls
`LockHandle.stillHeld()` right before the save (fencing) — a lost lock throws `LockBusyError` and nothing is
written. Stale copies left by a kill mid-takeover live inside the lock directory and vanish with it.

### 3. Save is export → tmp → fsync → `.prev` → rename

`db.export()` yields the complete database buffer. Writing it to `memory.sqlite.tmp-<pid>`, fsyncing, and
renaming over the live file means a crash leaves either the old or the new file, never a torn one. The
previous file is copied to `.prev` right before the rename, which is what `recoverFromPrev` restores when the
main file fails the header or `quick_check`; the damaged file is kept as `.corrupt-<ts>` for `hm doctor`.
Windows can refuse the rename while an antivirus or indexer holds the file (EPERM/EBUSY): five attempts
20 ms apart, then a copy fallback with a warning. Orphan `*.tmp-<pid>` files older than ten minutes are removed
at the start of every write (and by `worker dream`) from every directory whose writers use tmp + rename:
next to the database, `snapshot/`, `queue/`, `state/` and `raw/` (hooks, worker import, idle sweep, notify
and the provider cache all leave `<file>.tmp-<pid>` behind when killed between write and rename).

`export()` closes and reopens sql.js' internal connection: prepared statements die and connection PRAGMAs
reset (`foreign_keys` back to OFF). The store re-enables foreign keys after saving and documents that
callbacks must not keep statements across the save.

### 4. Migrations run outside any transaction, with a backup

017 rebuilds `memories` (`DROP TABLE` + rename) and must run with `PRAGMA foreign_keys = OFF`, which SQLite
ignores inside a transaction; with foreign keys on, the drop would cascade through `evidence` and the dream
links. So `runMigrationsOnDb` applies files on an open connection with no surrounding transaction and relies
on in-memory application plus the atomic save for atomicity; the file copy `memory.sqlite.bak-v<from>` taken
before the first pending file is the rollback point (`hm db:rollback`). A database whose `user_version` is
above what the build knows throws `DatabaseNewerThanCodeError` before anything is touched; readers still
work and report `newerThanCode`.

### 5. Idempotent writes: `write_ops` and `db_generation`

Workers are retried (lease expiry, crashes, the same queue file processed twice), so every write names an
operation id (`run id`, `decision:<proposal>:<at>`, `import:<sha>`, `dream:<started_at>`). The store refuses to
apply the same id twice: a callback can ask `ctx.alreadyApplied(id)` and return a noop; if it does not, the
store rolls its changes back and reports `alreadyApplied`. A noop without writes skips the save entirely
(the file's bytes and mtime do not change), so retries are free. `meta.db_generation` increases exactly once
per real write and is copied into the snapshot, which lets `doctor` compare the snapshot with the database.

### 6. Post-migrate data fix-ups are plain SQL

`post-migrate.ts` runs once (guarded by `meta.semantic_key_backfill`) in the same writer session as the
schema upgrade. It is the one place allowed to change `memories.status` without `transitionMemory`: the
transition module lives above `src/db` and the store must not depend on it. The fix-ups are ordered so that
DreamWorker template candidates are rejected before semantic keys are assigned; otherwise a template could
own a key or trigger a spurious merge proposal. Collisions keep the oldest row's key because the oldest row is
the one other rows' `supersedes_memory_id` and evidence most likely point at.

### 7. Hooks are injected

`StoreHooks` (`postMigrate`, `deriveRules`, `buildSnapshot`) are passed in by the composition root (worker
entry, CLI). `src/db` therefore depends only on `src/core`; policy derivation (`src/policy/derive.ts`) and
the snapshot builder (`src/db/snapshot.ts`) can import repositories and activation code freely without
creating a cycle. `postMigrate` defaults to `runPostMigrate` because it lives in this directory and forgetting
it would leave `semantic_key` NULL on every upgraded row; passing `null` disables it.

---

## v0.5 notes (migrations 001–016)

### UUID primary ids via TEXT

All tables use `TEXT PRIMARY KEY` for UUID identifiers: deterministic, collision-free ids without a central
sequence, portable exports, no dependency on auto-increment behaviour. Memory ids are derived from the
content hash (`createMemoryId`).

### Content-hash deduplication

`memories.content_hash` (SHA-256 of summary + details) detects exact duplicates without semantic matching.
007 added `identity_key` (type + content + scope + triggers); 017 narrows its uniqueness to live rows via the
partial index `ux_memories_identity_live`, because a superseded row and its replacement share the key.

### Migration versioning

`PRAGMA user_version` tracks the applied migration level; files are named `NNN_description.sql` and applied
when `NNN > user_version`. `CREATE … IF NOT EXISTS` keeps them idempotent.

### Lifecycle trigger constraints

`activation_logs.lifecycle_trigger` and `policy_rules.trigger_kind` are CHECK-constrained to
`session_start | before_model | before_tool | after_tool`.

### Status model

`candidate → active → stale | superseded`, plus `rejected` (004). v0.6 adds `status_reason`,
`superseded_by_memory_id` and moves every transition behind `transitionMemory` (§4.7).

### Evidence, policy rules, indexes

`evidence` links memories to their sources with `ON DELETE CASCADE`; `policy_rules` keeps enforceable rules
separate from advisory memories (020 adds tool/target/signature matching and `enforcement`); indexes cover
scope, status, timestamps and foreign keys so activation queries never scan whole tables.
