# 0.6.0-rc.2 — full autonomy (zero-touch) design

Date: 2026-11-26. Status: being implemented on `feat/full-autonomy`. Supersedes nothing in `spec-v0.6.md`; it adds
an autonomy level and tightens the write path. Numbers below come from the first dogfood run (17 days, one Java/Spring
service, Claude Code on WSL, 2026-11-09 … 11-26); the raw data stays with the author.

## Why

The author's verdict after 17 days: *a tool that needs human intervention will not be used.* The data agrees:

- 153 proposals opened, **0 decided**; 356 candidates waiting; the review gate (≤ 3 items per active day) was exceeded
  nine-fold (27 / day). `hm review` was never run.
- **0 `ask` / `deny` decisions in 13,685 PreToolUse calls.** All 51 auto rules stayed at `advise`; the ladder climbed
  once, because `distinct_session_count` counts re-extractions (rare) and not fires. Advise at PreToolUse is delivered
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

`decideTier` gets the level and the knowledge cap in its input and returns `reason: "type" | "scope"` only under
`standard`. Order under `full`: replacement → scope valid → scanner → confidence → (informational: at least one
lifecycle trigger, knowledge cap) → (pitfall/workflow/policy: trigger reachable, evidence ≥ 1, activation caps) →
active. `shadow` keeps its rc.1 meaning — a dry run of `standard` logged to `audit_log` — and `off` activates
nothing. The two daily counters are separate: knowledge activations never consume the rule caps, and the `dream`
sweep's activations (transition reason `full_sweep`) consume neither, so a sweep of 50 does not starve the day's
extractions.

The silent-write rule (§3) and the neighbour rules (§4) are level-agnostic: a `standard` project also gets them,
and `before_tool.auto_enforcement_silent_write: "advise"` is the switch back to rc.1 births.

Backlog drain: the consolidator (`dream`) gains a `full` sweep — every auto `candidate` row is re-evaluated with
`decideTier` under the running level and activated when it passes, up to `dream.full_sweep_per_run` (default 50) rows
per run; open `activate_policy` / `activate_global` proposals whose target activated are closed `expired` with
decision note `full_autonomy`. The author's 356 candidates drain in a week of normal `dream` runs.

## 2. Signature precision and side effect

Two new fact-level facts, computed once in the worker, stored on the row (migration 023):

- `signature_precision` ∈ {`mistake_exact`, `noun`} (NULL without a signature). The validator compiles the signature
  and tests it against every `tool_ok` line of the episode. A hit on a line the fact does **not** cite, or on a cited
  line that resolved a failure (`resolution_of` set), makes it `noun`: the pattern names the operation, not the
  mistake. Otherwise `mistake_exact`. (V12 is the special case "matches the resolving command of a different
  program"; it keeps rejecting.) The dogfood set: 17 of 28 active signatures would be `noun`, carrying 105 of 114
  signature fires.
- `side_effect` ∈ {`read`, `write`} on `trigger_signature`, emitted by the extractor (schema field, optional for
  recorded outputs; default `read`): `write` when the matched call creates, modifies, deletes or transitions data in
  a shared system (a push, a POST, an UPDATE, an MCP create / update / transition).
- `horizon` ∈ {`durable`, `task`} on the fact (optional, default `durable`): `task` marks knowledge about the current
  task's state. A `task` row gets the 7-day TTL and never exceeds `advise`.

A new signature whose `signature_key` is a substring or superstring of an existing active row's key for the same tool
is treated as that row's twin (reinforce), not a new row (§4).

## 3. Enforcement at birth and the ladder

`enforcementDefault` (auto rows), top to bottom:

1. type ∈ {pitfall, policy} ∧ compiled signature ∧ V10 ok ∧ `signature_precision = mistake_exact` ∧
   `side_effect = write` ∧ knowledge_kind ∈ {correction, failure_resolution} ∧ `evidence_score ≥ 2` ∧ `horizon = durable`
   → `before_tool.auto_enforcement_silent_write` (default **`soft_deny`**).
2. pitfall ∧ signature ∧ V10 ok ∧ knowledge_kind ∈ {correction, failure_resolution} → `before_tool.auto_enforcement`
   (default `advise`, unchanged).
3. everything else → `advise`.

On the dogfood set rule 1 would have fired exactly twice (the two rows both raters agreed on). `soft_deny` semantics are
unchanged: only the first attempt of a (memory, tool) pair per turn is denied, the retry passes and records an
override; ≥ 3 overrides with evidence < 3 drop the row to `advise` (consolidator); TTL 30 days with the +14-day fire
extension.

The ladder (`decideEscalation`) runs under `standard` and `full`, and adds `signature_precision = mistake_exact` to its
predicate: a noun-level row never climbs however often it is reinforced. Reinforcement itself becomes observable (§4).

## 4. Reinforcement and duplicates

- `distinct_session_count` counts distinct `(session_id, 4-hour block of episode.started_at)` pairs, so a resumed
  17-day session yields reinforcement when the same fact comes back hours later. Import episodes keep counting once.
- `findNeighbour` (reconcile step 3) treats a live row of the same type with an intersecting scope as the twin when
  any of these holds, in addition to Jaccard ≥ 0.6 on the summary: equal `signature_key`; one key a substring of the
  other (same tool); ≥ 2 shared aliases (case-folded); a shared error-code token (`C001`, `G006`, `P003`, `ERROR 1054`,
  `JDBC-11021` …). The §5.7 rule stays: a signature-bearing fact is never absorbed by a signature-less neighbour.

## 5. What is not extracted any more

- An episode closed as `interrupted` with ≤ 1 non-prompt event is `no_signal` whatever its flags (41 such episodes,
  0 accepted facts).
- A correction cue in the prompt counts **2** only when the episode is a correction of a previous turn that had tool
  calls (`correction_for` set and the corrected episode has ≥ 1 tool line); a bare cue (ordinary "A 말고 B", "never" in
  a new instruction) counts **1**. The episode stays eligible; auto activation then needs a second signal for
  `soft_deny`, and under `full` the fact still activates at `advise`.
- Decision-marker-only episodes (evidence 0) are extracted at most `extraction.decision_only_per_day` (default 5)
  times per day; the rest are skipped with reason `decision_cap`. Under `full` their facts activate (§1), so the
  budget buys session-start knowledge rather than review-queue entries.

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

Upgrading from rc.1: the default level changes to `full`; a project that wants the review gate sets
`autonomy_level: "standard"` in `.harness-memory/config.json`. Migration 023 adds `signature_precision`,
`side_effect`, `horizon` to `memories` (NULL for existing rows; the `full` sweep treats NULL precision as `noun`, so no
existing row can be escalated by the new rule without a re-extraction).

## 8. Files and ownership (implementation)

| area | files | tests |
|---|---|---|
| shared | `src/core/vocabulary.ts` (levels, `SignaturePrecision`, `Horizon`, `TriggerSignature.side_effect`), `src/core/extraction-types.ts` (schema fields, version), `src/core/config.ts`, `src/db/migrations/023_signature_precision.sql`, `src/db/schema/types.ts`, `src/memory/repository.ts` (columns, create input, mutators) | config, repository |
| A authority | `src/promotion/authority.ts`, `src/promotion/escalation.ts` | `test/authority.test.ts`, `test/promotion-escalation.test.ts` |
| B extraction | `src/dream/extract/validate.ts` (precision, side_effect / horizon passthrough, substring twin), `src/dream/extract/prompt.ts` | `test/extract-validate.test.ts`, `test/extract-prompt.test.ts` |
| C reconcile | `src/dream/reconcile.ts` (neighbour rules, enforcementDefault inputs, tier input), `src/db/repositories/provenance.ts` (4-hour blocks) | `test/reconcile-replay.test.ts`, provenance / repositories tests |
| D episodes & worker | `src/core/episode-types.ts`, `src/dream/episode.ts`, `src/dream/worker.ts` (decision cap), `src/dream/consolidate.ts` (full sweep), `src/adapters/hook-core.ts` (digest under full) | `test/episode.test.ts`, `test/worker-pipeline.test.ts`, consolidate / hook tests |
| E docs & eval | README / README.ko (autonomy table, review section, config), CHANGELOG, spec §7.4 / §7.6, `upgrade-from-0.5.md`, `setup-new-machine.ko.md`, eval replay scenarios (existing ones pinned to `standard`, two new `full` scenarios), `hm memory:show` fields | `test/docs-cli-reference.test.ts`, `hm eval:replay` |

Gates: tsc; full suite on Windows and WSL; `hm eval:replay`; `hm eval:latency` (no hot-path change expected);
a re-simulation of the new `decideTier` over the dogfood export (aggregate counts only) attached to the PR.
