# Roadmap

## Roadmap Rule

This roadmap follows the current evidence. It does not assume the product should broaden just because the harness replay passed.

## Phase 1: Live Benchmark On The Same Corpus

Goal: confirm that real model behavior improves, not just harness-level surfacing.

Deliverables:
- run a live side-by-side benchmark using the same 12-scenario corpus
- fill the baseline and memory-layer evidence artifacts with real session outputs
- confirm whether the current 100% important-policy-miss reduction survives a real agent run

Exit criteria:
- important policy misses still improve by at least 30%
- false-warning rate stays acceptable in live use
- the model actually heeds surfaced warnings and activated memories often enough to matter

## Phase 2: Tighten The Narrow Product Loop

Goal: improve operator ergonomics without broadening the product category.

Deliverables:
- make promotion review and evidence inspection faster for repeated project rules
- harden activation ranking and stale/conflict surfacing using failures found in the live benchmark
- keep inspectability first: local files, SQLite export, and explainable CLI output remain primary

Exit criteria:
- review overhead stays low enough for a solo operator
- activation quality improves on the scenarios that regressed or remained noisy
- the product still fits the coding-harness wedge without adding generic-memory sprawl

## Explicitly Deferred

Do not pull these into the next roadmap phase unless new evidence demands them:
- graph storage
- personal-memory features
- replacing markdown as the source of truth
- broad platform packaging before the live benchmark is complete

## Completed: Hybrid Retrieval + English Storage (v0.4.1)

- Dense ∪ Lexical (MiniSearch BM25) → RRF fusion for candidate generation
- Shared LexicalIndex built once per activation (not per-query)
- English-only storage enforced in LLM extraction prompts
- Tier 2 benchmarks: EN→KO hit 0.25→0.75, domain purity 55.6%→78.4%, hard-negative loss 7.7%→0.0%

## Completed: Conditional Auto-Promotion (v0.4.0)

Moved from "Explicitly Deferred" after implementing the B+ model:
- 5-gate conditional promotion (security, confidence, evidence, type, policy exclusion)
- Trust multiplier scoring (auto memories start at 0.65, earn up to 0.95 through revalidation)
- 14-day TTL for auto-promoted memories with revalidation extension
- Negative evidence demotion (contradiction → immediate stale)
- `memory:demote` CLI for manual reversion
