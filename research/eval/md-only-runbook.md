# Markdown-Only Baseline Runbook

## Purpose

This runbook defines the repeatable procedure for running the baseline condition in the memory-layer evaluation experiment. The baseline uses only markdown context (no memory layer) to establish a fair comparison point for measuring activation quality improvements.

## Baseline Condition Definition

**Condition Name**: `MD only`

**What is included**:
- A single `CLAUDE.md` file containing all project rules, policies, pitfalls, workflows, and architecture constraints
- Standard harness system prompt and tool access
- No memory-layer activation, warnings, or policy surfacing

**What is excluded**:
- Memory-layer activation engine
- Lifecycle-triggered policy warnings
- Structured memory retrieval or ranking
- Evidence-linked memory consolidation
- Any memory-layer adapter hooks

## Fairness Guardrails

### Honest Baseline Requirements

The baseline must be **honest, not artificially weak**:

1. **Markdown Quality**: The `CLAUDE.md` file should be well-structured, organized by section, and use clear headings. It should represent a realistic, disciplined markdown approach, not intentionally poor documentation.

2. **Content Completeness**: All policies, pitfalls, workflows, and constraints from the task corpus scenarios must be present in the markdown file before baseline runs begin.

3. **No Sandbagging**: Do not intentionally hide information, use confusing language, or bury critical rules in irrelevant sections.

4. **No Hidden Memory Hints**: Do not add memory-layer-specific metadata, structured tags, or activation hints that would not naturally appear in a real project's markdown documentation.

5. **Corpus Integrity**: Use the exact task prompts from `task-corpus.md` without modification. Do not simplify prompts for the baseline or add extra context that would not be available in a real session.

### What Counts as Unfair Sandbagging

The following practices would invalidate the baseline:

- Intentionally disorganized markdown with no headings or structure
- Burying critical policies in unrelated sections (e.g., database policy in a "UI Guidelines" section)
- Using vague or ambiguous language when clear language is possible
- Omitting policies that should be documented
- Making the markdown file artificially large with irrelevant content to dilute signal
- Changing task prompts between baseline and experimental conditions

## Setup

### 1. Prepare Markdown Context

**File**: `research/eval/fixtures/baseline-CLAUDE.md`

**Structure**:
```markdown
# Project Rules and Guidelines

## Architecture Constraints
[All architecture_constraint memories from corpus scenarios]

## Policies
[All policy memories from corpus scenarios]

## Pitfalls
[All pitfall memories from corpus scenarios]

## Workflows
[All workflow memories from corpus scenarios]

## Decisions
[All decision memories from corpus scenarios]
```

**Content Requirements**:
- Include all rules, policies, pitfalls, and constraints referenced in the 12 corpus scenarios
- Use clear section headings and bullet points
- Organize by memory type (architecture, policy, pitfall, workflow, decision)
- Include context about when each rule was established (e.g., "Established after GDPR review" or "After two production incidents")
- Mark stale or superseded items with clear status indicators (e.g., "OUTDATED: This preference was replaced by..." or "SUPERSEDED: See new approach below")

**Size Target**: 300-500 lines (realistic for a solo project with 2-3 months of accumulated rules)

### 2. Configure Harness

**Harness**: OpenCode (or compatible coding harness)

**Model**: Claude 3.5 Sonnet (or current production model)

**Session Management**:
- Use a fresh session for each scenario
- No context carryover between scenarios
- Standard system prompt with no memory-layer modifications

**Markdown Injection**:
- Load `baseline-CLAUDE.md` as the primary context file
- Use standard harness markdown loading (e.g., OpenCode's `CLAUDE.md` auto-load)
- No additional preprocessing or structured extraction

### 3. Prepare Scorecard

**File**: `research/eval/baseline-scorecard.csv`

**Schema** (must match experimental condition):
```csv
task_id,baseline_condition,miss_type,severity,notes
```

**Columns**:
- `task_id`: Scenario number (1-12) from `task-corpus.md`
- `baseline_condition`: Always `md_only` for this runbook
- `miss_type`: One of `policy_miss`, `exploration_miss`, `recall_miss`, `none`
- `severity`: One of `critical`, `high`, `medium`, `low`
- `notes`: Brief description of what was missed or why no miss occurred

## Execution

### Per-Scenario Procedure

For each of the 12 scenarios in `research/eval/task-corpus.md`:

1. **Start Fresh Session**
   - Open a new harness session
   - Verify `baseline-CLAUDE.md` is loaded as context
   - Confirm no memory-layer adapter is active

2. **Issue Task Prompt**
   - Copy the exact **Task Prompt** from the scenario
   - Paste into the harness without modification
   - Do not add hints, clarifications, or memory-layer context

3. **Observe Agent Response**
   - Let the agent complete the task without interruption
   - Do not provide corrective feedback during execution
   - Record the full agent output (text and generated code)

4. **Annotate Miss**
   - Compare agent output to the **Expected Outcome** (baseline miss) in the scenario
   - Determine if the expected miss occurred
   - Use the annotation rubric from `research/eval/annotation-rubric.md`
   - Record miss type and severity

5. **Save Evidence**
   - Save agent output to `research/eval/evidence/baseline/scenario-{N}-output.md`
   - Save generated code (if any) to `research/eval/evidence/baseline/scenario-{N}-code.{ext}`
   - Add one row to `baseline-scorecard.csv`

6. **Close Session**
   - End the session before starting the next scenario
   - Do not reuse context or conversation history

### Execution Order

Run scenarios in sequential order (1-12) to maintain consistency and avoid cross-contamination.

### Time Budget

Allocate approximately 10-15 minutes per scenario for execution and annotation (2-3 hours total for all 12 scenarios).

## Scoring

### Miss Type Definitions

Use the definitions from `research/eval/miss-taxonomy.md`:

- **policy_miss**: Agent violated or ignored an established project policy, constraint, or rule
- **exploration_miss**: Agent performed unnecessary exploration or asked questions that should have been answered by existing context
- **recall_miss**: Agent failed to recall or apply a relevant pitfall, workflow, or decision from prior sessions
- **none**: Agent completed the task correctly without missing relevant context

### Severity Levels

Use the rubric from `research/eval/annotation-rubric.md`:

- **critical**: Miss creates a security risk, compliance violation, or data loss
- **high**: Miss creates a production bug, architectural violation, or significant rework
- **medium**: Miss creates inconsistency, technical debt, or minor rework
- **low**: Miss creates a style violation or preference mismatch with no functional impact

### Annotation Consistency

- Annotate all 12 scenarios before comparing to experimental condition
- Use the same annotator for all baseline runs
- If uncertain about severity, default to the higher level and document reasoning in notes
- For negative control scenarios (6, 9), expect `miss_type: none` and verify no false positives

### Scorecard Completion

After all scenarios are run, verify:
- All 12 rows are present in `baseline-scorecard.csv`
- No missing or empty fields
- Miss types and severities are consistent with rubric definitions
- Notes provide enough context to understand each annotation

## Allowed Markdown Inputs

### What is Allowed

- A single `CLAUDE.md` file with clear structure and headings
- Plain markdown formatting (headings, lists, code blocks, emphasis)
- Inline comments or status markers (e.g., "OUTDATED", "SUPERSEDED", "Established 2024-03-15")
- Cross-references between sections (e.g., "See Policies section for database access rules")
- Contextual notes about when rules were established or why they exist

### What is NOT Allowed

The following would constitute unfair baseline enhancement and are prohibited:

- Structured metadata tags that mimic memory-layer activation (e.g., `[scope: src/**/*.ts]`, `[trigger: before_tool]`)
- Lifecycle-specific sections that mirror memory-layer triggers (e.g., "Rules to Check Before Tool Use")
- Importance or priority rankings that would not naturally appear in markdown (e.g., `[importance: high]`)
- Content hashes, deduplication markers, or evidence links
- Any preprocessing or structured extraction beyond standard markdown parsing
- Multiple markdown files organized by lifecycle or scope (baseline must use a single file)

## Corpus and Schema Alignment

### Same Task Corpus

Both baseline and experimental conditions use:
- **File**: `research/eval/task-corpus.md`
- **Scenarios**: All 12 scenarios, in order
- **Prompts**: Exact task prompts without modification

### Same Scorecard Schema

Both conditions use:
- **File**: `research/eval/baseline-scorecard.csv` (baseline) and `research/eval/memory-scorecard.csv` (experimental)
- **Schema**: `task_id,baseline_condition,miss_type,severity,notes`
- **Miss Types**: Same taxonomy from `miss-taxonomy.md`
- **Severity Levels**: Same rubric from `annotation-rubric.md`

### Same Annotation Rubric

Both conditions use:
- **File**: `research/eval/annotation-rubric.md`
- **Annotator**: Same person for both conditions
- **Timing**: Baseline annotated before experimental runs to avoid bias

## Output Artifacts

After completing all baseline runs, the following artifacts should exist:

1. **Scorecard**: `research/eval/baseline-scorecard.csv` (12 rows, one per scenario)
2. **Evidence**: `research/eval/evidence/baseline/scenario-{1-12}-output.md` (agent outputs)
3. **Code**: `research/eval/evidence/baseline/scenario-{1-12}-code.{ext}` (generated code, if applicable)
4. **Context**: `research/eval/fixtures/baseline-CLAUDE.md` (the markdown file used for all runs)
5. **Run Log**: `research/eval/evidence/baseline/run-log.md` (using template from `templates/baseline-run.md`)

## Next Steps

After baseline completion:

1. **Review Scorecard**: Verify all annotations are complete and consistent
2. **Calculate Baseline Metrics**: Count policy misses by severity (especially critical + high)
3. **Proceed to Experimental Condition**: Run the same corpus with memory layer active (see `research/eval/memory-layer-runbook.md`)
4. **Compare Results**: Use `research/eval/comparative-analysis.md` template to evaluate continue/kill decision

## Continue Threshold

The memory-layer condition must achieve:
- **At least 30% reduction** in important policy misses (critical + high severity) versus this baseline
- **Activation budget compliance**: All memory activations stay within 10 memories or 8KB
- **Low false-warning rate**: False positive warnings do not exceed 20% of total warnings

If these thresholds are not met, the experiment does not justify continued development.
