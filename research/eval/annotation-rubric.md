# Annotation Rubric

## Purpose

This rubric ensures consistent, repeatable scoring of baseline vs memory-layer performance across evaluation runs. Use this when annotating misses in the baseline scorecard.

## Severity Levels

### Critical
**Definition**: Miss caused or would cause production breakage, data loss, security vulnerability, or complete task failure.

**Indicators**:
- Violates security policy (auth, secrets, permissions)
- Breaks production deployment or critical user flow
- Causes data corruption or irreversible state change
- Blocks task completion entirely

**Examples**:
- Missed policy: "never commit `.env` files" → secrets leaked to git
- Missed constraint: "always validate user input" → SQL injection vulnerability
- Missed pitfall: "migration must run before deploy" → production database broken

**Scoring Impact**: Critical misses are disqualifying. If memory layer doesn't reduce these, kill the project.

---

### High
**Definition**: Miss caused significant rework, wasted time (>30 min), or violated important project standards.

**Indicators**:
- Requires substantial rework or rollback
- Violates documented architecture constraint
- Causes test suite failure or CI breakage
- Wastes >30 minutes of user time

**Examples**:
- Missed policy: "use TypeScript strict mode" → entire module needs rewrite
- Missed pitfall: "avoid N+1 queries" → performance regression requiring refactor
- Missed workflow: "run linter before commit" → CI fails, must fix and re-push

**Scoring Impact**: High misses are the primary success metric. Memory layer must reduce these by >30% to continue.

---

### Medium
**Definition**: Miss caused minor rework, style inconsistency, or violated soft preferences.

**Indicators**:
- Requires small fix or style adjustment
- Violates style guide or naming convention
- Causes minor test failure or warning
- Wastes 10-30 minutes of user time

**Examples**:
- Missed convention: "use kebab-case for file names" → one file needs rename
- Missed preference: "prefer async/await over .then()" → code works but inconsistent
- Missed tip: "use helper function for date formatting" → manual formatting used

**Scoring Impact**: Medium misses are secondary metrics. Reduction is good but not required for continuation.

---

### Low
**Definition**: Miss caused no immediate harm but represents missed opportunity for guidance or consistency.

**Indicators**:
- No rework required
- Violates optional suggestion or nice-to-have
- Causes no test failure or user friction
- Wastes <10 minutes or no time

**Examples**:
- Missed tip: "consider adding JSDoc comment" → code works fine without it
- Missed suggestion: "you might want to add error logging here" → not required
- Missed context: "this pattern was discussed in issue #42" → informational only

**Scoring Impact**: Low misses are tracked but not weighted in success criteria.

---

## Annotation Process

### Step 1: Identify the Miss
- Review session transcript or task log
- Locate the moment where relevant knowledge should have been surfaced
- Confirm the knowledge existed in baseline (markdown or memory store)

### Step 2: Classify the Miss Type
- Use the miss taxonomy to assign exactly one category
- Record evidence: what knowledge existed, when it should have activated, why it didn't

### Step 3: Assign Severity
- Use the severity definitions above
- When in doubt between two levels, choose the higher severity
- Consider actual impact, not hypothetical worst case

### Step 4: Record in Scorecard
- Fill all required columns: `task_id`, `baseline_condition`, `miss_type`, `severity`, `notes`
- Notes should include: what was missed, when, why it mattered, and evidence reference

### Step 5: Cross-Check Consistency
- Review previous annotations for similar misses
- Ensure severity is consistent with comparable cases
- If severity judgment changes, update previous entries and document why

---

## Baseline Conditions

### `md_only`
- Harness has access to markdown files only (e.g., `CLAUDE.md`, `AGENTS.md`)
- No memory layer, no structured activation
- This is the control condition

### `md_plus_memory`
- Harness has markdown files AND memory layer active
- Memory layer can promote, consolidate, and activate knowledge
- This is the experimental condition

---

## Reviewer Instructions

### Before Annotation
1. Read the miss taxonomy completely
2. Read this rubric completely
3. Review the task or session being evaluated
4. Confirm baseline condition (md_only or md_plus_memory)

### During Annotation
1. Annotate misses in chronological order
2. Take notes on edge cases or judgment calls
3. If unsure, mark for second-pass review
4. Don't batch-annotate without reviewing each case individually

### After Annotation
1. Review all annotations for consistency
2. Calculate summary stats (total misses, by type, by severity)
3. Document any rubric ambiguities or edge cases encountered
4. Save evidence files referenced in notes

### Quality Checks
- Every miss has exactly one type
- Every miss has exactly one severity
- Every miss has non-empty notes with evidence
- Severity is consistent across similar misses
- No duplicate entries for the same miss

---

## Edge Cases

### Miss Happened But User Caught It
- **Rule**: Still count as a miss. The memory layer should have caught it first.
- **Severity**: Reduce by one level (Critical → High, High → Medium, etc.)

### Multiple Misses in Same Moment
- **Rule**: Record as separate entries if they are distinct knowledge items
- **Rule**: Record as single entry if they are facets of the same policy

### Miss in Baseline, Fixed in Memory Layer
- **Rule**: Record the baseline miss with `baseline_condition=md_only`
- **Rule**: Do NOT record a "non-miss" for memory layer (only record actual misses)

### Unclear Whether Knowledge Existed
- **Rule**: If you can't confirm the knowledge was documented, it's not a miss (it's a coverage gap)
- **Rule**: Check markdown, memory store, and git history before marking as miss

### User Explicitly Ignored Warning
- **Rule**: Not a miss. The system surfaced it; user chose to proceed.
- **Rule**: Only count as miss if warning was unclear or buried in noise

---

## Reporting Format

After annotation, produce summary stats:

```
Total Misses: X
By Type:
  - Policy Miss: X (Y%)
  - Activation Miss: X (Y%)
  - Stale Memory: X (Y%)
  - False Positive: X (Y%)

By Severity:
  - Critical: X (Y%)
  - High: X (Y%)
  - Medium: X (Y%)
  - Low: X (Y%)

By Baseline Condition:
  - md_only: X misses
  - md_plus_memory: X misses
  - Reduction: X% (positive = improvement)
```

Include qualitative notes on patterns, edge cases, and rubric refinements needed.
