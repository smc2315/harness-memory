# Baseline vs Memory Layer Comparison Report

## Executive Summary

Decision signal: `CONTINUE`

- The corpus-anchored markdown baseline records 6 important policy misses out of 12 scenarios, while the deterministic memory-layer replay records 0 important misses across the same 12-scenario corpus.
- The memory layer also surfaces the edge cases markdown handles poorly: 2 stale markers, 3 conflict markers, and 5 warning events, all while staying within the 10-memory / 8KB activation budget.
- This is strong evidence that the wedge is real for coding harnesses, but the current evidence is still harness-level replay data rather than a live side-by-side agent benchmark.

## Data Sources

- Baseline source: `research/eval/baseline-scorecard.csv`
- Experimental source: `research/eval/output/summary.json`
- Corpus source: `research/eval/task-corpus.md`
- Baseline procedure: `research/eval/md-only-runbook.md`

## Method

The baseline side uses corpus-anchored markdown-only annotations captured in `research/eval/baseline-scorecard.csv`. The experimental side uses the implemented memory-layer evaluation harness in `research/eval/output/`, which deterministically replays the same scenario set through the activation engine, policy engine, and adapter logging path.

This means the comparison is valid for the MVP question - whether the memory layer surfaces the right things at the right lifecycle boundaries - but it is not yet a live agent A/B benchmark. The conclusions below should therefore be read as wedge validation, not final proof of production impact.

## Primary Metric

Continue threshold: reduce important policy misses by at least 30% versus markdown-only.

| Metric | Baseline | Memory Layer | Result |
|---|---:|---:|---:|
| Important policy misses | 6 | 0 | 100% reduction |
| Threshold | - | - | PASS |

The baseline's important misses cluster around exactly the cases the product claims to handle: architecture constraints, security warnings, reliability policies, deployment safety, and compliance rules. The memory-layer runner clears those same scenarios with explicit activations or warnings and records no important miss in the replayed harness condition.

## Miss Breakdown

| Miss Type | Baseline | Memory Layer |
|---|---:|---:|
| `policy_miss` | 7 | 0 |
| `stale_memory` | 1 | 0 |
| `none` | 4 | 12 |

| Severity | Baseline | Memory Layer |
|---|---:|---:|
| `critical` | 2 | 0 |
| `high` | 4 | 0 |
| `medium` | 2 | 0 |
| `low` | 4 | 12 |

The baseline profile is dominated by policy and stale-memory failures, which is consistent with the original product thesis. The experimental runner eliminates those failures in the deterministic harness condition rather than merely reducing them slightly.

## Memory Layer Performance

| Metric | Value |
|---|---:|
| Scenarios run | 12 |
| Passed scenarios | 12 |
| Failed scenarios | 0 |
| Activated memories | 23 |
| Suppressed memories | 301 |
| Warning count | 5 |
| Conflict markers | 3 |
| Stale markers | 2 |
| Average deterministic latency | 67.42 ms |
| Budget violations | 0 |

The activation numbers show the system is not merely returning everything. It is suppressing aggressively, which is the correct behavior for this wedge. The stale and conflict markers demonstrate that the memory layer is adding selective state management rather than just another documentation dump.

## Scenario Findings

- **Scenario 2**: The runner activates `mem_workflow_vitest_001` and explicitly suppresses stale `mem_workflow_bun_001`, which is the exact stale-preference failure mode markdown struggles to express cleanly.
- **Scenario 3**: The runner surfaces `NO_COMMIT_SECRETS` as a warning before the `.env.local` write path, validating the warning-only policy boundary.
- **Scenario 5**: The runner activates both validation decisions and emits a conflict marker instead of silently choosing one, which is a concrete improvement over markdown ambiguity.
- **Scenario 7**: The runner records session evidence after the tool cycle, preserving future promotion context that markdown-only does not capture.
- **Scenario 9**: The stale pitfall remains suppressed and is still logged as stale, proving the layer can retain history without reintroducing bad guidance.
- **Scenario 12**: The runner keeps the top 10 payment-service memories, suppresses the rest with `budget_limit`, and still records conflict markers, which validates bounded inspectability rather than unbounded recall.

## Where Markdown-Only Remains Sufficient

Markdown-only remains sufficient when the team only needs a static, well-maintained project handbook and can tolerate manual recall. It is also sufficient for negative-control cases where no scoped activation should happen at all.

Markdown-only is not sufficient for this wedge when the problem is trigger-aware surfacing: warning before tool execution, stale-memory suppression, unresolved conflict surfacing, or after-tool evidence capture. Those are the moments where the memory layer shows a real difference.

## Risks And Limits

- The baseline source is corpus-anchored annotation, not a fresh live run transcript.
- The experimental source is a deterministic harness replay, not a live model that can ignore or misuse the surfaced guidance.
- The current evidence proves the layer can surface the right things; it does not yet prove that every real model will heed them under production pressure.

The next evidence step should therefore be a live side-by-side agent benchmark on the same corpus, not a broader platform build-out.

## Recommendation

Continue, but keep the scope narrow. The product appears to beat disciplined markdown specifically on lifecycle-aware surfacing, stale/conflict handling, and evidence capture. That is enough to justify the next round, but not enough to justify expanding into generic memory, vector retrieval, or autonomous promotion.

## Data Integrity Markers

Baseline Rows: 12
Baseline Important Policy Misses: 6
Baseline Policy Misses: 7
Baseline Stale Memory Misses: 1
Experimental Scenario Count: 12
Experimental Passed Scenarios: 12
Experimental Warning Count: 5
Experimental Conflict Count: 3
Experimental Stale Marker Count: 2
Important Policy Miss Reduction: 100%
