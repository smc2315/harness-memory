# 0.6.0-rc.2 — full autonomy (zero-touch) design

Date: 2026-11-26. Status: being implemented on `feat/full-autonomy`. Supersedes nothing in `spec-v0.6.md`; it adds
an autonomy level and tightens the write path. Numbers below come from the first dogfood run (17 days, one Java/Spring
service, Claude Code on WSL, 2026-11-09 … 11-26); the raw data stays with the author.

## Why

The author's verdict after 17 days: *a tool that needs human intervention will not be used.* The data agrees:

- 153 proposals opened, **0 decided**; 356 candidates waiting over 13 active days (≈ 27 candidates per active day
  against a review gate of ≤ 3 items). `hm review` was never run.
- **0 `ask` / `deny` decisions in 13,685 PreToolUse calls.** 50 of the 51 active auto rules stayed at `advise`; the
  ladder climbed once (that row never fired), because `distinct_session_count` counts re-extractions (rare) and not fires. Advise at PreToolUse is delivered
  with the tool result, i.e. after the tool ran.
- decideTier parked 110 facts for their *type* (architecture_constraint, decision, policy), 131 for a repo-wide
  *scope*, 89 for confidence, 29 for evidence. Of the 356 candidates, judges read 53 % of the knowledge rows and 28 %
  of the rule rows as durable and immediately useful — none of it reached the model.
- The heat of a rule measured exposure, not recurrence: the five most-fired rules (27 / 23 / 19 / 17 / 15 fires) carry
  noun-level signatures (a host, a table, a tool name) or none; a fires-based ladder would have promoted exactly the
  rows that must not block. The two rules worth `soft_deny` had 1 and 0 fires: silent writes into a shared system.
- The correction cue regex flagged 15 % of episodes; a sample put its precision near 2 in 18. 41 interrupted,
  near-empty episodes were extracted for $2.3 and 0 facts. 122 episodes extracted on the decision marker alone
  produced candidates only ($6.8).
- Duplicates: two judges read 64 of 356 candidates as restatements; token Jaccard ≥ 0.5 caught 8. One session was
  resumed for 17 days and holds half of all episodes, so "another session" never happened inside it.

The human gate was a safety valve nobody opened. 0.6.0-rc.2 replaces it with mechanics: everything activates on its own
at `advise` under caps and TTLs, `soft_deny` is born only where the mistake is exactly identifiable *and* succeeds
silently, duplicates merge, noise is not extracted, and the backlog drains itself. Review stays available, optional.

Invariants kept: hooks never open SQLite; zero model tokens per tool call; the automatic path never touches human rows
(upward or downward); `deny` and `confirm` are human-only; no account, no telemetry.

## 1. `autonomy_level: "full"` (new default)

Levels: `off` | `shadow` | `standard` | **`full`**. `standard` is the 0.6.0-rc.1 behaviour (proposals for policies and
repo-wide rows, informational types wait for review). `full`:

| row | `standard` | `full` |
|---|---|---|
| policy (auto) | candidate + `activate_policy` proposal | active at `advise`; `soft_deny` only through §3 |
| repo-wide `**/*` without signature | candidate + `activate_global` proposal | active at `advise`, counted against the knowledge cap when informational |
| decision / architecture_constraint | candidate (`type`) | active at `advise` on `session_start` / `before_model` when `confidence ≥ 0.7`; needs no episode evidence (the decision marker is its evidence); counts against `extraction.max_auto_knowledge_activations_per_day` (default 10) |
| pitfall / workflow | active when `confidence ≥ 0.7 ∧ evidence ≥ 2` | active at `advise` when `confidence ≥ 0.7 ∧ evidence ≥ 1`; `evidence ≥ 2` stays required for a `soft_deny` birth (§3) |
| replacement rows, invalid scope, unsafe text, caps | candidate | unchanged |
| proposals | activate_* opened | none opened; `supersede` / `revalidate` keep today's automatic resolution (2-session auto-demotion, expiry) |
| SessionStart digest (`N proposals open — run hm review`) | shown once a day | not shown; the remember notice stays |

`decideTier` gets the level and the knowledge cap in its input; `type`, `autonomy` and the proposal-bearing `scope`
(activate_global) are `standard`-only reasons, while an invalid scope is `scope` under every level. Order under `full`:
replacement → scope valid → scanner → confidence → (informational: at least one lifecycle trigger, knowledge cap) →
(pitfall/workflow/policy: trigger reachable — a signature or `relevant_tools`, the rc.1 precondition, so a repo-wide
rule without either stays `candidate(trigger)` — evidence ≥ 1, activation caps) → active. A candidate whose
`activate_policy` / `activate_global` proposal a human rejected is never activated by the automatic path — neither by
`decideTier` on a reinforce nor by the sweep (`humanRejectedActivation`); it meets the candidate expiry like any
declined rc.1 candidate. `shadow` keeps its rc.1 meaning — a dry run of `standard` logged to `audit_log` — and `off` activates
nothing. The two daily counters are separate: knowledge activations never consume the rule caps, and the `dream`
sweep's activations (transition reason `full_sweep`) consume neither, so a sweep of 50 does not starve the day's
extractions.

The silent-write rule (§3) and the neighbour rules (§4) are level-agnostic: a `standard` project also gets them,
and `before_tool.auto_enforcement_silent_write: "advise"` is the switch back to rc.1 births.

Backlog drain: the consolidator (`dream`) gains a `full` sweep — auto `candidate` rows are re-evaluated with
`decideTier` oldest first and activated when they pass, up to `dream.full_sweep_per_run` (default 50) activations per
run (a row that does not pass costs nothing, so unpassable old rows never stall the drain); open `activate_policy` /
`activate_global` proposals whose target activated are closed `expired` with decision note `full_autonomy`. The
author's 356 candidates drain in a week of normal `dream` runs — once `hm install --host claude` has flipped the
rc.1-written `standard` in `config.json` (§7).

## 2. Signature precision and side effect

Two new fact-level facts, computed once in the worker, stored on the row (migration 023):

- `signature_precision` ∈ {`mistake_exact`, `noun`} (NULL without a signature). The validator compiles the signature
  and tests it against every `tool_ok` line of the episode — the full ledger line list, not only the lines the
  24k-char prompt rendered, so the fresh and the raw-cache path label alike. A hit on a line the fact does **not**
  cite, or on a cited line that resolved a failure (`resolution_of` set), makes it `noun`: the pattern names the
  operation, not the mistake. For a correction of a previous turn (`correction_for`, union mode) two more rules apply:
  a cited `tool_ok` line of the correcting turn is the fix, not the mistake, so a hit on it is `noun` too; and the
  corrected turn's tool lines (the non-citable context) are scanned as well — a pattern that matches two or more
  distinct calls there covers the mistake and a sibling and is `noun`, one match is the mistaken call itself; subagent
  calls are ignored on both sides, as the citable map ignores them. With no
  `tool_ok` line tested anywhere the label stays `mistake_exact` (a prompt-only correction). (V12 is the special case
  "matches the resolving command of a different program"; it keeps rejecting.) The dogfood set: 17 of 28 active
  signatures would be `noun`, carrying 105 of 114 signature fires.
- `side_effect` ∈ {`read`, `write`} on `trigger_signature`, emitted by the extractor (schema field, optional for
  recorded outputs; default `read`): `write` when the matched call creates, modifies, deletes or transitions data in
  a shared system (a push, a POST, an UPDATE, an MCP create / update / transition).
- `horizon` ∈ {`durable`, `task`} on the fact (optional, default `durable`): `task` marks knowledge about the current
  task's state. A `task` row gets the 7-day TTL — at activation, and as a ceiling on every reinforce and fire
  (`computeRevalidation`, `extendTtlOnFire` and the auto-accepted `supersede` replacement read the horizon) — and never
  exceeds `advise`.

A new signature whose key names the same tool, target, pattern kind and negation as an existing active row's key and
whose pattern narrows or widens it — `cmd`: same program and one token list contains the other (`npm test` ~
`npm test --coverage`, not `npm test:e2e`); `substring`: one pattern contains the other; `glob` / `regex`: equal only —
is treated as that row's twin (reinforce), not a new row (§4). A negated key is never the twin of a positive one.

## 3. Enforcement at birth and the ladder

`enforcementDefault` (auto rows), top to bottom:

1. type ∈ {pitfall, policy} ∧ compiled signature ∧ V10 ok ∧ `signature_precision = mistake_exact` ∧
   `side_effect = write` ∧ knowledge_kind ∈ {correction, failure_resolution} ∧ `evidence_score ≥ 2` ∧ `horizon = durable`
   → `before_tool.auto_enforcement_silent_write` (default **`soft_deny`**).
2. pitfall ∧ signature ∧ V10 ok ∧ knowledge_kind ∈ {correction, failure_resolution} → `before_tool.auto_enforcement`
   (default `advise`, unchanged).
3. everything else → `advise`.

An auto `policy` reaches `soft_deny` only at birth through rule 1; the ladder below stays pitfall-only. On the
dogfood set rule 1 would have fired exactly twice (the two rows both raters agreed on). `soft_deny` semantics are
unchanged: only the first attempt of a (memory, tool) pair per turn is denied, the retry passes and records an
override; ≥ 3 overrides with evidence < 3 drop the row to `advise` (consolidator); TTL 30 days with the +14-day fire
extension.

The ladder (`decideEscalation`) runs under `standard` and `full`, and adds `signature_precision = mistake_exact` to its
predicate: a noun-level row never climbs however often it is reinforced. Reinforcement itself becomes observable (§4).

## 4. Reinforcement and duplicates

- `distinct_session_count` counts distinct `(session_id, 4-hour block of episode.started_at)` pairs, so a resumed
  17-day session yields reinforcement when the same fact comes back hours later. Import episodes keep counting once.
- `findNeighbour` (reconcile step 3) treats a live row of the same type with an intersecting scope as the twin when
  any of these holds, in addition to Jaccard ≥ 0.6 on the summary: equal `signature_key`; a narrower / wider key of the
  same tool, target, kind and negation (§2); ≥ 2 shared aliases (case-folded); a shared error-code token (`C001`,
  `G006`, `P003`, `ERROR 1054`, `JDBC-11021` …) corroborated by Jaccard ≥ 0.2 or one shared alias — the token shapes
  also fit Jira keys, RFC numbers and JWT algorithm names, so a code alone identifies nothing. Aliases and error codes
  never fuse two facts whose signature keys are both non-empty and not twins (two different mistakes): there only
  Jaccard counts. The §5.7 rule stays: a signature-bearing fact is never absorbed by a signature-less neighbour; when
  the identity key (type, summary, details, scope, triggers) is the same, an auto signature-less row adopts the fact's
  signature instead — on a remember turn too, before the row becomes human (outcome detail `adopted=signature`; its
  `signature_precision` stays NULL, so the row never climbs; no adoption while an `activate_*` proposal on the row is
  open or was rejected by a human, so `standard`'s gate is not bypassed — a remember turn adopts regardless, the
  user's words being the approval) — and a human row only gets the reinforce (`collapsed=identity_key`). Both details
  also appear on the `propose_supersede` path, whose replacement text may meet such a twin (`twin=<id>` names the row
  when the outcome's memory is the supersede target).

## 5. What is not extracted any more

- An episode closed as `interrupted` with ≤ 2 ledger lines (the prompt plus at most one event) is `no_signal` whatever
  its flags (41 such episodes, 0 accepted facts).
- A correction cue in the prompt counts **2** only when the episode is a correction of a previous turn that had tool
  calls (`correction_for` set and the corrected episode has ≥ 1 tool line); a bare cue (ordinary "A 말고 B", "never" in
  a new instruction) counts **1**. The episode stays eligible; auto activation then needs a second signal for
  `soft_deny`, and under `full` the fact still activates at `advise`.
- Decision-marker-only episodes (evidence 0) are extracted at most `extraction.decision_only_per_day` (default 5)
  times per day; the rest are skipped with reason `decision_cap`. The counter sees extractions that reached the
  provider: an episode requeued by a probe or provider outage (its ghost run row, status `not_logged_in` …) does not
  consume the budget. Under `full` their facts activate (§1), so the budget buys session-start knowledge rather than
  review-queue entries.

## 6. Extraction prompt

Boundary rules added or changed (bump `EXTRACTOR_VERSION` to `2026.11.v2`):

- The signature pattern is the token that was wrong (bad path segment, column, argument name, URL scheme, document
  id, flag), never the name of the command, table, host or tool that the fix also uses; if the mistake has no token
  of its own, omit the signature and use `before_model`.
- A call made through an MCP tool uses tool `mcp:<server>/<tool>`; a call made through a CLI wrapper in bash
  (`mcp_cli.py call X`) uses tool `bash` with the subcommand in the pattern.
- `side_effect`: `write` when the matched call creates, modifies, deletes or transitions data in a shared system.
- `horizon`: `task` for the current task's state (what is deferred, what ships in which order, one document's
  wording); `durable` for what will still be true in a month.
- A code-review finding (a bug still to be fixed, a fix direction, line numbers) is `architecture_constraint` or
  `decision`, not `pitfall`; a pitfall needs an action the agent took and the consequence it caused.

## 7. Configuration

```jsonc
{
  "autonomy_level": "full",                                   // new default; "standard" = rc.1 behaviour
  "before_tool": {
    "auto_enforcement": "advise",                              // unchanged
    "auto_enforcement_silent_write": "soft_deny",             // new; "advise" turns §3 rule 1 off
    "auto_escalation": { "enabled": true, "sessions": 2 }      // unchanged; now also requires mistake_exact
  },
  "extraction": {
    "max_auto_activations_per_day": 10,                        // unchanged (pitfall / workflow / policy)
    "max_auto_knowledge_activations_per_day": 10,             // new (decision / architecture_constraint)
    "decision_only_per_day": 5                                 // new
  },
  "dream": { "interval_hours": 6, "full_sweep_per_run": 50 }   // new key
}
```

Upgrading from rc.1: rc.1's `hm install` wrote its whole default config — `"autonomy_level": "standard"` included —
into every `.harness-memory/config.json`, so the new default alone changes nothing for an existing project.
`hm install --host claude` (the documented upgrade step) reads the install manifest; when the previous install was
pre-rc.2 and the file still says `standard`, it rewrites that one value to `full` and prints it. A project that wants
the review gate sets `autonomy_level: "standard"` again afterwards; a project with no manifest (a hand-written config,
or a `config.json` copied to another machine) is never rewritten. Migration 023 adds `signature_precision`,
`side_effect`, `horizon` to `memories` (NULL for existing rows; `enforcementDefault` and the ladder treat NULL precision
as `noun`, and the sweep activates a row with the enforcement it was born with, so with the default
`before_tool.auto_enforcement: advise` no existing row can become blocking without a re-extraction).

## 8. Files and ownership (implementation)

| area | files | tests |
|---|---|---|
| shared | `src/core/vocabulary.ts` (levels, `SignaturePrecision`, `Horizon`, `TriggerSignature.side_effect`), `src/core/extraction-types.ts` (schema fields, version), `src/core/config.ts`, `src/db/migrations/023_signature_precision.sql`, `src/db/schema/types.ts`, `src/memory/repository.ts` (columns, create input, mutators) | config, repository |
| A authority | `src/promotion/authority.ts`, `src/promotion/escalation.ts` | `test/authority.test.ts`, `test/promotion-escalation.test.ts` |
| B extraction | `src/dream/extract/validate.ts` (precision, side_effect / horizon passthrough), `src/dream/extract/prompt.ts`, `src/dream/worker.ts` (precision inputs: full event map, corrected turn's tool lines) | `test/extract-validate.test.ts`, `test/extract-prompt.test.ts`, `test/worker-precision.test.ts` |
| C reconcile | `src/dream/reconcile.ts` (neighbour rules incl. `signatureKeysTwin`, identity-key adoption, enforcementDefault inputs, tier input, human-rejected guard), `src/db/repositories/provenance.ts` (4-hour blocks) | `test/reconcile-replay.test.ts`, provenance / repositories tests |
| D episodes & worker | `src/core/episode-types.ts`, `src/dream/episode.ts`, `src/dream/worker.ts` (decision cap), `src/dream/consolidate.ts` (full sweep), `src/adapters/hook-core.ts` (digest under full) | `test/episode.test.ts`, `test/worker-pipeline.test.ts`, consolidate / hook tests |
| F install | `src/cli/commands/install.ts` (rc.1-written `standard` → `full` when the manifest says pre-rc.2) | `test/cli-install.test.ts` |
| E docs & eval | README / README.ko (autonomy table, review section, config), CHANGELOG, spec §7.4 / §7.6, `upgrade-from-0.5.md`, `setup-new-machine.ko.md`, eval replay scenarios (s02 / s13 pinned to `standard`, the rest run under the default `full`; the full-only paths — silent-write birth, knowledge cap, sweep, human-rejected skip, precision rules — are covered by vitest in `test/authority.test.ts`, `test/reconcile-neighbour.test.ts`, `test/reconcile-replay.test.ts`, `test/consolidate.test.ts`, `test/extract-validate.test.ts`; a `full` replay scenario is deferred), `hm memory:show` fields | `test/docs-cli-reference.test.ts`, `hm eval:replay` |

Gates: tsc; full suite on Windows and WSL; `hm eval:replay`; `hm eval:latency` (no hot-path change expected);
a re-simulation of the new `decideTier` over the dogfood export (aggregate counts only) attached to the PR.
