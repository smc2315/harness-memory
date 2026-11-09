# Upgrading from harness-memory 0.5 to 0.6

For anyone with an existing `.harness-memory/memory.sqlite` written by 0.3–0.5 (the OpenCode plugin). The upgrade keeps every memory row; what changes is the host, the write path and the authority model. Read this once before running `hm install --host claude` in a project that already has a `.harness-memory/` directory.

## TL;DR

| | 0.5.x | 0.6.0 |
|---|---|---|
| Host | OpenCode plugin (`opencode.json` → `harness-memory/plugin`) | Claude Code hooks (`.claude/settings.local.json`); Codex in 0.6.1, OpenCode V2 in 0.6.2 |
| Capture | conversation buffer flushed every 5 lines into `evidence` rows per tool call | append-only ledger per session; the turn segment is the episode and the queue |
| Extraction | `dream:extract` once per process lifetime through the OpenCode SDK | detached worker per closed episode through your own `claude -p` (or `codex exec`) |
| Candidates | `DreamWorker` template candidates + LLM candidates, all `**/*` + `before_model` | validated facts with scope, triggers and a trigger signature; no templates |
| Promotion | 5-gate auto-promoter + `memory:review` | `authority` (human / auto), `decideTier`, proposals, `hm review` |
| `before_tool` | scope glob only; warnings arrived with the tool result | tool + argument signature; `permissionDecision ask / deny` before execution |
| Database | `user_version` 9–16 | `user_version` 22 (migrations 017–022), backups `memory.sqlite.bak-v<N>` |
| Embeddings | installed by default | optional (`hm install --with-embeddings`), idle-exit helper |

## Before you upgrade

1. **Back up** `.harness-memory/memory.sqlite` (the migrator also copies it to `memory.sqlite.bak-v<N>`, where `<N>` is the schema version it found — 9, 10 or 16 on real installs).
2. **Decide on the host.** 0.6.0 supports Claude Code only. If you work in OpenCode, stay on 0.5.1 until 0.6.2 — the two versions must not write the same database (0.6 migrates it to a schema 0.5 cannot open).
3. **Log in the extraction CLI (for learning).** `claude auth login` in a terminal (older CLIs: `claude`, then `/login`). The desktop app's login does not carry over to `claude -p`. Without it the hooks still enforce every migrated, imported and hand-added rule; new episodes queue up and `hm status` shows `probe not_logged_in` / `queue N (waiting: not_logged_in)` until you log in — nothing is lost, and `hm install --host claude` re-probes at once afterwards.

## Upgrade steps (Claude Code)

```bash
# 0.6.0-rc.1 is a GitHub pre-release, not on npm yet: plain `npm install -g harness-memory` still installs 0.5.1
npm install -g https://github.com/smc2315/harness-memory/releases/download/v0.6.0-rc.1/harness-memory-0.6.0-rc.1.tgz
#   (once published: npm install -g harness-memory@next; or update the project devDependency the same way)
cd <project>
hm install --host claude                   # migrates memory.sqlite → v22 (backup first), builds the snapshot, registers 9 hooks
hm doctor                                  # every check OK / WARN / FAIL
hm review                                  # fix_scope proposals for legacy rows, merge proposals for duplicates
```

Then remove the v0.5 plumbing by hand — the 0.6 CLI does not touch OpenCode files:

- the `"plugin": ["harness-memory/plugin"]` entry in `opencode.json`;
- the `harness-memory` dependency 0.5.1 added to `.opencode/package.json`;
- the slash commands under `.opencode/commands/harness-memory-*.md`.

The legacy state files `.harness-memory/.conversation-buffer.json` and `.harness-memory/.dream-extract-state.json` are left in place (they are inert) and removed only by `hm uninstall --purge`.

Optional but recommended: `hm import --from CLAUDE.md`. v0.5's `install` imported `CLAUDE.md` bullets as global baseline policies without signatures; the 0.6 importer runs the extractor on each bullet, so rules that name a command or a path get a trigger signature and fire at `PreToolUse`. A confirmed import supersedes a legacy row whose normalized summary matches (Jaccard ≥ 0.8) with `status_reason = import:upgraded`; `--yes` only opens `supersede` proposals.

## What the migrations do

All six files run on a fresh connection without a surrounding transaction (017 and 021 toggle `PRAGMA foreign_keys`); atomicity comes from applying them in memory and saving via tmp + rename. `PRAGMA user_version` is set after each file; a database already at 22 is untouched, and a database newer than 22 makes the CLI refuse with "upgrade harness-memory".

| # | file | effect |
|---|---|---|
| 017 | `017_memories_authority.sql` | Rebuilds `memories`: the 23 v0.5 columns are copied; adds `semantic_key`, `trigger_signature_json`, `signature_key`, `knowledge_kind`, `failure_classes_json`, `status_reason`, `superseded_by_memory_id`, `source_ref`, `revalidate_after`, `last_fired_at`, `open_proposal_id`, **`authority`** (NOT NULL, no default), `enforcement` (default `advise`), `source_kind`, `evidence_score`, `evidence_count`, `distinct_session_count`, `fire_count`, `override_count`, `contested`, `needs_scope`, `import_unconfirmed`, `aliases_json`. `identity_key` loses its table-wide UNIQUE in favour of partial unique indexes over live statuses (`candidate`, `active`, `stale`). **Authority rule:** `promotion_source = 'auto' OR status = 'candidate'` → `auto`, otherwise `human` (`knowledge_kind = 'manual'`). Rows written by the v0.5 `install` bullet import (`type = policy`, `scope_glob = '**'`, `activation_class = baseline`) become `source_kind = import`, `source_ref = import:legacy`. v0.5 LLM rows (`scope_glob` `**` / `**/*`, `lifecycle_triggers = ["before_model"]`, not baseline, live) become `source_kind = legacy`, `needs_scope = 1`. |
| 018 | `018_episodes_runs.sql` | Creates `episodes` (the queue: host, session, turn key, segment, ledger byte range, scope refs, tools, failure signatures, flags, fired list, `evidence_weight`, status `queued | leased | extracted | skipped | failed | dead`), `extraction_runs` (provider, model, prompt hash, status, per-fact outcomes), `write_ops` (idempotency ledger) and `meta` (`db_generation`, probe cache, `installed_version`, …). |
| 019 | `019_proposals_provenance.sql` | Creates `proposals` (eight kinds, one open per (kind, target, candidate)), `proposal_support`, `memory_provenance` (memory ↔ episode ↔ cited line, relation `origin | reinforce | contradict | import`, confidence) and `memory_transitions` (every status change with actor and reason). Opens one `fix_scope` proposal (90 days) per row 017 flagged `needs_scope = 1`. |
| 020 | `020_policy_rules_v2.sql` | Adds `tool_pattern`, `target_kind`, `pattern_kind`, `arg_pattern`, `enforcement`, `derived_at` to `policy_rules`. Rules with `derived_at` set are rewritten from active policy memories on every commit; your manual rules (`derived_at IS NULL`) are preserved. |
| 021 | `021_legacy_archive.sql` | Renames `dream_evidence_events`, `dream_runs`, `dream_memory_evidence_links` to `legacy_*`; marks unconsumed legacy evidence `discarded` (it is **not** re-extracted — those blobs have no tool set or scope refs, and re-extraction would burn a day of LLM budget for nothing); drops the never-populated `topic_summaries`. The `evidence` table stays for manual notes. |
| 022 | `022_episode_summaries.sql` | Adds `summary` (one line, ≤ 400 chars) and `summary_kind` (`extracted` = the extractor's `episode_summary`, `derived` = the worker's deterministic summary built from the descriptor and ledger lines) to `episodes` for the recall layer (`recall.enabled`, off by default). No backfill: episodes closed before the upgrade keep `NULL` and are invisible to `hm recall` until re-queued. |

**Post-migrate** (same lock session, idempotent through `meta.semantic_key_backfill`): (1) v0.5 `DreamWorker` template candidates — `status = 'candidate'` rows linked from `legacy_dream_memory_evidence_links` — are `rejected` with `status_reason = migration` and a `memory_transitions` row; (2) every live row gets a `semantic_key` (`sha256(type | scope | signature | normalized summary)`); when two live rows collide, the oldest keeps the key and a `merge` proposal (30 days) is opened for the pair.

On the author's real v0.5 databases: v9 (13 memories, 142 evidence rows, 75 legacy events) and v10 (1 memory) migrate with all rows preserved, 12 human active + 1 auto candidate in v9, and one `fix_scope` proposal per `needs_scope` row.

## What you will notice afterwards

- **Authority.** Every active row you promoted in 0.5 is `human`: no TTL, never demoted automatically, trust multiplier 1.0. Rows that were auto-promoted by the 0.4/0.5 auto-promoter are `auto` and now carry a TTL; reinforcement by new episodes extends it, expiry opens a `revalidate` proposal (correction / failure knowledge) or stales the row (conventions). A human candidate misfiled as `auto` is one `hm memory:promote <id>` away from `human`.
- **Legacy LLM rows** (`needs_scope = 1`) stay active but appear in `hm review` with a `fix_scope` proposal: accepting needs a scope / triggers / signature payload and 0.6.0 ships no editor that collects one, so `hm proposals:accept` refuses with `payload_missing` and changes nothing; rejecting hides the proposal for 30 days; after 90 days it expires and the row keeps working as a `before_model` memory. To give such a row a signature today, add a new row with `hm memory:add … --active` and reject the old proposal.
- **Template candidates** ("Pitfall around route.ts (pitfall:…:enoent)") are gone from review — rejected by the migration, still visible in `hm memory:history <id>`.
- **Nothing is injected into the system prompt** any more: no review digest, no session summaries. Startup injects only rows with `session_start` in their triggers (baseline / decision / architecture_constraint / workflow), capped at 5 items / 3 KB. The daily `systemMessage` digest is one line and goes to you, not to the model.
- **`hm memory:history <id>`** reads the v0.5 dream history from the `legacy_*` tables during 0.6.x; the tables are dropped in 0.7.
- `~/.harness-memory/global.sqlite` (the 0.3+ global tier) is untouched and not read by the hooks; global sync returns in 0.7.

## Old command → new command

| 0.5 | 0.6 |
|---|---|
| `npx harness-memory install` / `init` | `hm install --host claude` (`hm import --from CLAUDE.md` for the bullet import that `install` used to do) |
| `memory:review` | `hm review` |
| `memory:promote --all --min-confidence X`, `memory:reject --all --max-confidence Y` | `hm review`, `hm proposals:accept --kind <kind> --all`, `hm memory:promote <id>` / `hm memory:reject <id>` |
| `memory:promote --memory <id>` / `memory:reject --memory <id>` | `hm memory:promote <id>` / `hm memory:reject <id>` |
| `memory:add --type <t> --summary "..."` | `hm memory:add --type <t> --summary <text> [--scope <glob>]` |
| `memory:list`, `memory:stats`, `memory:why` | `hm memory:list`, `hm memory:stats [--since <iso>]`, `hm memory:why --tool <name> --target <text>` |
| `memory:health-check` | `hm status`, `hm doctor` |
| `dream:run` | `hm dream` (consolidation only — it no longer creates candidates) |
| `dream:extract` | `hm extract [--now]` (the hooks run it automatically after every eligible turn) |
| `dream:evidence:list`, `dream:runs:list` | `hm queue`, `hm trace <session_key>`, `hm memory:trace <id>`, `hm memory:history <id>` |
| `eval:baseline`, `eval:memory` | `hm eval:replay`, `hm eval:latency` |
| slash commands `/harness-memory-*` | none (OpenCode support returns in 0.6.2) |

## Rolling back

`hm db:rollback [--to <N>] [--yes]` restores `memory.sqlite.bak-v<N>` (newest by default), keeps the replaced file as `memory.sqlite.rollback-<ts>`, removes `memory.sqlite.prev` (it holds the newer schema) and the snapshot files. **The next writer — a hook-spawned worker or any CLI write — migrates the restored file forward again**, so to really go back to 0.5:

1. close every Claude Code session in the project;
2. `hm uninstall` (removes the hooks and the manifest, keeps `.harness-memory/`);
3. `hm db:rollback --yes` while the 0.6 CLI is still installed;
4. `npm install -g harness-memory@0.5.1` and restore the `opencode.json` plugin entry.

`hm uninstall --purge` keeps the `memory.sqlite.bak-v<N>` files for the same reason.

## Known gaps in 0.6.0-rc.1

- Live `claude -p` extraction has run in two synthetic sessions only (six calls on the `sonnet` alias; see docs/redesign/phase-e-notes.md); the replay provider covers the tests and the dogfood weeks have not started. The first live probe failed with `api 404` because the interactive default model was a gateway id — the claude provider now passes `--model sonnet` unless `extraction.model` is set, and such failures show as `probe provider_error` with the API message. Report any probe result other than `ok` / `not_logged_in` with `hm doctor --json`.
- Exec-form hooks are written when `claude --version` ≥ 2.1.139 or unknown; the minimum is inferred from release mirrors. If Claude Code reports hook errors on every call, re-run `hm install --host claude --hook-form shell`.
- `fix_scope` proposals carry their payload (scope, triggers, signature) in the proposal rationale; the interactive editor for it is part of `hm review` (Phase C).
