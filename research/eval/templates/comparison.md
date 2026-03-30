# Baseline vs Memory Layer Comparison Report

**Evaluation Period**: [Start Date] to [End Date]

**Evaluator**: [Name]

**Corpus Version**: [Git commit hash of task-corpus.md]

---

## Executive Summary

**Continue/Kill Decision**: [CONTINUE / KILL / NEEDS MORE DATA]

**Key Findings**:
- [1-2 sentence summary of the most important result]
- [1-2 sentence summary of the second most important result]
- [1-2 sentence summary of any critical concerns]

**Recommendation**:
[2-3 sentences explaining the continue/kill decision and next steps]

---

## Methodology

**Baseline Condition**:
- Markdown only (`CLAUDE.md`, [line count] lines, [KB] KB)
- Harness: [name and version]
- Model: [model name]
- Session management: [fresh per scenario / carryover]

**Experimental Condition**:
- Markdown + Memory Layer
- Active memories: [count]
- Active policies: [count]
- Harness: [name and version with adapter]
- Model: [model name]
- Session management: [fresh per scenario / carryover]

**Corpus**:
- Total scenarios: 12
- Lifecycle coverage: session_start (4), before_model (5), before_tool (5), after_tool (1)
- Edge cases: stale (2), conflict (1), scope mismatch (1), budget overflow (1)

**Annotation Protocol**:
- Miss taxonomy: policy_miss, exploration_miss, recall_miss
- Severity levels: critical, high, medium, low
- Important policy miss = critical OR high severity policy miss

---

## Primary Metric: Important Policy Miss Reduction

**Continue Threshold**: Memory layer must reduce important policy misses by at least 30% versus baseline.

| Condition | Important Policy Misses | Reduction |
|-----------|-------------------------|-----------|
| Baseline (MD only) | [count] | - |
| Experimental (MD + memory) | [count] | [percentage]% |

**Result**: [PASS / FAIL]

**Analysis**:
[2-3 paragraphs explaining:
- Which scenarios showed the biggest improvement
- Which scenarios showed no improvement or regression
- Why the memory layer succeeded or failed at reducing misses]

---

## Secondary Metrics

### Miss Type Breakdown

| Miss Type | Baseline | Experimental | Change |
|-----------|----------|--------------|--------|
| Policy Miss | [count] | [count] | [+/- count] |
| Exploration Miss | [count] | [count] | [+/- count] |
| Recall Miss | [count] | [count] | [+/- count] |
| No Miss | [count] | [count] | [+/- count] |

**Analysis**:
[1-2 paragraphs explaining patterns in miss type changes]

---

### Severity Breakdown

| Severity | Baseline | Experimental | Change |
|----------|----------|--------------|--------|
| Critical | [count] | [count] | [+/- count] |
| High | [count] | [count] | [+/- count] |
| Medium | [count] | [count] | [+/- count] |
| Low | [count] | [count] | [+/- count] |

**Analysis**:
[1-2 paragraphs explaining whether the memory layer prevented the most severe misses]

---

### Memory Layer Performance

| Metric | Count | Percentage |
|--------|-------|------------|
| Correct Activations | [count] / 12 | [percentage]% |
| Correct Suppressions | [count] / [total] | [percentage]% |
| False Positives | [count] | - |
| Warnings Surfaced | [count] | - |
| Warnings Heeded | [count] / [surfaced] | [percentage]% |

**Analysis**:
[2-3 paragraphs explaining:
- Whether the activation logic worked as designed
- Whether stale/conflict handling worked correctly
- Whether warnings were useful or ignored
- Whether false positives were a problem]

---

### Activation Budget Compliance

| Metric | Value |
|--------|-------|
| Average Payload Size | [KB] |
| Max Payload Size | [KB] |
| Budget Limit | 10 memories or 8KB |
| Budget Violations | [count] |

**Analysis**:
[1-2 paragraphs explaining whether the budget was respected and whether it was too tight or too loose]

---

## Scenario-by-Scenario Comparison

### Scenario 1: Session Start - Forgotten Architecture Constraint

| Metric | Baseline | Experimental |
|--------|----------|--------------|
| Miss Type | [type] | [type] |
| Severity | [level] | [level] |
| Memory Activated | N/A | [YES/NO] |
| Outcome | [brief description] | [brief description] |

**Winner**: [Baseline / Experimental / Tie]

**Notes**: [1-2 sentences explaining the result]

---

### Scenario 2: Before Model - Stale Workflow Preference

| Metric | Baseline | Experimental |
|--------|----------|--------------|
| Miss Type | [type] | [type] |
| Severity | [level] | [level] |
| Memory Activated | N/A | [YES/NO] |
| Stale Suppressed | N/A | [YES/NO] |
| Outcome | [brief description] | [brief description] |

**Winner**: [Baseline / Experimental / Tie]

**Notes**: [1-2 sentences explaining the result]

---

### Scenario 3: Before Tool - Policy Violation Warning

| Metric | Baseline | Experimental |
|--------|----------|--------------|
| Miss Type | [type] | [type] |
| Severity | [level] | [level] |
| Warning Surfaced | N/A | [YES/NO] |
| Warning Heeded | N/A | [YES/NO] |
| Outcome | [brief description] | [brief description] |

**Winner**: [Baseline / Experimental / Tie]

**Notes**: [1-2 sentences explaining the result]

---

### Scenario 4: Before Model - Pitfall Recall

| Metric | Baseline | Experimental |
|--------|----------|--------------|
| Miss Type | [type] | [type] |
| Severity | [level] | [level] |
| Memory Activated | N/A | [YES/NO] |
| Outcome | [brief description] | [brief description] |

**Winner**: [Baseline / Experimental / Tie]

**Notes**: [1-2 sentences explaining the result]

---

### Scenario 5: Session Start - Conflicting Decisions

| Metric | Baseline | Experimental |
|--------|----------|--------------|
| Miss Type | [type] | [type] |
| Severity | [level] | [level] |
| Conflict Surfaced | N/A | [YES/NO] |
| Outcome | [brief description] | [brief description] |

**Winner**: [Baseline / Experimental / Tie]

**Notes**: [1-2 sentences explaining the result]

---

### Scenario 6: Before Tool - Scope Mismatch (No Activation)

| Metric | Baseline | Experimental |
|--------|----------|--------------|
| Miss Type | [type] | [type] |
| Severity | [level] | [level] |
| Suppression Correct | N/A | [YES/NO] |
| Outcome | [brief description] | [brief description] |

**Winner**: [Baseline / Experimental / Tie]

**Notes**: [This is a negative control - both should succeed]

---

### Scenario 7: After Tool - Evidence Capture for Future Promotion

| Metric | Baseline | Experimental |
|--------|----------|--------------|
| Miss Type | [type] | [type] |
| Severity | [level] | [level] |
| Evidence Captured | N/A | [YES/NO] |
| Promotion Suggested | N/A | [YES/NO] |
| Outcome | [brief description] | [brief description] |

**Winner**: [Baseline / Experimental / Tie]

**Notes**: [1-2 sentences explaining the result]

---

### Scenario 8: Before Model - Multi-Trigger Policy

| Metric | Baseline | Experimental |
|--------|----------|--------------|
| Miss Type | [type] | [type] |
| Severity | [level] | [level] |
| Memory Activated | N/A | [YES/NO] |
| Outcome | [brief description] | [brief description] |

**Winner**: [Baseline / Experimental / Tie]

**Notes**: [1-2 sentences explaining the result]

---

### Scenario 9: Before Tool - Stale Pitfall (Resolved)

| Metric | Baseline | Experimental |
|--------|----------|--------------|
| Miss Type | [type] | [type] |
| Severity | [level] | [level] |
| Stale Suppressed | N/A | [YES/NO] |
| Outcome | [brief description] | [brief description] |

**Winner**: [Baseline / Experimental / Tie]

**Notes**: [This is a negative control - both should succeed]

---

### Scenario 10: Session Start - High-Priority Policy

| Metric | Baseline | Experimental |
|--------|----------|--------------|
| Miss Type | [type] | [type] |
| Severity | [level] | [level] |
| Memory Activated | N/A | [YES/NO] |
| Outcome | [brief description] | [brief description] |

**Winner**: [Baseline / Experimental / Tie]

**Notes**: [1-2 sentences explaining the result]

---

### Scenario 11: Before Model - Workflow + Pitfall Combination

| Metric | Baseline | Experimental |
|--------|----------|--------------|
| Miss Type | [type] | [type] |
| Severity | [level] | [level] |
| Memory Activated | N/A | [YES/NO] |
| Outcome | [brief description] | [brief description] |

**Winner**: [Baseline / Experimental / Tie]

**Notes**: [1-2 sentences explaining the result]

---

### Scenario 12: Before Tool - Budget Overflow (Activation Limit)

| Metric | Baseline | Experimental |
|--------|----------|--------------|
| Miss Type | [type] | [type] |
| Severity | [level] | [level] |
| Budget Respected | N/A | [YES/NO] |
| Ranking Quality | N/A | [good/fair/poor] |
| Outcome | [brief description] | [brief description] |

**Winner**: [Baseline / Experimental / Tie]

**Notes**: [1-2 sentences explaining the result]

---

## Qualitative Observations

### What Worked Well

**Baseline (MD only)**:
- [Observation 1]
- [Observation 2]
- [Observation 3]

**Experimental (MD + memory)**:
- [Observation 1]
- [Observation 2]
- [Observation 3]

---

### What Did Not Work

**Baseline (MD only)**:
- [Observation 1]
- [Observation 2]
- [Observation 3]

**Experimental (MD + memory)**:
- [Observation 1]
- [Observation 2]
- [Observation 3]

---

### Surprising Results

- [Observation 1]
- [Observation 2]
- [Observation 3]

---

## Risk Assessment

### Risks Validated

- [Risk from plan that was confirmed by evaluation]
- [Risk from plan that was confirmed by evaluation]

### Risks Mitigated

- [Risk from plan that did not materialize]
- [Risk from plan that did not materialize]

### New Risks Discovered

- [Risk not anticipated in the plan]
- [Risk not anticipated in the plan]

---

## Continue/Kill Decision

**Decision**: [CONTINUE / KILL / NEEDS MORE DATA]

**Rationale**:
[3-5 paragraphs explaining:
- Whether the primary metric (30% reduction in important policy misses) was met
- Whether the memory layer provided value beyond just better markdown organization
- Whether the manual promotion overhead was acceptable
- Whether the warning-only policy surfacing was effective
- Whether the system is worth continued investment]

**Next Steps** (if CONTINUE):
1. [Specific action item]
2. [Specific action item]
3. [Specific action item]

**Lessons Learned** (if KILL):
1. [What we learned about the problem space]
2. [What we learned about the solution approach]
3. [What alternative approaches might work better]

---

## Appendix: Raw Data

**Baseline Scorecard**: [link to baseline-scorecard.csv]

**Experimental Scorecard**: [link to experimental-scorecard.csv]

**Memory Database Export**: [link to memory-export.sql]

**Session Logs**: [link to session logs directory]
