# Evaluation Task Corpus

This corpus contains realistic repeated-task scenarios designed to expose activation misses in the baseline (MD only) condition and validate improvements in the experimental (MD + memory layer) condition.

Each scenario specifies:
- **Context**: Project state and prior session history
- **Trigger**: Lifecycle moment (session_start, before_model, before_tool, after_tool)
- **Expected Memory Activation**: What should surface if the memory layer works
- **Expected Outcome**: Correct behavior vs. likely baseline miss

---

## Scenario 1: Session Start - Forgotten Architecture Constraint

**Context**: A solo founder is working on a TypeScript backend service. Three sessions ago, they decided to keep all database access behind a repository pattern and never call SQLite directly from route handlers. This was documented in `CLAUDE.md` but buried in a 400-line file.

**Trigger**: `session_start`

**Task Prompt**: "Add a new endpoint to fetch user preferences. The route should be in `src/routes/preferences.ts`."

**Expected Memory Activation**:
- Memory Type: `architecture_constraint`
- Scope: `src/routes/**/*.ts`
- Summary: "All database access must go through repository pattern, never direct SQLite calls from routes"
- Evidence: Session from 3 days ago where this was established

**Expected Outcome**:
- **With Memory**: Agent surfaces the constraint before generating code, creates route that calls `UserPreferencesRepository.get()` instead of direct DB access.
- **Without Memory (Baseline Miss)**: Agent writes route with inline `db.prepare().get()` calls, violating the established pattern. User must correct in review.

**Miss Type**: Policy miss (architecture constraint)

---

## Scenario 2: Before Model - Stale Workflow Preference

**Context**: A developer previously preferred using `bun test` for all test runs. Two days ago, they switched to `vitest` for better watch mode and updated the project. The old preference is still in markdown but marked as outdated in a comment.

**Trigger**: `before_model`

**Task Prompt**: "Write tests for the new validation utility in `src/utils/validation.ts`."

**Expected Memory Activation**:
- Memory Type: `workflow` (stale)
- Scope: `src/**/*.test.ts`
- Summary: "Use vitest for test runs (supersedes old bun test preference)"
- Status: Active memory shows vitest, stale memory shows bun test
- Conflict Flag: System should surface that an old preference exists but is superseded

**Expected Outcome**:
- **With Memory**: Agent uses `vitest` and includes correct import syntax. Stale memory is logged but not activated.
- **Without Memory (Baseline Miss)**: Agent uses `bun test` because it appears first in the markdown file, or mixes both approaches inconsistently.

**Miss Type**: Stale memory activation / workflow miss

---

## Scenario 3: Before Tool - Policy Violation Warning

**Context**: The project has a policy: never commit `.env` files or any file containing `API_KEY` in plaintext. This was established after an accidental leak two weeks ago.

**Trigger**: `before_tool` (tool: `write`, target: `.env.local`)

**Task Prompt**: "Create a local environment file with the database URL and API key for development."

**Expected Memory Activation**:
- Memory Type: `policy`
- Scope: `**/.env*`
- Lifecycle Trigger: `before_tool` (write, edit)
- Severity: `warning`
- Message: "Policy: Never commit .env files. Use .env.example with placeholder values instead."

**Expected Outcome**:
- **With Memory**: Agent receives warning before writing `.env.local`, creates `.env.example` with placeholders and adds `.env.local` to `.gitignore`.
- **Without Memory (Baseline Miss)**: Agent creates `.env.local` with real secrets and may forget to update `.gitignore`, creating a security risk.

**Miss Type**: Policy miss (security)

---

## Scenario 4: Before Model - Pitfall Recall

**Context**: The project uses a custom ORM wrapper. Four sessions ago, the developer discovered that calling `.save()` without awaiting it causes silent data loss. This pitfall was documented but is easy to miss in a large markdown file.

**Trigger**: `before_model`

**Task Prompt**: "Add a function to update user profile data in `src/services/user-service.ts`."

**Expected Memory Activation**:
- Memory Type: `pitfall`
- Scope: `src/services/**/*.ts`
- Summary: "Always await .save() calls - missing await causes silent data loss"
- Evidence: Session from 4 days ago where this bug was discovered and fixed

**Expected Outcome**:
- **With Memory**: Agent writes `await user.save()` correctly on first try.
- **Without Memory (Baseline Miss)**: Agent writes `user.save()` without await, introducing a latent bug that will only surface in production.

**Miss Type**: Pitfall miss (correctness)

---

## Scenario 5: Session Start - Conflicting Decisions

**Context**: Two weeks ago, the developer decided to use Zod for all validation. One week ago, they experimented with Valibot for performance and added a note saying "considering Valibot for hot paths." Both are mentioned in markdown but no clear supersession.

**Trigger**: `session_start`

**Task Prompt**: "Add input validation for the new API endpoint in `src/routes/api/v1/users.ts`."

**Expected Memory Activation**:
- Memory Type: `decision` (conflict detected)
- Scope: `src/**/*.ts`
- Summary A: "Use Zod for all validation (established 2 weeks ago)"
- Summary B: "Considering Valibot for hot paths (experimental, 1 week ago)"
- Conflict Flag: System should surface both and note they are not yet resolved

**Expected Outcome**:
- **With Memory**: Agent surfaces the conflict and asks for clarification before proceeding, or defaults to the more established decision (Zod) with a note about the unresolved experiment.
- **Without Memory (Baseline Miss)**: Agent picks one arbitrarily or mixes both, creating inconsistent validation patterns across the codebase.

**Miss Type**: Conflict miss (decision ambiguity)

---

## Scenario 6: Before Tool - Scope Mismatch (No Activation)

**Context**: The project has a policy about database migrations: "Always use timestamped migration files, never edit existing migrations." This policy is scoped to `db/migrations/**/*.sql`.

**Trigger**: `before_tool` (tool: `edit`, target: `src/utils/date-helpers.ts`)

**Task Prompt**: "Fix the date formatting bug in `src/utils/date-helpers.ts`."

**Expected Memory Activation**:
- None (scope does not match)

**Expected Outcome**:
- **With Memory**: No migration policy surfaces because the scope is `src/utils/**`, not `db/migrations/**`. Agent proceeds without irrelevant warnings.
- **Without Memory (Baseline Miss)**: Same outcome, but this scenario validates that the memory layer does not over-activate.

**Miss Type**: None (negative control - correct suppression)

---

## Scenario 7: After Tool - Evidence Capture for Future Promotion

**Context**: The developer just fixed a subtle bug where calling `JSON.stringify()` on a Prisma model instance causes circular reference errors. This is the second time this has happened.

**Trigger**: `after_tool` (tool: `edit`, target: `src/services/export-service.ts`)

**Task Prompt**: "Fix the JSON export error in the export service."

**Expected Memory Activation**:
- None yet (this is a candidate for promotion, not an existing memory)

**Expected Outcome**:
- **With Memory**: After the fix, the system logs evidence linking this session to the previous occurrence and suggests promoting "Never stringify Prisma models directly, use .toJSON() or explicit field selection" as a pitfall memory.
- **Without Memory (Baseline Miss)**: Fix is applied but no connection is made to the previous occurrence. The pattern will likely repeat in a future session.

**Miss Type**: Promotion miss (learning opportunity)

---

## Scenario 8: Before Model - Multi-Trigger Policy

**Context**: The project has a policy: "All external API calls must include timeout and retry logic." This applies to both route handlers and background jobs.

**Trigger**: `before_model`

**Task Prompt**: "Add a background job to sync user data from the external CRM API in `src/jobs/sync-users.ts`."

**Expected Memory Activation**:
- Memory Type: `policy`
- Scope: `src/jobs/**/*.ts` OR `src/routes/**/*.ts`
- Lifecycle Trigger: `before_model`, `before_tool`
- Summary: "All external API calls must include timeout and retry logic"

**Expected Outcome**:
- **With Memory**: Agent includes timeout and retry configuration in the fetch call on first try.
- **Without Memory (Baseline Miss)**: Agent writes a bare `fetch()` call without timeout or retry, creating a reliability risk.

**Miss Type**: Policy miss (reliability)

---

## Scenario 9: Before Tool - Stale Pitfall (Resolved)

**Context**: Three weeks ago, the project had a pitfall: "Avoid using `fs.readFileSync` in route handlers, it blocks the event loop." Two weeks ago, the codebase was refactored to use async file operations everywhere, and this pitfall is no longer relevant.

**Trigger**: `before_tool` (tool: `edit`, target: `src/routes/files.ts`)

**Task Prompt**: "Add a route to serve uploaded files from the filesystem."

**Expected Memory Activation**:
- Memory Type: `pitfall` (stale)
- Status: `superseded` or `stale`
- Summary: "Old: Avoid fs.readFileSync in routes (no longer relevant after async refactor)"
- Should NOT activate by default

**Expected Outcome**:
- **With Memory**: Stale pitfall is suppressed. Agent uses modern async file operations without being warned about an outdated constraint.
- **Without Memory (Baseline Miss)**: Same outcome if markdown was updated, but this validates that the memory layer correctly suppresses stale items.

**Miss Type**: None (negative control - correct stale suppression)

---

## Scenario 10: Session Start - High-Priority Policy

**Context**: The project has a critical policy: "Never expose user email addresses in API responses without explicit consent flag check." This was established after a GDPR compliance review.

**Trigger**: `session_start`

**Task Prompt**: "Add a new admin endpoint to list all users with their details in `src/routes/admin/users.ts`."

**Expected Memory Activation**:
- Memory Type: `policy`
- Scope: `src/routes/**/*.ts`
- Importance: `high`
- Summary: "Never expose user email in API responses without consent flag check (GDPR)"

**Expected Outcome**:
- **With Memory**: Agent surfaces the policy at session start and ensures the response schema filters email based on `user.consent.email_visible`.
- **Without Memory (Baseline Miss)**: Agent includes email in the response by default, creating a compliance violation.

**Miss Type**: Policy miss (compliance)

---

## Scenario 11: Before Model - Workflow + Pitfall Combination

**Context**: The project uses a custom deployment script. The workflow is: "Always run `bun run build && bun run test:ci` before deploying." The pitfall is: "Never deploy from a branch other than `main` - staging deploys have accidentally gone to production twice."

**Trigger**: `before_model`

**Task Prompt**: "Write a GitHub Actions workflow for automated deployment in `.github/workflows/deploy.yml`."

**Expected Memory Activation**:
- Memory Type: `workflow` + `pitfall`
- Scope: `.github/workflows/**/*.yml`
- Summary A: "Deployment workflow: build && test:ci before deploy"
- Summary B: "Pitfall: Only deploy from main branch (staging accidents happened twice)"

**Expected Outcome**:
- **With Memory**: Agent includes both the build/test steps and a branch check (`if: github.ref == 'refs/heads/main'`) in the workflow.
- **Without Memory (Baseline Miss)**: Agent writes a deployment workflow that runs on any branch push, or omits the test step, recreating past mistakes.

**Miss Type**: Workflow miss + pitfall miss (deployment safety)

---

## Scenario 12: Before Tool - Budget Overflow (Activation Limit)

**Context**: The project has 15 active policies and pitfalls, all scoped to `src/**/*.ts`. The activation budget is 10 memories or 8KB, whichever is smaller.

**Trigger**: `before_tool` (tool: `edit`, target: `src/services/payment-service.ts`)

**Task Prompt**: "Add a new payment processing function in the payment service."

**Expected Memory Activation**:
- Top 10 memories by importance and scope relevance
- 5 memories suppressed due to budget overflow
- Suppression reason logged for auditability

**Expected Outcome**:
- **With Memory**: Agent receives the 10 most important/relevant memories (e.g., payment-specific policies ranked higher than general style preferences). Suppressed items are logged but not injected.
- **Without Memory (Baseline Miss)**: Agent receives either everything (context overflow) or nothing (too much noise), leading to inconsistent policy application.

**Miss Type**: Activation budget validation (system behavior, not a user-facing miss)

---

## Summary Statistics

- **Total Scenarios**: 12
- **Lifecycle Coverage**:
  - `session_start`: 4 scenarios (1, 5, 10, 11)
  - `before_model`: 5 scenarios (2, 4, 8, 11, 12)
  - `before_tool`: 5 scenarios (3, 6, 9, 12)
  - `after_tool`: 1 scenario (7)
- **Memory Types**:
  - `policy`: 5 scenarios
  - `workflow`: 3 scenarios
  - `pitfall`: 4 scenarios
  - `architecture_constraint`: 1 scenario
  - `decision`: 1 scenario
- **Edge Cases**:
  - Stale memory: 2 scenarios (2, 9)
  - Conflict: 1 scenario (5)
  - Scope mismatch (negative control): 1 scenario (6)
  - Budget overflow: 1 scenario (12)
  - Promotion opportunity: 1 scenario (7)

---

## Usage Notes

1. **Baseline Condition (MD only)**: Run each scenario with only markdown context. Record misses using the annotation rubric.
2. **Experimental Condition (MD + memory layer)**: Run each scenario with the memory layer active. Log activated memories, warnings, and suppression reasons.
3. **Comparison**: Use the scorecard to count policy misses, activation precision, and false positive warnings.
4. **Continue Threshold**: Memory layer must reduce important policy misses by at least 30% versus baseline to justify continued development.
