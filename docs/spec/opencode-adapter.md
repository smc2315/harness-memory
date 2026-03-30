# OpenCode Adapter Contract

## Overview

This document defines the harness-independent adapter contract for integrating the Project Memory Layer MVP with OpenCode. The adapter bridges core memory logic (harness-agnostic) with OpenCode-specific hook points and payload structures.

**Core Principle**: The memory layer core never depends on OpenCode metadata structures. The adapter translates between OpenCode events and core memory operations.

---

## 1. Lifecycle Hook Mapping

The MVP lifecycle has four critical triggers. Each maps to a specific OpenCode hook:

### 1.1 `session_start` → `chat.message` Hook

**OpenCode Hook**: `"chat.message"`

**Trigger**: When a new message is received in a session.

**Input Payload**:
```typescript
{
  sessionID: string;           // Unique session identifier
  agent?: string;              // Agent name (optional)
  model?: {
    providerID: string;        // e.g., "amazon-bedrock"
    modelID: string;           // e.g., "us.anthropic.claude-3-5-haiku-20241022-v1:0"
  };
  messageID?: string;          // Unique message identifier
  variant?: string;            // Message variant (optional)
}
```

**Output Payload**:
```typescript
{
  message: UserMessage;        // The user message object
  parts: Part[];               // Message parts (text, code, etc.)
}
```

**Adapter Responsibility**:
- Extract `sessionID` and pass to core memory layer
- Initialize session context if first message
- Record session metadata (agent, model info)

**Core Memory Responsibility**:
- Create or retrieve session record
- Initialize memory structures
- Return session context to adapter

---

### 1.2 `before_model` → `experimental.chat.system.transform` Hook

**OpenCode Hook**: `"experimental.chat.system.transform"`

**Trigger**: Before the system prompt is finalized for the LLM.

**Input Payload**:
```typescript
{
  sessionID?: string;          // Session identifier when available
  model: Model;                // Model object with metadata
}
```

**Output Payload**:
```typescript
{
  system: string[];            // System prompt fragments appended by plugins
}
```

**Adapter Responsibility**:
- Retrieve session context from core memory layer
- Request a bounded memory payload for the current lifecycle and scope
- Append memory guidance to the system prompt without modifying provider parameters

**Core Memory Responsibility**:
- Determine if memory should be injected
- Return bounded advisory text for the system prompt
- Keep activation/ranking logic outside the OpenCode adapter

---

### 1.3 `before_tool` → `tool.execute.before` Hook

**OpenCode Hook**: `"tool.execute.before"`

**Trigger**: Before a tool is executed.

**Input Payload**:
```typescript
{
  tool: string;                // Tool name/ID
  sessionID: string;           // Session identifier
  callID: string;              // Unique call identifier for this tool invocation
}
```

**Output Payload**:
```typescript
{
  args: any;                   // Tool arguments (can be modified)
}
```

**Adapter Responsibility**:
- Retrieve session context from core memory layer
- Request warning-only policy notes before tool execution
- Surface warnings without mutating permission or execution control flow

**Core Memory Responsibility**:
- Evaluate tool against memory-based policies
- Return zero or more warnings with rationale and scope context
- Never request a hard block in the MVP

---

### 1.4 `after_tool` → `tool.execute.after` Hook

**OpenCode Hook**: `"tool.execute.after"`

**Trigger**: After a tool completes execution.

**Input Payload**:
```typescript
{
  tool: string;                // Tool name/ID
  sessionID: string;           // Session identifier
  callID: string;              // Unique call identifier
  args: any;                   // Tool arguments that were used
}
```

**Output Payload**:
```typescript
{
  title: string;               // Human-readable title for the tool result
  output: string;              // Tool output/result
  metadata: any;               // Additional metadata (can be modified)
}
```

**Adapter Responsibility**:
- Capture tool execution evidence (args, output, metadata)
- Pass evidence to core memory layer for recording
- Store evidence in session context

**Core Memory Responsibility**:
- Record tool execution in session memory
- Extract key facts/decisions from output
- Update session state based on tool result

---

## 2. HarnessPort Contract

The `HarnessPort` interface abstracts harness-specific details from core memory logic.

```typescript
/**
 * Harness-independent port for session context and model injection.
 * Separates core memory logic from OpenCode-specific payload details.
 */
interface HarnessPort {
  /**
   * Session Context Management
   */
  
  /**
   * Get or create session context.
   * @param sessionID - Unique session identifier from harness
   * @returns Session context object with memory structures
   */
  getOrCreateSession(sessionID: string): Promise<SessionContext>;

  /**
   * Update session metadata (agent, model, etc.)
   * @param sessionID - Session identifier
   * @param metadata - Harness-specific metadata
   */
  updateSessionMetadata(
    sessionID: string,
    metadata: {
      agent?: string;
      model?: { providerID: string; modelID: string };
      variant?: string;
    }
  ): Promise<void>;

  /**
   * Model Injection
   */

  /**
   * Determine if memory should be injected into model context.
   * @param sessionID - Session identifier
   * @returns Memory-augmented system context or null if no injection
   */
  getMemoryAugmentedContext(sessionID: string): Promise<string | null>;

  /**
   * Tool Warnings & Policy
   */

  /**
   * Evaluate tool execution against memory-based policies.
   * @param sessionID - Session identifier
   * @param toolName - Name of tool to execute
   * @returns Warning-only policy notes for the current tool invocation
   */
  evaluateToolPolicy(
    sessionID: string,
    toolName: string
  ): Promise<Array<{
    ruleCode: string;
    severity: "info" | "warning";
    message: string;
  }>>;

  /**
   * Post-Tool Evidence Capture
   */

  /**
   * Record tool execution evidence in session memory.
   * @param sessionID - Session identifier
   * @param evidence - Tool execution evidence
   */
  recordToolEvidence(
    sessionID: string,
    evidence: {
      toolName: string;
      callID: string;
      args: any;
      output: string;
      metadata?: any;
      timestamp?: number;
    }
  ): Promise<void>;

  /**
   * Retrieve session memory for inspection/debugging.
   * @param sessionID - Session identifier
   * @returns Full session memory state
   */
  getSessionMemory(sessionID: string): Promise<SessionMemory>;
}

/**
 * Session context object returned by HarnessPort.
 */
interface SessionContext {
  sessionID: string;
  createdAt: number;
  lastUpdated: number;
  metadata: {
    agent?: string;
    model?: { providerID: string; modelID: string };
    variant?: string;
  };
  memory: SessionMemory;
}

/**
 * Session memory structure (core-owned).
 */
interface SessionMemory {
  facts: string[];           // Key facts extracted from conversation
  decisions: string[];       // Decisions made in session
  toolHistory: ToolRecord[]; // Tool execution history
  warnings: string[];        // Warnings issued
  state: Record<string, any>; // Custom session state
}

/**
 * Tool execution record.
 */
interface ToolRecord {
  toolName: string;
  callID: string;
  args: any;
  output: string;
  timestamp: number;
  metadata?: any;
}
```

---

## 3. Deferred Hooks (MVP Exclusions)

The following OpenCode hooks are **explicitly deferred** from the MVP:

### 3.1 `permission.ask` Hook

**Status**: DEFERRED

**Reason**: 
- Permission management is a harness-level concern, not a memory concern
- Memory layer should not make permission decisions
- Future: Memory could inform permission policies, but not in MVP

**Future Use**: None planned for the MVP. Advisory memory must stay separate from permission decisions.

---

### 3.2 `chat.headers` Hook

**Status**: DEFERRED

**Reason**:
- Header injection is a provider-specific concern
- Memory layer has no need to modify HTTP headers
- Future: Could be used for memory-aware rate limiting or tracing

**Future Use**: T13+ for observability integration

---

### 3.3 `command.execute.before` Hook

**Status**: DEFERRED

**Reason**:
- Commands are shell-level operations, not tool-level
- Memory layer focuses on tool execution, not shell commands
- Future: Could track command history for context

**Future Use**: T14+ for shell command memory

---

### 3.4 `shell.env` Hook

**Status**: DEFERRED

**Reason**:
- Environment variables are harness-level configuration
- Memory layer should not modify shell environment
- Future: Could be used for memory-aware environment setup

**Future Use**: T15+ for environment-aware memory

---

### 3.5 `experimental.*` Hooks

**Status**: DEFERRED

**Reason**:
- Experimental hooks are unstable and subject to change
- MVP focuses on stable, production-ready hooks
- Future: May adopt experimental hooks once stabilized

**Deferred Hooks**:
- `experimental.chat.messages.transform`
- `experimental.session.compacting`
- `experimental.text.complete`

**Future Use**: T16+ for advanced memory features

---

### 3.6 `tool.definition` Hook

**Status**: DEFERRED

**Reason**:
- Tool definition modification is a harness-level concern
- Memory layer should not alter tool schemas
- Future: Could be used for memory-aware tool filtering

**Future Use**: T17+ for context-aware tool availability

---

### 3.7 `event` Hook

**Status**: DEFERRED

**Reason**:
- Generic event handling is too broad for MVP scope
- Memory layer has specific hook requirements
- Future: Could be used for custom event tracking

**Future Use**: T18+ for extensible event handling

---

### 3.8 `config` Hook

**Status**: DEFERRED

**Reason**:
- Configuration management is a harness-level concern
- Memory layer should not modify harness configuration
- Future: Could be used for memory-aware configuration

**Future Use**: T19+ for dynamic configuration

---

### 3.9 `auth` Hook

**Status**: DEFERRED

**Reason**:
- Authentication is a harness-level concern
- Memory layer should not manage authentication
- Future: Could be used for memory-aware auth policies

**Future Use**: T20+ for auth-aware memory

---

### 3.10 `tool` Hook (Tool Registration)

**Status**: DEFERRED

**Reason**:
- Tool registration is a harness-level concern
- Memory layer should not register tools
- Future: Could be used for memory-aware tool registration

**Future Use**: T21+ for dynamic tool registration

---

## 4. Adapter Implementation Boundaries

### 4.1 What the Adapter Does

1. **Translates OpenCode Events** → Core Memory Operations
   - Maps hook payloads to HarnessPort method calls
   - Extracts relevant data from OpenCode structures

2. **Manages Session Context** → Delegates to HarnessPort
   - Retrieves session context on demand
   - Updates metadata as needed

3. **Applies Core Decisions** → Back to OpenCode Hooks
   - Takes memory-augmented context and applies to LLM params
   - Takes tool policy decisions and applies to tool execution
   - Records tool evidence after execution

### 4.2 What the Adapter Does NOT Do

1. **Store Memory** → Core memory layer owns storage
2. **Make Policy Decisions** → Core memory layer owns policies
3. **Modify OpenCode Internals** → Adapter only uses public hook APIs
4. **Couple to OpenCode Metadata** → Adapter translates, not embeds

---

## 5. Coupling Prevention

### 5.1 Core Memory Layer Isolation

The core memory layer **MUST NOT**:
- Import OpenCode SDK types directly
- Reference OpenCode hook names
- Depend on OpenCode metadata structures
- Use OpenCode-specific field names

### 5.2 Adapter Isolation

The adapter **MUST**:
- Translate all OpenCode payloads to HarnessPort calls
- Never pass raw OpenCode objects to core
- Implement HarnessPort interface completely
- Handle all OpenCode hook lifecycle events

### 5.3 Verification

See Section 6 for verification scripts that enforce these boundaries.

---

## 6. Verification Scripts

### 6.1 `check_terms.py`

Verifies that the adapter document uses the correct hook names and HarnessPort interface.

**Usage**:
```bash
python scripts/check_terms.py docs/spec/opencode-adapter.md \
  session_start before_model before_tool after_tool HarnessPort
```

**Expected Output**:
```
✓ Found term: session_start
✓ Found term: before_model
✓ Found term: before_tool
✓ Found term: after_tool
✓ Found term: HarnessPort
All required terms found.
```

### 6.2 `check_no_terms.py`

Verifies that the adapter document does NOT contain forbidden coupling patterns.

**Usage**:
```bash
python scripts/check_no_terms.py docs/spec/opencode-adapter.md \
  "<forbidden coupling phrase 1>" \
  "<forbidden coupling phrase 2>"
```

**Expected Output**:
```text
OK Forbidden term not found: <forbidden coupling phrase 1>
OK Forbidden term not found: <forbidden coupling phrase 2>
OK All forbidden terms absent.
```

---

## 7. Next Steps

### 7.1 T11: Adapter Prototype Implementation

Implement the HarnessPort interface and OpenCode hook handlers:
- Create `src/adapters/opencode-adapter.ts`
- Implement all four hook handlers
- Integrate with core memory layer
- Add unit tests for adapter

### 7.2 Deferred Harness Policies

Do not route advisory memory through `permission.ask`. If harness-level permission policies are explored later, they must remain separate from warning-only memory surfacing.

### 7.3 T13+: Advanced Features

Adopt deferred hooks as needed for:
- Observability (headers, events)
- Shell command memory (command.execute.before)
- Environment-aware memory (shell.env)
- Experimental message-list transforms beyond bounded system guidance

---

## Appendix: Hook Reference

| Hook | MVP | Purpose | Deferred Reason |
|------|-----|---------|-----------------|
| `chat.message` | ✓ | Session start trigger | — |
| `experimental.chat.system.transform` | ✓ | System prompt memory injection | — |
| `tool.execute.before` | ✓ | Tool policy evaluation | — |
| `tool.execute.after` | ✓ | Evidence capture | — |
| `permission.ask` | ✗ | Permission decisions | Harness-level concern |
| `chat.headers` | ✗ | HTTP header injection | Provider-specific |
| `command.execute.before` | ✗ | Shell command tracking | Out of MVP scope |
| `shell.env` | ✗ | Environment setup | Harness-level concern |
| `experimental.chat.messages.transform` | ✗ | Full message rewriting | More invasive than MVP needs |
| `tool.definition` | ✗ | Tool schema modification | Harness-level concern |
| `event` | ✗ | Generic event handling | Too broad for MVP |
| `config` | ✗ | Configuration management | Harness-level concern |
| `auth` | ✗ | Authentication | Harness-level concern |
| `tool` | ✗ | Tool registration | Harness-level concern |

---

**Document Version**: 1.0  
**Last Updated**: 2026-03-28  
**Status**: APPROVED FOR MVP IMPLEMENTATION
