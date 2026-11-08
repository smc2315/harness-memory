# Changelog

All notable changes to `harness-memory`. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the project uses [Semantic Versioning](https://semver.org/) (0.x: minor versions may break).

## 0.6.0-rc.1 — 2026-11-08

Release candidate of the v0.6 redesign (branch `redesign/v0.6`). Design: [docs/redesign/spec-v0.6.md](docs/redesign/spec-v0.6.md); build plan: [docs/redesign/implementation-plan.md](docs/redesign/implementation-plan.md); upgrade notes: [docs/redesign/upgrade-from-0.5.md](docs/redesign/upgrade-from-0.5.md).

### Highlights

- **Claude Code is the first host.** harness-memory now runs as nine Claude Code hooks (`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `Stop`, `StopFailure`, `PreCompact`, `SessionEnd`) — short-lived `node dist/hook.js <event>` processes that read one precomputed snapshot and never open SQLite. Codex follows in 0.6.1, OpenCode (V2 plugin) in 0.6.2.
- **Enforcement at the tool boundary.** Every memory carries `enforcement ∈ {advise, confirm, soft_deny, deny}`; `PreToolUse` maps it to `additionalContext`, `permissionDecision: "ask"` or `"deny"`. A `soft_deny` blocks only the first attempt of a `(memory, tool)` pair per turn; the retry passes and the override is recorded.
- **One write path.** Per-session append-only ledger → turn segments as episodes (the queue) → structured extraction through your own headless CLI (`claude -p --json-schema`, `codex exec --output-schema`) → validation V1–V11 → deterministic, idempotent reconcile → authority-tiered activation → snapshot.
- **Authority as an invariant.** `authority ∈ {human, auto}` is a NOT NULL column without a default; `transitionMemory` is the only status writer and throws `AuthorityViolationError` when the automatic path touches a human row. Pitfalls and workflows learned from one correction or one failure → resolution pair activate on their own (`authority = auto`, TTL 30 / 7 days, trust multiplier 0.65 → 0.95); policies, global rows and every demotion of a human row go through proposals and `hm review`.
- **Optional dense retrieval without a daemon.** An idle-exit embedding helper (named pipe / Unix socket, exits after 15 idle minutes) serves `before_model`; `PreToolUse` stays snapshot-only. Extractor-provided `aliases` (including Korean) are indexed lexically so non-English prompts reach memories without embeddings.
- **Operability.** `hm status` (one line), `hm doctor [--fix] [--self-test] [--host-debug]`, `logs/hooks.log` with one line per hook call and p95, `install-manifest.json`, `db:rollback`, `snapshot:rebuild`.

### Added

- Runtime bundles `dist/hook.js` (launcher with `module.enableCompileCache`), `dist/hook-bundle.js`, `dist/worker.js` (`extract | dream | reindex | import`), `dist/embed-helper.js`; CLI `dist/bin/harness-memory.js` with the `hm` alias.
- `src/core`: shared vocabularies (hosts, hook events, authorities, enforcements, knowledge kinds, proposal kinds, canonical tool families, failure classes), ledger / episode / extraction / snapshot / hook contracts, `config.v1` schema with tolerant loader, path layout, deterministic ids, error types, `providerEnv()` allowlist and `spawnDetached`.
- Store with `mkdir`-based locks and heartbeats (`locks/db.lock`, `locks/worker.lock`), lock takeover for stale holders, atomic save (`.tmp-<pid>` → fsync → `.prev` → rename), `.prev` recovery for damaged files, `write_ops` idempotency, `db_generation`, migrate-on-write.
- Migrations 017–021 (`user_version = 21`): `memories` rebuilt with authority / enforcement / trigger signatures / derived counters / aliases; `episodes`, `extraction_runs`, `write_ops`, `meta`; `proposals`, `proposal_support`, `memory_provenance`, `memory_transitions`; `policy_rules` tool / signature / enforcement columns; v0.5 dream tables archived as `legacy_*`. Post-migrate backfills `semantic_key`, opens `merge` proposals for colliding live rows and rejects v0.5 template candidates. Verified against real v0.5 databases at `user_version` 9 and 10 with zero row loss.
- Repositories for episodes, extraction runs, proposals, provenance, transitions, meta and write ops; `MemoryRecord` gains the v0.6 columns; focused mutators (`recordFire`, `setEnforcement`, `setScope`, `setAuthority`, `setFlags`, `setTtl`, `setAliases`).
- Pure write-path modules: command canonicalization (`npm|pnpm|yarn|bun [run] <script>` → `pm <script>`, `npx|pnpm dlx|bunx <bin>` → `bin <bin>`, PowerShell and bash dialects), signature compilation with regex safety (V5) and specificity (V10) checks, canonical tool vocabulary and scope-ref extraction, ledger serialization / parsing / tail state, episode descriptors with evidence weights (correction 2, remember 3, resolution 2, failure 1) and override / heed outcomes, extraction prompt and validator, `enforcementDefault` and `decideTier`.
- Worker pipeline: providers `claude`, `codex`, `replay` with a daily probe (`ok | not_logged_in | missing | nested_refusal | probe_timeout | invalid_output`), raw output cache, two short lock sessions around the LLM call, lease / retry / dead handling, reconcile with per-fact savepoints and derived counters, proposals (open / support / decide / auto-demotion with the 2-session rule / expiry), consolidation (`dream`: TTL, candidate and proposal expiry, fire-based TTL extension, override downgrade, merge and fix-signature proposals, embedding backfill, idle-turn sweep, GC), snapshot builder (`active.v1.json`, `lexical.v1.json`, `dense.v1.bin`), policy rule derivation on every commit, legacy history reader.
- Hook hot path: snapshot reader with staleness detection and throttled reindex, `decideBeforeTool` (signature match, scope, ranking, quotas, budgets, once-per-turn soft deny, non-interactive downgrade), `before_model` (scope ∧ BM25 or dense, RRF fusion), `session_start` selection and daily digest, `after_tool` failure hints, Claude Code adapter (`PowerShell` → `bash` with dialect, `mcp__s__t` → `mcp:s/t`, `Exit code N` parsing), hook I/O with 5 MB × 3 log rotation and `HARNESS_MEMORY_DEBUG=1`, recursion guards.
- Embedding helper over a named pipe / socket with lazy `@xenova/transformers`, idle exit, pid file, client with 60 s spawn throttle; worker-side embedding of new rows (`passage:` prefix).
- CLI core: `install --host claude [--user] [--with-embeddings] [--hook-form] [--hook-script] [--skip-probe] [--skip-self-test]` (exec-form hooks with the absolute node path, idempotent settings merge, `.git/info/exclude`, manifest, probe, self-test), `uninstall [--purge] [--user]`, `doctor`, `status`, `db:migrate`, `db:rollback [--to] [--yes]`, `snapshot:rebuild`; the 33 commands of the spec are registered so unimplemented ones explain themselves and exit 2.
- Documentation: README rewritten for v0.6 (English and Korean), this changelog, upgrade notes, banners on the v0.5 pages under `docs/product/` and `docs/spec/`.

### Changed

- `MemoryRepository.create()` requires `authority` and `sourceKind`; duplicate detection considers live rows only (`candidate`, `active`, `stale`) and `reviveTerminal` re-creates a fact whose earlier rows are terminal; `update()` rejects `status` and `authority`.
- `revalidateMemory` rewritten: gated on `authority = 'auto'`, `ttlDays(v) = min(90, 7·2^v)`, TTL never shrinks on reinforcement, 14-day extension on fire.
- ActivationEngine (minimal diff): `MemoryReader` type, lazy lexical rebuild, `session_start` trigger filter for startup rows, trust multiplier from `authority` / `validation_count`, `signature_mismatch` suppression kind.
- PolicyEngine matches tool pattern and argument signature, not scope alone; rules are derived from active policy memories on every writer commit.
- Injection budgets per trigger: `session_start` 5 / 3 KB, `before_model` 5 / 3 KB, `before_tool` 3 / 2 KB, `after_tool` 2 / 1 KB.
- `@xenova/transformers` is an optional peer dependency installed by `hm install --with-embeddings`; embeddings are off by default.
- Package version 0.6.0-rc.1; `bin` gains `hm`; `description` / `keywords` describe the Claude Code hooks.

### Removed

- The OpenCode plugin (`src/plugin/**`), the OpenCode adapter and test harness, `@opencode-ai/sdk`, the `opencode` package field and slash commands.
- `DreamWorker` template candidates, `ConversationBuffer`, the conversation-batch evidence path, `llm-extract.ts`, `auto-promoter.ts`, `summary-generator.ts` and the never-populated `topic_summaries` table, the review digest injected into the system prompt, per-tool-call `evidence` rows.
- CLI commands `init`, `memory:review`, `memory:health-check`, `dream:run`, `dream:extract`, `dream:evidence:list`, `dream:runs:list`, `eval:baseline`, `eval:memory` (replacements in [docs/redesign/upgrade-from-0.5.md](docs/redesign/upgrade-from-0.5.md)).
- Roughly 150 tests tied to the deleted modules (dream-worker, e2e-pipeline, opencode-adapter, consolidation, benchmark suites); the regression floor (activation engine and fusion, memory core, migrator, policy engine, scanner) stays green.

### Fixed (v0.5 defects, see `docs/redesign/core-review-v0.5.md`)

- R1 — LLM candidates could never be promoted (evidence count always 0): provenance rows and derived counters are written in the same savepoint as the row, and `decideTier` reads them.
- R2 — LLM memories were hard-coded to `**/*` + `before_model` and never reached `before_tool`: scope, triggers and trigger signatures are required schema fields; legacy rows are flagged `needs_scope` with `fix_scope` proposals.
- R3 — extraction ran at most once per process lifetime: every closed episode is queued and a detached worker drains the queue.
- R4 — an LLM `supersede` / `stale` demoted human memories without review: the LLM can only propose; `transitionMemory` refuses automatic actors on human rows.
- R5 — a duplicate fact threw and the batch retried forever: live-only duplicate detection, reinforce instead of throw, per-fact savepoints, `write_ops` idempotency, dead after three attempts.
- R6 — template-text candidates: regexes only set flags; no candidate is synthesized without the extractor.
- R7 — two write paths consuming each other's inputs: one input stream (ledger → episodes) and one consumer (`worker extract`).
- D1–D7 — resident database overwrites, mem0-style prompt without scope / tools / triggers, 300 / 4,000-char truncation and mis-attributed sessions, reinforcement without revalidation, scope-only policy engine without a rule writer, review inbox in the system prompt, 2 KB evidence per tool call.

### Known limitations (0.6.0-rc.1)

- Live `claude -p` extraction was not exercised on the development machine (its standalone CLI is not logged in); the replay provider covers the tests and the `not_logged_in` path is verified end to end.
- The exec-form hook minimum (Claude Code 2.1.139) is inferred from release notes; `--hook-form shell` is the escape hatch.
- The worker-pid recursion guard is a no-op on Windows (the environment guard `HARNESS_MEMORY_DISABLE=1` covers nested calls on every platform).
- The 80 ms dense budget may be too short for a cold helper; `before_model` then degrades to lexical-only for that turn.
- `eval:live` (the live three-arm evaluation) is registered but not implemented in this build; every other command runs.
- `hm eval:latency` measures p95 ≈ 90–96 ms on the development machine (Windows 11, Node 24, `node -e 0` ≈ 50 ms when loaded); the 90 ms gate is marginal on that class of machine and the dominant cost is Node start-up, not the hook.

## 0.5.1 — 2026-04-09

- `install` adds `harness-memory` to `.opencode/package.json` and runs `npm install`.

## 0.4.2 — 2026-04-09

- `.gitignore` encoding fix and temp directory ignores.

## 0.4.1 — 2026-04-03 (published as part of the 0.4.x line)

- Hybrid retrieval (dense ∪ MiniSearch BM25 → RRF), dual summary / details embeddings, English-only storage in extraction prompts, Tier 2 benchmarks.
- Then (2026-04-06, pre-0.5): session summaries and hierarchical query routing, four-mode activation (`startup`, `default`, `temporal`, `cross_session`), dream evidence retention schema, shadow validation logging, file-based activation audit logger, `memory:health-check`, stress benchmarks, README rewrite with a Korean version.

## 0.4.0 — 2026-04-02

- Conditional auto-promotion (B+ model: five gates, trust multiplier, 14-day TTL, contradiction demotion, `memory:demote`), security scanner, `relevant_tools`, progressive disclosure.

## 0.3.1 — 2026-04-02

- Two-tier memory (global + project), MIT license file, comparison table fixes.

## 0.3.0 — 2026-04-02

- Vector search, LLM extraction, benchmark suite, OpenCode plugin overhaul.

## Earlier (2026-03-28 … 03-30)

- Initial publish of the `harness-memory` package: OpenCode plugin, dream workflow, deterministic evidence and review flows, migrations 001–016.
