# Phase D notes (adversarial review, refutation, fixes)

Assembled on 2026-11-08 from the Phase D workflow (`hm-v06-phase-d.js`): five review dimensions → every finding refuted independently by two verifiers (a finding survives only when neither refutes it) → one fixer per owning area → orchestrator integration of the cross-module requests → final gates.

## Run facts

- Agents: 107 (5 reviewers, 94 refuters, 8 fixers); tool calls 3719; subagent tokens ≈ 17.6 M; wall clock ≈ 87 min.
- Findings: 47 raised, 34 survived refutation, 12 refuted.
- Review dimensions (plan §6): (1) write-path correctness against spec §5/§7 and the §12 defect matrix; (2) hook hot-path safety (never throws, never opens SQLite, exit 0, budgets, latency); (3) concurrency and crash safety (§9); (4) security (redaction, scanner, prompt injection reaching the extractor, path handling); (5) cross-module consistency (vocabularies, file formats, CLI vs snapshot).

## Confirmed findings by area

Severity: 1 blocker, 12 major, 21 minor.

### core (signals, process, scanner) — 4

- **[blocker]** Credential redaction misses the most common secret shapes; unredacted values reach the extractor prompt and permanent provenance excerpts (`src/core/signals.ts:58`)
- **[major]** Credential redaction misses env-var style assignments and non-http URL credentials (`src/core/signals.ts:58`)
- **[major]** Scanner (V6) credential/injection regexes share the `\b` gap and are English-only, so secret-bearing or injected facts pass the only content gate before injection into the model (`src/security/scanner.ts:113`)
- **[minor]** spawnDetached has no 'error' listener: an asynchronous spawn failure exits the hook with code 1 (user-visible hook error) (`src/core/process.ts:93`)

### dream (worker, reconcile, consolidate, prompt, validate) — 12

- **[major]** Two-session propose_supersede auto rule is unreachable; repeated claim degrades to a stale proposal and the replacement never activates (`src/dream/reconcile.ts:725`)
- **[major]** Provider-level probe failures and spawn errors burn episode attempts; correction episodes go dead after three days of a broken provider (`src/dream/worker.ts:526`)
- **[major]** Import-mode propose_supersede inserts the replacement as an active human row without any proposal acceptance (`src/dream/reconcile.ts:580`)
- **[major]** Attacker-controlled tool output can mint an active soft_deny memory in a single episode; the prompt renders it verbatim and nothing scans the input side (`src/dream/extract/prompt.ts:111`)
- **[major]** Worker reads an arbitrary absolute path named in `episodes.ledger_ref` (`import:<path>`) and feeds it unredacted to the extractor (`src/dream/worker.ts:479`)
- **[minor]** Raw-cache reuse ignores prompt identity although evidence refs are positional (`src/dream/worker.ts:594`)
- **[minor]** extractLoop ends when a lease batch is entirely ineligible even though more due episodes remain (`src/dream/worker.ts:764`)
- **[minor]** Embedding backfill runs model inference while holding db.lock, unbounded on first enable (`src/dream/worker.ts:815`)
- **[minor]** worker.lock busy path drops work: no post-release queue rescan (§9.3 E) and reindex requests exit busy (`src/dream/worker.ts:893`)
- **[minor]** Idle-turn sweep rewrites another session's state file and can clobber a prompt hook racing with it (`src/dream/consolidate.ts:366`)
- **[minor]** Two idle-sweep implementations leave different SessionState for the same event (`src/dream/consolidate.ts:312`)
- **[minor]** Worker's `isEpisodeDescriptor` accepts queue files that `EpisodeRepository.insertIfAbsent` cannot insert, and the file survives the failure (`src/dream/worker.ts:246`)

### promotion (proposals, authority) — 4

- **[major]** fix_scope / fix_signature acceptance expects an `@payload` JSON that no production producer writes (`src/promotion/proposals.ts:297`)
- **[minor]** Rejecting a revalidate (or fix_signature) proposal does nothing and the same proposal is re-opened at the next dream (`src/promotion/proposals.ts:367`)
- **[minor]** Accepting a supersede proposal supersedes the target even when the candidate row is no longer live (`src/promotion/proposals.ts:232`)
- **[minor]** V11 reachability is implemented twice with different tool-glob semantics (validator vs snapshot/decideTier) (`src/promotion/authority.ts:128`)

### activation (before-tool, policy engine, signature, tool vocabulary, injection) — 5

- **[major]** PolicyEngine recompiles derived-rule signatures in every hook process (loads minimatch, runs regex-safety sampling on the pre-tool path) (`src/policy/engine.ts:189`)
- **[major]** scope_refs / failure_sig / program_token bypass redaction and have no length cap (credentials in the ledger, lines > 32 KB) (`src/activation/tool-vocabulary.ts:265`)
- **[minor]** Rule-only fired items never enter firedKeys, so soft_deny/confirm from a rule without a snapshot memory re-fires on every retry (`src/activation/before-tool.ts:314`)
- **[minor]** matchSignature re-tokenizes the same command once per cmd-signature memory (`src/activation/signature.ts:916`)
- **[minor]** Rendered memory text keeps control characters (ANSI escapes) and the scanner skips `aliases`/`rationale` (`src/activation/injection.ts:48`)

### adapters (hook-core) — 2

- **[minor]** Correction signal from a failed previous turn is lost when a marker-only segment (resume/compact) precedes the prompt (`src/adapters/hook-core.ts:454`)
- **[minor]** Stale locks/worker.pid can disable every hook with no self-healing path (POSIX) (`src/adapters/hook-core.ts:338`)

### db (locks, store, db-file) — 2

- **[major]** db.lock takeover is not atomic: two contenders can both acquire a stale lock (`src/db/locks.ts:179`)
- **[minor]** cleanOrphanTmp never visits queue/, state/ or raw/, so hook/worker tmp leftovers accumulate forever (`src/db/db-file.ts:249`)

### embed (helper socket) — 1

- **[minor]** POSIX embed-helper socket lives under the repo path and exceeds the Unix socket name limit on deep checkouts (`src/core/paths.ts:77`)

### cli (install, doctor, uninstall, paths, settings, registry) — 4

- **[major]** install excludes `.claude/settings.local.json` from git but never `.harness-memory/`, whose ledgers and database hold prompts, tool output and permanent excerpts (`src/cli/commands/install.ts:272`)
- **[minor]** `shell: true` spawns resolve commands through cmd.exe (current-directory-first lookup) and pass unquoted binary paths (`src/cli/commands/install.ts:83`)
- **[minor]** `.git/info/exclude` is skipped for worktrees and submodules, so `.claude/settings.local.json` can be committed there (`src/cli/lib/paths.ts:150`)
- **[minor]** Registry usage strings omit options the command modules declare (shown together in `hm <cmd> --help`) (`src/cli/registry.ts:84`)

## Refuted findings (not changed)

Both refuters showed each of these to be wrong, already handled, or not a defect; they are recorded so the next review does not re-raise them without new evidence.

- 1 MB stdin cap makes PreToolUse fail-open for large Write/Edit payloads and drops PostToolUse capture for large outputs
- A signature dropped at snapshot-build time turns a narrow policy into a scope-only blanket rule with its full enforcement
- Heartbeat and release never re-check ownership; a taken-over holder re-stamps and then deletes the taker's lock, and the store saves without a fencing check
- Lock release swallows rmSync failures with no retry, turning a transient Windows sharing violation into a 120 s writer outage
- Hooks trust any committed `.harness-memory/` above cwd: no ownership check, and a snapshot without `memory.sqlite` is never stale
- Raw provider output is cached to disk before V6, so scanner-rejected or credential-bearing facts sit in `raw/` for 24 h
- Repository `fallbackSignatureKey` produces a non-canonical signature_key that diverges from A3's compiled key and from the snapshot
- Spec text lags the core contracts in key names and enumerations
- Dense snapshot codec duplicated under the same export names with different decode contracts
- Enumerations and limits duplicated outside src/core (WorkerCommand, line kinds, lexical fields, trigger order, TTL bases, schema enums, target caps)
- `not_installed` HookRunStatus is declared and documented but never produced or logged
- `SessionEnd.reason` is read from the raw stdin instead of the normalized hook contract

## Fix reports by area

### dream (worker, reconcile, consolidate, prompt, validate)

#### Fixed

- Two-session propose_supersede auto rule unreachable (src/dream/reconcile.ts): proposeAgainst split into supportProposal + proposeAgainst; when createRow collapses the replacement into its live twin and that twin is the target's proposed replacement (supersedes_memory_id or an open supersede proposal names it), the same (supersede, target, candidate) proposal gains the session's support; a `reinforce` on a proposed replacement row supports its open supersede proposal(s) too (supportReplacementProposals). evaluateAutoDemotion now fires for supersede: target superseded, replacement activated by auto_rule with baseTtlDays TTL. Tests: reconcile-replay.test.ts "(f') propose_supersede needs two sessions" (same claim, reinforce variant, same-session-twice stays candidate).
- Provider-level probe failures burned episode attempts (src/dream/worker.ts, src/dream/reconcile.ts): ExtractedWork.providerUnavailable marks probe-derived failures; recordExtractionFailure gained providerUnavailable and requeues with undoAttempt (+24 h) for any probe outcome (probe_timeout/invalid_output included), matching the cached-probe gate that already leaves such batches waiting. The run row keeps the distinguishable status/error ("probe: probe_timeout") for doctor. Tests: worker-pipeline "a probe timeout ... never kills it" (4 daily probe failures, attempt_count stays 0, extracted on recovery); reconcile-replay recordExtractionFailure providerUnavailable case.
- Import-mode propose_* inserted an active human replacement (src/dream/extract/validate.ts): in import mode (spec §11 line 531, action = create only) propose_supersede/propose_stale are relabelled to `create` with target null (relabel `import_create_only`) before V7, so no proposal is opened with an already-active candidate and the CLI import table sees a `created` outcome. Tests: extract-validate "import episodes are create-only"; reconcile-replay "import episodes are create-only" (no proposal, target untouched, created import row).
- Raw-cache reuse ignored prompt identity (src/dream/extract/prompt.ts, src/dream/worker.ts): event ids are now positional over the episode's FULL non-subagent line list (assigned before drops, so a drop leaves a gap instead of renumbering); new eventIdMap(lines) exposes every id; unlockedPhase resolves a cached raw output's refs through eventIdMap(lines) instead of the current render's kept-lines map. Tests: extract-prompt "event ids do not move when the memory list changes the number of dropped lines" and the updated drop test.
- extractLoop ended on an all-ineligible lease batch (src/dream/worker.ts): leaseSession repeats the lease inside the same lock session (MAX_SKIP_ROUNDS) when every leased row was no_signal and eligible rows remain due; extractLoop additionally `continue`s when leased is empty but skipped > 0 and moreDue. Test: worker-pipeline "a lease batch made only of no_signal episodes does not end the run" (3 read-only turns + eligible s02 processed in one loop).
- Embedding backfill ran the model under db.lock (src/dream/worker.ts, src/dream/consolidate.ts): embedNewRows now reads the backlog with store.read (no lock), runs the model lock-free (selectEmbeddingBacklog → embedBacklog), caps the backlog at EMBED_BACKLOG_PER_RUN = 64 beyond the rows this run created, then stores vectors in a short lock session only for rows whose content_hash is unchanged and still lack a vector (applyEmbeddings). backfillEmbeddingsOp removed (only caller). Dream-path backfill left inside the dream session (spec §5.8 (6)). Tests: worker-pipeline embedder tests assert db.lock is absent during embed and that a row edited mid-pass is skipped; consolidate.test.ts lock-free split unit test.
- No post-release queue rescan (§9.3 E) (src/dream/worker.ts): runWorker releases worker.lock, rescans queue/ and re-acquires with waitMs 0 to run the extract loop again (MAX_RESCANS_PER_RUN = 3) for extract/dream/import; a loser taking the lock meanwhile ends the rescan. Test: worker-pipeline "queue files written while the worker ran are picked up after worker.lock is released". The reindex half of the finding was not changed (both refuters showed the holder's own snapshot rebuild clears staleness).
- Idle sweep clobbered a racing prompt hook (src/dream/consolidate.ts): sweepIdleTurns re-reads the state file and re-stats the ledger right before advancing (sessionMoved) and leaves the session alone when updated_at/turn_key/turn_start_offset/segment or the ledger size changed; the queue file is written only after that check. Test seam IdleSweepOptions.beforeAdvance; consolidate.test.ts "a session resumed while the sweep was reading it keeps the state its prompt hook wrote".
- Prompt renders untrusted text with no data boundary (src/dream/extract/prompt.ts): events, previous-turn context, last assistant message and existing-memory summaries are wrapped in DATA_FENCE_OPEN/DATA_FENCE_CLOSE lines and the instructions open with a "Recorded data versus instructions" section that names fenced content as data and forbids turning tool output/error text into facts. Fixes (2) and (3) of the suggestion were not applied (both votes: spec change / false positives). Test: extract-prompt "recorded content is fenced as data and the instructions say so" with an injected stderr payload.
- Worker read an arbitrary path from `import:<path>` (src/dream/worker.ts): resolveImportSource resolves against paths.root and refuses anything outside it (absolute paths, `..`, the root itself); rememberImportText keeps the bullet text in raw/<episode_id>.import.txt when the queue file is consumed so retries never re-read the source (supports outside-root `hm import --from` retries; removed by the raw GC); readEpisodeLines prefers queue text → kept text → in-root source line, and the synthesized prompt line goes through redactCredentials. Tests: worker-pipeline "import episodes: source text" (outside-root/.. refused, relative path resolves against root not cwd, redaction, kept text served, worker-level retry without the source file).
- Two idle-sweep implementations diverged (src/dream/consolidate.ts, partial): the worker sweep now follows hook-core's closeSegment selection and state shape — skips turns already closed (turn_start_offset >= EOF) and content-less tails, renders contextLines from last_episode_range when correction_for is set, keeps turn_key and correction_for, increments segment, sets last_episode_id/range and turn_start_offset past the marker (so a resumed session's Stop closes the continuation and its prompt hook sees the swept turn). The shared helper and the single IDLE_TURN_MS constant need hook-core / core changes outside this area. Test: consolidate.test.ts updated sweep test + "a turn the stop hook already closed, or a tail without episode content, is left alone".
- isEpisodeDescriptor accepted uninsertable queue files (src/dream/worker.ts): the validator now checks the full contract (host/close_reason vocabularies, segment/event_count non-negative ints, started_at, session_key, evidence_weight, arrays incl. fired entries with memory_id, failure_signatures objects, nullable strings); leaseSession wraps each insert + fire roll-up in a SAVEPOINT and reports throwing files as `rejected`, which extractLoop renames to `<file>.bad` instead of aborting the session. Test: worker-pipeline "a queue file that is not a complete descriptor is removed instead of wedging every later lease session".

#### Left to other areas / deliberately not changed

- Finding 7, reindex half (worker reindex exits busy while another worker runs): not changed — both refuters showed every saved write session rebuilds the snapshot and clears .reindex-requested, so no once-a-minute storm materializes; the queue-rescan half was fixed.
- Finding 9, suggested fixes (2) scanning the rendered episode / episode_summary with the injection patterns and (3) requiring a human signal for soft_deny: not applied — both votes marked them as contradicting spec §7.3/§7.4 and as false-positive-prone; only the fencing/data statement and a fixture-style test were added.
- Finding 11, shared closeIdleTurn helper and single IDLE_TURN_MS: the hook-core.ts/session-state.ts side and the core constant are outside the dream area; consolidate.ts was aligned to hook-core's semantics instead (cross-module request: hooks could import a shared pure helper from src/dream/episode.ts once one exists).
- Finding 4, sub-claim that extraction_runs.prompt_sha256 records the current render on cache reuse: left as is (both votes called it weak; the spec deliberately excludes the prompt hash from the run id and never defines prompt_sha256 for a reused cache).

#### Files

`src/dream/reconcile.ts`, `src/dream/worker.ts`, `src/dream/consolidate.ts`, `src/dream/extract/prompt.ts`, `src/dream/extract/validate.ts`, `test/reconcile-replay.test.ts`, `test/worker-pipeline.test.ts`, `test/consolidate.test.ts`, `test/extract-prompt.test.ts`, `test/extract-validate.test.ts`

#### Tests added

- test/reconcile-replay.test.ts: (f') two-session propose_supersede → target superseded, replacement active (same claim; reinforce variant; same session twice stays candidate)
- test/reconcile-replay.test.ts: recordExtractionFailure providerUnavailable waits for timeout/invalid_output
- test/reconcile-replay.test.ts: import episodes are create-only (propose_supersede bullet → created import row, no proposal, target untouched)
- test/worker-pipeline.test.ts: all-no_signal lease batch does not end the run while an eligible episode is due
- test/worker-pipeline.test.ts: probe timeout leaves the batch queued without burning an attempt across four daily failures, then extracts on recovery
- test/worker-pipeline.test.ts: queue files written during the run are picked up after worker.lock is released (§9.3 E)
- test/worker-pipeline.test.ts: incomplete queue descriptor is removed; isEpisodeDescriptor full-contract table
- test/worker-pipeline.test.ts: embedding runs with db.lock absent; backlog embedded after new rows and a row edited mid-pass is skipped
- test/worker-pipeline.test.ts: import source text — outside-root / `..` refused, relative path resolves against root not cwd, credentials redacted, kept text serves retries, worker-level retry without the source file
- test/consolidate.test.ts: lock-free embedding split (selectEmbeddingBacklog order/limit, embedBacklog, applyEmbeddings skips moved rows)
- test/consolidate.test.ts: idle sweep keeps turn_key/segment+1 (hook-aligned state); already-closed turns and content-less tails left alone; resumed-session race keeps the hook's state
- test/extract-prompt.test.ts: fenced data blocks + instruction statement with an injected stderr payload; stable event ids across memory-list changes / drops (eventIdMap)
- test/extract-validate.test.ts: import_create_only relabel for propose_supersede / propose_stale in import mode

#### Gates reported by the fixer

- tsc clean: true
- npx tsc --noEmit -p tsconfig.json: no errors. npx vitest run (full suite): 73 files / 985 tests passed. Affected files re-run after the last edit: test/worker-pipeline.test.ts, test/consolidate.test.ts, test/reconcile-replay.test.ts, test/extract-prompt.test.ts, test/extract-validate.test.ts, test/ops-garbage-extraction.test.ts, test/eval-replay.test.ts, test/cli-pipeline.test.ts, test/cli-import.test.ts, test/cli-review.test.ts, test/snapshot-builder.test.ts: 11 files / 149 tests passed.

### promotion (proposals, authority)

#### Fixed

- [minor] Rejecting a revalidate does nothing / re-opened next dream — src/promotion/proposals.ts decideProposal reject branch: a rejected `revalidate` on an active target now runs transitionMemory(active → stale, actor human (or `expiry` for a non-human decider, auto rows with ttl <= now only), statusReason 'ttl_expired' for auto rows, reason 'proposal:revalidate rejected', proposalId) and records effect `target:stale(ttl_expired)` — the §5.8 (2) outcome the proposal's expiry would have produced (spec-v0.6.md:305; the review prompt literally offers 'confirm the memory still holds or let it go stale'). Because the row leaves status='active', consolidate's ttlExpiry query no longer selects it, so no second proposal is opened regardless of the `rejectSkipDays: 0` call site. Test proves reject → stale(ttl_expired) with a human transition row, then runDream 6 h later opens nothing, and that a reject on a row that is no longer active changes nothing.
- [minor] Accepting a supersede supersedes the target even when the candidate is not live — src/promotion/proposals.ts: the supersede accept branch now throws ProposalNotApplicableError(code 'candidate_not_live') before any write when !isLive(candidate.status) (rejected / superseded), so the target keeps its status and flags and the proposal stays open (Store.withWriteLock rolls the session back on throw, so `--all` batches write nothing either); evaluateAutoDemotion returns {applied: false, reason: 'candidate_not_live'} for the same situation instead of calling decideProposal (reconcile.ts:687 consumes the reason string). Rejecting the dangling proposal remains the way out and is covered by the test.
- [major] fix_scope / fix_signature acceptance expects an @payload no producer writes — src/promotion/proposals.ts: accepting a fix_scope / fix_signature proposal whose rationale carries no `\n@payload {json}` now throws ProposalNotApplicableError(code 'payload_missing', message with guidance) before anything is written: needs_scope is no longer cleared, authority is no longer promoted to human, and the proposal stays open (the former `payload_missing` effect is gone). The with-payload path is unchanged. ProposalNotApplicableError extends InvalidMemoryTransitionError so the existing CLI describeDomainError renders it as one error line (exit 1) for `hm proposals:accept` and `hm review` prints `! …` and re-prompts (keys / --accept-all-kind count it as skipped). Test uses the exact migration-019 rationale and the consolidator's fix_signature prose and asserts scope/triggers/needs_scope/authority/proposal status are untouched.
- [minor] V11 reachability implemented twice with different tool-glob semantics — src/promotion/authority.ts: toolGlobReachesHook now is `toolGlobFamilies(glob).some(f => PRE_TOOL_HOOKED_FAMILIES has f)` (imported from src/activation/tool-vocabulary, the same resolver validate.ts V11 and the PreToolUse matcher use; tool-vocabulary imports only core + signature, no cycle), so isReachableTrigger / decideTier / the snapshot builder agree with the validator on `wr*`, `*sh`, `ba*sh`, `e*|read` etc. Test cross-checks isReachableTrigger against toolGlobFamilies for reachable and unreachable glob shapes and asserts decideTier activates a `wr*` signature while `gr*` stays candidate(trigger).

#### Left to other areas / deliberately not changed

- Finding 1, consolidate side (dream area, not edited): src/dream/consolidate.ts still passes `rejectSkipDays: 0` at lines 143 (ttlExpiry) and 228 (fixSignatureProposals). For `revalidate` the loop is closed by the promotion change (the row is stale, so it is never re-selected). For `fix_signature` a human reject still gets re-proposed at the next dream until the dream owner drops `rejectSkipDays: 0` (or passes the configured skip) — the §7.5 30-day skip (spec-v0.6.md:400) is then honoured by the existing openOrSupportProposal path (covered by test/proposals.test.ts 'a claim rejected within 30 days is skipped'). I did not mutate the row on a fix_signature reject because dropping or rewriting a signature is not what 'reject' means.
- Finding 2, consolidate side (dream area, not edited): the suggested guard in candidateAndProposalExpiry (skip candidates that are candidate_memory_id of an open proposal, or expire that proposal in the same step) is in src/dream/consolidate.ts:158-171; with the promotion guard such a proposal can no longer be accepted (human or auto) and expires normally after retention.proposal_days, so the data loss is prevented but the dangling proposal still sits in the review queue until rejected or expired.
- Finding 3, CLI/docs side (other areas, not edited): no editor collects scope/triggers/signature yet, so a payload-less fix_* proposal can only be rejected or skipped (or the row re-created with `hm memory:add … --active`). Optional follow-ups: a dedicated describeDomainError branch for ProposalNotApplicableError in src/cli/lib/cli-error.ts (today it inherits the InvalidMemoryTransitionError hint about the §4.7 edge table, the message itself carries the guidance); docs/redesign/upgrade-from-0.5.md:63 ('accepting lets you set the scope…') and docs/redesign/phase-b-notes.md:77 (decideProposal contract) describe the pre-fix behaviour.

#### Files

`src/promotion/proposals.ts`, `src/promotion/authority.ts`, `test/proposals.test.ts`, `test/authority.test.ts`

#### Tests added

- test/proposals.test.ts > decideProposal > rejecting a revalidate by a human stales the row as ttl_expired and the next dream does not re-propose it (runs runDream twice; also covers the no-op reject on a row that is no longer active)
- test/proposals.test.ts > decideProposal > accepting a supersede whose replacement is no longer live is refused before anything is written (ProposalNotApplicableError code candidate_not_live; target/flags/proposal untouched; reject still closes it)
- test/proposals.test.ts > decideProposal > a fix_scope / fix_signature proposal without a payload cannot be accepted: nothing is cleared, promoted or decided (migration-019 rationale and consolidator prose; code payload_missing; reject still possible)
- test/proposals.test.ts > evaluateAutoDemotion > a supersede whose replacement expired as a candidate is not applied by the auto rule (reason candidate_not_live)
- test/authority.test.ts > decideTier (§7.4) > isReachableTrigger resolves tool globs exactly like the validator's V11 and the PreToolUse matcher (wr*, *sh, ba*sh, ba*, b*, e*|read, bash*, mcp, mcp:server/*, * reachable; read|grep, gr*, re*, *ob, powershell, '' not; decideTier wr* → active, gr* → candidate/trigger)

#### Gates reported by the fixer

- tsc clean: true
- npx vitest run on the 16 affected files (test/proposals.test.ts, test/authority.test.ts, test/consolidate.test.ts, test/cli-review.test.ts, test/snapshot-builder.test.ts, test/ops-snapshot-invariants.test.ts, test/reconcile-replay.test.ts, test/worker-pipeline.test.ts, test/hook-bundle-imports.test.ts, test/promotion-transitions.test.ts, test/promotion-revalidate.test.ts, test/repositories-proposals.test.ts, test/extract-validate.test.ts, test/db-migrations-legacy.test.ts, test/cli-doctor-status.test.ts, test/cli-memory.test.ts): 16 files passed, 209 tests passed, 0 failed (3.0 s). tsconfig.json includes test/**, so `npx tsc --noEmit -p tsconfig.json` (exit 0) type-checked the new tests as well. No lint script exists in package.json.

### activation (before-tool, policy engine, signature, tool vocabulary, injection)

#### Fixed

- [major] PolicyEngine recompiles derived-rule signatures in every hook process — src/policy/engine.ts + src/activation/before-tool.ts: `PolicyEngine.fromSnapshotRules(rules, memories?)` now takes the snapshot's `byId` map (`decideBeforeTool` passes `loaded.byId`); `SnapshotRuleSource` resolves each derived rule (memory_id set, pattern_kind/arg_pattern equal to the memory's compiled `signature`) to that precompiled `CompiledSignature`, exposed through a new optional `PolicyRuleSource.precompiledSignature(rule)`, and `compiledArgPattern` only falls back to `compileSignature` for manual rules (memory_id NULL) or a stale mismatch. Result: a PreToolUse process never loads minimatch for glob rules and never runs the timing-based regex-safety sampling (which could spuriously null a regex rule). Behaviour note: the snapshot path now honours the memory's compiled `negate` and exact cmd tokens (e.g. a quoted argument), i.e. rule and memory can no longer disagree as the engine header promises; the SQLite `PolicyRuleRepository` path is unchanged. Verified in-process: test asserts `require.cache` has no minimatch before/after `evaluate` and `decideBeforeTool` over glob+regex derived rules (vitest isolates files). `memory:why` inherits the fix via decideBeforeTool. (dist was NOT rebuilt — plan §2 forbids `npm run build` here — so the hm eval:latency p95 should be re-measured after the integrator builds.)
- [major] scope_refs / failure_sig / program_token bypass redaction and have no length cap — src/activation/tool-vocabulary.ts `extractScopeRefs` now (1) runs `redactCredentials` over the text first and additionally scrubs `NAME=value` assignments whose NAME smells like a credential (`AWS_SECRET_ACCESS_KEY=…`, `GH_TOKEN=…`, the shared assignment regex misses `_`-joined names), replacing the value with a delimiter-free `$redacted$` marker so nothing glued to a secret can survive tokenization (`<`/`>` are token delimiters, so `<redacted>` itself would be split); (2) drops tokens longer than 256 chars (blobs, JWTs, base64), tokens carrying a `:` outside a Windows drive prefix (`Authorization: Bearer …`, `user@host:path`, `image:tag`, `git@github.com:org/repo.git`), and refs past a 4,000-char total (max 50 × 256 → bounded far below the §5.1 32 KB line cap even for CJK paths); (3) `pickTarget` clips `programToken` to 256 chars so `failure_sig` (= tool|class|scope_refs[0] ?? program_token) is bounded too. scope_refs are therefore never less redacted than input_digest; lastScopeRef, EpisodeDescriptor.scope_refs/failure_signatures, queue files and the extraction prompt all inherit the sanitized refs. Quoted paths with spaces (existing test `'docs/x y.md'`) are kept. Cost: redactCredentials measured at 0.03 ms / 16 KB and 1.6 ms / 1 MB command via dist, so no scan window was needed.
- [minor] matchSignature re-tokenizes the same command once per cmd-signature memory — src/activation/signature.ts: new exported `canonicalCommandFor(command, dialect)` memoizes `canonicalizeCommand` per (text, dialect ?? 'unknown') in an 8-entry LRU (`CANONICAL_CACHE_SIZE`); `matchSignature`'s cmd branch and `primaryProgramToken` (so pickTarget primes the entry the signature loop then hits for commands ≤ 4,000 chars) use it; `PolicyEngine.ruleMatches` benefits through matchSignature. `canonicalizeCommand` itself stays pure. Test proves matchSignature goes through the cache deterministically via LRU identity (the target survives capacity-1 newer insertions only if matchSignature refreshed it).
- [minor] Rendered memory text keeps control characters (ANSI escapes) — src/activation/injection.ts: new exported `stripControlCharacters` removes CSI sequences (`ESC [ … m/K/A`) and C0/C1 controls (`[\u0000-\u0008\u000e-\u001f\u007f-\u009f]`, leaving `\t \n \v \f \r` for the `\s+` collapse) and `oneLine` applies it, so `renderItemText`, `renderReason` (permissionDecisionReason), rule items (`warning.message`) and every additionalContext line render exactly their visible text; also re-exported from src/activation/index.ts for the CLI/dream owners to reuse.

#### Left to other areas / deliberately not changed

- [minor] Rule-only fired items never enter firedKeys (before-tool.ts:314) — NOT fixed here: the only correct fix is in src/dream/ledger.ts `deriveTailState`, outside the activation area (plan §2 strict ownership: 'describe the change instead of editing'). No in-area fix exists: the once-per-turn state crosses hook processes only through the ledger, and putting `rule:<code>` ids into fired.memory_ids would corrupt the stop/reconcile fire trail. Cross-module request for the dream/ledger owner: inside the `if (inTurn)` block of the `fired` case add `for (const code of line.rule_codes) firedKeys.add(firedKey(`rule:${code}`, line.tool));`, extend the TailState.firedKeys doc to `memory_id|tool` and `rule:<code>|tool` (memory-why inherits), and add a hook-core test with a manual soft_deny rule (memory_id NULL, tool_pattern bash) asserting the same-turn retry is `none` with an `already_fired` suppression for `rule:<code>`. The consumer side (before-tool.ts:234-238) already keys on `rule:<code>` and needs no change.
- [major, remainder of the scope_refs finding] Defense-in-depth in src/dream/ledger.ts (clean() every scope_refs element, failure_sig and program_token in prepareLine; make serializeLine shrink array elements and enforce line_bytes after the halving loop) — out of area; the source-level caps/redaction above already bound the fields, so this is hardening only. Also src/core/signals.ts (shared contract): the `assignment` pattern's leading `\b` cannot match after `_` (`AWS_SECRET_ACCESS_KEY=…` is not redacted in input_digest either, as both verifiers noted); replacing `\b(` with `(?<![A-Za-z0-9])(` would close that gap for every ledger field. JSON-shaped credentials (`"token":"…"`) are likewise not matched by the shared pattern (MCP digests).
- [major, remainder of the PolicyEngine finding] 'extend hm eval:latency to report Bash vs Edit percentiles separately' — src/eval is another area; and the suggested spawned-process test against dist was replaced by an in-process require.cache witness because dist is stale and `npm run build` is not permitted for this agent. The gate (spec §6.3 p95 ≤ 90 ms) should be re-run after a build.
- [minor, remainder of the control-character finding] `clip` in src/cli/lib/memory-render.ts and `oneLine` in src/dream/reconcile.ts (CLI/dream areas) can now call the exported `stripControlCharacters` from src/activation/injection.ts; scanning `aliases`/`rationale` in validateFact and a block-severity scanner pattern (src/security, src/dream/extract) were judged overstated by both verifiers (neither field reaches model context; the alias scenario is not something scanMemoryContent could detect) and are outside the area.

#### Files

`src/policy/engine.ts`, `src/activation/before-tool.ts`, `src/activation/signature.ts`, `src/activation/tool-vocabulary.ts`, `src/activation/injection.ts`, `src/activation/index.ts`, `test/policy-engine-snapshot.test.ts`, `test/signature.test.ts`, `test/tool-vocabulary.test.ts`, `test/activation-hooks.test.ts`

#### Tests added

- test/policy-engine-snapshot.test.ts (new, 5 tests): derived glob rule matches through the memory's precompiled signature with `require.cache` asserted free of minimatch before/after; memory's compiled tokens are authoritative (quoted cmd argument matches only via the precompiled form, recompiling without memories does not); mismatched memory signature falls back to compiling; decideBeforeTool resolves glob+regex derived rules via loaded.byId with no minimatch; manual rule without a memory still compiles its glob lazily (last, since it loads minimatch)
- test/signature.test.ts: `canonicalCommandFor` returns one shared object per (command, dialect), null/undefined share the `unknown` key; LRU-identity test proving matchSignature refreshes the cached entry (bypass would let it be evicted)
- test/tool-vocabulary.test.ts: credential-shaped tokens never become scope refs (AWS_SECRET_ACCESS_KEY export, GH_TOKEN prefix, quoted and unquoted Bearer header, `secret=` assignment, URL credentials); `host:path`/`image:tag`/`git@host:` tokens dropped while drive prefixes still relativize; 40 KB slash-containing blob dropped, 256-char token kept vs 257 dropped, 60 × ~100-char refs capped under 4,000 total chars; pickTarget clips a 600-char program token to 256 and redacts scope refs while leaving `target` to the ledger writer
- test/activation-hooks.test.ts: renderItemText drops ANSI CSI sequences, BEL and VT and yields exactly the visible text; renderReason carries no ESC; stripControlCharacters removes C1 controls (NEL, CSI, DEL) and keeps \n/\t

#### Gates reported by the fixer

- tsc clean: true
- Affected files green: npx vitest run test/policy-engine-snapshot.test.ts test/policy-engine.test.ts test/signature.test.ts test/tool-vocabulary.test.ts test/activation-hooks.test.ts test/hook-core.test.ts test/hook-latency.test.ts test/hook-bundle-imports.test.ts test/ledger.test.ts → 9 files / 255 tests passed (hook-latency in-process p50 2.94 ms over 300 memories). Full suite (npx vitest run): 73 files, 962 passed / 5 failed — the failures are test/extract-prompt.test.ts (2: '# Last assistant message' fencing, count 4 vs 3), test/worker-pipeline.test.ts (1: embedder warm-up call order) and test/consolidate.test.ts (1: idle sweep expected turn_key null, got 'p2'), all in src/dream paths being changed by other areas; none imports the activation code changed here beyond the untouched compileSignature.

### core (signals, process, scanner)

#### Fixed

- Findings 1+3 (src/core/signals.ts:58, major+blocker, same root cause): the `assignment` pattern now uses an identifier-aware key boundary `(?<![A-Za-z0-9])` instead of `\b` (underscore is a word char, so `DB_PASSWORD=`, `JWT_SECRET=`, `AWS_SECRET_ACCESS_KEY=`, `NPM_TOKEN=`, `MY_API_KEY=`, `ACCESS_TOKEN=`, `export DB_PASSWORD=`, `$env:DB_PASSWORD =`, `x-api-key:` were all passing through), accepts `_SEGMENT` suffixes and an optional closing quote of a JSON/YAML key (`"password": "hunter22"`, `{"apiKey":"…"}`), and spells out camelCase compounds (`accessToken`, `clientSecret`, `secretKey`). `url_credentials` now covers any scheme (`postgres://admin:pw@`, `mongodb+srv://u:p@`, `redis://:pw@`) with the scheme anchored and bounded to stay linear. New patterns: `basic_auth_header` (`Authorization: Basic …`), `cli_user_password` (`curl -u/--user user:pass`, 2-char user minimum so `-u C:\path` survives), `cli_password_flag` (`--password value`), `mysql_password_flag` (`mysql … -pXXX`), value-shaped `stripe_key` (sk_live_/sk_test_/rk_*), `github_fine_grained_token` (github_pat_), `gitlab_token` (glpat-), `npm_token` (npm_…36), `slack_app_token` (xapp-). `$VAR` / `${VAR}` / `$(cmd)` values are references, not secrets, and are kept. Each pattern carries its own replacement template (host, key and flag survive: `DATABASE_URL=postgres://<redacted>@db.internal:5432/app`). Shared building blocks exported for the scanner: CREDENTIAL_KEY_BOUNDARY, CREDENTIAL_KEY_TAIL, CREDENTIAL_VALUE_NOT_REFERENCE, CREDENTIAL_KEYWORDS, credentialKeySource(). Performance was verified because redaction runs on raw text before clipping: an unbounded `[a-z][a-z0-9+.-]*://` scheme took 25 s on a 200 KB alphanumeric run; the shipped set takes ~1–11 ms on 200 KB adversarial inputs (test guards it).
- Finding 2 (src/core/process.ts:93, minor): spawnDetached attaches `child.on("error", …)` before `child.unref()`, so EAGAIN/EMFILE/ENFILE/ENOENT/EACCES — which Node reports asynchronously after spawn returns — no longer become an uncaught exception that exits the hook with code 1 (spec §8.6 / §6.2 step 10). SpawnDetachedOptions gains an optional `onError(error)` callback (default ignore) whose own exceptions are contained. Reproduced the pre-fix behaviour on this machine (Node 24.14.0, missing cwd → `Unhandled 'error' event … ENOENT`, exit 1) and the fixed behaviour (exit 0, onError sees ENOENT) in a real child process.
- Finding 4 (src/security/scanner.ts:113, major): generic_password/secret/token_assignment are built from the shared credentialKeySource() (same identifier-aware boundary, `_SEGMENT` suffixes, quoted keys, `$VAR` references allowed), plus a new generic_api_key_assignment (api/access/private key). `tokenizer = parser.nextToken()` stays safe. Prompt-injection list widened: `ignore_previous_instructions` now matches ignore|disregard|forget + (all|any|the|your) + previous|prior|preceding|earlier|above + instructions|directions|guidelines|prompt(s)|constraints; new `user_override` (do not follow/obey/listen to the user); new Korean cues ignore_previous_instructions_ko (이전/모든/기존 지시·지침·규칙을 무시/잊), identity_override_ko (지금부터/이제부터 너는, 너는 이제부터), concealment_instruction_ko (사용자에게 … 알리지/말하지/숨기), reveal_system_instructions_ko (시스템 프롬프트를 … 보여/출력/공개). Korean patterns are built NFKD-normalized because scanMemoryContent scans NFKD text, which decomposes Hangul syllables into jamo (verified: a naive NFC pattern never matches). New block-severity `control_character` pattern (C0/C1 except tab/LF/CR, category invisible_unicode). Reported match text is NFC-normalized so Korean matches are readable (identity for ASCII). Benign Korean memory text (이제부터 pnpm을 쓴다, 타입 경고는 무시하고 빌드, 사용자에게 확인을 받은 뒤 배포) stays safe; hm-safety benchmark keeps block rate 1.0 / false-positive rate 0.0.

#### Left to other areas / deliberately not changed

- Finding 2, launcher part: `process.on('uncaughtException'/'unhandledRejection')` guards in src/hook-launch.ts — file is outside the core area (hooks/B2). Cross-module request: add the two listeners (optionally logging via appendHookLog); the spawnDetached listener already removes the only known trigger.
- Finding 3, defense-in-depth re-redaction in excerptFor() (src/dream/reconcile.ts:481-485) and the synthesized import prompt line (src/dream/worker.ts:491-493) — dream area, not core. Note for that owner: ledger-derived excerpts are now redacted at the source by serializeLine; only the import path builds text that never passed through serializeLine, so a `redactCredentials` call there is the remaining gap.
- Finding 4, `scanSafe` fed from a real scan in reconcile's decideTier call (src/dream/reconcile.ts / src/promotion/authority.ts) — outside core. Cross-module request: pass `scanSafe: scanMemoryContent(summary, details).safe` so authority.ts's `security` reason is reachable for legacy v0.5 auto candidates.
- Sub-claims that are wrong on closer reading (no change): hooks.log under HARNESS_MEMORY_DEBUG=1 never carries ledger text (hook-io writes {ts, summary, detail} only); a tool_ok line is not lost on spawn failure (post-tool never spawns, and the ledger append completes before the nextTick error).
- Deliberately not added from the suggested fixes: a bare glued `-p<value>` pattern outside `mysql*` (Go-style single-dash flags such as `go test -parallel 4` would be mangled in input_digest); a bare `auth` keyword (`authority=human` appears in this project's own tool output). `--password=value` is already covered by the assignment pattern.
- README.md:417 (redaction shape list) not updated — docs, not core; suggest listing env-var keys, any-scheme URLs, Basic auth, CLI flags and the new token shapes.
- Observed in the full suite but not mine: 6 failures in other areas' in-flight files — test/tool-vocabulary.test.ts (git-clone scope-ref case; verified independent of this change: old and new redaction yield the identical string `https://<redacted>@example.com/org/repo.git`, their tokenizer then splits `<redacted>` on `<`/`>` and surfaces `@example.com/org/repo.git`), test/consolidate.test.ts (idle sweep turn_key), test/extract-prompt.test.ts ×3 (seqMap keys), test/worker-pipeline.test.ts (embedder warm-up). None of those files import signals/scanner/process.
- Heads-up for the activation owner: src/activation/tool-vocabulary.ts's in-flight SECRET_ASSIGNMENT regex duplicates what core's `assignment` pattern now catches and can be dropped.

#### Files

`src/core/signals.ts`, `src/core/process.ts`, `src/security/scanner.ts`, `test/core-signals.test.ts`, `test/core-process.test.ts`, `test/security-scanner.test.ts`, `test/ops-detached-spawn.test.ts`

#### Tests added

- test/core-signals.test.ts (new): table of 32 redacted shapes (env-var keys, quoted JSON keys, camelCase, any-scheme URL credentials, Basic/Bearer headers, curl -u/--user, mysql -p, --password, github_pat_/glpat-/xapp-/sk_test_), 19 must-stay-untouched strings (tokenizer=, https://host:8080/?x=a@b, go test -parallel, authority=human, -u C:\path, $VAR references, OLDPWD=, password_min_length=8 …), a full `cat .env` dump keeping keys/hosts and losing every value, idempotency + every pattern global, and a linear-time guard on 200 KB adversarial inputs
- test/core-process.test.ts (new): real child_process — a missing cwd makes spawn emit `error` after return; the process still exits 0, stderr has no "Unhandled 'error' event", onError receives ENOENT (gated on Node ≥ 23.6 type stripping, flagged on 22.6+; ran on 24.14.0)
- test/ops-detached-spawn.test.ts: fake child is now a real EventEmitter; expectDetached asserts one `error` listener; new test that `emit("error")` after spawnDetached does not throw and a throwing onError is contained
- test/security-scanner.test.ts: 6 env-var/quoted-key credential cases incl. generic_api_key_assignment; `$VAR` reference stays safe; 8 injection cases (ignore prior / forget the above / do not follow the user / 4 Korean cues); Korean match reported as NFC text; 5 benign Korean sentences stay safe; control characters block while tab/LF/CR stay safe

#### Gates reported by the fixer

- tsc clean: true
- Affected files (12): 257/257 passed — test/core-signals, core-process, security-scanner, ops-detached-spawn, ledger, memory-promote-security, extract-validate, benchmark/hm-safety (block rate 1.0, false-positive rate 0.0), hook-bundle-imports, hook-core, embed-helper, activation-hooks. Full suite: 960 passed / 6 failed; all 6 failures are in other areas' in-flight files (tool-vocabulary git-clone scope-ref case — verified independent of this change; consolidate idle sweep; extract-prompt ×3; worker-pipeline embedder warm-up). `npx tsc --noEmit -p tsconfig.json` exits 0 on the final run (an earlier run showed one error in src/dream/worker.ts, fixed by its owner meanwhile).

### adapters (hook-core)

#### Fixed

- Correction signal lost when a marker-only segment (resume/compact) precedes the prompt — C:\Users\choey\harness-memory-repo\src\adapters\hook-core.ts handlePrompt: the correction window `prevStart` now defaults to `state.last_episode_range?.start ?? state.turn_start_offset` (the last closed episode) and is moved onto the open segment only when the interrupted close actually produces an episode (`closeSegment` non-null). A tail holding only marker/assistant lines after a Stop (SessionStart compact|resume, PreCompact, SessionEnd, continued Stop) therefore no longer hides the previous turn's tool_fail from detectCorrection, and `correction_for` / `context_ref` (spec §5.1 line 237, §5.2 line 241, §9.4 F7) are set as promised. Verified: prompt → tool_fail → Stop → PreCompact(manual) → SessionStart(compact) → prompt 'use pnpm' gives correction=1, correction_for=<episode>, and the correcting Stop carries '(prev) tool_fail bash(bash): npm test'; same for SessionEnd → SessionStart(resume).
- Stale locks/worker.pid can disable every hook (POSIX) — C:\Users\choey\harness-memory-repo\src\adapters\hook-core.ts spawnedByWorker now validates the pid before honouring it: (a) a worker.pid whose mtime is older than the new exported `WORKER_PID_MAX_AGE_MS` (2 h; a run is bounded by ≤10 loops × ≤3 leases × 120 s plus embed/dream) is ignored; (b) when an ancestor pid matches, its wall-clock start (`/proc/<pid>/stat` field 22 in USER_HZ=100 ticks + `/proc/stat` btime) must be ≤ the pid file's mtime + 2 s — the real worker writes the file after it starts, so a reused pid (younger process) is rejected and the hook runs normally. Without /proc start times (macOS) the old ancestor match still applies, bounded by the age check. Added injectable `procRoot` / `nowMs` options (defaults '/proc' / Date.now()) so the guard is unit-testable on Windows; `parentPidOf` takes the proc root. runHook's call site is unchanged.

#### Left to other areas / deliberately not changed

- Finding 2 sub-suggestions outside the adapters area (not skipped findings; both findings above are fixed): `hm doctor` flagging a stale/reused worker.pid and `--fix` removing it lives in src/cli/commands/doctor.ts + src/cli/lib/diagnostics.ts (cli area); writing worker.pid via tmp+rename and removing it on SIGTERM/SIGINT lives in src/dream/worker.ts / src/worker.ts (dream area). Left to those areas' owners; the hook-side validation makes a stale file harmless regardless.

#### Files

`src/adapters/hook-core.ts`, `test/hook-core.test.ts`

#### Tests added

- test/hook-core.test.ts > hook core > 'a marker-only tail after Stop (compact / resume) does not hide the failed turn from the correction check' (prompt → PostToolUseFailure exit 1 → Stop → PreCompact(manual) → SessionStart(compact) → prompt 'use pnpm' asserts correction=1, no interrupted close, no junk queue file, state.correction_for = previous episode id, and the correcting Stop's descriptor has correction_for + context_ref '(prev) tool_fail bash(bash): npm test'; then SessionEnd → SessionStart(resume) → prompt asserts the same; prompt correction flags end as [0,1,0,1])
- test/hook-core.test.ts > 'recursion guard 2: locks/worker.pid against the ppid chain (fake /proc)' > 'a live worker that wrote the pid file is found through the ppid chain; an unrelated chain is not'
- test/hook-core.test.ts > recursion guard 2 > 'a reused pid (the matching ancestor started after the file was written) never disables the hook'
- test/hook-core.test.ts > recursion guard 2 > 'a pid file older than the worker lifetime bound is ignored even when the chain matches' (true at exactly WORKER_PID_MAX_AGE_MS, false at +1 ms)
- test/hook-core.test.ts > recursion guard 2 > 'windows, a garbage pid and a missing file are never disabled'

#### Gates reported by the fixer

- tsc clean: true
- npx vitest run on the affected files: 11 files / 176 tests passed, 0 failed — test/hook-core.test.ts (25, incl. the 5 new), hook-adapters (7), activation-hooks (19), ops-parallel-hooks (3), hook-latency (2), worker-pipeline (13), eval-replay (19), reconcile-replay (23), ledger (43), episode (15), cli-pipeline (7). The replay suites were included because their fixtures carry session_start markers that the correction-window change could have shifted; they are unchanged.

### db (locks, store, db-file)

#### Fixed

- db.lock takeover is not atomic (major): src/db/locks.ts — the takeover never removes or renames the lock directory any more. It is a compare-and-swap on owner.json inside the directory: renameSync(owner.json → owner.json.stale-<pid>-<ms>-<n>) claims the stale record (only one rename can win), the moved copy must equal the inspected record byte-for-byte (heartbeat included: a holder that woke up and refreshed is left alone and the copy is moved back), then the new owner publishes its own owner.json with an exclusive `wx` create. A fresh mkdir is stamped with the same exclusive create, and a contender whose directory or record vanishes under it competes again instead of exiting with a raw ENOENT (the F1 violation the refuters observed). takenOver is set only when this contender's CAS actually succeeded (fixes the over-reporting). Guards for the residual sub-ms windows: the heartbeat never re-stamps an owner.json carrying another identity; LockHandle.stillHeld() (new) is checked by Store.withWriteLock right before the save — a lost lock logs a warning and throws LockBusyError (CLI exit 75), nothing is written, and release() leaves the new owner's lock alone. Store also logs takeovers at info level so they appear in logs/worker.log. Note: a first version that renamed the directory to a tombstone was rejected after the 6-contender race showed a third contender can mkdir the path before the restore (phantom holder); the owner.json CAS has no such hole. Evidence (scratchpad/lockfix/*.mjs against an esbuild bundle of the fixed module): 0 overlapping holds, 0 double takeovers, 0 raw errors, 0 leftovers in 6×30, 3×40 and 2×40 natural trials and 5/5 seam-based trials; the identical scripts against the old dist build reproduce the defect (seam: 153 ms double hold with fast's owner.json replaced; natural 6×15: 1 overlap, 14 double takeovers, 29 raw ENOENT exits). Windows semantics relied on were probed on this volume: renaming owner.json while another process reads it succeeds, wx is exclusive, an inner rename bumps the directory mtime.
- cleanOrphanTmp never visits queue/, state/ or raw/ (minor): src/db/db-file.ts cleanOrphanTmp now sweeps paths.dir, snapshotDir, queueDir, stateDir and rawDir (new exported type OrphanTmpPaths and helper orphanTmpDirectories) with the same TMP_SUFFIX_PATTERN and 10-minute age; Store.withWriteLock and garbageCollectFiles (consolidate.ts) already pass full HarnessPaths, so hook/worker/import/idle-sweep/notify/raw-cache tmp leftovers are now removed per spec §5.8 GC line and §9.4 F1 without touching the dream area. Docs updated: src/db/README.md, src/db/DESIGN_NOTES.md, module header comments.

#### Left to other areas / deliberately not changed

- Part of finding 2's suggested fix — GC of `import-*.json` descriptor files older than raw_hours in garbageCollectFiles (src/dream/consolidate.ts): dream area, not db; left to its owner.
- Part of finding 2's suggested fix — reporting tmp orphans in `hm doctor`: cli area, not db.
- Part of finding 2's suggested fix — adding the locks/ directory to the tmp sweep: unnecessary; owner.json.tmp has no pid suffix (never matches TMP_SUFFIX_PATTERN), lives inside the lock directory and is removed with it on release, and the new stale copies (owner.json.stale-*) likewise vanish with the directory.
- Part of finding 1's suggested fix — logging takenOver in the worker/CLI (src/dream/worker.ts, src/cli): outside the db area; covered instead by Store.withWriteLock logging `stale db.lock taken over for <purpose>` (info) and `db.lock was taken over by … during <purpose>; nothing saved` (warn), which the worker and CLI loggers route into logs/worker.log.
- Two unrelated failures seen once in a mid-task run of other suites (test/consolidate.test.ts idle-sweep turn_key, test/worker-pipeline.test.ts import retry text) are in the dream/worker areas, do not involve locks or tmp cleanup, and passed in the final full-suite run (73/73 files).

#### Files

`src/db/locks.ts`, `src/db/store.ts`, `src/db/db-file.ts`, `src/db/index.ts`, `src/db/README.md`, `src/db/DESIGN_NOTES.md`, `test/db-locks.test.ts`, `test/db-store.test.ts`

#### Tests added

- test/db-locks.test.ts: 'a stale verdict never removes the lock a faster contender has already taken over' (isAlive seam replays the other contender's takeover inside the inspect→remove window; fails on the old rmSync code, which deleted the fresh lock and acquired)
- test/db-locks.test.ts: 'a holder that refreshes its heartbeat right after the stale verdict keeps the lock' (now seam refreshes owner.json between verdict and CAS)
- test/db-locks.test.ts: 'losing the fresh directory between mkdir and the owner write makes the contender compete again' (old code threw raw ENOENT)
- test/db-locks.test.ts: 'the heartbeat never re-stamps owner.json after another owner took the lock over'
- test/db-locks.test.ts: extended 'acquires a free lock…' with stillHeld() true/false, extended 'takes over a lock whose heartbeat is older than staleMs…' to assert no leftovers in locks/ or inside db.lock, extended 'an orphan directory without owner.json…' with an unparsable (crash-torn) owner.json takeover
- test/db-store.test.ts: 'a lock lost to another writer during the callback is detected before the save: nothing is written' (fence → LockBusyError with the intruder as holder, file byte-identical, no snapshot hook, warn line logged, intruder's lock left intact)
- test/db-store.test.ts: extended orphan test to 'removes orphan tmp files older than ten minutes in db, snapshot, queue, state and raw; keeps fresh ones and real files' (old queue/state/notify/raw tmp removed; fresh tmp and real queue/state files kept)

#### Gates reported by the fixer

- tsc clean: true
- npx vitest run test/db-locks.test.ts test/db-store.test.ts: 2 files, 30 tests passed (db-locks 13, db-store 17). Full default suite (npx vitest run --config vitest.config.ts) with the final code: 73/73 test files passed, including consolidate, worker-pipeline, ops-parallel-hooks and cli-doctor-status which consume the changed lock/store/tmp surface.

### embed (helper socket)

#### Fixed

- POSIX embed-helper socket lives under the repo path and exceeds the Unix socket name limit on deep checkouts (src/core/paths.ts:77) — the POSIX socket now mirrors the Windows pipe naming: `embedHelperSocketPath(repoHash, {platform?, env?, tmpDir?})` in C:\Users\choey\harness-memory-repo\src\core\paths.ts returns `$XDG_RUNTIME_DIR/harness-memory-embed-<repoHash>.sock` (falling back to os.tmpdir()), so the path length no longer depends on the repository root (~50–90 bytes, well under sun_path 107/103); `resolvePaths` uses it, Windows keeps `\\.\pipe\harness-memory-embed-<hash>`. Added `unixSocketPathMaxBytes(platform)` (107 Linux / 103 macOS+BSD) and `unixSocketPathTooLong(path, platform)` (UTF-8 byte count) to the core contract. In C:\Users\choey\harness-memory-repo\src\embed\helper.ts `startHelper` now refuses an over-long POSIX socket path loudly before binding (logs `socket path is N bytes, over the M-byte unix socket limit: <path>; exiting`, exit(1)) instead of letting Node 24 fail with a bare EINVAL or Node 20/22 bind to a silently truncated name, and ensures the socket's directory exists (guarded mkdir). The hook and the detached helper compute the same path because providerEnv forwards XDG_* and TMPDIR/TEMP/TMP. Doc comments in paths.ts, helper.ts and client.ts updated.

#### Left to other areas / deliberately not changed

- Finding sub-suggestion 'record the chosen path in the pid file so doctor can report it': not done on purpose — `readPidFile` (src/cli/lib/diagnostics.ts) parses the whole file as one integer, so extra content would break pid detection; the path is deterministic from `resolvePaths`, so doctor can simply print `ctx.paths.embedHelperSocket` (and warn via `unixSocketPathTooLong`) without any pid-file change.
- Finding sub-suggestion 'fail loudly in doctor': src/cli/commands/doctor.ts:286-296 is the cli area, not embed, so it was left untouched. Cross-area request for the cli owner: in the `embeddings` check print `ctx.paths.embedHelperSocket` and, when `process.platform !== 'win32' && unixSocketPathTooLong(ctx.paths.embedHelperSocket)`, report status warn with the byte count (both helpers are exported from src/core/paths.ts). Optional nit: `uninstall --purge` could unlink the runtime-dir socket if one is stale (the helper already unlinks it on clean exit).
- Documentation still names the old location (docs/redesign/phase-b-notes.md:26-27,36 and docs/redesign/v1-explained.ko.md:189 say POSIX `locks/embed-helper.sock`): not in the embed area / owned by the orchestrator; they should now read `$XDG_RUNTIME_DIR/harness-memory-embed-<repoHash>.sock` (else tmpdir).
- Reviewer suggestion to add 'EINVAL' to the client's NO_LISTENER_CODES: skipped — spawning a helper that cannot bind the same path is pointless, and with the short runtime-dir path EINVAL is no longer reachable; the helper-side pre-check is where the condition is now surfaced.

#### Files

`src/core/paths.ts`, `src/embed/helper.ts`, `src/embed/client.ts`, `test/embed-helper.test.ts`

#### Tests added

- test/embed-helper.test.ts > socket location stays under the unix socket path limit > Windows keeps the named pipe keyed by repoHash
- test/embed-helper.test.ts > socket location stays under the unix socket path limit > POSIX uses $XDG_RUNTIME_DIR, else the temp dir, never a path under the repository
- test/embed-helper.test.ts > socket location stays under the unix socket path limit > the socket path length does not depend on the repository path (linux + darwin, ASCII and Hangul deep roots, distinct per repo)
- test/embed-helper.test.ts > socket location stays under the unix socket path limit > unixSocketPathTooLong counts UTF-8 bytes against sizeof(sun_path) - 1 per platform (107/103 boundaries, Hangul bytes, and the review's macOS example at the old location overflows)
- test/embed-helper.test.ts > socket location stays under the unix socket path limit > resolvePaths gives a deep checkout a usable rendezvous point on this platform (pipe on win32; under the limit and outside the root on POSIX — this is the assertion the old code fails on POSIX)
- test/embed-helper.test.ts > socket location stays under the unix socket path limit > the helper refuses an over-long socket path loudly instead of binding to a truncated name (exit 1, one log line with byte count and path, no pid file)

#### Gates reported by the fixer

- tsc clean: true
- Affected files (test/embed-helper.test.ts, test/hook-bundle-imports.test.ts, test/hook-core.test.ts, test/ops-detached-spawn.test.ts, test/cli-doctor-status.test.ts): 5 files / 48 tests passed. Full suite (npx vitest run --config vitest.config.ts): 68 files / 846 tests passed, exit 0. Run on Windows / Node 24.14.0; the POSIX rule is exercised through the injected platform/env options, not on a POSIX box.

### cli (install, doctor, uninstall, paths, settings, registry)

#### Fixed

- [major→minor] `.harness-memory/` never ignored by git (src/cli/commands/install.ts:272). `runInstall` step 1 now writes `.harness-memory/.gitignore` containing `*` right after creating the state directories (`ensureStateGitignore` / `STATE_GITIGNORE_CONTENT` / `stateGitignoreFile` in src/cli/lib/paths.ts), for both scopes and every checkout layout; idempotent (an existing, possibly edited file such as `*\n!skills/` is kept), recorded in the manifest (`ManifestFileRole` gained `git_ignore`) and in `InstallReport.git_ignore` plus a `git …` line in text output. `uninstall --purge` keeps the `.gitignore` when `.bak-v<N>` backups remain (a backup is a full database) and removes it with the directory otherwise. `doctor` gained check `install.state_ignore`: warn with `git rm -r --cached .harness-memory` guidance when `git ls-files` reports tracked files under the directory (new `readGitTrackedFiles` in src/cli/lib/diagnostics.ts: git found via `findExecutable` on PATH and spawned by absolute path, never a shell; null when git or a repository is absent; seam `CliSeams.gitTrackedFiles`), warn when the `.gitignore` is missing, and `doctor --fix` writes it. Chose the in-directory `.gitignore` (vote 2's recommendation) over a second `.git/info/exclude` line: no manifest/uninstall line bookkeeping and it also covers `--user` installs, worktrees and unresolvable pointers. Docs follow-up for the docs area: README.md:89-96 / README.ko.md table could list `.harness-memory/.gitignore`; README.md:230 / README.ko.md:230 'add `.harness-memory/` to .gitignore by hand' is now done by install.
- [minor] `shell: true` spawns (src/cli/commands/install.ts:83, src/cli/lib/settings.ts:295). npm: `defaultRunNpm` now follows `planNpmSpawn` — the `npm-cli.js` bundled with the running node (`bundledNpmCli`: `<node dir>/node_modules/npm/bin/npm-cli.js` or `<node dir>/../lib/node_modules/npm/bin/npm-cli.js`) run through `process.execPath` with no shell and absolute paths; POSIX fallback bare `npm` (execvp, no shell); Windows fallback the absolute `npm.cmd` from PATH as ONE quoted command string with an empty args array (cmd.exe cannot look it up in the cwd, no DEP0190); null → clear 'npm not found' failure. `--with-embeddings` never runs in the project any more: when `ctx.packageRoot` is null install pushes 'npm install @xenova/transformers skipped: the harness-memory package directory was not found …' (exit 1, embeddings off) instead of using `ctx.paths.root`; `RunCliOptions.packageRoot` (src/cli/main.ts) was added so tests can force that case. claude version probe: `detectClaudeVersion` now uses `claudeVersionSpawn(binary, isWindowsShim(binary))` — a `.cmd`/`.bat` shim goes straight to cmd.exe as `"<binary>" --version` (quoted, no args array), everything else is spawned directly. Verified live on this machine: a fake `claude.cmd` under `…\Program Files\claude code\` now returns 9.9.9 where the old code failed with "'C:\…\Program' is not recognized" and emitted DEP0190.
- [minor] `.git/info/exclude` skipped for worktrees and submodules (src/cli/lib/paths.ts:150). `gitExcludeFile` now follows a `.git` pointer file through new `resolveGitDirPointer(root, pointerFile)`: parses `gitdir: <path>` (relative to the work tree), then the gitdir's `commondir` when present (a linked worktree → `<main>/.git/info/exclude`, which git reads for worktrees), else the gitdir itself (a submodule → `.git/modules/<name>/info/exclude`); null only when the pointer cannot be resolved, and `install` then pushes a warning naming `.claude/settings.local.json` instead of staying silent (`gitDirectory(root) !== null && gitExclude === null`). The manifest records the resolved exclude path and `uninstall` now removes the line from `manifest.git_exclude.path` (`removeGitExcludeLine(file)`) rather than recomputing it from the root. `doctor` gained `install.git_exclude` (project scope): warn when the manifest has `git_exclude: null` while `.git` exists (unresolvable pointer), warn when the recorded file no longer carries the line, ok otherwise (`hasGitExcludeLine` shared by install and doctor). Docs follow-up for the docs area: README.md:94 / README.ko.md:94 'skipped when `.git` is a worktree file' is now stale.
- [minor] Registry usage strings lag the OptionSpecs (src/cli/registry.ts). Updated twelve synopses so `hm <cmd> --help` names every declared flag: install (--hook-form auto|exec|shell --hook-script --skip-probe --skip-self-test), uninstall (--user), doctor (--self-test --hook-script), proposals:accept (--note, which the finding missed), memory:list (--source --scope --unconfirmed --contested), memory:add (eight flags), memory:export-skill (--min-confidence --min-importance), memory:why (--input --permission-mode), trace (--host), import (--provider), eval:latency (--runs --threshold --memories --large --hook-script), eval:replay (--scenario --fixtures --keep --verbose). The strings match the synopses both READMEs already carry, so test/docs-cli-reference.test.ts is unchanged and green. Fixed despite one 'refuted' vote: the drift is factual, the project's own synopsis style enumerates flags, and new test/cli-registry.test.ts now pins usage ⊇ options (and usage flags ⊆ accepted options, so a typo in a synopsis is caught too).

#### Files

`src/cli/commands/install.ts`, `src/cli/commands/uninstall.ts`, `src/cli/commands/doctor.ts`, `src/cli/lib/paths.ts`, `src/cli/lib/settings.ts`, `src/cli/lib/diagnostics.ts`, `src/cli/lib/manifest.ts`, `src/cli/main.ts`, `src/cli/context.ts`, `src/cli/registry.ts`, `test/cli-install.test.ts`, `test/cli-settings.test.ts`, `test/cli-doctor-status.test.ts`, `test/cli-paths.test.ts`, `test/cli-registry.test.ts`

#### Tests added

- test/cli-paths.test.ts (new): gitExcludeFile for a plain checkout, a linked worktree pointer + commondir, a submodule's relative pointer, a dangling pointer and a non-pointer .git file; hasGitExcludeLine; ensureStateGitignore writes `*` once and keeps an edited file; findExecutable returns the first PATH hit as an absolute path or null
- test/cli-registry.test.ts (new): every declared option appears in its command's usage synopsis; every usage flag is an option the dispatcher accepts; `hm eval:replay --help` / `hm install --help` first line carries the flags
- test/cli-install.test.ts: install reports/records `.harness-memory/.gitignire` (report.git_ignore, manifest role git_ignore, file content `*`); an edited .gitignore is kept on re-install; `--user` still writes it; a worktree `.git` pointer puts the exclude line into the main repository's info/exclude and uninstall removes it there; an unresolvable pointer yields git_exclude null plus a warning; `--with-embeddings` with packageRoot null never calls npm (exit 1, 'skipped' warning); `--purge` keeps .gitignore alongside .bak-v<N> backups and removes the whole directory when there are none; planNpmSpawn/bundledNpmCli: bundled npm-cli.js via node without a shell (Windows and POSIX layouts), Windows fallback is the absolute PATH npm.cmd as one quoted command string, null without npm, POSIX bare npm
- test/cli-settings.test.ts: claudeVersionSpawn / isWindowsShim shapes (quoted .cmd command string with empty args, direct spawn otherwise); detectClaudeVersion against a fake shim installed under a path with a space (`claude.cmd` on Windows, sh script elsewhere) via HARNESS_MEMORY_CLAUDE_BIN returns the version — fails on the pre-fix code
- test/cli-doctor-status.test.ts: install.state_ignore ok / warn with tracked files (seam) / warn when .gitignore missing; install.git_exclude ok / warn when the line vanished; `doctor --fix` writes the missing .gitignore; readGitTrackedFiles returns null outside a repository (and lists tracked paths inside this checkout when git is available)

#### Gates reported by the fixer

- tsc clean: true
- npx vitest run on all 14 CLI test files (test/cli-*.test.ts incl. the two new ones) + test/docs-cli-reference.test.ts: 14 files, 113 tests passed, 0 failed (3.3 s). `npx tsc --noEmit -p tsconfig.json`: no errors in src/cli/** or test/cli-*; the only errors reported are in src/dream/worker.ts (dream area, being edited in parallel: missing consolidate exports / embedCursor), not touched.

## Orchestrator integration (cross-module requests)

The fixers were confined to their areas; these requests crossed area lines and were applied by the orchestrator after the workflow, each with a test:

- **ledger `deriveTailState`** (dream ← activation): `rule:<code>|tool` keys for rule-only `fired` lines, so a manual `soft_deny` / `confirm` rule (memory_id NULL) fires once per turn like a memory and the same-turn retry is suppressed as `already_fired` (test/ledger.test.ts; test/hook-core.test.ts manual-rule scenario).
- **reconcile `decideTiers`** (dream ← core): passes `scanSafe: scanMemoryContent(summary, details).safe`, so a pre-0.6 or imported candidate whose stored text fails the scanner is reinforced but never auto-activated (`tier=candidate:security`; test/reconcile-replay.test.ts).
- **consolidate `fixSignatureProposals`** (dream ← promotion): default 30-day reject skip instead of `rejectSkipDays: 0`, so a human who rejected the fix is not asked again at every dream; the `revalidate` call keeps 0 with a comment (a rejected revalidate stales the row, so it leaves the query) (test/consolidate.test.ts).
- **consolidate `garbageCollectFiles`** (dream ← db): removes `import-<pid>-<ts>.json` descriptors older than `retention.raw_hours` from `.harness-memory/` (a crashed `hm import` leaves them) and adds them to the `tmp` count (test/consolidate.test.ts GC test).
- **doctor `embeddings` check** (cli ← embed): prints `rendezvous <path>` and turns the check to `warn` when a POSIX socket path is over `sizeof(sun_path)`, with the XDG_RUNTIME_DIR / TMPDIR hint (test/cli-doctor-status.test.ts).
- **`src/hook-launch.ts`** (hooks ← core): `uncaughtException` / `unhandledRejection` listeners keep exit 0 after `main()` returned (18 lines, still under the 20-line pin in test/hook-bundle-imports.test.ts).
- **Docs named by the fixers**: README / README.ko (`.harness-memory/.gitignore` row, worktree / submodule pointer resolution, the redaction shape list, Korean injection cues and data fences, helper socket location), `docs/redesign/upgrade-from-0.5.md` (`fix_scope` acceptance refuses without a payload), CHANGELOG (a "Fixed (Phase D adversarial review)" section; known limitations rewritten for the pid guard, the latency number and the payload-less proposals). The docs test rejected `git rm -r --cached` as an unknown `hm` flag on the `.gitignore` row, so the row now says "prints the git command that untracks them".

### Deliberately left for later (also in CHANGELOG known limitations and v1-explained §11)

- `worker.pid` written through tmp + rename and removed on SIGTERM (the hook-side validation — 2 h age bound, start-time check — makes a stale file harmless, so the worker side was not touched).
- An `hm review` editor for `fix_scope` / `fix_signature` payloads (today: reject the proposal, or add a new row with `hm memory:add … --active`).
- A shared `closeIdleTurn` helper and a single `IDLE_TURN_MS` for hook-core and the worker sweep (semantics aligned in Phase D, code still duplicated).
- Defense-in-depth re-redaction in `ledger.ts prepareLine` for `scope_refs` / `failure_sig` / `program_token` (the fields are redacted and bounded at the source now).
- `hm eval:latency` per-tool percentiles (Bash vs Edit).
- A dedicated `describeDomainError` hint for `ProposalNotApplicableError` (it inherits the transition hint; the message itself carries the guidance).
- A `supersede` proposal whose candidate expired stays in `hm review` until rejected or expired (acceptance is refused, so no data loss).
- The `reindex` half of the worker.lock finding (reindex exits busy while another worker runs) — both refuters showed every saved write session rebuilds the snapshot, so no storm materializes.

## Final gates (2026-11-08, Windows 11, Node 24.14.0, after integration)

- `npx tsc --noEmit -p tsconfig.json`: 0 errors.
- `npm test`: 73 files / 990 tests passed (Phase C: 68 / 839; new files `core-signals`, `core-process`, `policy-engine-snapshot`, `cli-paths`, `cli-registry`). `npm run test:latency`: 9 tests passed (dist pre-tool p95 85.8 ms inside the 180 ms soft bound).
- `npm run build`: `dist/hook.js` 0.4 KB, `hook-bundle.js` 153.9 KB, `worker.js` 379.4 KB, `embed-helper.js` 22.3 KB, `bin/harness-memory.js` 798.5 KB.
- `hm eval:replay`: 12/12 scenarios, 314/314 checks, 178 hook calls in 2.07 s.
- `hm eval:latency` (300 memories × 50 spawned `pre-tool` hooks), three runs: min 72.6–74.0 / p50 77.1–78.2 / **p95 84.5–87.0** / max 88.7–90.8 ms — inside the 90 ms gate (Phase C: p95 93–96). The gain is the PolicyEngine fix (no minimatch load, no regex-safety sampling per hook process); Node start-up (≈ 50 ms) remains the floor.
- Temp-project smoke against the built dist (`scratchpad/smoke-d.sh`): `hm install --host claude` (9 exec-form hooks, `.harness-memory/.gitignore`, `.git/info/exclude` line, probe `not_logged_in` with guidance, self-test 79 ms) → 12 hook calls (startup, failed turn, correction turn with `pnpm test`, `.env` write, precompact, session-end) all exit 0 → two episodes queued (evidence weights 1 and 2, correction flag set on the second prompt) → three detached workers (`extract` ×2, `dream`) each stop at `waiting=not_logged_in` without burning attempts → `hm status` / `hm queue` / `hm doctor` (15 ok, 2 warnings for the probe, 0 failures; `install.state_ignore` and `install.git_exclude` ok; hook-internal pre-tool p95 9 ms) → `git status` shows only the project's own files → `hm uninstall` removes the 9 entries, the exclude line and the manifest and keeps `.harness-memory/`.
- Not exercised on this machine: live `claude -p` extraction (CLI not logged in), the POSIX socket / `/proc` paths (covered by injected-platform unit tests only), `npm install @xenova/transformers` (seam tests).
