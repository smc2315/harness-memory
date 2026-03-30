# Memory Layer Run Evidence Template (MD + Memory)

**Condition**: Markdown + Memory Layer

**Date**: [YYYY-MM-DD]

**Evaluator**: [Name]

**Corpus Version**: [Git commit hash of task-corpus.md]

---

## Run Configuration

**Markdown Context**:
- File: `CLAUDE.md`
- Size: [line count] lines, [KB] KB
- Structure: [brief description - should match baseline]

**Memory Layer**:
- Database: [path to SQLite file]
- Active Memories: [count]
- Active Policies: [count]
- Schema Version: [version number]

**Harness**:
- Name: [e.g., OpenCode with memory adapter]
- Version: [version number]
- Model: [e.g., Claude 3.5 Sonnet]
- Adapter Version: [version number]

**Session Management**:
- Fresh session per scenario: [YES/NO]
- Context carryover: [describe if any]

---

## Scenario Results

### Scenario 1: Session Start - Forgotten Architecture Constraint

**Task Prompt**: "Add a new endpoint to fetch user preferences. The route should be in `src/routes/preferences.ts`."

**Memory Activation Log**:
```json
{
  "trigger": "session_start",
  "scope": "src/routes/**/*.ts",
  "activated": [
    {
      "id": "mem_arch_001",
      "type": "architecture_constraint",
      "summary": "All database access must go through repository pattern",
      "importance": "high",
      "reason": "scope_match + lifecycle_match"
    }
  ],
  "suppressed": [],
  "total_payload_size": "1.2 KB"
}
```

**Agent Output**:
```
[Paste or summarize agent's response]
```

**Generated Code** (if applicable):
```typescript
[Paste relevant code snippet]
```

**Miss Annotation**:
- Miss Type: [policy_miss / exploration_miss / recall_miss / none]
- Severity: [critical / high / medium / low]
- Description: [What was missed and why it matters]
- Evidence: [Line numbers or specific violations]

**Memory Layer Performance**:
- Activation Correct: [YES/NO]
- Warning Surfaced: [YES/NO/NA]
- False Positive: [YES/NO]

**Notes**: [Any context about memory layer behavior]

---

### Scenario 2: Before Model - Stale Workflow Preference

**Task Prompt**: "Write tests for the new validation utility in `src/utils/validation.ts`."

**Memory Activation Log**:
```json
{
  "trigger": "before_model",
  "scope": "src/**/*.test.ts",
  "activated": [
    {
      "id": "mem_workflow_002",
      "type": "workflow",
      "summary": "Use vitest for test runs",
      "importance": "medium",
      "reason": "scope_match + lifecycle_match + active_status"
    }
  ],
  "suppressed": [
    {
      "id": "mem_workflow_001",
      "type": "workflow",
      "summary": "Use bun test for test runs",
      "status": "stale",
      "reason": "superseded_by mem_workflow_002"
    }
  ],
  "total_payload_size": "0.8 KB"
}
```

**Agent Output**:
```
[Paste or summarize agent's response]
```

**Generated Code** (if applicable):
```typescript
[Paste relevant code snippet]
```

**Miss Annotation**:
- Miss Type: [policy_miss / exploration_miss / recall_miss / none]
- Severity: [critical / high / medium / low]
- Description: [What was missed and why it matters]
- Evidence: [Line numbers or specific violations]

**Memory Layer Performance**:
- Activation Correct: [YES/NO]
- Stale Suppression Correct: [YES/NO]
- Warning Surfaced: [YES/NO/NA]
- False Positive: [YES/NO]

**Notes**: [Any context about memory layer behavior]

---

### Scenario 3: Before Tool - Policy Violation Warning

**Task Prompt**: "Create a local environment file with the database URL and API key for development."

**Memory Activation Log**:
```json
{
  "trigger": "before_tool",
  "tool": "write",
  "target": ".env.local",
  "scope": "**/.env*",
  "activated": [],
  "policy_warnings": [
    {
      "id": "policy_sec_001",
      "rule_code": "NO_COMMIT_SECRETS",
      "severity": "warning",
      "message": "Policy: Never commit .env files. Use .env.example with placeholder values instead.",
      "reason": "scope_match + tool_match"
    }
  ],
  "suppressed": [],
  "total_payload_size": "0.3 KB"
}
```

**Agent Output**:
```
[Paste or summarize agent's response]
```

**Generated Code** (if applicable):
```bash
[Paste relevant code snippet]
```

**Miss Annotation**:
- Miss Type: [policy_miss / exploration_miss / recall_miss / none]
- Severity: [critical / high / medium / low]
- Description: [What was missed and why it matters]
- Evidence: [Line numbers or specific violations]

**Memory Layer Performance**:
- Activation Correct: [YES/NO]
- Warning Surfaced: [YES/NO/NA]
- Warning Heeded: [YES/NO/NA]
- False Positive: [YES/NO]

**Notes**: [Any context about memory layer behavior]

---

### Scenario 4: Before Model - Pitfall Recall

**Task Prompt**: "Add a function to update user profile data in `src/services/user-service.ts`."

**Memory Activation Log**:
```json
{
  "trigger": "before_model",
  "scope": "src/services/**/*.ts",
  "activated": [
    {
      "id": "mem_pitfall_001",
      "type": "pitfall",
      "summary": "Always await .save() calls - missing await causes silent data loss",
      "importance": "high",
      "reason": "scope_match + lifecycle_match"
    }
  ],
  "suppressed": [],
  "total_payload_size": "1.0 KB"
}
```

**Agent Output**:
```
[Paste or summarize agent's response]
```

**Generated Code** (if applicable):
```typescript
[Paste relevant code snippet]
```

**Miss Annotation**:
- Miss Type: [policy_miss / exploration_miss / recall_miss / none]
- Severity: [critical / high / medium / low]
- Description: [What was missed and why it matters]
- Evidence: [Line numbers or specific violations]

**Memory Layer Performance**:
- Activation Correct: [YES/NO]
- Warning Surfaced: [YES/NO/NA]
- False Positive: [YES/NO]

**Notes**: [Any context about memory layer behavior]

---

### Scenario 5: Session Start - Conflicting Decisions

**Task Prompt**: "Add input validation for the new API endpoint in `src/routes/api/v1/users.ts`."

**Memory Activation Log**:
```json
{
  "trigger": "session_start",
  "scope": "src/**/*.ts",
  "activated": [
    {
      "id": "mem_decision_001",
      "type": "decision",
      "summary": "Use Zod for all validation",
      "importance": "medium",
      "created_at": "2026-03-14",
      "reason": "scope_match + lifecycle_match"
    },
    {
      "id": "mem_decision_002",
      "type": "decision",
      "summary": "Considering Valibot for hot paths",
      "importance": "low",
      "created_at": "2026-03-21",
      "reason": "scope_match + lifecycle_match"
    }
  ],
  "conflict_detected": true,
  "conflict_note": "Two validation library decisions exist without clear supersession",
  "suppressed": [],
  "total_payload_size": "1.5 KB"
}
```

**Agent Output**:
```
[Paste or summarize agent's response]
```

**Generated Code** (if applicable):
```typescript
[Paste relevant code snippet]
```

**Miss Annotation**:
- Miss Type: [policy_miss / exploration_miss / recall_miss / none]
- Severity: [critical / high / medium / low]
- Description: [What was missed and why it matters]
- Evidence: [Line numbers or specific violations]

**Memory Layer Performance**:
- Activation Correct: [YES/NO]
- Conflict Surfaced: [YES/NO]
- Warning Surfaced: [YES/NO/NA]
- False Positive: [YES/NO]

**Notes**: [Any context about memory layer behavior]

---

### Scenario 6: Before Tool - Scope Mismatch (No Activation)

**Task Prompt**: "Fix the date formatting bug in `src/utils/date-helpers.ts`."

**Memory Activation Log**:
```json
{
  "trigger": "before_tool",
  "tool": "edit",
  "target": "src/utils/date-helpers.ts",
  "scope": "src/utils/**/*.ts",
  "activated": [],
  "suppressed": [
    {
      "id": "policy_db_001",
      "type": "policy",
      "summary": "Always use timestamped migration files",
      "scope": "db/migrations/**/*.sql",
      "reason": "scope_mismatch"
    }
  ],
  "total_payload_size": "0 KB"
}
```

**Agent Output**:
```
[Paste or summarize agent's response]
```

**Generated Code** (if applicable):
```typescript
[Paste relevant code snippet]
```

**Miss Annotation**:
- Miss Type: [policy_miss / exploration_miss / recall_miss / none]
- Severity: [critical / high / medium / low]
- Description: [What was missed and why it matters]
- Evidence: [Line numbers or specific violations]

**Memory Layer Performance**:
- Activation Correct: [YES/NO]
- Suppression Correct: [YES/NO]
- Warning Surfaced: [YES/NO/NA]
- False Positive: [YES/NO]

**Notes**: [This is a negative control - validates correct suppression]

---

### Scenario 7: After Tool - Evidence Capture for Future Promotion

**Task Prompt**: "Fix the JSON export error in the export service."

**Memory Activation Log**:
```json
{
  "trigger": "after_tool",
  "tool": "edit",
  "target": "src/services/export-service.ts",
  "activated": [],
  "evidence_captured": {
    "session_id": "ses_20260328_001",
    "source_kind": "session",
    "excerpt": "Fixed circular reference error by using explicit field selection instead of JSON.stringify(prismaModel)",
    "candidate_memory": {
      "type": "pitfall",
      "summary": "Never stringify Prisma models directly - use .toJSON() or explicit field selection",
      "scope": "src/**/*.ts",
      "confidence": "medium",
      "promotion_suggested": true,
      "reason": "Second occurrence of this pattern"
    }
  },
  "total_payload_size": "0 KB"
}
```

**Agent Output**:
```
[Paste or summarize agent's response]
```

**Generated Code** (if applicable):
```typescript
[Paste relevant code snippet]
```

**Miss Annotation**:
- Miss Type: [policy_miss / exploration_miss / recall_miss / none]
- Severity: [critical / high / medium / low]
- Description: [What was missed and why it matters]
- Evidence: [Line numbers or specific violations]

**Memory Layer Performance**:
- Evidence Captured: [YES/NO]
- Promotion Suggested: [YES/NO]
- Suggestion Quality: [good / fair / poor]

**Notes**: [Any context about evidence capture behavior]

---

### Scenario 8: Before Model - Multi-Trigger Policy

**Task Prompt**: "Add a background job to sync user data from the external CRM API in `src/jobs/sync-users.ts`."

**Memory Activation Log**:
```json
{
  "trigger": "before_model",
  "scope": "src/jobs/**/*.ts",
  "activated": [
    {
      "id": "policy_api_001",
      "type": "policy",
      "summary": "All external API calls must include timeout and retry logic",
      "importance": "high",
      "reason": "scope_match + lifecycle_match"
    }
  ],
  "suppressed": [],
  "total_payload_size": "0.9 KB"
}
```

**Agent Output**:
```
[Paste or summarize agent's response]
```

**Generated Code** (if applicable):
```typescript
[Paste relevant code snippet]
```

**Miss Annotation**:
- Miss Type: [policy_miss / exploration_miss / recall_miss / none]
- Severity: [critical / high / medium / low]
- Description: [What was missed and why it matters]
- Evidence: [Line numbers or specific violations]

**Memory Layer Performance**:
- Activation Correct: [YES/NO]
- Warning Surfaced: [YES/NO/NA]
- False Positive: [YES/NO]

**Notes**: [Any context about memory layer behavior]

---

### Scenario 9: Before Tool - Stale Pitfall (Resolved)

**Task Prompt**: "Add a route to serve uploaded files from the filesystem."

**Memory Activation Log**:
```json
{
  "trigger": "before_tool",
  "tool": "edit",
  "target": "src/routes/files.ts",
  "scope": "src/routes/**/*.ts",
  "activated": [],
  "suppressed": [
    {
      "id": "mem_pitfall_002",
      "type": "pitfall",
      "summary": "Avoid fs.readFileSync in route handlers",
      "status": "stale",
      "reason": "superseded after async refactor"
    }
  ],
  "total_payload_size": "0 KB"
}
```

**Agent Output**:
```
[Paste or summarize agent's response]
```

**Generated Code** (if applicable):
```typescript
[Paste relevant code snippet]
```

**Miss Annotation**:
- Miss Type: [policy_miss / exploration_miss / recall_miss / none]
- Severity: [critical / high / medium / low]
- Description: [What was missed and why it matters]
- Evidence: [Line numbers or specific violations]

**Memory Layer Performance**:
- Activation Correct: [YES/NO]
- Stale Suppression Correct: [YES/NO]
- Warning Surfaced: [YES/NO/NA]
- False Positive: [YES/NO]

**Notes**: [This is a negative control - validates stale suppression]

---

### Scenario 10: Session Start - High-Priority Policy

**Task Prompt**: "Add a new admin endpoint to list all users with their details in `src/routes/admin/users.ts`."

**Memory Activation Log**:
```json
{
  "trigger": "session_start",
  "scope": "src/routes/**/*.ts",
  "activated": [
    {
      "id": "policy_gdpr_001",
      "type": "policy",
      "summary": "Never expose user email in API responses without consent flag check",
      "importance": "critical",
      "reason": "scope_match + lifecycle_match + high_priority"
    }
  ],
  "suppressed": [],
  "total_payload_size": "1.1 KB"
}
```

**Agent Output**:
```
[Paste or summarize agent's response]
```

**Generated Code** (if applicable):
```typescript
[Paste relevant code snippet]
```

**Miss Annotation**:
- Miss Type: [policy_miss / exploration_miss / recall_miss / none]
- Severity: [critical / high / medium / low]
- Description: [What was missed and why it matters]
- Evidence: [Line numbers or specific violations]

**Memory Layer Performance**:
- Activation Correct: [YES/NO]
- Warning Surfaced: [YES/NO/NA]
- False Positive: [YES/NO]

**Notes**: [Any context about memory layer behavior]

---

### Scenario 11: Before Model - Workflow + Pitfall Combination

**Task Prompt**: "Write a GitHub Actions workflow for automated deployment in `.github/workflows/deploy.yml`."

**Memory Activation Log**:
```json
{
  "trigger": "before_model",
  "scope": ".github/workflows/**/*.yml",
  "activated": [
    {
      "id": "mem_workflow_003",
      "type": "workflow",
      "summary": "Deployment workflow: build && test:ci before deploy",
      "importance": "high",
      "reason": "scope_match + lifecycle_match"
    },
    {
      "id": "mem_pitfall_003",
      "type": "pitfall",
      "summary": "Only deploy from main branch (staging accidents happened twice)",
      "importance": "high",
      "reason": "scope_match + lifecycle_match"
    }
  ],
  "suppressed": [],
  "total_payload_size": "1.8 KB"
}
```

**Agent Output**:
```
[Paste or summarize agent's response]
```

**Generated Code** (if applicable):
```yaml
[Paste relevant code snippet]
```

**Miss Annotation**:
- Miss Type: [policy_miss / exploration_miss / recall_miss / none]
- Severity: [critical / high / medium / low]
- Description: [What was missed and why it matters]
- Evidence: [Line numbers or specific violations]

**Memory Layer Performance**:
- Activation Correct: [YES/NO]
- Warning Surfaced: [YES/NO/NA]
- False Positive: [YES/NO]

**Notes**: [Any context about memory layer behavior]

---

### Scenario 12: Before Tool - Budget Overflow (Activation Limit)

**Task Prompt**: "Add a new payment processing function in the payment service."

**Memory Activation Log**:
```json
{
  "trigger": "before_tool",
  "tool": "edit",
  "target": "src/services/payment-service.ts",
  "scope": "src/**/*.ts",
  "activated": [
    {"id": "policy_payment_001", "importance": "critical", "summary": "..."},
    {"id": "policy_payment_002", "importance": "high", "summary": "..."},
    {"id": "mem_pitfall_004", "importance": "high", "summary": "..."},
    {"id": "policy_api_001", "importance": "high", "summary": "..."},
    {"id": "mem_workflow_004", "importance": "medium", "summary": "..."},
    {"id": "policy_logging_001", "importance": "medium", "summary": "..."},
    {"id": "mem_pitfall_005", "importance": "medium", "summary": "..."},
    {"id": "policy_error_001", "importance": "medium", "summary": "..."},
    {"id": "mem_decision_003", "importance": "low", "summary": "..."},
    {"id": "policy_style_001", "importance": "low", "summary": "..."}
  ],
  "suppressed": [
    {"id": "policy_style_002", "importance": "low", "reason": "budget_overflow"},
    {"id": "mem_workflow_005", "importance": "low", "reason": "budget_overflow"},
    {"id": "policy_comment_001", "importance": "low", "reason": "budget_overflow"},
    {"id": "mem_decision_004", "importance": "low", "reason": "budget_overflow"},
    {"id": "policy_naming_001", "importance": "low", "reason": "budget_overflow"}
  ],
  "total_payload_size": "7.8 KB",
  "budget_limit": "10 memories or 8KB"
}
```

**Agent Output**:
```
[Paste or summarize agent's response]
```

**Generated Code** (if applicable):
```typescript
[Paste relevant code snippet]
```

**Miss Annotation**:
- Miss Type: [policy_miss / exploration_miss / recall_miss / none]
- Severity: [critical / high / medium / low]
- Description: [What was missed and why it matters]
- Evidence: [Line numbers or specific violations]

**Memory Layer Performance**:
- Activation Correct: [YES/NO]
- Budget Respected: [YES/NO]
- Ranking Quality: [good / fair / poor]
- Warning Surfaced: [YES/NO/NA]
- False Positive: [YES/NO]

**Notes**: [This scenario validates budget enforcement and ranking logic]

---

## Summary Statistics

**Total Scenarios**: 12

**Miss Counts**:
- Policy Miss: [count]
- Exploration Miss: [count]
- Recall Miss: [count]
- No Miss: [count]

**Severity Breakdown**:
- Critical: [count]
- High: [count]
- Medium: [count]
- Low: [count]

**Important Policy Miss Count**: [count of critical + high severity policy misses]

**Memory Layer Performance**:
- Correct Activations: [count] / 12
- Correct Suppressions: [count] / [total suppressions]
- False Positives: [count]
- Warnings Surfaced: [count]
- Warnings Heeded: [count] / [warnings surfaced]

**Activation Budget Compliance**:
- Average Payload Size: [KB]
- Max Payload Size: [KB]
- Budget Violations: [count]

---

## Appendix: Memory Database State

**Active Memories**: [count]
**Active Policies**: [count]
**Stale Memories**: [count]
**Superseded Memories**: [count]

**Sample Memory Export** (first 5 active memories):
```json
[Paste or link to memory export]
```
