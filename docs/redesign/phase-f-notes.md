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
