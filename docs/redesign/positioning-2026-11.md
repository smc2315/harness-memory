# Positioning check — claude-mem, Claude Code native memory, the landscape (2026-11-08)

Three research agents swept public sources (GitHub API, READMEs, docs sites, release pages, issue trackers,
Anthropic's Claude Code docs and changelog) and a fourth synthesized them. Every number below is as of 2026-11-08
and carries its source; things the sweeps could not verify are listed at the end. The question that triggered it:
*is the differentiation versus claude-mem clear, and has demand been validated?*

**Answer: the differentiation is clear and verifiable on paper; demand is not validated at all.**

## 1. claude-mem today

- Scale: 114,679 stars / 9,953 forks (GitHub API), 36,980 npm downloads in the week of Nov 1–7, ~20 releases in
  19 days (v15.12.0 on 2026-11-07), ~2,379 issues since 2025-08-31, 15 agents supported, ~30 README translations
  including Korean. https://github.com/thedotmack/claude-mem
- Architecture overlaps with ours: Claude Code hooks (SessionStart, UserPromptSubmit, PreToolUse, PostToolUse,
  PostToolUseFailure, Stop, SubagentStop, SessionEnd), a detached Express worker on a per-user port, SQLite + FTS5
  under `~/.claude-mem` with optional Chroma, AI-compressed observations injected at SessionStart (last 50, under
  10,000 chars, from the second session on), MCP / skill search tools. Nothing is injected per prompt.
  https://docs.claude-mem.ai/architecture/overview, https://docs.claude-mem.ai/architecture/hooks.md
- What it remembers: observations of tool activity (title, narrative, facts, concepts; types decision / bugfix /
  feature / refactor / discovery / change), session summaries, raw prompts. The documented schema (v51) has no rules,
  authority, TTL, confidence or validation fields. https://docs.claude-mem.ai/architecture/database.md
- Gating: exactly one gate — the File Read Gate (deny a whole-file Read of a ≥ 32 KB code file that already has
  observations; Claude Code only; fails open after 3 s). No learned rules, no advise / ask / deny from corrections.
  v15.3.0 removed an Antigravity PreToolUse that had been auto-approving every tool call.
  https://docs.claude-mem.ai/file-read-gate.md
- Cost model: every PostToolUse event is queued for an observer model call (default alias haiku via the Agent SDK)
  that counts against the user's own Claude plan unless an API key or the paid hosted observer is used; a quota guard
  pauses saving near 95 %. CMEM Pro / Heavy / Max at $30 / $70 / $100 per month, 30-day trial with a card; the
  maintainer states the hosted observer runs DeepSeek V4 Flash via OpenRouter. https://docs.claude-mem.ai/usage/quota-fallback.md,
  https://cmem.ai/pricing, https://github.com/thedotmack/claude-mem/issues/3763
- Privacy: PostHog telemetry on by default (opt-out); in Oct–Nov 2026 the installer uploaded 30 days of prompts,
  paths and project names to cmem.ai without opt-in (issue #5176, fixed in v15.8.3, earlier uploads not removed); the
  README endorses a third-party CMEM crypto token. https://github.com/thedotmack/claude-mem/issues/5176
- Korean: a `code--ko` output mode exists; CJK text is searched by keyword substring, no local multilingual embedding
  is documented. https://docs.claude-mem.ai/usage/search-tools.md
- Complaint clusters (issues sorted by comments): worker / port failures and version-mismatch kill loops, Windows
  breakage (#380, 37 comments; a Reddit thread calls its Windows state "beyond unusable"), CLAUDE.md spam across
  repos (now default-off), plan-quota burn (~615 issues match tokens / cost / quota), DB bloat, process leaks.
- A cheaper rebuild on the same cost critique, claude-mem-lite, has 68 stars: a cost / architecture differentiator
  alone has not translated into adoption in this niche.

## 2. Claude Code's native memory

- Two native layers: the CLAUDE.md hierarchy (managed / user / project / local, `.claude/rules/*.md` with path
  globs, `@imports`) and **auto memory**, on by default since v2.1.32 (2026-02-05): notes of four kinds — user,
  **feedback (corrections the user gives Claude)**, project, reference — in `~/.claude/projects/<project>/memory/`
  (MEMORY.md index, first 200 lines / 25 KB loaded every session, topic files on demand, machine-local, per repo;
  `autoMemoryEnabled`, `/memory`, `CLAUDE_CODE_DISABLE_AUTO_MEMORY`). https://code.claude.com/docs/en/memory
- Anthropic's own framing: CLAUDE.md and auto memory are "context, not enforced configuration"; the docs tell users to
  use a PreToolUse hook or `permissions.deny` for anything that must hold regardless of what Claude decides.
- Hooks are mature: 33 events; PreToolUse returns allow / deny / ask / defer with a reason and can rewrite input
  (`updatedInput`); exit 2 blocks even over allow rules. https://code.claude.com/docs/en/hooks
- No fetched page describes a native path from learned memory to deterministic tool-time enforcement. The closest:
  standing approvals saved as allow rules, `/auto-mode-setup` drafting rules from recent sessions (written only after
  the user accepts), the auto-mode classifier (reads CLAUDE.md, no documented link to auto memory).
- Auto memory moves fast: ~25 memory-related changelog entries Feb–Oct 2026, including security hardening of recalled
  notes (2.1.284) and team memory stores for Claude Tag. **Both halves of our wedge exist natively — unjoined.**

## 3. The landscape

- Capture-and-inject memory (crowded, six-figure traction): claude-mem 114.7k, agentmemory 30.2k, Mem0 68.6k,
  Cognee 33.1k, Supermemory 31.6k, memsearch 2.8k.
- Corrections → rules written to CLAUDE.md / AGENTS.md / SQLite and loaded at SessionStart (inject only, a few
  thousand stars): pro-workflow 2.9k (propose → approve → saved), claude-reflect 1.9k, claude-smart 792,
  claude-evolve 17, claude-learn 0.
- Tool-time deny / ask exists only as static hand-written guardrails (tool-gate-hook 41, claude-guardrails 41).
- The intersection we claim — rules learned from corrections / failure → resolution, enforced at PreToolUse with
  advise / ask / deny, deterministic validation, zero LLM at tool time — has three tiny partial entrants: axme-code
  (14 stars, alpha; blocks on safety rules; auditor-to-hook link unverified; no ask), muninn (6; compiles instruction-
  file rules into deny hooks after approval; corrections stored, not enforced), lessons-learned (0; pattern-matches
  mistakes at PreToolUse, mostly injects). **The wedge is open — and every neighbour sits at ≤ 14 stars.**
- Platform caveats that bound the wedge: Codex hooks support deny but not ask yet; a Claude Code PreToolUse `allow`
  no longer overrides ask-rules (~2.1.78, closed not planned — we never emit allow); hooks fail open on timeout unless
  `onFailure: "block"`; PreToolUse runs on every registered tool call.
- Our public footprint: 22 stars, 0 forks, last push 2026-04-09, npm 0.5.1 (the OpenCode plugin). Anyone who looks
  today sees an abandoned-looking project.

## 4. Differentiation matrix (condensed)

| Dimension | harness-memory 0.6 | claude-mem | native auto memory |
|---|---|---|---|
| What is remembered | structured rules: type, scope, trigger signature, authority, enforcement, TTL, aliases, provenance | AI-compressed narrative observations + summaries | Markdown notes (user / feedback / project / reference) + CLAUDE.md |
| When it is used | session_start, before_model (BM25 + optional dense), **before_tool**, after_tool; hard budgets | SessionStart (50 observations), on-demand search, per-file timeline at PreToolUse | everything at conversation start; path-scoped rules on file touch |
| Gates a tool call | **yes**: advise / confirm(ask) / soft_deny / deny; verified live once | only the File Read Gate | primitive exists (PreToolUse), nothing native joins memory to it |
| Tokens per tool call | 0 (a Node process reading a snapshot; p95 65–87 ms) | one haiku observation per PostToolUse, on the plan or paid | 0 |
| Model spend | one `claude -p` per eligible episode: $0.03–0.04, 22–27 s (sonnet; haiku ≈ 1/12) | per observation; quota guard; CMEM Pro moves it off-plan | undocumented in-session extraction |
| Validation / trust | 12 deterministic validators, authority invariant, TTL, override downgrade | none documented | model-side judgement, staleness by timestamp |
| Review burden | proposals for policies / global / demotions (`hm review`, ≤ 3/day gate, unmeasured) | none (shows up as ops incidents) | none |
| Privacy / account | none; local; the user's own CLI login | telemetry on by default; cloud account for Pro; #5176 | local, first-party |
| Korean retrieval | aliases + Hangul-aware BM25 + optional e5-small dense | substring match for CJK | model reads Markdown |
| Maturity | 996 tests, 0 dogfood days, 0 users | 114.7k stars, 20 releases / 19 days | shipped to every user, iterating monthly |

## 5. Wedge assessment

Technically **open, narrow, copyable, unproven in demand**. Open: no project combines the four properties. Narrow:
the hook mechanics are commodity — the non-commodity part is the write path (validators, authority, TTL, V12,
`hm memory:why`), which is also the hardest to communicate. Copyable within a release by Anthropic (feedback notes +
PreToolUse + `/auto-mode-setup` already exist), by claude-mem (a rules table and a deny path at its velocity), by
pro-workflow (correction store + static guardrails + permission tuner). Demand: six-figure stars prove people want
"remember what happened"; a few thousand prove they will approve corrections into CLAUDE.md; nobody has shown users
want a tool to block them. The strongest indirect signal: claude-mem's complaint clusters (quota burn, Windows,
CLAUDE.md spam, privacy) are what our design answers structurally — whether those complainers would switch to a tool
that does less (no history) is exactly what must be tested.

## 6. Risks (from the synthesis, in order)

1. False positives that block the correct command — already happened once (phase-e-notes §4b); only one scenario
   exercised; regex / substring / glob and scope-only policies can still over-match.
2. Trust in auto-activated rules: one correction activates a soft_deny with nobody in the loop; autonomy regret
   ≤ 10 % is a paper gate.
3. Review fatigue or neglect: policies do nothing until `hm review`; claude-mem's success shows users prefer
   zero-review tools even with worse behaviour.
4. Cost and latency per episode on the user's plan, plus the separate terminal login that most new installs start
   without (episodes queue silently).
5. Hook latency tax on Windows; hooks fail open on timeout.
6. Overlap with native auto memory, which records the same corrections; a first-party join removes the wedge.
7. Detached-worker reliability on a one-person project — the same machinery behind claude-mem's worst incidents.
8. Invisible value: the win is a non-event; every cost is visible.
9. Distribution mismatch: npm + `hm install` vs `npx claude-mem install` / the plugin marketplace; public repo looks
   abandoned.
10. Security surface of auto-enforced rules (adversarial tool output → a blocking rule); mitigated, not red-teamed
    externally.

## 7. Demand-validation plan (two to four weeks)

| When | Step | Pass if |
|---|---|---|
| wk 1–2 | Dogfood on ≥ 2 real projects (one Korean), auto memory left ON, ≥ 10 active days; log every before_tool fire as right / wrong / unsure | precision ≥ 80 %, override ≤ 20 %, ≥ 3 "repeat prevented" events, review ≤ 3/day, regret ≤ 10 %, Windows p95 ≤ 90 ms, non-ok hooks < 0.5 %, spend ≤ $0.50/day |
| wk 1 | Native-overlap test: for each prevented repeat, was the same feedback already in MEMORY.md, and did Claude attempt it anyway? | ≥ 50 % of prevented repeats absent from auto memory or present-but-attempted; below that the wedge is weaker than designed |
| wk 2 | Publish 0.6.0-rc under the `next` tag, push, pre-release, README top: 30-second pitch + 60-second recording of one loop + "what it does NOT do" | ≥ 75 % of testers reach `hm doctor` 0 failures unaided; median ≤ 15 min |
| wk 2–4 | Cohort of 8–12 daily Claude Code users (Korean communities, r/ClaudeAI, commenters on claude-mem's #380 / #618 / #5176); weekly `hm memory:stats --json` + `hm doctor` | ≥ 6 green installs; ≥ 50 % active at day 14; ≥ 70 % with a fired auto pitfall; override ≤ 25 %; ≥ 50 % ran `hm review` |
| wk 3–4 | Fixed questionnaire: repeated-mistake base rate, which memory complaint they have, was the deny right, auto-block vs approve-first, did native memory already have it, is 25 s / $0.03 acceptable, Sean Ellis, would they keep claude-mem too | ≥ 40 % "very disappointed"; ≥ 40 % rank enforcement above history; ≥ 50 % report a repeated mistake per two weeks; if most want approve-first → default auto rules to advise / confirm |
| wk 3 | Two posts (r/ClaudeAI, a Korean dev community) with two closed questions; watch claude-mem's tracker for new cost / privacy complaints | ≥ 20 qualified answers per post, ≥ 50 % report repeats, ≥ 30 % would install; stars / downloads informational |
| wk 4 | Decision gate on one page | **A** GA as designed only if dogfood, overlap and retention all pass; **B** GA with auto rules at advise / confirm if dogfood passes but interviews prefer approve-first; **C** re-scope as a thin enforcement layer over native auto memory (and optionally claude-mem observations), dropping own extraction, if the overlap test fails or retention < 50 % |

## 8. Design directions on the table (the user's question of 2026-11-08 night)

- **A. Keep the rule core; add a recall layer; auto rules start at advise.** The recall layer costs no extra model
  calls: every extraction already produces an `episode_summary`; index it in the snapshot, expose `hm recall`, a
  before_model injection of the two most relevant episodes, and an MCP search tool. Auto-learned rules begin at
  `advise` and climb to `soft_deny` only after fires without overrides.
- **A′. Same, plus: what the user explicitly asked to remember is enforced from the start.** Facts extracted from a
  `remember=1` turn ("기억해") and citing that prompt line become human-authority rows, active immediately with the
  type's default enforcement, instead of policy candidates waiting in `hm review`. Mitigations: V6 / V8 / V12 still
  apply, a session-start notice names the new rule, `hm memory:demote` reverts it in one command, or confirm-first
  for the first N fires. Native auto memory saves such requests as feedback notes today — without enforcement.
- **B. Build enforcement on top of claude-mem.** Inherits its users and recall; but its data model is narrative
  (no rules / authority / TTL / validation fields), its cost model is per-tool-call observation, and the design
  would be theirs.
- **C. A thin enforcement layer over existing memories** (the synthesis's path C, the generalisation of the user's
  instinct): read native auto memory's feedback notes (and optionally claude-mem observations), compile the
  command-like ones into validated signatures, keep only the PreToolUse gate and `hm review`; drop own extraction and
  with it the $0.03 / 25 s per episode and the separate CLI login — the two largest install frictions found. Risk:
  Anthropic's note format is free text that changes monthly, so "note → signature" still needs a compiler (an LLM
  step or a deterministic parser for command-shaped notes) and the validators.

A compatible middle: keep the pipeline, make the CLI login optional (imported / native rules are enforced without
it; own extraction is the premium path), and add MEMORY.md feedback notes as an import source next to CLAUDE.md.

## 9. What the sweeps could not verify

Anthropic's intent to join feedback notes to enforcement (nothing published either way); whether subscription users
accept headless `claude -p` extraction plus a separate login; how often Claude retries the identical call after a
soft_deny; the base rate of repeated-after-correction mistakes; running alongside claude-mem (duplicate latency,
contradictory guidance); two possible neighbours (blueman82/recall, a Mem0 PreToolUse guide) that could not be
fetched; Korean-market demand (no community discussion found for any memory tool); plugin-marketplace distribution;
whether `hm import` should skip MEMORY.md like it skips CLAUDE.md; the real per-episode cost distribution over a
normal day. Full agent reports: the workflow journal `wf_61ac0397-e96` (session-local).
