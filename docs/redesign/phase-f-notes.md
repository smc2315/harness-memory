# Phase F — direction A′ (decided 2026-11-08 night)

The positioning research (`positioning-2026-11.md`) ended with four directions; the author chose **A′**:

1. **Autonomy ladder.** Auto-learned rules are born at `advise` and climb to `soft_deny` only when a second session
   reinforces them (`before_tool.auto_escalation`, default `{ enabled: true, sessions: 2 }`); `autonomy_level:
   shadow` caps auto rows at advise. The override downgrade stays the way down. The default of
   `before_tool.auto_enforcement` changes from `soft_deny` to `advise`.
2. **Remember-as-human.** A fact extracted from a turn the ledger flagged `remember=1` ("기억해", "remember this"),
   citing that prompt line, is created as a human-authority row, active at once, `status_reason: remember`, with the
   type's human default enforcement (policy → confirm, pitfall with signature → soft_deny, else advise). The session
   start digest names such rows for 24 h with the `hm memory:demote` undo. The user's words are the approval; V6 /
   V8 / V12 still apply.
3. **Recall layer.** Every episode keeps a summary (the extractor's `episode_summary`, or a deterministic one for
   skipped episodes), published in `snapshot/recall.v1.json`, searchable with `hm recall`, and injected at
   UserPromptSubmit as at most two plain-context items after the memories — never enforced, never on PreToolUse.
4. **Login optional, native auto memory as an import source.** Imported rules enforce without the CLI login; learning
   from sessions starts after `claude auth login` (the messaging says so). `hm import --from auto-memory` turns Claude
   Code's `~/.claude/projects/<slug>/memory/*.md` feedback notes into human rows like CLAUDE.md bullets.

Implementation ran as workflow `hm-v06-phase-f` (run `wf_8d8b8ba7-e41`): three build streams with strict file
ownership (L ladder + remember, R recall, M import + login), two reviewers and a fixer per stream, then orchestrator
integration. Results, gates and deviations follow once the streams report.

## Decisions taken while the streams ran

- **Recall ships dark.** The recall layer is built as briefed, but `recall.enabled` defaults to `false` until the
  dogfood shows that "what was that last time" is actually missed; the ladder and remember-as-human are on by default
  because they answer problems the author hit. (Process rule: a feature nobody asked for does not get a default-on.)
- **No gstack.** Garry Tan's skill pack was considered for the development process and declined: its review skills
  overlap what the adversarial workflows already do, its QA / browse / ship skills assume a web product, and the real
  weaknesses of this project's process were sequencing and scope, not review depth. Three practices are borrowed
  instead: a "CEO question" at the start of every phase (what is the ten-out-of-ten outcome for the user, what can
  wait until a user asks), a **live scenario** as the closing gate of every phase (replay alone is not enough — the
  four live-run bugs of Phase E were all invisible to tests), and a fixed pre-commit checklist (docs, CHANGELOG,
  tests, gates, notes, script expectations) run by an agent.

## What was built

- **Stream L.** `before_tool.auto_enforcement` default `advise`; `before_tool.auto_escalation { enabled: true,
  sessions: 2 }`; `src/promotion/escalation.ts` raises an active auto `advise` pitfall (signature, knowledge_kind
  correction | failure_resolution) to `soft_deny` when its evidence spans two sessions, recorded as an
  `active (enforcement)` transition by `auto_rule` plus an audit row; `shadow` / `off` never climb; a row downgraded
  by overrides is not re-escalated by the overriding session. `src/promotion/remember.ts`: an explicit-request
  detector separate from the evidence-weight flag (recall talk such as "I don't remember whether …" is stripped
  first; an imperative cue must remain), `citesRememberPrompt`, `rememberEnforcement` (policy → `hard_policy`,
  pitfall with signature → `soft_deny`, else `advise`), at most two remember creates per turn, twin adoption for
  already-stored rows (`adoptActiveMemory`), the 24-hour session-start notice with the `hm memory:demote` undo,
  `[remember]` tag, history / show labels. Replay scenarios updated; new **s13** (remember turn → immediately active
  human rule → the next session is told and asked). The reviewers' blocker ("human-authority gate too weak") led to
  the detector and the per-turn cap.
- **Stream R.** Migration 022 (`summary`, `summary_kind` on `episodes`, `user_version` 22); every episode gets a
  deterministic summary at insert (`src/dream/recall-summary.ts`) and the extractor's `episode_summary` replaces it —
  after the same content scanner that guards memory text (a reviewer caught that free LLM text was about to be
  injected into other sessions unscanned); import episodes never enter recall. `snapshot/recall.v1.json` with a
  serialized MiniSearch index; `src/activation/recall.ts`; `activateBeforeModel` appends ≤ 2 recall items within
  1 KB after the memories, never on PreToolUse (a hot-path test wraps `node:fs` and asserts PreToolUse never opens
  the recall or lexical files); `hm recall`; `hm status` `recall N episodes`. Measured prompt-hook cost of the recall
  leg: median 3.6–4.2 ms, index build moved to snapshot time (12 ms in-hook otherwise).
- **Stream M.** `src/cli/lib/auto-memory.ts` locates `~/.claude/projects/<slug>/memory/` (slug = every character
  outside `[A-Za-z0-9]` → `-`, verified against three real directories on this machine, with realpath / case / sub-
  directory fallbacks and `--memory-dir`), parses frontmatter (BOM, quoted and block scalars), filters `type:
  feedback` (+ `project` on request), turns bodies into bullets following Claude Code's own feedback-note template,
  and feeds the unchanged import pipeline with `source_ref = import:auto-memory:<file>#L<n>`; directory-wide `--sync`
  with protected prefixes; `MEMORY.md` is never imported and `isHostLoadedFile` now recognises it. Bullets still
  queued because no extraction CLI answered become verbatim `advise` rows (typed later), which is what made the
  login-optional sentence true. `hm install` reports the notes and suggests the import.
- **Orchestrator.** Cross-stream requests applied (worker report counts, `memory:stats` filters, snapshot rebuild /
  rollback listings, schema row type, `sourceFileOf`, host-loaded rule), V3 lets a remember create carry a
  repository-wide glob without a signature, `recall.enabled` default **false**, stale test pins, READMEs (the
  headline example now ends in advice, then soft_deny after a second session), CHANGELOG, upgrade notes (022).

## Live scenario (real `claude -p`, `scratchpad/live-smoke-f.sh`)

| Step | Observed |
|---|---|
| Session A: `npm test` fails → "no, use pnpm test instead" → `pnpm test` passes | the pitfall is created then activated at **advise** (evidence 3, two episodes) |
| Session A: "앞으로 이 프로젝트에서는 커밋하기 전에 꼭 pnpm lint를 돌려. 기억해." | a **human policy at confirm**, active at once, `[remember]`; worker line `remembered=1` |
| Session B start | `systemMessage: "harness-memory: 1 rule from your request is active — Run pnpm lint before every git commit … (undo: hm memory:demote c9a99848)"` |
| Session B `npm test` / `pnpm test` / `git commit` | `additionalContext` (advise) / nothing / `permissionDecision: "ask"` with the policy text |
| Session B repeats the failure → correction | worker line `escalated=1`; `hm memory:history`: `active (enforcement) by auto_rule auto_escalation: advise → soft_deny (2 sessions)` |
| Session C `npm test` / `pnpm test` | **deny** / nothing |
| `hm recall "npm test"` | "recall is disabled (config.json: recall.enabled = false)", exit 0; after enabling and `hm snapshot:rebuild` (recall.v1.json 4.1 KB): 3 of 5 episodes with the extractor's summaries, `hm status` shows `recall 5 episodes`, a new session's prompt receives two `RECALL 2026-11-08: …` lines |
| `hm import --from auto-memory --memory-dir <this session's memory> --include-project --dry-run` | 1 note → 19 bullets, `MEMORY.md` skipped as the index file |
| `hm doctor` | 18 ok, 0 warnings, 0 failures |

Five extraction calls, $0.031–0.051 each on the `sonnet` alias (resolved to `claude-sonnet-4-6`).

## Gates (final tree)

- `npx tsc --noEmit`: 0 errors. `hm eval:replay`: 13 / 13 scenarios, 350 / 350 checks. `test/docs-cli-reference`:
  both READMEs match the registry (34 commands). Recall suites green with recall enabled explicitly plus one
  dark-default test. Full `npm test` on the final tree: 81 files, 1152 tests passed, 1 todo (Phase E: 73 files / 996).
- `hm eval:latency` read p95 116 ms during this phase with the same background load as the evening's other runs
  (min 96 ms); the PreToolUse path gained nothing (hot-path test), so the number is the machine, not the code.

## Open after Phase F

- The twin-adoption path, escalation after audit pruning (30 d) and the digest's daily throttle are documented
  edge cases, not fixed (stream L's open issues).
- Episodes closed before migration 022 have no summary (no backfill).
- `hm recall` is lexical only; dense recall over summaries is not built.
- MCP / skill exposure of `hm recall` and `hm memory:why` (the lesson from gstack's distribution) is not started.
- Dogfood has not started; the autonomy ladder's thresholds (two sessions) and the remember detector's recall are
  untested on real days.

## CI follow-up (first GitHub Actions run 2026-11-08, fix 2026-11-09)

Run 42489023967 on `redesign/v0.6`, the first run of `.github/workflows/ci.yml`: Windows and package-verify green;
ubuntu Node 24 / 20 and macOS red on two tests. No product bug in the hooks; behind the tests one validator defect
(V5, which the worker's extraction validator, the snapshot builder, `hm memory:add` and the proposal fixes run) and
one import edge case. Four adversarial review workflows (`review-ci-fix`, `-v2`, `-v3`, `-v4`) ran on the fix; each
caught something real, recorded below, and the fourth's remaining nits are listed at the end as known limits.

- **`locateAutoMemory` case test.** The case-different-root test expected `null` on a case-sensitive volume. The
  `scan_case` fallback (case-insensitive match over `<projects>/*/memory`) finds the canonical directory there, which
  is what an idempotent import wants. The test now flips only the project's basename and expects `derived` when the
  variant's own derived directory exists (case-insensitive volume) and `scan_case` otherwise — same directory, refs
  and `--sync` prefix either way. The reviews found two real gaps behind it: on a case-insensitive **Linux** mount
  (WSL `/mnt/c`, ext4 casefold, CIFS) `realpath(3)` keeps the caller's spelling, so `canonicalDirectory` alone did
  not fold the case — `found` now takes the slug's on-disk name from the projects listing (exact match first, then
  case-insensitive); and that listing skipped symlinked / junctioned project directories, so the exact match could
  miss and the fallback pick a case-variant sibling — the listing now includes them (regression test with a
  junction on Windows, a symlink elsewhere). An explicit `--memory-dir` is still realpath-only; its docstring says so.
- **V5 time budget.** `curl .* \| (ba)?sh` was rejected with `exceeded 2 ms` on macOS (Node 24) and ubuntu (Node 20)
  while ubuntu Node 24 passed. The first diagnosis was wrong: a timing script written through the shell lost the
  backslash, measured the alternation `curl .* | (ba)?sh` (0.02 ms) and blamed a scheduler stall; the first review
  caught it. The real pattern is quadratic on V5's seed sample — `regexSamples` strips `\|`, so the 4 KB sample is
  `curl   bash` × 372 without a pipe and `.*` backtracks to the end from every `curl ` — at 0.75–0.95 ms per sweep
  on the author's machine; the sibling quadratic-rejection test shows the failing runners were 2–3.5× slower (75 /
  132 ms against 37 ms here), and on a 4-vCPU runner with vitest's workers and the spawned hook processes a round
  longer than one scheduler slice (≈ 2–3 ms) always carries a wait, so every round of the old two-round loop was
  over 2 ms there. A fixed millisecond line makes V5's verdict depend on the machine that runs the worker — a
  validator defect, not a test problem.

  **Fix: a machine-relative budget on a ladder, against a reference of the same shape.** `checkRegexSafety` runs
  the samples at 128 B, 256 B, 512 B, 1 KB, 2 KB and 4 KB (`REGEX_STAGE_BYTES`). At each stage one timed sweep within
  the floor (`REGEX_BUDGET_MS` = 2 ms at 4 KB, scaled with the sample below) passes at once — the common case,
  microseconds. Otherwise the reference pattern `ref .*\.x` (`REGEX_REFERENCE_SOURCE`: a literal prefix, `.*` and an
  escaped literal its samples cannot contain, so it backtracks to the end from every prefix the way the accepted
  fixtures do) is swept over its own samples of the same size in the same process, with a timed round as long as the
  candidate's first sweep, and the pattern passes when the fastest of `REGEX_BUDGET_ROUNDS` = 5 sweeps is within
  `REGEX_BUDGET_RATIO` = 2.5× that reference; a first sweep beyond 50× the budget (and 250 ms) is refused at once.
  Before any sample runs, the static check refuses more than `REGEX_AMBIGUOUS_LIMIT` = 3 ambiguous quantifiers in one
  alternative — atoms with a choice whose class can begin what must follow them. The samples are letter, digit and
  space runs, a mixed text, the pattern's literal text repeated, and that text without its last word padded with
  spaces to three times its length and repeated (`regexSamples`).

  What the four review rounds added. Round 2: a microsecond-scale reference slips into clean scheduler slices while
  a candidate round longer than a slice never does, so at 6:1 oversubscription a linear-scan reference inflated the
  ratio 4–6× — the reference's timed round is sized to the candidate's. Rounds 2 and 3: with two stages (512 B, 4 KB)
  a cubic or quartic pattern that passes the static check held the validator for 0.5–1.6 s, and even a ladder from
  512 B let a dense degree-6 pattern run 13.5 s — hence the 128 B start and the hopeless cutoff. Round 4: a sweep
  cannot be interrupted and repeated-literal chains such as `a.*a.*a.*a.*a\.b` are C(N, k) on a dense sample (one
  128 B sweep: 1.1 s; one more `.*`: minutes), so only a static cap bounds them — `REGEX_AMBIGUOUS_LIMIT`; the
  samples were not adversarial for `prefix .* a .* b` shapes whose full literal text matches at once, nor for
  digit-run quadratics — hence the sparse truncated-literal sample and the digit runs (`\d+\s+\d+` is now refused
  like `[a-z]+\s+[0-9]+`); and HEAD had dropped the matched round length — restored. The first calibration on the
  CI matrix (`calibrate.yml`, run 42505220909) is why the reference is a pattern and not a linear scan: with `[a-z]!`
  the accepted fixtures cost 76–179× on x64 (ubuntu, Windows, Intel macOS, the author's desktop) but 342–523× on
  the Apple M1 runner, which refused `cat .*\.env`, while the cost of `cat .*\.env` relative to `[a-z]+[0-9]*\s+x`
  stayed within 1.6× across every native environment (0.060–0.098).

  Against the reference on the author's x64 desktop (4 KB, min of five sweeps; `scripts/regex-budget-calibration.mjs`):
  `curl .* \| (ba)?sh` 0.48×, `cat .*\.env` 0.88×, `curl .*\|.*sh` 0.77×; `[a-z]+\s+[0-9]+`, `[a-z]+[0-9]*\s+x` and
  `\d+\s+\d+` 7.2–7.7×, `.*\.env.*` 27×, `echo .* > .*\.env` 53×, `docker .* run .* -v .* /var/run/docker\.sock`
  237×; with the interpreter forced 0.65–0.82× against 9.7–10×. The reference sweeps its 4 KB samples in 2.4–2.8 ms
  here. The 2.5× line sits at the geometric middle: ≈ 2.8× margin to the costliest accepted fixture and ≈ 2.9× to
  the cheapest refused one. A pattern of the accepted shape costs ≈ 5 / (length of its literal text), so a
  2-character literal sits on the line; `sudo .* apt(-get)? .* install` — two `.*` before a literal the sparse sample
  lacks — is ≈ 2.7× and flips, which is why it is measured but not a fixture.

    The per-runner ratios against this reference come from the `calibrate.yml` run on this commit and are recorded here in
  the follow-up commit.

  Superseded calibration against a linear scan (4 KB, min of five sweeps, ms per sweep and ratio to `[a-z]!`, which
  is 0.0076–0.0089 ms native and 0.087–0.10 ms interpreted on x64; `ci-fix/calib-*.log`; the last three rows are the
  Apple M1 runner, native, from run 42505220909):

  | pattern | Windows Node 24 | WSL Node 24 | WSL Node 20 | `--regexp-interpret-all` (all three) |
  |---|---|---|---|---|
  | `curl .* \| (ba)?sh` | 0.81 ms, 90× | 0.75 ms, 98× | 0.78 ms, 102× | 3.3–3.7 ms, 34–43× |
  | `cat .*\.env` | 1.60 ms, 179× | 1.33 ms, 175× | 1.29 ms, 168× | 4.7–5.2 ms, 46–58× |
  | `curl .*\|.*sh` | 1.52 ms, 170× | 1.17 ms, 154× | 1.30 ms, 171× | 4.8–5.5 ms, 53–63× |
  | `[a-z]+\s+[0-9]+` — rejected | 17.6 ms, 1 968× | 17.9 ms, 2 356× | 21.0 ms, 2 748× | 110–126 ms, 1 198–1 402× |
  | `[a-z]+[0-9]*\s+x` — rejected | 17.0 ms, 1 904× | 19.1 ms, 2 505× | 21.5 ms, 2 813× | 112–115 ms, 1 147–1 283× |
  | `.*\.env.*` — rejected | 43.7 ms, 4 895× | 46.1 ms, 6 053× | 51.2 ms, 6 690× | 177–193 ms, 1 759–2 220× |
  | `echo .* > .*\.env` — rejected (cubic) | 107 ms, 11 944× | 108 ms, 14 250× | 135 ms, 17 630× | 402–465 ms, 4 066–5 344× |
  | M1: `curl .* \| (ba)?sh` | 2.86 ms, 342× | | | |
  | M1: `cat .*\.env` | 4.37 ms, 523× | | | |
  | M1: `[a-z]+[0-9]*\s+x` — rejected | 61.4 ms, 7 342× | | | |

  Every other pattern the `accepts` list held before is linear on all the samples; `curl .* \| (ba)?sh` was its one
  quadratic fixture. Cost through the real `checkRegexSafety` on the author's desktop: patterns within the floor
  0.1–1 ms; the accepted over-floor patterns 1.6–3 ms when the first 4 KB sweep is inside the floor and ≈ 25–40 ms
  when it is not (one sweep plus the quick and the matched reference rounds); the refused ones 0.7–5.5 ms for the
  quadratic fixtures (128–512 B), 28–31 ms for the quartic `docker` fixture (1 KB), 2.6–2.8 ms for the dense
  degree-4 chain (128 B) and ≈ 200 ms for the three-link repeated-literal chain `a.*a.*a.*a\.b` (its 38 ms first sweep
  at 128 B times five rounds — the most the static cap lets through), 0 ms for the statically refused ones — against
  ≈ 35–105 ms for the old loop's two 4 KB rounds on the quadratic pair and 0.3–13.5 s on the dense patterns. Paid
  wherever `compileSignature` runs in the worker or the CLI; the hooks never sample — PreToolUse matches through the
  `regex_source` the snapshot builder compiled — except for a hand-written manual rule with an `arg_pattern`, which
  `PolicyEngine` compiles once per process. Tests: the loop with an injected clock (fastest round wins, early exit,
  passes), the floor and ratio helpers and the ladder constants, the reference (itself V5-safe), `cat .*\.env` /
  `curl .*\|.*sh` as the regression for the ratio, the every-position trio refused at whatever stage the machine
  reaches, the quartic `docker` fixture and the three-link chain refused below 4 KB within a bounded time, and the
  static cap on four chains.

  Known limits after round 4: a 2-character-literal pattern of the accepted shape (`cd.*\.\.`) sits on the 2.5× line
  and is not reliably accepted; `prefix .* a .* b` shapes with a long prefix are on the line too; the per-stage ratio
  of a quadratic pattern varies within ≈ 2×, so the stage that refuses it is machine-dependent (the tests do not pin
  it); the verdict is still a timing, so a stall longer than REGEX_HOPELESS_MS on a first sweep refuses a pattern
  that a retry would accept.
- **Process.** Four lessons: a timing claim needs the exact pattern bytes it was measured on (write measurement
  scripts with the editor, never through a shell that rewrites backslashes); a failure on two runners of different
  OS and Node version is a sustained factor until proven otherwise; a budget measured in microseconds cannot be
  compared with one measured in milliseconds on a loaded host; and a bound claimed for a class of patterns must be
  measured on its dense member, not on two sparse fixtures. The Windows checkout is CRLF (`core.autocrlf = true`);
  patch scripts with multi-line anchors must normalise line endings before matching.
- **Gates after the fix.** `npx tsc --noEmit` 0 errors. Windows (Node 24.14): `npm test` 81 files / 1161 tests passed (1 todo), `hm eval:replay` 13 / 13 scenarios, 350 / 350 checks. Linux (WSL Ubuntu-22.04, Node 24.14): 80 files passed + 1 skipped (1157 tests, 4 skipped), eval:replay 350 / 350, `hm eval:latency` p95 55–68 ms over three runs, `npm run test:latency` 9 / 9. The recall-cost median test (`test/recall-hook.test.ts`, 10 ms line) failed twice during the day while review agents ran benchmarks on this machine; it passes alone and on an idle machine, and CI judges it against 25 ms. CI and calibration results for this commit are recorded with the per-runner table above.
