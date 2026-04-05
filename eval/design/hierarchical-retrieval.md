# Hierarchical Retrieval Design — Phase 2

**Status**: Design (not implemented)
**Author**: harness-memory team
**Date**: 2026-04-06

## Problem Statement

Current retrieval uses flat top-k: all memories are scored equally regardless of structural context. This fails for:

1. **Temporal queries** (CodeMemo: 14.3%): Cannot reconstruct event ordering because individual chunks lack session-level context.
2. **Cross-session queries** (CodeMemo: 0-43%): Top-k grabs chunks from one session, missing multi-session synthesis.
3. **Scale** (CodeMemo project_02: 34%): 44 sessions with 354 memories — retrieval precision drops as pool grows.

### Evidence

| Benchmark | Current Score | Root Cause |
|-----------|--------------|------------|
| CodeMemo Temporal | 14.3% | No time ordering in retrieval |
| CodeMemo Cross-Session | 0-43% | Single-session top-k dominance |
| HM-TimelineBench | 2 test.fails() | Superseded context not retrievable |
| HM-ProductBench | 48.6% coverage | Some rules not found by concept matching |

## Current Architecture (Flat)

```
Query → [Dense Top-40] + [BM25 Top-40] → RRF Fusion → Top-K → LLM
```

All memories compete equally. No session structure. No topic grouping.

## Proposed Architecture (3-Tier Hierarchical)

```
                    ┌──────────────────┐
                    │   Query Router    │
                    │ (default/temporal/│
                    │  cross-session)   │
                    └────────┬─────────┘
                             │
              ┌──────────────┼──────────────┐
              ▼              ▼              ▼
     ┌────────────┐  ┌─────────────┐ ┌──────────┐
     │  Default    │  │  Temporal   │ │  Cross-  │
     │  Retrieval  │  │  Retrieval  │ │  Session │
     └────────────┘  └─────────────┘ └──────────┘

Each retrieval mode uses 3 tiers:

Tier 1: Session Summaries
  ┌─────────────────────────────────────┐
  │ One summary per session (~50 tokens)│
  │ Contains: key decisions, events,    │
  │ topics discussed, tools used        │
  └─────────────────────────────────────┘
         │ Score & select top-N sessions
         ▼
Tier 2: Topic/Event Nodes
  ┌─────────────────────────────────────┐
  │ Per-topic within selected sessions  │
  │ Contains: event type, change point, │
  │ decision rationale, tool pattern    │
  └─────────────────────────────────────┘
         │ Score & select top-M topics
         ▼
Tier 3: Raw Chunks
  ┌─────────────────────────────────────┐
  │ Original conversation pairs         │
  │ Full detail with user+assistant     │
  └─────────────────────────────────────┘
```

## Implementation Plan

### Phase 2a: Session Summary Generation
- At ingest time, generate a 50-token summary per session
- Store as a special memory type or in a separate table
- Summary includes: session_index, key topics, decisions made, tools used

### Phase 2b: Query Router Enhancement
- Current router uses regex patterns (temporal/cross_session/default)
- Enhance with: query embedding similarity to each category
- Add confidence score to routing decision

### Phase 2c: Tiered Retrieval
- Default: existing flat retrieval (works well for factual/debug queries)
- Temporal: Tier 1 → select sessions → Tier 3 chunks in chronological order
- Cross-session: Tier 1 → select diverse sessions → Tier 2 topics → Tier 3 evidence

### Phase 2d: Context Assembly
- Temporal: assemble context in session chronological order
- Cross-session: assemble by session, with session headers
- Default: assemble by relevance score (current behavior)

## Expected Impact

| Benchmark | Current | Expected (Phase 2) |
|-----------|---------|---------------------|
| CodeMemo Temporal | 14.3% | 40-60% |
| CodeMemo Cross-Session | 0-43% | 30-50% |
| CodeMemo Overall | ~50% | 55-65% |
| HM-TimelineBench fails | 2 | 0 (all pass) |
| HM-ProductBench coverage | 48.6% | 55-65% |

## Risks

1. Session summary quality depends on ingest-time processing
2. Additional storage and computation for summary generation
3. Router misclassification can hurt default query performance
4. Over-engineering risk: current system already achieves 74% on compact projects

## Decision

Phase 2 is justified because:
- Temporal and cross-session are the two largest gaps in the benchmark suite
- The flat retrieval ceiling is documented (~50-60% with current approach)
- Hierarchical retrieval is the approach used by top-performing systems (SmartSearch, synapt)

Phase 2 should be implemented AFTER:
- CodeMemo 3-run median results are stable
- Current benchmark suite is committed and CI-integrated
- README is updated with current numbers
