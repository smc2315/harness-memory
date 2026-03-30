# Use Cases

## Overview

These scenarios center on activation misses: moments when important project knowledge should surface but doesn't, or surfaces too late. Each use case maps to a specific lifecycle boundary where the memory layer can intervene.

## Use Case 1: Session Start - Policy Briefing

**Scenario**: A developer starts a new coding session in a repo with strict architectural constraints (e.g., "never use direct DB queries in controllers; always use repository pattern").

**Without memory layer**: The agent reads a 50-page `AGENTS.md` file. The architectural constraint is on page 37. The agent misses it or deprioritizes it because the current task prompt doesn't mention architecture.

**With memory layer**: At session start, the memory layer activates the `architecture_constraint` memory with scope `src/controllers/**/*.ts` and lifecycle trigger `session_start`. The agent sees a concise summary: "Repository pattern required for all DB access in controllers."

**Outcome**: The agent applies the constraint from the first file edit, not after three rounds of correction.

**Markdown alone remains sufficient when**: The project has 2-3 clear rules and the agent reliably reads the full context every time.

---

## Use Case 2: Before Model - Pitfall Reminder

**Scenario**: A developer asks the agent to refactor authentication logic. The project has a known pitfall: "JWT refresh tokens must be rotated on every use; static refresh tokens were exploited in incident #47."

**Without memory layer**: The pitfall is documented in `docs/security/incidents.md`, but the agent doesn't retrieve it because the task prompt says "refactor auth" without mentioning security incidents.

**With memory layer**: Before the model generates the refactor plan, the memory layer activates the `pitfall` memory with scope `src/auth/**/*.ts` and lifecycle trigger `before_model`. The agent sees: "Pitfall: static refresh tokens. Always rotate on use (incident #47)."

**Outcome**: The refactor plan includes token rotation from the start, not as a follow-up fix.

**Markdown alone remains sufficient when**: Security pitfalls are few, well-known, and the agent always checks incident logs before touching auth code.

---

## Use Case 3: Before Tool - Policy Warning

**Scenario**: The agent is about to run `edit` on `src/core/database.ts`. The project has a policy: "Core database module changes require manual review and integration test run before commit."

**Without memory layer**: The agent edits the file, commits, and pushes. The policy is buried in `CONTRIBUTING.md` section 4.2.

**With memory layer**: Before the `edit` tool executes, the memory layer evaluates policy rules with scope `src/core/**/*.ts` and lifecycle trigger `before_tool`. It surfaces a warning: "Policy: core DB changes require manual review + integration tests."

**Outcome**: The agent includes a note in the commit message or pauses for confirmation. The policy isn't missed.

**Markdown alone remains sufficient when**: The project has 1-2 critical files and the agent always checks contribution guidelines before editing them.

---

## Use Case 4: Before Tool - Workflow Constraint

**Scenario**: The agent is about to run `bash` to execute a database migration script. The project has a workflow constraint: "Migrations must run in a transaction-safe environment; never run raw SQL in production shell."

**Without memory layer**: The agent runs the script directly. The constraint is in `docs/ops/runbooks.md` under "Database Operations."

**With memory layer**: Before the `bash` tool executes with a migration command, the memory layer activates the `workflow` memory with scope `migrations/**/*.sql` and lifecycle trigger `before_tool`. It warns: "Workflow: migrations require transaction-safe environment."

**Outcome**: The agent suggests using the migration runner instead of raw bash.

**Markdown alone remains sufficient when**: The project has a single deployment workflow and the agent always checks runbooks before running ops commands.

---

## Use Case 5: Stale Memory - Conflict Detection

**Scenario**: The project used to require "all API responses must include a `request_id` field." That policy was superseded by a new standard: "use OpenTelemetry trace IDs instead of custom request_id."

**Without memory layer**: Both the old policy (in `docs/api-guidelines.md`) and the new standard (in `docs/observability.md`) exist. The agent picks the old one because it appears first in the markdown index.

**With memory layer**: The memory layer has two memories:
1. `policy` (status: `superseded`): "API responses must include request_id"
2. `policy` (status: `active`, supersedes: memory #1): "Use OpenTelemetry trace IDs"

When the agent queries for API response policies, the memory layer activates only the active memory and logs that memory #1 was superseded.

**Outcome**: The agent applies the current standard, not the outdated one. If both were still active, the memory layer would surface a conflict warning.

**Markdown alone remains sufficient when**: The project has stable policies that rarely change, and old docs are deleted immediately when superseded.

---

## Summary: When Markdown Alone Works

Markdown remains the best choice when:
- The project is small (1-5 files, 10-20 rules)
- Rules are stable and rarely conflict
- Session repetition is low (new tasks every time, not repeated workflows)
- The agent reliably reads and applies the full context
- No lifecycle-specific activation is needed (all rules apply all the time)

This memory layer adds value when:
- Selective activation matters (50+ policies, only 3-5 relevant per task)
- Freshness matters (policies evolve, old ones must be retired)
- Conflict handling matters (contradictory rules must be surfaced, not silently ignored)
- Lifecycle-aware activation matters (different policies apply at different boundaries)
