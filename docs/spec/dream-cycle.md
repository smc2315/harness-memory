# Dream Cycle

## Purpose

The dream cycle is a background-style consolidation pass over recent evidence. It does **not** directly auto-promote long-term memory by default. Instead, it transforms append-only evidence into `candidate` memories, merge suggestions, stale markers, and reviewable summaries.

This keeps the hot path cheap:

- `after_tool` captures raw evidence
- `dream` consolidates recent evidence windows
- `active` memory remains conservative and explainable

## Memory Layers

The system operates in three layers:

1. **Evidence layer**
   - Append-only tool evidence events
   - Fast writes, no promotion decisions
   - Raw signal for later review

2. **Candidate layer**
   - Dream-generated, reviewable memories
   - Status stays `candidate`
   - Safe place for repeated workflow/pitfall patterns

3. **Active memory layer**
   - Manually promoted or otherwise validated memories
   - Used by activation and warning flows
   - Kept intentionally small and trustworthy

## Trigger Model

The dream step should use multiple signals instead of a single coarse trigger.

### Manual trigger

- `dream:run --trigger manual`
- Always available
- Used for explicit review or post-refactor cleanup

### Boundary triggers

- `precompact`
- `task_end`
- `session_end` equivalents such as explicit rollover or new session start

These should usually enqueue or prioritize a dream run rather than force an expensive consolidation in the hot path.

### Idle trigger

- `idle`
- Intended for background-style consolidation after a recent activity burst

## What Dream Does

Each dream run follows four phases.

### Phase 1: Orient

- Inspect recent evidence window
- Inspect nearby candidate memories in the same scope/topic
- Inspect matching active memories only when needed for conflict/stale reasoning

### Phase 2: Gather

- Group evidence by scope and topic guess
- Prefer repeated signals over one-off traces
- Treat failed tool executions as stronger `pitfall` candidates
- Treat repeated successful, structured sequences as `workflow` candidates

### Phase 3: Consolidate

- Create or refresh `candidate` memories
- Merge repeated evidence into existing candidate details
- Mark weak or contradictory evidence for later review
- Never auto-promote directly to `active` in the MVP

### Phase 4: Summarize

- Record a `dream_run`
- Mark consumed evidence events
- Defer or discard low-value evidence so it does not loop forever
- Emit a concise summary of candidate creation/refresh/skip decisions

## Promotion Policy

Dream does **not** replace the promotion rubric.

- `candidate` -> `active` remains review-gated by default
- `workflow` and `pitfall` are the safest first types for dream-generated candidates
- `policy`, `architecture_constraint`, and `decision` need stronger external evidence and should stay conservative

## Storage Contract

Dream requires two persistence layers beyond the existing MVP tables:

- `dream_evidence_events`
  - append-only recent signal store
  - later consumed/deferred/discarded by dream runs

- `dream_runs`
  - run history, trigger reason, time window, and summary

- `dream_memory_evidence_links`
  - durable provenance from dream evidence events to candidate memories
  - used by review/history and later audit flows

The existing `memories` table already supports the candidate layer through `status = candidate`.

## Non-Goals

This design intentionally does **not** do the following yet:

- direct auto-promotion to `active`
- transcript-wide reprocessing on every dream
- vector search or graph-based consolidation
- hidden, opaque relevance scoring that cannot be explained
- LLM-based candidate creation in the default dream path
