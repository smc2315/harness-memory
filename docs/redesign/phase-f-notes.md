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

    On the CI matrix (`calibrate.yml` run 42510808939 on 21b9b0c; 4 KB, min of five sweeps, ratio to the reference,
  native / `--regexp-interpret-all`; the `.*\.env.*` interpreter cell is skipped where its 512 B sweep is already over
  5 ms) every verdict came out as expected, and the CI run 42510808824 on the same commit was green on all five jobs:

  | runner | reference | `curl .* \| (ba)?sh` | `cat .*\.env` | `curl .*\|.*sh` | `[a-z]+\s+[0-9]+`, `[a-z]+[0-9]*\s+x` | `.*\.env.*` | `echo .* > .*\.env` | `docker .* run .* -v .* /var/run/docker\.sock` | `sudo .* apt(-get)? .* install` (border) |
  |---|---|---|---|---|---|---|---|---|---|
  | ubuntu x64 (EPYC 7763) | 4.10 / 16.5 ms | 0.49 / 0.76 | 0.80 / 0.90 | 0.74 / 0.97 | 6.8–7.7 / 10–11 | 25 / — | 46 / 51 | 171 / 207 | 2.37 / 4.24 |
  | Windows x64 (EPYC 9V45) | 2.26 / 10.5 ms | 0.49 / 0.64 | 0.80 / 0.70 | 0.56 / 0.76 | 5.1–6.5 / 11 | 22 / 22 | 37 / 47 | 160 / 171 | 2.47 / 3.74 |
  | macOS x64 (i7-8700B) | 4.82 / 15.2 ms | 0.55 / 0.81 | 0.90 / 0.75 | 0.84 / 0.67 | 6.5–6.8 / 8.6–8.9 | 26 / — | 57 / 41 | 170 / 169 | 2.37 / 2.55 |
  | macOS arm64 (M1) | 8.23 / 12.6 ms | 0.47 / 0.68 | 0.81 / 0.83 | 0.91 / 0.83 | 7.5–7.6 / 11–12 | 26 / — | 59 / 65 | 155 / 265 | 2.55 / 4.51 |
  | author's desktop x64 (7800X3D) | 2.36 ms | 0.48 | 0.88 | 0.77 | 7.2–7.7 | 27 | 53 | 237 | 2.74 |

  The 2.5× line keeps ≥ 2.6× margin to the costliest accepted fixture (0.97×, ubuntu with the interpreter; 0.91×
  natively) and ≥ 2.0× to the cheapest refused one (5.1×, Windows native; ≥ 2.6× everywhere else), on every
  architecture; the borderline `sudo` pattern flips between 2.4× and 4.5× as expected. The arm64 runner was an M1
  this time (3.5× slower than the M2 Pro of the earlier run); the ratios did not move — which is the point.

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

## Fresh-machine verification and the pre-release (2026-11-09)

The author will run the build on another computer, so the question moved from "does the suite pass here" to "does the
packed tarball install and work on a machine that is not this one". npm `latest` is still 0.5.1 (the OpenCode plugin) and
this machine is not logged in to npm, so the distribution for the rc is a GitHub pre-release with the tarball attached
(`npm install -g https://github.com/smc2315/harness-memory/releases/download/v0.6.0-rc.1/harness-memory-0.6.0-rc.1.tgz`);
installing from git does not work because the build runs only in `prepack`, and adding `prepare` would make every git
install pull the devDependencies (`@xenova/transformers` with onnxruntime and sharp among them). `npm publish --tag next`
stays the author's step (`docs/setup-new-machine.ko.md` §10).

### What was run

One workflow, ten agents, 46 minutes, nothing in the repository modified by them:

- **Windows 11 / Node 24.14.0** — the tarball (sha1 73e5248893c3078f91e4f3b3753dc72423137e7a, 86 files, 3.3 MB packed /
  13.2 MB unpacked, runtime deps minimatch · minisearch · sql.js) into `npm install -g --prefix <tmp>`: 23 steps, 23 ok.
  `hm.cmd`, the `hm` sh shim and `hm.ps1` all print 0.6.0-rc.1; under the Windows-default execution policy (Restricted,
  simulated with `-ExecutionPolicy Restricted`) `hm.ps1` is refused exactly like npm's own `npm.ps1`, RemoteSigned and
  `hm.cmd` work. Project A: real probe `ok` (4.9 s including the probe, detected `claude 2.1.317` through
  `CLAUDE_CODE_EXECPATH` because the tester ran inside the desktop app), `database … v22 (migrated from v0)`, self-test
  105 ms, `hm doctor` 15 ok / 0 warn; `hm memory:add --type policy --summary "…" --signature "bash:command:cmd:npm test" --enforce deny
  --active` rebuilt the snapshot itself, `pre-tool` on Bash `npm test` → `permissionDecision: deny` with the policy text,
  `pnpm test` → `{}` (signature_mismatch); five PreToolUse calls 93–98 ms wall, 10–15 ms inside the hook (bare
  `node -e 0` ≈ 72–79 ms, Defender real-time on). Project B at `<tmp>\프로젝트 테스트`: installed, self-tested, one
  hook call, uninstalled; the Korean path appears only in `install-manifest.json`, as UTF-8, round-tripping exactly.
  Project C with the real v9 fixture: `v22 (migrated from v9, backup memory.sqlite.bak-v9)`, backup byte-identical,
  active 12 / candidates 1 / proposals 2. Project D `--with-embeddings`: exit 0 in 17.3 s, but see F3.
- **WSL2 Ubuntu 22.04 / Node 24.14.0 and 20.20.2** (user-space tarball nodes): 20 steps, 19 ok; the one failure was
  systemd-tmpfiles wiping `/tmp` between separate `wsl --` invocations (the distro stops when the last client exits) — an
  environment trap, recorded in the README's WSL bullet (keep the prefix out of `/tmp`). Real probe `not_logged_in` with the
  guidance text as designed (2.07 s including the probe), `deny` on `npm test` / `git status && npm test` /
  `npm test -- --watch`, `{}` on `pnpm test`; PreToolUse 49–56 ms wall / 8–10 ms inside (bare node 22–25 ms); Node 20 has no
  `module.enableCompileCache` and the optional call is silent; the `#!/usr/bin/env node` shebang means the CLI (not the
  hooks) needs `node` on PATH — `/usr/bin/env: 'node': No such file or directory`, exit 127, in a shell without it. Korean
  path intact everywhere; v9 and v10 fixtures migrate; the helper socket path check (107 bytes) and the `/proc` recursion
  guard behave on their native platform.
- **Fresh-machine code review** (11 findings, 12 "handled" confirmations) and **documentation critic** (20 wrong or
  misleading statements, 13 missing topics, as read by someone installing on a second computer), each medium-or-higher
  code finding handed to an adversarial verifier with repository access and a scratch directory.

### Findings and what was done

| id | verdict | finding | action |
|---|---|---|---|
| F1 | confirmed (medium) | On macOS/Linux `process.execPath` is already the real path, so Homebrew pins `/opt/homebrew/Cellar/node/<v>/bin/node` and `brew upgrade node` (which cleans the old version) deletes it; nvm likewise on `nvm uninstall`. Reproduced in WSL with a Homebrew-shaped layout. | Install warns when the binary lives under `/Cellar/`; README Node-path bullet names `brew upgrade node` and `nvm alias default`; the "prefer the stable PATH symlink" code fix was rejected (fnm's per-shell link resolves to the same binary and would be pinned instead). |
| F2 | confirmed (low) | On Windows `process.execPath` keeps the junction it was started through (verified with `mklink /J`): fnm's `%LOCALAPPDATA%\fnm_multishells\<pid>_…` is one link per shell, nvm-windows' `C:\Program Files\nodejs` follows `nvm use`, so the hooks ran whatever that shell last selected or died with it. | `stableExecPath()` (`fs.realpathSync.native`, guarded) in `main.ts`, so install, doctor `--fix` and the self-test all pin the real binary; a no-op on POSIX and on a plain MSI install. |
| F3 | confirmed (medium) | `--with-embeddings` runs plain `npm install @xenova/transformers` inside the installed package, whose published manifest still carries devDependencies: 45 → 385 MB, 144 top-level entries, a `package-lock.json` written into the global package; EACCES on a `sudo`-installed prefix (reported as `installed with problems`, exit 1); the copy is wiped by the next package upgrade. `--omit=dev` alone drops transformers itself (npm infers the dev save-type from the manifest). | Documented (README Embeddings, CHANGELOG known limitations, the Korean guide): size, `npm install -g @xenova/transformers` next to the package plus `embeddings.enabled: true` (never `sudo hm install`, which would leave root-owned files in the project), re-run after upgrades. The proper fix — a dedicated directory under `~/.harness-memory/` resolved through `createRequire` — is 0.6.1 work. |
| F4 | confirmed (medium) | Shell-form PowerShell entries were `"<node>" "<hook.js>" <event>`; PowerShell does not execute a statement that starts with a quoted string (Claude Code's hooks reference says the same), so every hook exited 1 — reachable with Claude Code < 2.1.139 without Git Bash or `--hook-form shell`. Verified through `-EncodedCommand`, the way the host runs it. | `& ` call operator for `shell: "powershell"`; `nodeOf()` accepts it so uninstall / doctor still recognise the entry; tests for both shells. |
| F5 | confirmed (medium) | `providerEnv()` forwarded only the fixed allowlist plus `ANTHROPIC_` / `OPENAI_` / `XDG_`; a `claude` authenticated or routed through `CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_OAUTH_TOKEN`, Bedrock / Vertex with `AWS_*` / `GOOGLE_*`, or a corporate CA probed `not_logged_in` / `provider_error` and the guidance said to log in. Both hops (hook → worker, worker → `claude -p`) use the same filter, so the fix had to be there. | Names and prefixes added; `CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_EXECPATH` stay dropped (recursion guards); test. Troubleshooting row. |
| F6 | confirmed (medium) | pnpm registers `<project>/node_modules/.pnpm/harness-memory@<v>/…/dist/hook.js` (its own bin shim targets the realpath), npx `~/.npm/_npx/<hash>/…`; both change on upgrade or prune, nothing warned, and the README said a devDependency "stays put". | Install warns on `.pnpm` / `_npx` / `.yarn` segments; README bullet rewritten (npm installs keep the path, pnpm / yarn / npx do not). |
| — | observed | After an idempotent re-install, `hm uninstall --purge` left `.claude/settings.local.json` as `{}` and the exclude line (the rewritten manifest said `created: false`, `added: false`). | Manifest provenance carried over from the previous manifest; test installs twice, uninstalls, checks both are gone. |
| F9 | low | A brand-new database printed `v22 (migrated from v0)`. | `(created)` when no backup was written; an existing file at `user_version` 0 keeps `migrated from v0, backup …`. |
| F10 | low | README, README.ko and the upgrade note said the schema ends at v21 (`TARGET_USER_VERSION` is 22). | Fixed in the docs before this round. |
| F7, F8, F11 | low, left | Settings / manifest writes use a single `renameSync` (the database save retries); source maps are 9.3 of the 13.2 MB unpacked; `SessionEnd` has a 1 s timeout against 95–170 ms wall per hook on Windows. | Recorded here; none blocks a fresh install. |

Documentation findings folded into README / README.ko / the upgrade note: the install command (0.5.1!), `npx` as an active
hazard, the shell-form fallback only when `claude --version` is detectable, `hm` not on PATH, the PowerShell execution
policy, env-based logins, moving to another machine (nothing to copy; never the settings file or the manifest), schema
version 22 where four places still said 21 (CHANGELOG line 34 contradicted its own Phase F entry), `migrations 001–022` in
the development table, the upgrade note's login step and its stale live-extraction paragraph. The critic's claim that
settings edits need a restart was checked against the current hooks reference, which says direct edits are picked up by
the file watcher; the README keeps that sentence and adds the `hooks.calls` check.

The diff itself was reviewed before the commit (code, documentation and the Korean guide, each finding handed to a
verifier). Code: two tests still compared the pinned node to `process.execPath` (doctor `--fix`, the dist smoke test)
and the Homebrew negative ran on the real binary, so a Homebrew Mac would have failed them — all three now use the
resolved path or an explicit one; two existing env tests assumed no `CLAUDE*` name reaches a child, which the forwarded
auth names break for a developer whose shell carries them — they now exclude exactly those names; `(created)` is
printed only when no backup was written (a valid file at `user_version` 0 is backed up and migrated, verified with a
fresh sql.js export); `hm doctor` does not notice a PowerShell entry written by the old form (compareRegistration
matches on node and script only) — documented, since no released build wrote that form. Docs: the yarn generalisation,
`SSL_CERT_*` as if a prefix, a stale v21 in v1-explained, an abridged command quoted without `--summary`, F10 missing
from the table. Guide: `hm memory:reject` cannot remove an active row (`memory:demote` can), `hm doctor` shows a WARN for
`extraction.probe` before the login (so "WARN 0" was wrong at that step), worker.log line names, `nested_refusal` as a
possibility rather than a certainty, the p95 measures the hook's inside time, `dogfood` spelled as the other Korean
documents spell it.

### Known limits after this round

- `--with-embeddings` as above (F3). The `npm install -g @xenova/transformers` alternative is resolvable by Node's lookup
  from the package directory but was not exercised end to end here.
- Not tested: a fresh machine with `LANG=C` / POSIX locale and a Korean path; a project inside a OneDrive-synced folder
  (every hook call appends to the ledger and the CLI renames the database — plausible interference, not observed); macOS
  itself (the Homebrew case was reproduced on Linux with the same layout); nvm-windows (the junction behaviour is inferred
  from `mklink /J`, which is what nvm-windows uses).
- The Windows PowerShell shim needs RemoteSigned or `hm.cmd`; the hooks are unaffected. Documented, not changed (it is
  npm's shim).

### Gates

tsc 0; the targeted suites first (install 22, settings 11, process 2), then the full Windows suite, `npm run package:verify`
and CI on the pushed commit; the tarball attached to the pre-release is packed from the tagged commit and installed once
more from its release URL on Windows and WSL before the release is announced as usable.

How it ended (2026-11-09): commits 4327554 (code) and 1bb155e (docs); Windows 81 files / 1166 tests, `package:verify` ok;
WSL Ubuntu 22.04 / Node 24 full suite 1165 of 1166 — the one failure is the load-sensitive recall-cost median
(`test/recall-hook.test.ts`, 12.7 ms against its 10 ms local line under the suite's parallelism, 2.3 ms alone); CI run
42542574009 green on every job for 1bb155e. Tag `v0.6.0-rc.1` → GitHub pre-release with `harness-memory-0.6.0-rc.1.tgz`
(86 files, 3.3 MB; sha256 09cf8e683f5fe3263ff304b08364053c4cd5f50dc77cba817d35ca93b2f37981, the downloaded asset verified
byte-identical). Installed from the release URL into fresh prefixes on Windows 11 / Node 24.14.0 and WSL / Node 24.14.0,
and from the same tarball with Node 20.20.2: `hm --version`, `hm install --host claude --skip-probe` (`v22 (created)`),
`hm doctor --self-test`, a `deny` on Bash `npm test` through `dist/hook.js` and `{}` on `pnpm test`, `hm uninstall --purge`.
`npm publish --tag next` remains the author's step.
