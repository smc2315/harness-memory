# Lifecycle Triggers

This document defines when and how memories are activated during the OpenCode session lifecycle. It maps memory system triggers to OpenCode plugin hook points.

## Overview

The memory system integrates with OpenCode through four lifecycle triggers:

1. **session_start** – Load context at session initialization
2. **before_model** – Inject memories into system prompt before LLM call
3. **before_tool** – Provide preventive guidance before tool execution
4. **after_tool** – Validate outputs and capture new learnings

Each trigger activates specific memory types based on relevance and timing.

---

## Trigger Mapping

| Memory Trigger | OpenCode Hook | Purpose |
|----------------|---------------|---------|
| `session_start` | Plugin initialization | Load persistent context |
| `before_model` | `chat.params` | Inject memories into system prompt |
| `before_tool` | `tool.execute.before` | Provide preventive guidance |
| `after_tool` | `tool.execute.after` | Validate outputs, capture learnings |

---

## 1. session_start

**OpenCode Hook**: Plugin initialization (when plugin loads, before first message)

**Purpose**: Load persistent context that applies throughout the session. This includes architectural constraints, historical decisions, and general workflows that don't need per-message activation.

**Activated Memory Types**:
- **architecture_constraint**: System boundaries and design limits (always relevant)
- **decision**: Historical choices that inform current work (context-dependent)
- **workflow**: General procedural patterns (loaded for reference, not injected every turn)

**Activation Logic**:
```typescript
async function onPluginInit(input: PluginInput): Promise<void> {
  const sessionID = getCurrentSessionID();
  
  // Load architecture constraints (always active)
  const constraints = await memoryStore.query({
    type: 'architecture_constraint',
    status: 'active'
  });
  
  // Load relevant decisions (based on project context)
  const decisions = await memoryStore.query({
    type: 'decision',
    status: 'active',
    scope: input.project.id
  });
  
  // Load general workflows (for reference)
  const workflows = await memoryStore.query({
    type: 'workflow',
    status: 'active'
  });
  
  // Store in session context (not injected into prompt yet)
  await sessionContext.set(sessionID, {
    constraints,
    decisions,
    workflows
  });
}
```

**Example**: At session start, load "Memory system uses UUID primary keys" (architecture_constraint) and "Use advisory memory + policy rules" (decision). These inform all subsequent work without needing per-message injection.

**Non-example**: Don't load "Never use em dashes" (policy) at session start. Policies are injected at `before_model` only when relevant to the current task.

---

## 2. before_model

**OpenCode Hook**: `chat.params` (called before sending messages to LLM)

**Purpose**: Inject relevant memories into the system prompt to guide the model's response. This is the primary activation point for policies and task-specific workflows.

**Activated Memory Types**:
- **policy**: Enforceable rules (injected as warnings)
- **workflow**: Task-specific procedures (injected when task pattern matches)
- **pitfall**: Relevant failure modes (injected when context suggests risk)

**Activation Logic**:
```typescript
"chat.params": async (input, output) => {
  const sessionID = input.sessionID;
  const userMessage = input.message;
  
  // Analyze user message to determine relevant memories
  const taskType = classifyTask(userMessage);
  
  // Load policies (always inject active policies)
  const policies = await memoryStore.query({
    type: 'policy',
    status: 'active'
  });
  
  // Load workflows matching task type
  const workflows = await memoryStore.query({
    type: 'workflow',
    status: 'active',
    task_pattern: taskType
  });
  
  // Load pitfalls relevant to task context
  const pitfalls = await memoryStore.query({
    type: 'pitfall',
    status: 'active',
    context: taskType
  });
  
  // Inject into system prompt via experimental.chat.system.transform
  await injectMemories(sessionID, {
    policies,
    workflows,
    pitfalls
  });
}
```

**Example**: User asks to create a git commit. Inject:
- Policy: "Never skip hooks unless explicitly requested"
- Workflow: "Run git status and git diff in parallel, analyze changes, draft message, commit, verify"
- Pitfall: "Don't amend commits after pushing to remote"

**Non-example**: Don't inject "Memory system uses UUID primary keys" (architecture_constraint) unless the task involves database schema work. Constraints are loaded at `session_start`, not injected every turn.

---

## 3. before_tool

**OpenCode Hook**: `tool.execute.before` (called before tool execution)

**Purpose**: Provide preventive guidance specific to the tool being invoked. This catches potential mistakes before they happen.

**Activated Memory Types**:
- **pitfall**: Failure modes related to the specific tool
- **policy**: Rules that apply to tool usage (e.g., "Never use git push --force to main")

**Activation Logic**:
```typescript
"tool.execute.before": async (input, output) => {
  const toolName = input.tool;
  const toolArgs = output.args;
  
  // Load pitfalls related to this tool
  const pitfalls = await memoryStore.query({
    type: 'pitfall',
    status: 'active',
    tool: toolName
  });
  
  // Load policies that apply to this tool
  const policies = await memoryStore.query({
    type: 'policy',
    status: 'active',
    tool: toolName
  });
  
  // Check for violations or risks
  const warnings = [];
  for (const policy of policies) {
    if (violatesPolicy(toolArgs, policy)) {
      warnings.push(`⚠️ Policy violation: ${policy.rule}`);
    }
  }
  
  for (const pitfall of pitfalls) {
    if (matchesPitfall(toolArgs, pitfall)) {
      warnings.push(`⚠️ Pitfall detected: ${pitfall.mistake}`);
    }
  }
  
  // Inject warnings into tool context (implementation-specific)
  if (warnings.length > 0) {
    await notifyAgent(input.sessionID, warnings);
  }
}
```

**Example**: Before executing `bash` tool with `git commit --amend`, check:
- Pitfall: "Amending pushed commits requires force push"
- Policy: "Never amend commits after pushing to remote"
- If `git log` shows commit is pushed, inject warning

**Non-example**: Don't check "Use TypeScript for new files" (policy) when executing `bash` tool for git operations. Policy is not relevant to the tool being invoked.

---

## 4. after_tool

**OpenCode Hook**: `tool.execute.after` (called after tool execution)

**Purpose**: Validate tool outputs against policies, detect new patterns, and capture candidate memories for future learning.

**Activated Memory Types**:
- **policy**: Validate outputs against rules (e.g., check for em dashes in written content)
- **pitfall**: Detect failure patterns in tool results (e.g., git errors)
- **All types**: Extract candidate memories from successful patterns

**Activation Logic**:
```typescript
"tool.execute.after": async (input, output) => {
  const toolName = input.tool;
  const toolArgs = input.args;
  const toolOutput = output.output;
  
  // Validate against policies
  const policies = await memoryStore.query({
    type: 'policy',
    status: 'active',
    applies_to: 'output'
  });
  
  const violations = [];
  for (const policy of policies) {
    if (violatesPolicy(toolOutput, policy)) {
      violations.push({
        policy: policy.rule,
        violation: detectViolation(toolOutput, policy)
      });
    }
  }
  
  // Detect pitfall patterns
  const pitfalls = await memoryStore.query({
    type: 'pitfall',
    status: 'active',
    tool: toolName
  });
  
  for (const pitfall of pitfalls) {
    if (matchesPitfall(toolOutput, pitfall)) {
      await logPitfallOccurrence(pitfall.id, input.sessionID);
    }
  }
  
  // Extract candidate memories from successful patterns
  if (isSuccessfulExecution(toolOutput)) {
    const candidates = await extractCandidates({
      tool: toolName,
      args: toolArgs,
      output: toolOutput,
      context: input.sessionID
    });
    
    for (const candidate of candidates) {
      await memoryStore.addCandidate(candidate);
    }
  }
  
  // Report violations
  if (violations.length > 0) {
    await notifyAgent(input.sessionID, violations);
  }
}
```

**Example**: After executing `write` tool to create prose document:
- Validate: Check output for em dashes (policy violation)
- Detect: If output contains "—", log violation and suggest correction
- Extract: If output follows anti-AI-slop rules, extract as candidate workflow

**Non-example**: Don't extract "User wrote a file" as a candidate memory. This is too general. Extract specific patterns like "User consistently uses Oxford commas in lists" (potential policy candidate).

---

## Activation Frequency

| Trigger | Frequency | Performance Impact |
|---------|-----------|-------------------|
| `session_start` | Once per session | Low (one-time load) |
| `before_model` | Every LLM call | Medium (query + injection) |
| `before_tool` | Every tool execution | Low (targeted query) |
| `after_tool` | Every tool execution | Medium (validation + extraction) |

**Optimization strategies**:
- Cache active memories at `session_start`, refresh only on updates
- Use indexed queries (by type, status, tool, task_pattern)
- Lazy-load memory content (fetch IDs first, load full content only when needed)
- Batch candidate extraction (don't extract after every tool call, aggregate patterns)

---

## Hook Implementation

The memory system integrates with OpenCode via the plugin interface:

```typescript
export default async function memoryPlugin(input: PluginInput): Promise<Hooks> {
  const memoryStore = await initMemoryStore(input.directory);
  
  return {
    // Session initialization
    async config(config: Config) {
      await onSessionStart(input, memoryStore);
    },
    
    // Before model call
    "experimental.chat.system.transform": async (hookInput, output) => {
      const memories = await loadRelevantMemories(
        hookInput.sessionID,
        memoryStore
      );
      output.system.push(formatMemoriesForPrompt(memories));
    },
    
    // Before tool execution
    "tool.execute.before": async (hookInput, output) => {
      await checkPitfallsAndPolicies(
        hookInput.tool,
        output.args,
        memoryStore
      );
    },
    
    // After tool execution
    "tool.execute.after": async (hookInput, output) => {
      await validateAndExtract(
        hookInput.tool,
        hookInput.args,
        output.output,
        memoryStore
      );
    }
  };
}
```

**Key points**:
- `session_start` maps to `config` hook (earliest initialization point)
- `before_model` maps to `experimental.chat.system.transform` (system prompt injection)
- `before_tool` and `after_tool` map directly to OpenCode hooks
- All hooks receive `sessionID` for context tracking

---

## Memory Injection Format

When injecting memories into the system prompt, use structured format:

```markdown
## Active Memories

### Policies
- [POLICY] Never use em dashes (—) or en dashes (–) in prose output
- [POLICY] Never skip git hooks unless explicitly requested

### Workflows
- [WORKFLOW] Git commit creation: Run git status and git diff in parallel → analyze changes → draft message → commit → verify

### Pitfalls
- [PITFALL] Don't amend commits after pushing to remote (requires force push)

### Architecture Constraints
- [CONSTRAINT] Memory system uses UUID primary keys, not auto-increment integers

### Decisions
- [DECISION] Use advisory memory + policy rules (not single 'rule' type) for separation of concerns
```

**Formatting rules**:
- Prefix each memory with type tag (`[POLICY]`, `[WORKFLOW]`, etc.)
- Keep entries concise (one line per memory when possible)
- Group by type for clarity
- Inject only relevant memories (don't dump entire memory store)

---

## Validation

This document must cover all four lifecycle triggers: `session_start`, `before_model`, `before_tool`, `after_tool`.
