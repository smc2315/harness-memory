# Final Positioning

## First User

The first user is a solo harness builder or power user who already keeps a disciplined `CLAUDE.md` but still loses important rules at execution time. They are not looking for a new knowledge base. They are looking for fewer policy misses, fewer stale reminders, and better timing around repeated coding work.

## Wedge

The wedge is trigger-aware project memory for coding harnesses.

It is specifically for moments where markdown alone is too blunt:
- before-model guidance when the next response needs a scoped subset of durable project memory
- before-tool warnings when a policy should surface exactly at the risky action boundary
- stale/conflict handling when old or contradictory guidance should remain visible without being silently applied
- after-tool evidence capture when repeated fixes should become reviewable promotion candidates

## Where It Beats Markdown

This product beats disciplined markdown when the problem is selective activation rather than storage.

- It can activate a small, scoped set of memories instead of dumping a full handbook into every session.
- It can suppress stale or superseded guidance while keeping the history visible.
- It can surface unresolved conflicts instead of forcing the harness to pick one rule arbitrarily.
- It can emit warnings at the tool boundary, which is exactly where markdown often arrives too early or too late.

## Where Markdown Is Still Enough

Markdown-only remains sufficient when the team mostly needs a static handbook and can tolerate manual recall. If the project is small, the rules are stable, and the agent reliably reads the whole context file, a disciplined `CLAUDE.md` is still the simpler answer.

This product is not justified just because a project has many notes. It is justified when the cost of missing the right warning or stale/conflict signal at the right moment is high enough to matter.

## What The MVP Is

This MVP is:
- a structured activation layer on top of markdown
- project-scoped and coding-harness-specific
- warning-first rather than hard-block-first
- deliberately review-driven for promotion and consolidation
- optimized for inspectability over autonomy

## What The MVP Is Not

This MVP is not:
- an individual note-history product
- a consumer chat-history system
- a replacement for disciplined markdown
- a generic knowledge platform
- an autonomous memory engine that decides what matters without review

## Competitive Boundary

The product does not compete with markdown on authoring simplicity. Markdown stays the canonical human-readable record.

The product competes on execution timing: which rules, pitfalls, and constraints show up at the exact lifecycle boundary where they matter. That is the narrow boundary where the evidence currently shows a meaningful advantage.

## Non-Goals

Not in scope for the next phase:
- vector-first retrieval
- graph databases
- autonomous memory evolution
- broad multi-harness expansion
- dashboard-first workflow
- hard-block enforcement as the primary product story

## Current Claim

The strongest honest claim is this: for repeated coding tasks inside a harness, a narrow memory layer can outperform markdown-only context on trigger-aware warning surfacing, stale/conflict handling, and evidence capture.
