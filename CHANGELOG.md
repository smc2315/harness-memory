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

### Fixed (Phase D adversarial review)

Five review dimensions (write path, hook hot path, concurrency and crash safety, security, cross-module consistency) produced 47 findings; 34 survived two independent refutation passes each and were fixed by area, every fix with a test (`docs/redesign/phase-d-notes.md`).

- **Redaction and scanning.** `redactCredentials` now catches env-var style keys (`DB_PASSWORD=`, `AWS_SECRET_ACCESS_KEY=`, `$env:DB_PASSWORD =`), quoted JSON / YAML keys, camelCase keys (`accessToken`), credentials in a URL of any scheme, `Authorization: Basic`, `curl -u`, `--password`, `mysql -p…`, Stripe / GitHub fine-grained / GitLab / npm / Slack app tokens, keeps `$VAR` references and stays linear on 200 KB inputs. The content scanner (V6) shares the key boundary, adds Korean injection cues (built NFKD because it scans NFKD text), "do not follow the user" and a block-severity control-character pattern. `scope_refs`, `failure_sig` and `program_token` are redacted and capped (256 chars per token, 4,000 in total); rendered memory text drops ANSI / C0 / C1 controls.
- **Extraction prompt.** Recorded events, the previous turn, the last assistant message and the existing-memory list sit inside data fences under an explicit "recorded data versus instructions" section; event ids are positional over the full line list, so a cached raw output resolves to the same ledger lines whatever the memory list did to the drops; import episodes are create-only (`propose_*` relabelled); the worker refuses `import:<path>` sources outside the project root and keeps the bullet text in `raw/` for retries, redacted.
- **Write path.** The two-session `propose_supersede` auto rule is reachable (a replacement's live twin supports the open proposal; `evaluateAutoDemotion` supersedes the target and activates the replacement); provider-level probe failures and spawn errors requeue without burning an attempt; `extractLoop` continues when a lease batch is entirely `no_signal`; the worker rescans `queue/` after releasing `worker.lock` (§9.3 E); an incomplete queue descriptor is renamed `.bad` instead of wedging every later lease; embeddings are computed lock-free and stored in a short lock session (backlog capped at 64 rows per run); the idle sweep re-checks the state file right before advancing and follows hook-core's segment semantics; a legacy candidate whose stored text fails the scanner is reinforced but never auto-activated (`tier=candidate:security`).
- **Proposals.** Rejecting a `revalidate` stales the row (`ttl_expired`); accepting a `supersede` whose candidate is no longer live, or a `fix_scope` / `fix_signature` without a payload, is refused with `ProposalNotApplicableError` before anything is written; a rejected `fix_signature` is not re-proposed for 30 days; V11 reachability uses the same tool-glob resolver as the validator and the PreToolUse matcher.
- **Hot path.** `PolicyEngine.fromSnapshotRules` reuses each derived rule's precompiled signature from the snapshot — no minimatch load and no regex-safety sampling in a `PreToolUse` process (`hm eval:latency` p95 93–96 → 84.5 ms on the development machine); manual rules fire once per turn like memories (`rule:<code>|tool` in `firedKeys`); command canonicalization is memoized per hook; the launcher and `spawnDetached` absorb late asynchronous errors (exit 0, no host-visible hook error); a correction typed after a resume / compact marker still sees the failed previous turn; stale `locks/worker.pid` files (older than 2 h, or a reused pid) no longer disable the POSIX hooks.
- **Concurrency.** `db.lock` takeover is a compare-and-swap on `owner.json` (rename, byte-equal check, exclusive create) instead of remove-and-recreate; `Store.withWriteLock` fences the save with `stillHeld()` and throws `LockBusyError` rather than writing after a lost lock; `cleanOrphanTmp` sweeps `queue/`, `state/` and `raw/`; the dream GC removes orphan `import-*.json` descriptors.
- **Install and CLI.** `hm install` writes `.harness-memory/.gitignore` (`*`), follows worktree / submodule `.git` pointers to the real `info/exclude` (and warns when it cannot), runs npm and the `claude --version` probe without `shell: true` (the bundled `npm-cli.js` through `process.execPath`; `.cmd` shims as one quoted command) and never runs `npm install` inside the project when the package root is unknown; `hm doctor` gained `install.state_ignore`, `install.git_exclude` and the embedding rendezvous path (warning when a Unix socket path is over the limit); the POSIX helper socket lives in `$XDG_RUNTIME_DIR` / tmpdir; every registry usage string names the flags the command accepts (pinned by `test/cli-registry.test.ts`).
### Fixed (verification round, after Phase D)

- A failed provider probe (`not_logged_in`, `missing`, `nested_refusal`, `probe_timeout`, `invalid_output`) was cached for 24 h like a successful one, so a login was only noticed a day later unless `hm install` re-probed. Failures are now trusted for ten minutes (`PROBE_FAILURE_CACHE_MS`) and the waiting episodes are requeued for the same moment; an `ok` probe is still trusted for a day. The `not_logged_in` guidance names `claude auth login` and the `hm install --host claude` re-probe.
- The claude provider passes `--model sonnet` unless `extraction.model` is set. The first live probe on the author's machine failed with `api 404` because the interactive default model in `~/.claude/settings.json` (`anthropic.claude-opus-5[1m]`, a gateway id) does not exist for the headless first-party call; background extraction should not inherit the interactive default anyway.
- A provider-level failure of the probe (an API error such as that 404) was reported as `probe invalid_output` with misleading guidance. It is now `probe provider_error`; the provider's message is kept in `meta.last_probe_error` and printed by `hm install`, `hm status`, `hm doctor` and `hm extract --dry-run`, and an `api_error_status` of 401 classifies as `not_logged_in`.
- `cmd` signatures keep the package manager you name: `npm test` fires on `npm test`, `npm run test` and `& npm.cmd test` but not on `pnpm test`; the family forms `pm <script>` / `bin <name>` keep covering every manager / runner (`CanonicalCommand.literals`, `CompiledSignature.program`). The first live extraction had copied the family-level failure signature `pm test` into the trigger, so the auto-activated pitfall denied the very `pnpm test` the user had asked for; the README example described that behaviour as intended.
- V12 `signature_matches_resolution`: a created fact's signature is rejected when it also matches the command that resolved the cited failure and that command differs from the failing one; the extraction prompt explains the literal and family forms and the rule.
- The recorded model of a run is the `modelUsage` entry with the most output tokens (Claude Code 2.1.3xx lists a helper model first) and `total_cost_usd` is written to `worker.log` per provider call.
- `[contested]` in `hm memory:list` now means an open supersede / stale / revalidate proposal on the row; rows waiting on an activation or a scope / signature fix show `[proposal]`.
- `scripts/verify-packed-install.mjs` expected `hm memory:list` on an empty database to exit 2; the CLI prints "no memories match" and exits 0, so `npm run package:verify` failed on every fresh consumer. Fixed; the packed install verifies end to end again.
- New: `.github/workflows/ci.yml` (ubuntu × Node 20 / 24, macOS, Windows: typecheck → build → vitest → `hm eval:replay`; a packed-install job; a manual real-model embedding job with the model cached) and `test/embedding/helper-real-model.test.ts` (the v0.6 helper, the worker's embedding pass, Korean → English `topk` through the client, idle exit and the built bundle, all with the real multilingual-e5-small; `npm run test:embedding`).
- Linux is now exercised for real (WSL Ubuntu-22.04, Node 24): the whole suite, `eval:replay`, `eval:latency` (p95 64–76 ms) and the real-model tests pass; the unix-socket rendezvous path and the `/proc` pid check run on their native platform.

### Known limitations (0.6.0-rc.1)

- Live `claude -p` extraction was not exercised on the development machine (its standalone CLI is not logged in); the replay provider covers the tests and the `not_logged_in` path is verified end to end.
- The exec-form hook minimum (Claude Code 2.1.139) is inferred from release notes; `--hook-form shell` is the escape hatch.
- The worker-pid recursion guard is a no-op on Windows (the environment guard `HARNESS_MEMORY_DISABLE=1` covers nested calls on every platform); on POSIX it ignores pid files older than 2 h and pids that started after the file was written. The worker still writes `worker.pid` in place and does not remove it on SIGTERM.
- The 80 ms dense budget may be too short for a cold helper; `before_model` then degrades to lexical-only for that turn.
- `eval:live` (the live three-arm evaluation) is registered but not implemented in this build; every other command runs.
- `hm eval:latency` measures p95 ≈ 85 ms on the development machine (Windows 11, Node 24, `node -e 0` ≈ 50 ms) after Phase D took minimatch off the `PreToolUse` path; the 90 ms gate holds there with a few milliseconds to spare, and Node start-up remains the dominant cost.
- `fix_scope` / `fix_signature` proposals can be rejected but not accepted in this build: no CLI editor collects the scope / triggers / signature payload yet (`hm proposals:accept` reports `payload_missing`).

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
