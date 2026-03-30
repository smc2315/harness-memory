# Memory Taxonomy

This document defines the five memory types in the MVP memory system. Each type serves a distinct purpose in capturing and applying learned knowledge across sessions.

## Overview

The memory system categorizes learned knowledge into five types:

1. **policy** – Enforceable rules that trigger warnings
2. **workflow** – Procedural patterns and sequences
3. **pitfall** – Known failure modes and anti-patterns
4. **architecture_constraint** – Structural boundaries and design limits
5. **decision** – Historical choices with rationale

All memory types share a common lifecycle (candidate → active → stale/superseded) but differ in content structure, activation triggers, and application context.

---

## 1. policy

**Definition**: Enforceable rules that trigger warnings when violated. Policies represent "must do" or "must not do" directives derived from repeated corrections, explicit user instructions, or critical failures.

**Structure**:
- **rule**: The enforceable directive (e.g., "Never use em dashes in prose")
- **rationale**: Why this rule exists
- **violation_pattern**: How to detect violations (regex, AST pattern, or heuristic)
- **severity**: `warning` (MVP does not support hard blocks)

**Activation**: Triggered at `before_model` (system prompt injection) and `after_tool` (output validation).

**Example**:
```yaml
type: policy
rule: "Never use em dashes (—) or en dashes (–) in prose output"
rationale: "User explicitly requires plain punctuation to avoid AI-sounding text"
violation_pattern: "[—–]"
severity: warning
```

**Non-example**: "Prefer short sentences" is too vague and subjective. It belongs in `workflow` as a stylistic guideline, not a policy.

---

## 2. workflow

**Definition**: Procedural patterns, sequences, and best practices for accomplishing tasks. Workflows capture "how to do X" knowledge, including tool usage patterns, multi-step procedures, and coordination strategies.

**Structure**:
- **task_pattern**: The type of task this workflow applies to (e.g., "git commit creation")
- **steps**: Ordered sequence of actions
- **preconditions**: When this workflow is applicable
- **success_criteria**: How to verify completion

**Activation**: Triggered at `session_start` (context loading) and `before_model` (task planning).

**Example**:
```yaml
type: workflow
task_pattern: "Creating git commits"
steps:
  - "Run git status and git diff in parallel"
  - "Analyze all staged changes"
  - "Draft commit message focusing on 'why' not 'what'"
  - "Add untracked files and commit"
  - "Run git status to verify"
preconditions: "User requests commit creation"
success_criteria: "Commit created, git status shows clean state"
```

**Non-example**: "Always check git status before committing" is a single-step rule, not a workflow. It could be a policy if enforceable, or advisory context if it's just a reminder.

---

## 3. pitfall

**Definition**: Known failure modes, anti-patterns, and mistakes to avoid. Pitfalls capture "don't do X because Y happens" knowledge, including edge cases, common errors, and debugging insights.

**Structure**:
- **mistake**: The action or pattern that causes problems
- **consequence**: What goes wrong
- **detection**: How to recognize this pitfall is occurring
- **mitigation**: How to avoid or fix it

**Activation**: Triggered at `before_tool` (preventive warnings) and `after_tool` (error analysis).

**Example**:
```yaml
type: pitfall
mistake: "Using git commit --amend after pushing to remote"
consequence: "Requires force push, risks overwriting others' work"
detection: "git log shows HEAD commit already pushed (git status: 'Your branch is up to date')"
mitigation: "Create new commit instead of amending. Only amend unpushed commits."
```

**Non-example**: "Git can be confusing" is too general. Pitfalls must describe specific failure modes with concrete consequences.

---

## 4. architecture_constraint

**Definition**: Structural boundaries, design limits, and system invariants. Architecture constraints capture "the system must/cannot do X" knowledge, including technical limitations, integration boundaries, and non-negotiable design decisions.

**Structure**:
- **constraint**: The boundary or limit
- **scope**: What part of the system this applies to
- **rationale**: Why this constraint exists
- **implications**: How this affects design decisions

**Activation**: Triggered at `session_start` (context loading) and `before_model` (design validation).

**Example**:
```yaml
type: architecture_constraint
constraint: "Memory system uses UUID primary keys, not auto-increment integers"
scope: "Database schema, memory identity"
rationale: "Enables distributed creation without coordination, content-hash deduplication"
implications: "All memory references use UUIDs. Deduplication requires content-hash comparison."
```

**Non-example**: "We use PostgreSQL" is a technology choice (belongs in `decision`), not a constraint unless it imposes specific limits (e.g., "PostgreSQL's JSONB size limit is 1GB").

---

## 5. decision

**Definition**: Historical choices with rationale and context. Decisions capture "we chose X over Y because Z" knowledge, including rejected alternatives, trade-off analysis, and future reconsideration triggers.

**Structure**:
- **choice**: What was decided
- **alternatives**: What was considered and rejected
- **rationale**: Why this choice was made
- **context**: Circumstances that influenced the decision
- **reconsider_if**: Conditions that might invalidate this decision

**Activation**: Triggered at `session_start` (context loading) and `before_model` (design consistency).

**Example**:
```yaml
type: decision
choice: "Use advisory memory + policy rules instead of single 'rule' type"
alternatives:
  - "Single 'rule' type with severity levels"
  - "Hard-block policies separate from soft guidelines"
rationale: "Separation allows different activation triggers and lifecycle management"
context: "MVP focuses on warnings, not enforcement. Future may add hard blocks."
reconsider_if: "Hard enforcement becomes required, or advisory memory proves redundant"
```

**Non-example**: "We decided to build a memory system" is too high-level. Decisions should capture specific design choices with clear alternatives.

---

## Cross-Type Distinctions

| Type | Focus | Enforceability | Temporal Scope |
|------|-------|----------------|----------------|
| **policy** | Rules | Warning-level | Ongoing |
| **workflow** | Procedures | Guidance | Task-specific |
| **pitfall** | Failures | Preventive | Situational |
| **architecture_constraint** | Boundaries | Structural | System-wide |
| **decision** | Choices | Historical | Context-dependent |

**Key principle**: If you can't decide between types, ask:
- Is it enforceable? → `policy`
- Is it a sequence of steps? → `workflow`
- Is it a mistake to avoid? → `pitfall`
- Is it a system boundary? → `architecture_constraint`
- Is it a choice with alternatives? → `decision`

---

## Validation

All five types must appear in this document. The validation script `scripts/check_terms.py` confirms presence of: `policy`, `workflow`, `pitfall`, `architecture_constraint`, `decision`.
