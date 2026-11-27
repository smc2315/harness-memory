# 0.6.0-rc.3 — full autonomy, second pass: decision-born rules and replacement rows

Status: design for 0.6.0-rc.3, written 2026-11-27 after running the rc.2 build against the author's dogfood database (the
17-day, one-project run that motivated [full-autonomy-0.6.0-rc.2.md](full-autonomy-0.6.0-rc.2.md)). The rc.2 design and
its invariants stand; this document only closes two gaps that the rc.2 sweep left open on that data.

## Why

The rc.2 `dream` sweep was run on a copy of the author's database (356 auto candidates). It activates 154 of them, all at
`advise`; 202 stay candidates: 183 for `confidence < 0.7`, and nineteen others that no later run would ever lift:

- **GAP A — decision-born rules.** 14 pitfall / workflow / policy rows with `confidence ≥ 0.7` sit at `candidate(evidence)`
  with `evidence_score 0`. Every one of them was born from an episode whose flags are exactly `{"decision":1}`
  (eligible for extraction through the decision marker, weight 0). decideTierFull demands `evidence ≥ 1` for rule types
  while it takes the same marker as sufficient evidence for `decision` / `architecture_constraint` rows. The rows can
  never meet the bar from their own episode; reinforcement by another decision-only episode adds 0 as well. Among them:
  "Do not run build-migration against prod Tibero: RUN_DDL_ON_START=true drops and recreates the TLEFT account"
  (pitfall 0.75, bash substring signature), "Tibero has no ON UPDATE CURRENT_TIMESTAMP; bulk JPQL UPDATE must set
  updatedAt" (pitfall 0.8). The extractor labelled ten of the fourteen `failure_resolution` and one `correction`
  although their episodes contain no failure and no correction — the label, not the episode, would have given them the
  30-day TTL, the `revalidate` grace, `before_tool.auto_enforcement` at birth and ladder eligibility.
- **GAP B — replacement rows.** 7 `supersede` proposals opened by the extractor are open with `support_sessions = 1`.
  In six of them the *target* is itself a candidate. The sweep walks candidates oldest first, so it activates the old
  target and skips the newer replacement (a replacement row is always `candidate(replacement)`); the 2-session auto
  demotion needs the target to be active and two distinct `session_id`s, which a session resumed for 17 days never
  produces. Result on this data: five corrections parked while the claims they correct are injected for their TTL
  ("MCP server must not decide … that judgment belongs to the TLeft Agent" active, "No TLeft Agent will be built
  (decided 2026-10-27)" waiting; the old zip-marketplace distribution decision active, the HTTPS marketplace.json
  decision waiting).

Both are mechanics gaps, not judgement calls: the rc.2 rule set has no path from these states to resolution. rc.3 adds
the paths and keeps the rc.2 invariants (§7).

## 1. Decision-born rules (GAP A)

### 1.1 The marker counts toward the `full` bar

`decideTierFull` treats a decision marker on the row's **origin** episode as `FULL_DECISION_MARKER_EVIDENCE = 1` toward
`FULL_ACTIVATION_MIN_EVIDENCE` (1) for pitfall / workflow / policy rows:

```
evidence = evidenceScore + (originDecisionMarker ? FULL_DECISION_MARKER_EVIDENCE : 0)
if (evidence < FULL_ACTIVATION_MIN_EVIDENCE) → candidate(evidence)
```

`DecideTierInput.originDecisionMarker?: boolean` (default false = rc.2 answers) is filled by the two callers from the
database with `ProvenanceRepository.hasDecisionOrigin(memoryId)`: true when a `memory_provenance` row with relation
`origin` points at an episode whose `flags_json` carries `"decision":1`. Origin only: a legacy or imported evidence-0 row
reinforced once by a decision-only episode stays a candidate, as §1 of the rc.2 design intends; the current episode's
flag is not consulted separately because the origin provenance of a row created in this run is already stored when
step 7 runs. Nothing else reads the marker: `computeEvidenceWeight`, `isEligibleForExtraction` and the
`decision_only_per_day` cap, `enforcementDefault`'s silent-write bar (`evidence ≥ 2`) and the `standard` / `shadow` /
`off` chain (bar `evidence ≥ 2`) are unchanged. `evidence_score` itself stays 0 for such rows.

Consequence, stated plainly: under `full` every extracted rule row with `confidence ≥ 0.7` and a reachable trigger now
activates, because extraction eligibility already guarantees weight ≥ 1 or a marker. The evidence check still parks
legacy and imported candidates that have no evidence episode.

### 1.2 Labels follow signals

A `knowledge_kind` of `correction` or `failure_resolution` is a claim about the episode: a correction happened, or a tool
failed and was fixed. When the episode carries none of the signals that would make it true — `flags.correction`,
`flags.remember`, `flags.failure`, or `correction_for` — the label is wrong by construction, and it is the label that
drives `baseTtlDays` (30 d instead of 7), the `revalidate` proposal at TTL (another 30 d of injection), rule 2 of
`enforcementDefault` (`before_tool.auto_enforcement`, selectable `soft_deny`) and the A′ ladder predicate.

- **New rows.** `normalizeFact` relabels such a fact to `convention` and records the relabel `kind_without_signal` in the
  outcome (like `policy_to_pitfall`). This is a validator-side correctness rule and applies under every level; import
  episodes keep `knowledge_kind = import`.
- **Existing rows.** Migration 024 (`user_version` 24) applies the same rule once to stored auto rows: a row with
  `knowledge_kind IN ('correction','failure_resolution')`, at least one evidence provenance row (`origin` / `reinforce`),
  and no evidence episode carrying `"correction":1`, `"remember":1`, `"failure":1` or a non-null `correction_for`
  becomes `convention`. Human rows, rows without provenance (legacy, imports) and rows with any signal episode are left
  alone; `ttl_expires_at` already set on active rows is not shortened — the relabel changes what happens at expiry, not
  when.

With both, the 14 dogfood rows activate at `advise` with the 7-day convention TTL (fires extend it by 14 d as for any
rule), go stale directly at expiry and never climb the ladder.

## 2. Replacement rows (GAP B)

### 2.1 Definitions

A **supersede contest** is an open proposal `P(T, R)` of kind `supersede`: `T` is the row named by `target_memory_id`
(read literally — no `superseded_by` chain is followed to decide what `R` replaces), `R` the row named by
`candidate_memory_id`. *Parking* keeps its rc.2 definition untouched (`supersedes_memory_id` resolving through
`resolveTargetRow` to a live row, or being the candidate of any open proposal): whatever rc.3 does not resolve stays
parked exactly as before.

`P(T, R)` is **resolvable** under `full` when all of these hold:

1. `T` exists, is live, `authority = auto`, and `status` is `candidate`, or `stale` with `status_reason = ttl_expired`
   (nothing injected is lost: a candidate was never shown, a TTL-expired row already left the snapshot).
2. No human said no: no `supersede` / `stale` proposal on `T` was `rejected` by a human (`humanRejectedContest`), and
   no `activate_*` proposal on `R` was rejected by a human (`humanRejectedActivation`, rc.2).
3. The human-signal rule of §5.7 step 6, unchanged: when an `origin` episode of `T` carries `correction` or `remember`,
   one supporter of `P` must have `has_human_signal = 1` or `deterministic = 1`. An agent's own claim never erases the
   user's correction.
4. `R` is `authority = auto`, `status = candidate`, and is the candidate of no other open proposal of a different kind
   (a `merge`-parked row keeps rc.2 behaviour). `R` may also already be `active` (it resolved another contest in this
   run); then step 5 is skipped.
5. `R` passes `decideTier` under `full` as if it were not a replacement (`isReplacementRow: false`,
   `originDecisionMarker` per §1.1, the caller's `scanSafe` and budgets): valid scope, scanner, `confidence ≥ 0.7`,
   reachable trigger, the evidence bar, the caps. A replacement below the bar resolves nothing and holds nothing.

Rule **4b** — chains resolve from the correction end. After rules 1–4, when `R` is itself the target of an open
`supersede` contest `P′(R, R′)` that is resolvable — ok under rules 1–4 and, unless `R′` is already active, passing
rule 5 as the caller judges it (`SupersedeCheckOptions.passesTier`: the sweep and reconcile each pass their own
`decideTier` call) — or that is itself held by this rule (recursively, up to `CHAIN_MAX_DEPTH` = 10), `P` is skipped as
`candidate_contested`: the contest on `R` resolves first and its chain walk (§2.2) settles `P`, so `T` is superseded by
`R′`, never by the contradicted `R`. In a chain `T0 ← T ← R ← S` with `T` and `R` passing, `P(T0, T)` and `P(T, R)` are
`candidate_contested` and `P(R, S)` is ok: that one resolution supersedes `R`, `T` and `T0` by `S` (three
`full_supersede` rows, `via` on the hops). When no contest on `R` is resolvable (`R′` below the bar, `R′`
human-rejected, …) `P` proceeds as before, and an active `R` keeps the two-session rule for its own contests, so `P` on
an active `R` is ok without a tier decision. A `candidate_contested` skip costs no budget unit and leaves no report
entry: the later contest in the same pass resolves it.

### 2.2 Candidate and stale targets resolve on one support

For a resolvable `P(T, R)` the resolution is `decideProposal({ accept: true, decidedBy: "auto_rule", note:
"full_autonomy" })`, which is the activation owner: `T → superseded` (`superseded_by_memory_id = R`, the two new edges of
§2.6), `R → active` with `tierTtlDays(kind, horizon, type)`, `revalidate_after` at the midpoint and
`validation_count = evidence_count − 1`. Nothing else activates `R`. Then, in the same resolution:

- every other open `supersede` / `stale` / `revalidate` proposal whose target is `T` is closed `expired` by `auto_rule`
  with decision note `full_autonomy` (a dead target cannot be contested further; a sibling replacement `R2` stays parked
  by its `supersedes_memory_id` until a new extraction names the live row, exactly as rc.2 would have left it);
- every open `supersede` proposal `P'(T0, T)` whose *candidate* is `T` is walked (≤ 10 hops): `T0` auto, `candidate` /
  `stale(ttl_expired)`, not human-rejected, and admissible under rule 3 with `P'`'s supporters → `T0 → superseded` by
  `auto_rule` with replacement `R` and `P'` accepted (`full_autonomy`), its own siblings closed, recursion on `T0`;
  otherwise `P'` is closed `expired` (`full_autonomy`) and `T0` is left alone. A proposal whose candidate is dead can
  never be accepted by anyone, so it never dangles;
- open `activate_policy` / `activate_global` proposals on `R` are closed `expired(full_autonomy)` as the sweep does for
  any activation;
- `open_proposal_id` / `contested` are refreshed on every touched target; one `audit_log` row `full_supersede` per
  superseded row (`targetId`, `replacementId`, `proposalId`, `source: "sweep" | "extraction"`, `via` for chain hops).

The walk is idempotent across diamonds: every proposal is re-read before it is decided and a hop that an earlier hop's
recursion already closed is skipped, so two paths to the same proposal never throw `Proposal … is already expired`;
`proposalsAccepted` / `proposalsClosed` list each id at most once and `superseded` lists `T` first, then the chain
targets in walk order. `CONTESTING_KINDS` (`supersede`, `stale`, `revalidate`; exported from `promotion/proposals.ts`)
is the one definition behind the sibling closure and `flagTarget`'s `contested` flag; `chainTargets(proposals,
targetId)` (read-only, the same `CHAIN_MAX_DEPTH`) lists the targets behind a row through open `supersede` proposals,
nearest first, each once — decided proposals do not count.

### 2.3 Active targets keep the two-session rule — and the rule becomes reachable

A row that is **active** was injected; rc.2's protection against erasing it on one extractor claim stands under every
level: `evaluateAutoDemotion` (target active, `support_sessions ≥ 2`, human-signal rule, no policy target). The rule
has never been gated by `autonomy_level`: reconcile step 6 runs it under `off`, `shadow` and `standard` exactly as under
`full`, so everything this section changes about it applies under every level. rc.3 adds the human veto to it: a
`supersede` / `stale` on the target that a human rejected returns `target_human_rejected`, a human-rejected
`activate_policy` / `activate_global` on the replacement of a `supersede` returns `candidate_human_rejected`
(`humanRejectedContest` / `humanRejectedActivation`), both checked right after the target's status and before the
session count, at extraction time (outcome detail `support=<count>/<sessions> (target_human_rejected)` /
`(candidate_human_rejected)`) and in the sweep's phase 2. What rc.3 also fixes is the counter. `support_sessions` is
now `COUNT(DISTINCT (session_id, 4-hour block of episodes.started_at))`
over the proposal's supporters — the same key `distinct_session_count` has used since rc.2 §4 — instead of
`COUNT(DISTINCT session_id)`, so a claim repeated in another block of the same resumed session is a second session.
The sweep additionally re-evaluates every open `supersede` / `stale` proposal whose target is an active auto row:
`recomputeDerived(P)` then `evaluateAutoDemotion(P)`, so a proposal that already has two blocks resolves at the next
`dream` instead of waiting for a fresh support. A replacement that resolves this way is activated by `decideProposal`
with the same TTL rule as §2.2 and gets the sweep's activation bookkeeping: its open `activate_policy` /
`activate_global` proposals are closed `expired` by `auto_rule` with decision note `full_autonomy` (ids appended to
`DreamReport.sweptProposalsClosed`) and one `audit_log` row `full_sweep_activation` is written — summary `full sweep:
<type> <summary> activated via supersede of <targetId> (evidence N, confidence C)`, `details_json` `{ memoryId, type,
evidenceScore, confidence, ttlExpiresAt, proposalsClosed, proposalId, superseded: [targetId] }`.

### 2.4 Where it runs

- **`dream` full sweep** (`autonomy_level: full` only). Order inside the step: (1) open `supersede` proposals, oldest
  first, whose target is an auto `candidate` / `stale(ttl_expired)` and whose candidate is an auto candidate — each
  checked (§2.1; a contest rule 4b holds is skipped as `candidate_contested`, no unit, no report entry — the later
  contest in the same pass resolves it through its chain walk), evaluated (`decideTier` with the sweep's own budget)
  and resolved (§2.2); (2) open `supersede` / `stale` proposals on active auto targets — recount and
  `evaluateAutoDemotion` (§2.3), no unit, with the activation bookkeeping of §2.3; an application makes the `dream`
  op non-noop; (3) the rc.2 candidate loop, which now re-reads each row before deciding (a target superseded in
  phase 1 is skipped) and passes `originDecisionMarker`. `dream.full_sweep_per_run = 0` switches phases 1 and 3 off;
  phase 2 still runs. Because phase 1 runs first, a contested candidate whose contest is resolvable is superseded
  before the loop could activate it; a candidate whose contest is not resolvable (replacement below the bar, human-signal
  rule, human target) activates as under rc.2 — nothing is held. Each resolution and each activation runs in its own
  `SAVEPOINT` (as reconcile runs every fact): a throw costs that row, is reported in `report.sweptErrors`
  (`resolution <proposalId>: <message>` / `activation <memoryId>: <message>`), and never rolls back the run's other
  activations; a resolution that threw holds its target **and** every chain target behind it (`chainTargets`) back
  from phase 3 in that run, so the retry at the next `dream` finds the chain intact. A resolution costs one unit of
  `dream.full_sweep_per_run`. `DreamReport.sweptActivated` lists the auto rows the sweep activated — by `decideTier` in
  phase 3, by `decideProposal` as the replacement of a resolved or demoted contest in phases 1–2.
- **Extraction (reconcile step 7, `full` only).** Per-candidate `SAVEPOINT`. For every tier candidate `M` the open
  `supersede` contests whose *target* is `M` are resolved first (source `extraction`); only when none resolved and `M`
  is a replacement row are the contests it is the *candidate* of resolved, and if none resolves the row stays
  `candidate(replacement)`. A contest rule 4b holds is resolved from the correction end here too: the step recurses on
  the contests whose target is that contest's candidate (up to `CHAIN_MAX_DEPTH`), and `M` is then superseded through
  the top resolution's chain walk, never activated; a contested candidate whose chain did not resolve in this run (a
  `supersede` cycle, a chain deeper than `CHAIN_MAX_DEPTH`) is left to the sweep's phase 1 with outcome detail
  `tier=candidate:contested`. The outcome annotations are written the moment a resolution is applied, for every row of
  this run it touched: each superseded target gets `tier=candidate:superseded(<replacementId>)` — exactly one id, the
  replacement that superseded it (`S` for `T0` in a 3-chain) — and the activated replacement gets `tier=active;
  full_supersede=<targetIds>` (walk order, `T` then the chain hops) with `proposal_id` = the resolving contest (a
  `created` / `reinforced` entry flips to `activated`, a `superseded_proposed` entry keeps its kind). A row annotated
  this way is no longer `candidate`, so its own step-7 entry adds nothing: `tier=` appears once per detail. An
  activation through a resolution is charged to the run's caps like any `decideTier` activation (`activatedThisRun` /
  `activatedToday`, or `knowledgeActivatedToday` by type), once per activated replacement. Report:
  `ReconcileReport.superseded` (the targets in walk order) and `activated` (the replacement, once); the worker's
  `reconciled` log line carries `superseded=<n>` after `activated=<n>`, `ProcessedEpisode.superseded` reaches
  `hm extract --json` / `hm import --json`, and the per-episode CLI line reads `episode <id8> run <id8> <status>:
  created N, activated N, superseded N, proposals N, outcomes N`.

### 2.5 Budgets and transition reasons

`DecideProposalInput.transitionReason?: string` (default `proposal:<kind>`) is written to every transition the decision
makes. Sweep resolutions pass `full_sweep`, so `countAutoActivationsSince` keeps excluding them and the rc.2 promise —
sweep activations consume neither daily cap — still holds; extraction-time resolutions keep the default reason and are
counted. `hm memory:history` prints the decision note of a decided proposal (`accepted by auto_rule (full_autonomy)`).

### 2.6 State machine

Two edges are added to §4.7, both `auto_rule`, both auto-only: `candidate → superseded` and `stale → superseded` with
`status_reason = ttl_expired` required for the latter (a row a human demoted keeps the human's verdict, as the existing
`stale → active` edge already does). `transitionMemory` remains the only status writer; an `auto_rule` transition on a
human row still throws `AuthorityViolationError` before anything is written.

### 2.7 `decideProposal` TTL

The `auto_rule` accept of a `supersede` gives the replacement `tierTtlDays(kind, horizon, type)` instead of
`horizon === task ? 7 : baseTtlDays(kind)`: a `task` row still gets 7 days, a rule keeps `baseTtlDays`, and a
`decision` / `architecture_constraint` replacement gets `KNOWLEDGE_TTL_DAYS` (30) like every other knowledge activation.
Visible outside `full` for a knowledge replacement accepted by the two-session rule (7 → 30 days) — under `standard`,
`shadow` and `off` alike, since that rule is level-blind (§2.3).

## 3. What does not change, and known limits

- `standard` is the rc.1 gate except for two deliberate, documented changes: the block-aligned `support_sessions`
  (the two-session rule fires in a resumed session, as the rc.2 ladder already does) and the knowledge-replacement TTL
  of §2.7. Both apply under every level, because the two-session rule has never been gated by `autonomy_level`
  (§2.3), and so does its human veto (`target_human_rejected` / `candidate_human_rejected`). `shadow` logs
  `decideTier` decisions only (`audit_log(auto_activation_shadow)`): a contested active auto row can still be
  superseded, and its replacement activated, by the two-session rule under every level, as under rc.1. `off` likewise:
  `decideTier` never activates anything, the two-session rule still runs. `kind_without_signal` applies to extraction
  under every level.
- A `stale` proposal against a *candidate* target has no automatic resolution and does not hold the candidate: the
  two-session rule applies once the target is active, otherwise the proposal expires.
- A contest that is not resolvable — human target, human-signal rule unmet, replacement below the bar, merge-parked
  replacement, expired proposal — leaves the contest open and both rows as rc.2 left them: the target follows its own
  rules (it is swept like any other candidate; nothing is held) and the replacement stays parked until the candidate
  expiry or until a new extraction names the live row. A contest held by rule 4b is not unresolvable: the contest
  above it settles it in the same pass. The one dogfood
  pair this applies to ("no other prod system accesses tleft2 MariaDB tables", born from a correction + remember
  episode, versus "Foreign TBL_* tables are read by an external client", born from a failure → resolution episode
  without a human-signal supporter) is a deliberate outcome of rule 3, not a gap: a correction by the user resolves it.
- Human targets: the proposal waits for `hm review` or expires; `full` suppresses the daily digest as in rc.2.
- No new configuration key. The paths are bounded by the rc.2 knobs (`dream.full_sweep_per_run`, the activation caps,
  `before_tool.auto_enforcement`).

## 4. Approaches considered

GAP A. (A-2) Count the marker in `computeEvidenceWeight`: changes extraction eligibility (the `decision_only_per_day`
cap keys on the `decision` reason), lifts decision + bare-correction episodes to the silent-write bar, and needs a
backfill of `episodes.evidence_weight` — rejected. (A-3) Use `knowledge_kind` as the marker: unreliable (nine of the
fourteen rows are labelled `failure_resolution`). (A-4) Drop the evidence check under `full`: activates legacy evidence-0
candidates and makes the documented bar false. Chosen: §1.1 (origin-only marker, additive constant, the bar stays
literally `evidence ≥ 1`) plus §1.2, because without the relabel the fix would inject marker-only rules for 60 days
under a false label.

GAP B. (B-2) `AUTO_DEMOTION_MIN_SESSIONS = 1` under `full`: still requires an active target (six of seven are
candidates) and runs only at support time. (B-3) Hold contested candidates without resolving: leaves the correction
parked until the target dies. (B-5, the first draft) Resolve any live target on one support, including active rows,
with a "direct" path following `superseded_by` chains and a hold-back rule: the review found it activates the
replacement twice (`decideProposal` already does), rolls back the whole sweep on any throw, supersedes rows no
extraction ever contradicted through the chain hop, charges sweep resolutions to the daily caps, drops the two-session
protection for active rows, orphans chained proposals, and holds passing rows for a month on an unpassable claim.
Chosen: §2 — literal targets through open proposals only, candidate / stale targets on one support, active targets
through the two-session rule made reachable, `decideProposal` as the single activation owner, per-row savepoints.

## 5. Expected effect on the dogfood dump

Verified by re-running the sandbox (`hm db:migrate`, then `hm dream` until the sweep reports nothing):

- GAP A: the 14 rows activate at `advise` with a 7-day TTL (eleven relabelled to `convention` by migration 024 — ten
  `failure_resolution`, one `correction` — and three conventions; one of the fourteen is also the replacement of a
  resolvable contest and activates through §2.2). Migration 024 relabels 22 stored auto rows on the dump in all.
- GAP B: four proposals resolve — targets superseded, replacements active (`accepted by auto_rule (full_autonomy)`).
  Three stay open: the 0.65 replacement (below the bar; its 0.6 target fails the bar too), the active-target case
  (waits for a second 4-hour block), the human-signal case of §3 (its target activates as under rc.2).
- Against the rc.2 run: 17 rows newly active (14 + 4 − 1 row that is both), 3 rows active under rc.2 now superseded,
  human rows untouched, every activated row at `advise`, a second `dream` run changes nothing.

## 6. Files and ownership

- `src/db/repositories/common.ts` (`decisionEpisodeSql`, `sessionBlockKeySql`), `provenance.ts` (`hasDecisionOrigin`),
  `proposals.ts` (`recomputeDerived` block-aligned). Tests: `repositories-provenance`, `repositories-proposals`.
- `src/promotion/transitions.ts` (edges, doc table); `src/promotion/proposals.ts` (`transitionReason`, `tierTtlDays`,
  exported `flagTarget`, `targetOriginHasHumanSignal`, `humanRejectedContest`, `CONTESTING_KINDS`; the human veto of
  `evaluateAutoDemotion`). Tests: `promotion-transitions`, `proposals`.
- `src/promotion/authority.ts` (`FULL_DECISION_MARKER_EVIDENCE`, `originDecisionMarker`). Tests: `authority`.
- `src/dream/reconcile.ts` (`normalizeFact` relabel, `decideTiers`), `src/db/migrations/024_knowledge_kind_signal.sql`,
  `src/core/paths.ts` (`TARGET_USER_VERSION` 24). Tests: `reconcile-replay`, `migrator`, `db-migrations-legacy`.
- `src/promotion/replacement.ts` (new: `checkSupersedeResolution` with `SupersedeCheckOptions`, `applySupersedeResolution`,
  `chainTargets`, `CHAIN_MAX_DEPTH`, the two constants). Tests: `promotion-replacement` (new).
- `src/dream/consolidate.ts` (`fullSweep` phases, savepoints, `sweptSuperseded` / `sweptErrors`), `src/cli/lib/worker-run.ts`,
  `src/dream/worker.ts` (log fields), `src/cli/commands/memory-history.ts` (decision note). Tests: `consolidate`,
  `worker-pipeline`.
- Docs: `README.md`, `README.ko.md`, `CHANGELOG.md`, `docs/redesign/spec-v0.6.md` (§4.7, §5.7 steps 6–7, §7.4, §12 R4),
  `package.json` (0.6.0-rc.3).

## 7. Invariants kept

Hooks never open SQLite; zero model tokens per tool call; the automatic path never touches human rows (upward or
downward); `deny` and `confirm` are human-only; `transitionMemory` is the only status writer; a claim a human declined is
never enacted by the automatic path (now including a rejected `supersede` / `stale` on the target and, in the
two-session rule under every level, a rejected `activate_*` on the replacement — `target_human_rejected` /
`candidate_human_rejected`); sweep activations consume neither daily cap; no account, no telemetry.
