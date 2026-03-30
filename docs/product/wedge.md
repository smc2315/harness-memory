# Product Wedge

## First User

**Solo harness builder / power user**

This person tunes prompts, rules, and workflows across repeated coding sessions. They've already invested in markdown rule files, but those files keep growing. The agent misses important policies, partially applies constraints, or rediscovers the same pitfalls session after session.

They want fewer activation misses without abandoning markdown or adopting a heavyweight memory system.

## First Wedge

**Reduce activation misses at the moment they matter**

The first wedge targets a specific failure mode: important project policies, pitfalls, and constraints disappear inside ever-growing markdown files. The agent either doesn't see them, mis-prioritizes them, or applies them inconsistently.

This product solves that by:
- Promoting only durable operating knowledge into structured memory
- Activating only the relevant subset at the right lifecycle boundary (session start, before model, before tool)
- Keeping advisory memory separate from enforceable policy
- Surfacing warnings at the moment a policy applies, not buried in a 50-page markdown file

**First moment of value**: The agent warns about a known project constraint *before* executing a tool that would violate it, because the memory layer activated that policy at the right scope and lifecycle trigger.

## Continue Signal

Continue building if, after 2 weeks of evaluation:
- Important policy misses drop by at least 30% versus markdown-only baseline
- Activation stays within the 10-memory/8KB budget
- False-warning rate stays low enough that users want repeat usage
- Manual promotion overhead doesn't outweigh value

Kill if the product can't beat disciplined markdown structure on real tasks.

## Why Not Markdown Only

Markdown wins when:
- The project is small enough that one file works
- Rules are few and stable
- Session repetition is low
- The agent reliably reads and applies the full context

This product wins when:
- Selective activation matters (you don't want to inject 50 policies into every session)
- Freshness matters (you need to know which memories are stale or superseded)
- Conflict handling matters (you need to surface contradictory rules, not silently ignore them)
- Lifecycle-aware activation matters (different policies apply at session start vs. before tool use)

Markdown remains the canonical human-readable source. This product is a structured activation layer on top, not a replacement.

## Non-Goals

**Not in scope for MVP:**
- Generic personal memory (this is project-scoped only)
- Automatic memory evolution without human review
- Vector/semantic search as default retrieval
- Graph database
- Continual fine-tuning
- Hard-block enforcement by default
- Multi-harness support beyond the first adapter
- Web dashboard/admin UI

**Explicit boundaries:**
- This is not life logging or consumer chat history
- This is not a generic knowledge base
- This is not trying to replace markdown entirely
- This is not an autonomous memory system that decides what matters

The product stays narrow: policy-aware project memory for coding harnesses, with deliberate promotion, deterministic activation, and warning-first enforcement.
