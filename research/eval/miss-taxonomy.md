# Miss Taxonomy

## Purpose

This taxonomy defines mutually exclusive categories for evaluation misses in the project memory layer MVP. Each category represents a distinct failure mode that can be measured, tracked, and addressed.

## Miss Categories

### 1. Policy Miss

**Definition**: The harness failed to surface or apply a known project policy, constraint, or rule at the moment it was relevant.

**Characteristics**:
- A policy exists in the baseline (markdown or memory store)
- The policy was relevant to the current action, file, or tool use
- The harness did not warn, activate, or enforce the policy
- The user proceeded without awareness of the policy

**Examples**:
- User modifies `backend/auth.py` but harness doesn't warn about the "always validate JWT expiry" policy
- User runs `git commit` without pre-commit hook reminder despite documented policy
- User creates new API endpoint without rate-limiting check despite project constraint
- User refactors database schema without migration policy activation

**Not a Policy Miss**:
- Policy doesn't exist yet (not a miss, just missing coverage)
- Policy exists but isn't relevant to current action (correct non-activation)
- Policy was shown but user ignored it (user choice, not system failure)

---

### 2. Activation Miss

**Definition**: The memory layer retrieved or ranked memories incorrectly, causing relevant knowledge to be absent from context when needed.

**Characteristics**:
- Relevant memory exists in the store
- The lifecycle boundary or scope should have triggered activation
- The memory was not included in the active set
- Failure occurred in retrieval, ranking, or budget allocation

**Examples**:
- Memory about "avoid N+1 queries in ORM" exists but doesn't activate when user edits database query code
- Pitfall memory scoped to `frontend/` doesn't activate when user works in `frontend/components/`
- High-priority architecture constraint gets ranked below low-priority workflow tip
- Memory budget exhausted before critical policy could be included

**Not an Activation Miss**:
- Memory doesn't exist (that's a capture gap, not activation failure)
- Memory is stale or superseded (correct non-activation)
- Scope is too broad and memory correctly doesn't match narrow context

---

### 3. Stale Memory

**Definition**: The memory layer activated outdated, superseded, or no-longer-relevant knowledge that confused or misled the session.

**Characteristics**:
- Memory was activated and surfaced to the harness
- The memory content is outdated, contradicts current state, or has been superseded
- The stale memory caused confusion, incorrect action, or wasted effort
- Freshness tracking or supersession logic failed

**Examples**:
- Old API endpoint pattern activates after migration to new REST structure
- Deprecated testing framework advice surfaces despite project switch to new framework
- Constraint about "always use Python 3.8 syntax" activates after upgrade to 3.11
- Pitfall about legacy auth flow surfaces after complete rewrite

**Not Stale Memory**:
- Memory is old but still correct (age alone doesn't make it stale)
- Memory was superseded but correctly marked inactive (system working as intended)
- Memory conflicts with another memory but both are current (that's a conflict, not staleness)

---

### 4. False Positive Warning

**Definition**: The memory layer surfaced a warning, policy, or constraint that was not relevant or applicable to the current action.

**Characteristics**:
- Memory was activated and presented as relevant
- The memory does not actually apply to the current context
- The warning created noise, confusion, or unnecessary friction
- Scope matching, lifecycle boundary, or relevance logic was too broad

**Examples**:
- "Never use `eval()`" policy activates when user types `evaluation_score` variable name
- Backend database policy activates when user edits frontend CSS file
- Git commit policy activates during read-only file browsing
- Testing pitfall activates when user is writing documentation

**Not a False Positive**:
- Warning is relevant but user disagrees with the policy (policy content issue, not activation issue)
- Warning is precautionary and broadly scoped by design (working as intended)
- Multiple warnings activate and one is marginally relevant (that's ranking/budget issue)

---

## Boundary Cases

### Policy Miss vs Activation Miss
- **Policy Miss**: Focus is on the outcome (policy wasn't applied)
- **Activation Miss**: Focus is on the mechanism (retrieval/ranking failed)
- **Rule**: If you can't tell whether the memory existed or just wasn't retrieved, default to **Policy Miss** (outcome-focused evaluation)

### Activation Miss vs Stale Memory
- **Activation Miss**: Right memory didn't activate
- **Stale Memory**: Wrong (outdated) memory did activate
- **Rule**: If something activated but was wrong, it's **Stale Memory**. If nothing activated but should have, it's **Activation Miss**.

### Stale Memory vs False Positive Warning
- **Stale Memory**: Memory content is outdated
- **False Positive**: Memory content is current but irrelevant to this context
- **Rule**: If the memory would be correct in a different context, it's **False Positive**. If the memory is wrong everywhere now, it's **Stale Memory**.

---

## Usage Notes

- Each miss should be assigned to exactly one category
- When in doubt, prioritize outcome over mechanism (Policy Miss > Activation Miss)
- Track severity separately (see annotation rubric)
- Record evidence and context in the scorecard notes field
