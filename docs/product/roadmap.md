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
- vector retrieval
- graph storage
- autonomous promotion
- personal-memory features
- replacing markdown as the source of truth
- broad platform packaging before the live benchmark is complete
