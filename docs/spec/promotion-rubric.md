# Promotion Rubric

This document defines the criteria and decision logic for promoting candidate memories to active status, merging duplicates, marking stale entries, and handling supersession.

## Overview

The promotion rubric answers: "What should happen to this candidate memory?"

Five possible outcomes:
1. **promote** – Elevate to active status
2. **merge** – Combine with existing memory
3. **stale** – Mark existing memory as outdated
4. **supersede** – Replace existing memory entirely
5. **reject** – Discard candidate

In the MVP, all promotion decisions are **manual** (human-approved). Automatic promotion is explicitly out of scope.

---

## Decision Flow

```
Candidate Memory
    ↓
Is it valid and useful?
    ↓ No → REJECT
    ↓ Yes
Does similar memory exist?
    ↓ No → PROMOTE (new)
    ↓ Yes
Is it identical (content-hash match)?
    ↓ Yes → REJECT (duplicate)
    ↓ No
Does it add new information?
    ↓ Yes → MERGE (combine)
    ↓ No
Does it contradict existing memory?
    ↓ Yes → SUPERSEDE (replace)
    ↓ No
Is existing memory still relevant?
    ↓ No → STALE (mark old, promote new)
    ↓ Yes → REJECT (redundant)
```

---

## 1. promote

**Criteria**: The candidate memory is valid, useful, and does not duplicate or conflict with existing active memories.

**Conditions**:
- Content is well-formed (all required fields present)
- Information is actionable and specific
- No content-hash match with existing memories
- No semantic overlap with active memories (or overlap is complementary, not redundant)

**Action**:
- Set `status = active`
- Assign UUID if not already present
- Add to active memory index
- Log promotion event

**Example**: First time capturing "Never use em dashes in prose" as a policy. No existing policy covers this rule.

**Non-example**: Candidate says "Prefer short sentences" but active memory already says "Use varied sentence lengths". This is contradictory → consider `supersede` or `reject`.

---

## 2. merge

**Criteria**: The candidate memory adds new information to an existing memory without contradicting it.

**Conditions**:
- Semantic similarity to existing memory (same topic, same type)
- Candidate provides additional details, examples, or context
- No contradiction with existing content
- Combined memory remains coherent

**Action**:
- Combine candidate content with existing memory
- Update `updated_at` timestamp
- Increment version or revision counter
- Preserve original UUID
- Log merge event with both memory IDs

**Example**:
- **Existing**: "Use `git status` before committing"
- **Candidate**: "Run `git diff` to review changes before committing"
- **Merged**: "Run `git status` and `git diff` in parallel before committing"

**Non-example**: Candidate says "Always amend commits" but existing memory says "Never amend pushed commits". This is contradictory → consider `supersede`, not `merge`.

---

## 3. stale

**Criteria**: The candidate memory represents updated knowledge, and the existing memory is no longer fully accurate but still has historical value.

**Conditions**:
- Existing memory is outdated but not wrong
- Candidate reflects changed circumstances (new tools, updated APIs, evolved practices)
- Existing memory might still be useful for understanding past decisions
- No direct contradiction, just evolution

**Action**:
- Set existing memory `status = stale`
- Add `superseded_by` reference to new memory UUID
- Promote candidate as new active memory
- Retain stale memory in archive (do not delete)
- Log stale-marking event

**Example**:
- **Existing**: "Use `npm install` to add dependencies"
- **Candidate**: "Use `bun install` for faster dependency installation"
- **Result**: Mark npm memory as stale (still valid for npm projects), promote bun memory as active (reflects current project setup)

**Non-example**: Candidate says "Use TypeScript" but existing memory says "Use JavaScript". This is a technology change, not evolution → consider `supersede` if the project switched languages.

---

## 4. supersede

**Criteria**: The candidate memory directly contradicts or replaces existing memory, and the old information is no longer valid.

**Conditions**:
- Direct contradiction between candidate and existing memory
- Candidate reflects corrected understanding or changed requirements
- Existing memory is incorrect or obsolete
- No value in retaining old memory as active

**Action**:
- Set existing memory `status = superseded`
- Add `superseded_by` reference to new memory UUID
- Promote candidate as new active memory
- Retain superseded memory in archive (for audit trail)
- Log supersession event with reason

**Example**:
- **Existing**: "Always use `git commit --amend` to fix mistakes"
- **Candidate**: "Never amend commits after pushing to remote"
- **Result**: Supersede old memory (incorrect advice), promote new memory (correct practice)

**Non-example**: Candidate says "Prefer async/await" but existing memory says "Use promises". This is stylistic preference, not contradiction → consider `merge` or `reject` depending on project standards.

---

## 5. reject

**Criteria**: The candidate memory is invalid, redundant, too vague, or not useful.

**Conditions**:
- Content is malformed or incomplete
- Information is too general to be actionable
- Exact duplicate (content-hash match) of existing memory
- Contradicts existing memory but candidate is less reliable
- Not relevant to the project or user's work

**Action**:
- Do not promote candidate
- Log rejection event with reason
- Optionally store in rejected candidates log (for debugging)

**Example**:
- **Candidate**: "Code should be good"
- **Reason**: Too vague, not actionable

**Example**:
- **Candidate**: "Use React hooks" (content-hash matches existing memory)
- **Reason**: Exact duplicate

**Non-example**: Candidate says "Never use `eval()` in production" but existing memory says "Avoid `eval()` for security". This is complementary (stronger version) → consider `merge` or `supersede` depending on project policy.

---

## Type-Specific Considerations

### policy
- **Promote**: When rule is clear, enforceable, and not covered by existing policies
- **Merge**: When candidate adds violation patterns or severity levels
- **Supersede**: When rule changes (e.g., relaxing or tightening restrictions)
- **Reject**: When rule is too vague or conflicts with established policies

### workflow
- **Promote**: When procedure is complete, tested, and not documented elsewhere
- **Merge**: When candidate adds steps, preconditions, or success criteria
- **Supersede**: When workflow changes fundamentally (new tools, different approach)
- **Reject**: When workflow is incomplete or duplicates existing procedure

### pitfall
- **Promote**: When failure mode is specific, reproducible, and not already documented
- **Merge**: When candidate adds detection methods or mitigation strategies
- **Supersede**: When original pitfall analysis was incorrect
- **Reject**: When pitfall is too general or hypothetical

### architecture_constraint
- **Promote**: When constraint is structural, enforceable, and not already captured
- **Merge**: When candidate adds implications or rationale
- **Supersede**: When constraint changes (rare, usually indicates architecture shift)
- **Reject**: When constraint is preference, not boundary

### decision
- **Promote**: When choice is significant, has clear alternatives, and rationale is documented
- **Merge**: When candidate adds alternatives or reconsideration triggers
- **Supersede**: When decision is reversed (new choice replaces old)
- **Reject**: When decision is trivial or lacks rationale

---

## Manual Review Checklist

For each candidate memory, the reviewer should ask:

1. **Validity**: Is the content well-formed and complete?
2. **Utility**: Is this information actionable and specific?
3. **Uniqueness**: Does this duplicate existing memory (content-hash or semantic)?
4. **Accuracy**: Is this information correct and reliable?
5. **Relevance**: Does this apply to current work?
6. **Consistency**: Does this contradict existing memories?

Based on answers:
- All yes, no duplicates → **promote**
- Yes, but adds to existing → **merge**
- Yes, but existing is outdated → **stale**
- Yes, but contradicts existing → **supersede**
- Any no → **reject**

---

## Conditional Auto-Promotion (B+ Model)

Since v0.4.0, harness-memory supports conditional auto-promotion for low-risk memory types.

### How It Works

Auto-promotion runs after dream extraction (in `session.idle`). Candidates must pass ALL 5 gates:

| Gate | Condition | Rationale |
|------|-----------|-----------|
| Security | `scanMemoryContent()` passes | No prompt injection / credential leaks |
| Confidence | `confidence >= 0.85` | High-quality extractions only |
| Evidence | `evidence >= 3` | Repeated observation, not single instance |
| Type | `pitfall` or `workflow` only | Low-risk types first |
| Policy | `policy` NEVER auto-promotes | Policies require human judgment |

### Trust Scoring

Auto-promoted memories start with lower activation scores:

| Source | Validation Count | Trust Multiplier |
|--------|-----------------|------------------|
| Manual | — | 1.00 |
| Auto | 0 | 0.65 |
| Auto | 1 | 0.80 |
| Auto | ≥2 | 0.95 |

### TTL Management

- Auto-promoted memories get a 14-day TTL
- Revalidation (same-topic evidence) extends TTL by 14 days and increments `validation_count`
- Contradicting evidence immediately marks the memory as `stale`
- Manual memories have no TTL (permanent until manually changed)

### Demotion

- `memory:demote <id>` — manually revert active → stale
- Contradicting evidence → automatic stale transition
- TTL expiration → suppressed from activation (not deleted)

---

## Validation

This document must cover all five decision outcomes: `promote`, `merge`, `stale`, `supersede`, `reject`.
