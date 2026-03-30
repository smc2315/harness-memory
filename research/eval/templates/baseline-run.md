# Baseline Run Evidence Template (MD Only)

**Condition**: Markdown only (no memory layer)

**Date**: [YYYY-MM-DD]

**Evaluator**: [Name]

**Corpus Version**: [Git commit hash of task-corpus.md]

---

## Run Configuration

**Markdown Context**:
- File: `CLAUDE.md`
- Size: [line count] lines, [KB] KB
- Structure: [brief description of how rules are organized]

**Harness**:
- Name: [e.g., OpenCode, Cline, custom]
- Version: [version number]
- Model: [e.g., Claude 3.5 Sonnet]

**Session Management**:
- Fresh session per scenario: [YES/NO]
- Context carryover: [describe if any]

---

## Scenario Results

### Scenario 1: Session Start - Forgotten Architecture Constraint

**Task Prompt**: "Add a new endpoint to fetch user preferences. The route should be in `src/routes/preferences.ts`."

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

**Notes**: [Any context about why the miss occurred or mitigating factors]

---

### Scenario 2: Before Model - Stale Workflow Preference

**Task Prompt**: "Write tests for the new validation utility in `src/utils/validation.ts`."

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

**Notes**: [Any context about why the miss occurred or mitigating factors]

---

### Scenario 3: Before Tool - Policy Violation Warning

**Task Prompt**: "Create a local environment file with the database URL and API key for development."

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

**Notes**: [Any context about why the miss occurred or mitigating factors]

---

### Scenario 4: Before Model - Pitfall Recall

**Task Prompt**: "Add a function to update user profile data in `src/services/user-service.ts`."

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

**Notes**: [Any context about why the miss occurred or mitigating factors]

---

### Scenario 5: Session Start - Conflicting Decisions

**Task Prompt**: "Add input validation for the new API endpoint in `src/routes/api/v1/users.ts`."

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

**Notes**: [Any context about why the miss occurred or mitigating factors]

---

### Scenario 6: Before Tool - Scope Mismatch (No Activation)

**Task Prompt**: "Fix the date formatting bug in `src/utils/date-helpers.ts`."

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

**Notes**: [This is a negative control - no miss expected]

---

### Scenario 7: After Tool - Evidence Capture for Future Promotion

**Task Prompt**: "Fix the JSON export error in the export service."

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

**Notes**: [Did the agent make the connection to previous occurrences?]

---

### Scenario 8: Before Model - Multi-Trigger Policy

**Task Prompt**: "Add a background job to sync user data from the external CRM API in `src/jobs/sync-users.ts`."

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

**Notes**: [Any context about why the miss occurred or mitigating factors]

---

### Scenario 9: Before Tool - Stale Pitfall (Resolved)

**Task Prompt**: "Add a route to serve uploaded files from the filesystem."

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

**Notes**: [This is a negative control - no miss expected, validates stale handling]

---

### Scenario 10: Session Start - High-Priority Policy

**Task Prompt**: "Add a new admin endpoint to list all users with their details in `src/routes/admin/users.ts`."

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

**Notes**: [Any context about why the miss occurred or mitigating factors]

---

### Scenario 11: Before Model - Workflow + Pitfall Combination

**Task Prompt**: "Write a GitHub Actions workflow for automated deployment in `.github/workflows/deploy.yml`."

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

**Notes**: [Any context about why the miss occurred or mitigating factors]

---

### Scenario 12: Before Tool - Budget Overflow (Activation Limit)

**Task Prompt**: "Add a new payment processing function in the payment service."

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

**Notes**: [This scenario tests context management, not memory layer behavior]

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

**Notes on Baseline Quality**:
[Describe the quality of the markdown context used. Was it well-structured? Were rules clear? This helps ensure the baseline is fair.]

---

## Appendix: Markdown Context

**Full CLAUDE.md Content** (or relevant excerpts):
```markdown
[Paste or link to the markdown file used for this baseline run]
```
