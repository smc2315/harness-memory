/**
 * OpenCode plugin for harness-memory.
 *
 * Bridges OpenCode lifecycle hooks to the OpenCodeAdapter so that
 * project memories are injected automatically, policy warnings are
 * evaluated, and tool evidence is captured — all without manual CLI
 * invocations.
 *
 * Compatible types are defined inline to avoid a hard dependency on
 * `@opencode-ai/plugin`.  The plugin is loaded by OpenCode when
 * registered via `opencode.json`:
 *
 *   { "plugin": ["harness-memory/plugin"] }
 */

import { existsSync, readFileSync, writeFileSync } from "fs";
import { dirname, resolve } from "path";
import { homedir } from "os";

import { ActivationEngine, EmbeddingService } from "../activation";
import { AuditLogger } from "../audit/logger";
import { OpenCodeAdapter } from "../adapters";
import type { AdapterModelRef } from "../adapters/types";
import { openSqlJsDatabase, saveSqlJsDatabase, runMigrations } from "../db";
import { DreamRepository } from "../dream";
import {
  callLlmForExtraction,
  executeExtractionActions,
} from "../dream/llm-extract";
import {
  checkGates,
  readGateState,
  writeGateState,
  incrementSessionCount,
} from "../cli/dream-extract";
import { MemoryRepository, CompositeMemoryRepository } from "../memory";
import { PolicyEngine, PolicyRuleRepository } from "../policy";

// ---------------------------------------------------------------------------
// OpenCode-compatible type stubs (avoids coupling to @opencode-ai/plugin)
// ---------------------------------------------------------------------------

/** Minimal subset of the PluginInput OpenCode passes on load. */
interface PluginInput {
  directory: string;
  worktree: string;
  [key: string]: unknown;
}

interface SystemTransformOutput {
  system: string[];
}

interface ToolBeforeInput {
  tool: string;
  sessionID: string;
  callID: string;
}

interface ToolBeforeOutput {
  args: unknown;
}

interface ToolAfterInput {
  tool: string;
  sessionID: string;
  callID: string;
}

interface ToolAfterOutput {
  title: string;
  output: string;
  metadata: unknown;
}

interface ChatMessageInput {
  sessionID: string;
  agent?: string;
  model?: { providerID: string; modelID: string };
  messageID?: string;
  variant?: string;
}

interface ChatMessageOutput {
  message: unknown;
  parts: unknown[];
}

interface ChatParamsInput {
  sessionID: string;
  agent: string;
  model: { id?: string; provider?: string; providerID?: string; modelID?: string; [key: string]: unknown };
  [key: string]: unknown;
}

interface ChatParamsOutput {
  [key: string]: unknown;
}

interface SessionInput {
  sessionID: string;
}

type PluginHooks = {
  "chat.message"?: (input: ChatMessageInput, output: ChatMessageOutput) => Promise<void>;
  "chat.params"?: (input: ChatParamsInput, output: ChatParamsOutput) => Promise<void>;
  "experimental.chat.system.transform"?: (
    input: Record<string, unknown>,
    output: SystemTransformOutput,
  ) => Promise<void>;
  "tool.execute.before"?: (input: ToolBeforeInput, output: ToolBeforeOutput) => Promise<void>;
  "tool.execute.after"?: (input: ToolAfterInput, output: ToolAfterOutput) => Promise<void>;
  "session.idle"?: (input: SessionInput) => Promise<void>;
  "session.compacted"?: (input: SessionInput) => Promise<void>;
};

type Plugin = (input: PluginInput) => Promise<PluginHooks>;

interface PluginExport {
  server: (input: PluginInput, options?: Record<string, unknown>) => Promise<PluginHooks>;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_DB_RELATIVE_PATH = ".harness-memory/memory.sqlite";
const PLUGIN_LOG_PREFIX = "[harness-memory]";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(...args: unknown[]): void {
  console.log(PLUGIN_LOG_PREFIX, ...args);
}

function warn(...args: unknown[]): void {
  console.warn(PLUGIN_LOG_PREFIX, ...args);
}

function extractModelRef(raw: ChatParamsInput["model"]): AdapterModelRef {
  return {
    providerID: String(raw.providerID ?? raw.provider ?? "unknown"),
    modelID: String(raw.modelID ?? raw.id ?? "unknown"),
  };
}

/**
 * Try to extract a file-system scope reference from tool arguments.
 *
 * OpenCode tools commonly carry a file path in `filePath`, `path`, or
 * `file` fields.  When found, we normalise to forward slashes so the
 * activation scope matcher works cross-platform.
 */
function extractScopeFromArgs(args: unknown): string | undefined {
  if (args === null || typeof args !== "object") {
    return undefined;
  }

  const obj = args as Record<string, unknown>;
  const raw = obj.filePath ?? obj.path ?? obj.file;

  if (typeof raw !== "string" || raw.length === 0) {
    return undefined;
  }

  return raw.replace(/\\/g, "/");
}

function tokenizeForQuery(text: string): string[] {
  return text
    .split(/[\s\p{P}]+/u)
    .map((token) => token.toLowerCase())
    .filter((token) => token.length > 2 && token.length < 50);
}

// ---------------------------------------------------------------------------
// Conversation buffer for LLM-based memory extraction
// ---------------------------------------------------------------------------

interface BufferEntry {
  role: "user" | "tool";
  text: string;
  timestamp: string;
  sessionId: string;
}

const DEFAULT_BUFFER_FLUSH_THRESHOLD = 5;
const TOOL_OUTPUT_MAX_CHARS = 300;

/**
 * Accumulates user messages and tool-call summaries across process restarts.
 *
 * Each `opencode run` invocation starts a fresh process, so the buffer must
 * be persisted to disk. The buffer file is stored alongside the SQLite DB
 * (e.g. `.harness-memory/.conversation-buffer.json`).
 *
 * When the buffer reaches the flush threshold, its contents are written as
 * a single `conversation-batch` dream evidence event.
 */
class ConversationBuffer {
  private entries: BufferEntry[] = [];
  private flushThreshold: number;
  private persistPath: string | null;

  constructor(flushThreshold: number = DEFAULT_BUFFER_FLUSH_THRESHOLD, persistPath?: string) {
    this.flushThreshold = flushThreshold;
    this.persistPath = persistPath ?? null;

    // Restore from disk on construction
    if (this.persistPath !== null) {
      try {
        const raw = readFileSync(this.persistPath, "utf-8");
        const parsed = JSON.parse(raw) as BufferEntry[];

        if (Array.isArray(parsed)) {
          this.entries = parsed;
        }
      } catch {
        // No persisted buffer — start empty
      }
    }
  }

  /** Push a user message into the buffer. */
  pushUserMessage(text: string, sessionId: string): void {
    this.entries.push({
      role: "user",
      text,
      timestamp: new Date().toISOString(),
      sessionId,
    });
    this.persist();
  }

  /** Push a tool-call summary (title + truncated output). */
  pushToolSummary(toolName: string, title: string, output: string, sessionId: string): void {
    const truncatedOutput =
      output.length > TOOL_OUTPUT_MAX_CHARS
        ? output.slice(0, TOOL_OUTPUT_MAX_CHARS) + "..."
        : output;

    this.entries.push({
      role: "tool",
      text: `[${toolName}] ${title}: ${truncatedOutput}`,
      timestamp: new Date().toISOString(),
      sessionId,
    });
    this.persist();
  }

  /** Check if the buffer should be flushed. */
  shouldFlush(): boolean {
    return this.entries.length >= this.flushThreshold;
  }

  /** Return the buffer contents as a formatted excerpt and clear the buffer. */
  flush(): { excerpt: string; sessionId: string; entryCount: number } | null {
    if (this.entries.length === 0) {
      return null;
    }

    const sessionId = this.entries[this.entries.length - 1].sessionId;
    const entryCount = this.entries.length;

    const lines = this.entries.map(
      (entry) => `[${entry.role}] ${entry.text}`,
    );
    const excerpt = lines.join("\n");

    this.entries = [];
    this.persist();

    return { excerpt, sessionId, entryCount };
  }

  get length(): number {
    return this.entries.length;
  }

  /** Persist current buffer to disk. */
  private persist(): void {
    if (this.persistPath === null) {
      return;
    }

    try {
      writeFileSync(this.persistPath, JSON.stringify(this.entries), "utf-8");
    } catch {
      // Non-critical — buffer loss is acceptable
    }
  }
}

function extractMessageText(message: unknown, parts?: unknown[]): string | undefined {
  // First try extracting from parts (OpenCode puts user text in parts[].text)
  if (parts !== undefined && Array.isArray(parts)) {
    for (const part of parts) {
      if (part !== null && typeof part === "object") {
        const typed = part as Record<string, unknown>;

        if (typeof typed.text === "string" && typed.text.length > 0) {
          return typed.text;
        }

        if (typeof typed.content === "string" && typed.content.length > 0) {
          return typed.content;
        }
      }
    }
  }

  // Fallback: try message object
  if (typeof message === "string") {
    return message;
  }

  if (message !== null && typeof message === "object") {
    const typed = message as Record<string, unknown>;

    if (typeof typed.content === "string") {
      return typed.content;
    }

    if (typeof typed.text === "string") {
      return typed.text;
    }
  }

  return undefined;
}

async function detectBranchName(directory: string): Promise<string | undefined> {
  try {
    const { spawnSync } = await import("child_process");
    const result = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: directory,
      encoding: "utf-8",
      timeout: 3_000,
    });

    if (result.status !== 0) {
      return undefined;
    }

    return result.stdout.trim();
  } catch {
    return undefined;
  }
}

function detectRepoFingerprint(directory: string): string[] {
  const tokens: string[] = [];

  try {
    const packageJsonPath = resolve(directory, "package.json");
    if (!existsSync(packageJsonPath)) {
      return tokens;
    }

    const parsed = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as {
      dependencies?: Record<string, unknown>;
      devDependencies?: Record<string, unknown>;
    };
    const deps = {
      ...(parsed.dependencies ?? {}),
      ...(parsed.devDependencies ?? {}),
    };

    for (const depName of Object.keys(deps)) {
      tokens.push(depName.replace(/^@/, "").replace(/\//g, "-"));
    }
  } catch {
    return tokens;
  }

  return tokens;
}

// ---------------------------------------------------------------------------
// Plugin implementation
// ---------------------------------------------------------------------------

/**
 * Inner plugin function — returns hook implementations.
 * Wrapped by the OpenCode-compatible `server()` export below.
 */
async function createPluginHooks(ctx: PluginInput): Promise<PluginHooks> {
  const dbPath = resolve(ctx.directory, DEFAULT_DB_RELATIVE_PATH);

  if (!existsSync(dbPath)) {
    const { mkdirSync } = await import("fs");
    mkdirSync(dirname(dbPath), { recursive: true });
    log("Auto-initializing database at", dbPath);
  }

  await runMigrations(dbPath, { log: () => {}, error: () => {} });

  // ---- Lazy initialization state -------------------------------------------

  let adapter: OpenCodeAdapter | null = null;
  let dbSavePath: string = dbPath;
  let dbInstance: import("sql.js").Database | null = null;
  let embedMissingMemoriesTask: Promise<void> | null = null;
  let embedMissingMemoriesRunner: (() => Promise<void>) | null = null;
  let dreamRepo: DreamRepository | null = null;
  let auditLog: AuditLogger | null = null;
  const bufferPersistPath = resolve(dirname(dbPath), ".conversation-buffer.json");
  const conversationBuffer = new ConversationBuffer(DEFAULT_BUFFER_FLUSH_THRESHOLD, bufferPersistPath);

  /** Initialize once, reuse across hook calls. */
  async function ensureAdapter(): Promise<OpenCodeAdapter> {
    if (adapter !== null) {
      return adapter;
    }

    const db = await openSqlJsDatabase(dbPath);
    dbInstance = db;
    dbSavePath = dbPath;

    const memoryRepository = new MemoryRepository(db);
    const embeddingCacheDir = resolve(ctx.directory, ".harness-memory", "models");
    const embeddingService = new EmbeddingService({ cacheDir: embeddingCacheDir });

    embeddingService.warmup().catch((error: unknown) => {
      warn("Embedding warmup failed, falling back to lexical search:", error);
    });

    // Load global DB if it exists (~/.harness-memory/global.sqlite).
    const globalDbPath = resolve(homedir(), ".harness-memory", "global.sqlite");
    let globalMemoryRepository: MemoryRepository | undefined;

    try {
      if (existsSync(globalDbPath)) {
        await runMigrations(globalDbPath);
        const globalDb = await openSqlJsDatabase(globalDbPath);
        globalMemoryRepository = new MemoryRepository(globalDb);
        log("Global memory loaded from", globalDbPath);
      }
    } catch (error) {
      warn("Failed to load global memory DB:", error);
    }

    const compositeRepo = new CompositeMemoryRepository(memoryRepository, globalMemoryRepository);

    // The activation engine needs to see memories from BOTH tiers.
    // Create a thin wrapper that merges list() results while
    // delegating writes to the project repo.
    const mergedRepoForEngine = new Proxy(memoryRepository, {
      get(target, prop, receiver) {
        if (prop === "list") {
          return (input: Record<string, unknown>) => compositeRepo.list(input);
        }

        if (prop === "getById") {
          return (id: string) => compositeRepo.getById(id) ?? target.getById(id);
        }

        return Reflect.get(target, prop, receiver);
      },
    }) as MemoryRepository;

    const auditLogger = new AuditLogger(db);
    auditLog = auditLogger;
    const activationEngine = new ActivationEngine(mergedRepoForEngine, embeddingService, auditLogger);
    const policyRuleRepository = new PolicyRuleRepository(db);
    const policyEngine = new PolicyEngine(policyRuleRepository);
    const dreamRepository = new DreamRepository(db);
    dreamRepo = dreamRepository;

    async function embedMissingMemories(): Promise<void> {
      if (!embeddingService.isReady) {
        return;
      }

      const memories = memoryRepository.list({});
      let updated = false;

      for (const memory of memories) {
        if (memory.embedding !== null) {
          continue;
        }

        try {
          const text = `${memory.summary} ${memory.details}`;
          const embedding = await embeddingService.embedPassage(text);
          memoryRepository.updateEmbedding(memory.id, embedding);
          updated = true;
        } catch {
          // Non-critical; lexical fallback remains available.
        }
      }

      if (updated) {
        saveDb();
      }
    }

    embedMissingMemoriesRunner = embedMissingMemories;

    adapter = new OpenCodeAdapter({
      activationEngine,
      policyEngine,
      dreamRepository,
    });

    embedMissingMemoriesTask = embedMissingMemories();

    log("Adapter initialized from", dbPath);
    return adapter;
  }

  /** Flush the in-memory sql.js database to disk. */
  function saveDb(): void {
    if (dbInstance !== null) {
      saveSqlJsDatabase(dbInstance, dbSavePath);
    }
  }

  /**
   * Reload the in-memory database from the file on disk.
   *
   * This is needed when an external process (e.g. `npx harness-memory memory:add`
   * run via a slash command) modifies the SQLite file directly. Without this,
   * the plugin's next `saveDb()` would overwrite those changes with its stale
   * in-memory copy.
   */
  async function reloadDbFromDisk(): Promise<void> {
    if (dbInstance !== null) {
      dbInstance.close();
    }

    const db = await openSqlJsDatabase(dbSavePath);
    dbInstance = db;

    // Re-wire repositories that hold references to the old DB instance.
    // The adapter and its sub-components need reconstruction.
    adapter = null;
    dreamRepo = null;
    auditLog = null;
    log("Reloaded DB from disk after external CLI modification");
  }

  /** Check if a tool call was a harness-memory CLI execution. */
  function isHarnessMemoryCliCall(toolName: string, title: string, output: string): boolean {
    if (toolName !== "bash") {
      return false;
    }

    const combined = `${title} ${output}`;
    return combined.includes("harness-memory") || combined.includes("memory:add") || combined.includes("memory:promote") || combined.includes("memory:reject");
  }

  // ---- Per-session tracking ------------------------------------------------

  /** Most recent sessionID — used for system.transform which has no input. */
  let currentSessionID: string | undefined;

  /** Track whether we already ran dream extraction in this plugin lifecycle. */
  let dreamExtractRunning = false;

  /** Track whether the review notice has been shown this session. */
  let reviewNoticeShown = false;

  /** Increment session count on initialization for gate tracking. */
  incrementSessionCount(dbPath);

  /**
   * Attempt background dream extraction if gates pass.
   * Called from session.idle and session.compacted — non-blocking moments
   * where the user isn't waiting for a response.
   */
  async function tryBackgroundDreamExtract(): Promise<void> {
    if (dreamExtractRunning || dreamRepo === null) {
      return;
    }

    // Count pending conversation-batch evidence
    const allEvents = dreamRepo.listEvidenceEvents({ limit: 100 });
    const pendingBatches = allEvents.filter(
      (e) => e.toolName === "conversation-batch" && e.status === "pending",
    );

    if (pendingBatches.length === 0) {
      return;
    }

    // Check gates
    const gateState = readGateState(dbPath);
    const gateResult = checkGates(pendingBatches.length, gateState);

    if (!gateResult.pass) {
      return;
    }

    // Acquire lock
    dreamExtractRunning = true;
    gateState.lockPid = process.pid;
    writeGateState(dbPath, gateState);

    try {
      log("Dream extraction started (background):", pendingBatches.length, "batches");

      // Load existing memories for dedup context
      const adp = await ensureAdapter();
      const memoryRepo = new MemoryRepository(dbInstance!);
      const existingMemories = memoryRepo
        .list({})
        .filter((m) => m.status === "active" || m.status === "candidate")
        .map((m) => ({ id: m.id, type: m.type, summary: m.summary, status: m.status }));

      // Call LLM via SDK
      const result = await callLlmForExtraction(pendingBatches, existingMemories);

      log("Dream extraction:", result.facts.length, "facts extracted");

      // Execute actions
      const actionResults = await executeExtractionActions(result.facts, {
        memoryRepository: memoryRepo,
      });

      // Mark batches as consumed
      const dreamRun = dreamRepo.createDreamRun({
        trigger: "idle",
        windowStart: pendingBatches[0].createdAt,
        windowEnd: pendingBatches[pendingBatches.length - 1].createdAt,
        evidenceCount: pendingBatches.length,
        summary: `auto dream:extract — ${actionResults.filter((r) => !r.skipped).length} actions`,
      });

      dreamRepo.markEvidenceEventsConsumed(
        pendingBatches.map((b) => b.id),
        dreamRun.id,
      );

      saveDb();

      // Show toast notification for review
      const applied = actionResults.filter((r) => !r.skipped);

      if (applied.length > 0) {
        const candidateList = applied
          .map((r, i) => `${i + 1}. [${r.action}] ${r.summary}`)
          .join("\n");

        log("Dream extraction complete:", applied.length, "candidates created. Use /harness-memory-review to approve.");

        // Audit log
        if (auditLog !== null) {
          auditLog.logExtraction({
            batchCount: pendingBatches.length,
            factsExtracted: result.facts.length,
            actionsApplied: applied.length,
            actionsSkipped: actionResults.length - applied.length,
            durationMs: 0,
          });
        }
      }

      // Release lock and update state
      const finalState = readGateState(dbPath);
      finalState.lockPid = null;
      finalState.lastExtractAt = new Date().toISOString();
      finalState.sessionsSinceLastExtract = 0;
      writeGateState(dbPath, finalState);
    } catch (error) {
      warn("Dream extraction failed:", error);

      // Release lock on failure
      const finalState = readGateState(dbPath);
      finalState.lockPid = null;
      writeGateState(dbPath, finalState);
    } finally {
      dreamExtractRunning = false;
    }
  }

  /** Most recent model ref — updated from chat.message or chat.params. */
  let currentModel: AdapterModelRef = { providerID: "unknown", modelID: "unknown" };

  /** Tokens extracted from current message + branch context for lexical retrieval. */
  let currentQueryTokens: string[] = [];

  /** Last text message seen in chat.message. */
  let currentMessageText: string | undefined;

  /** Repository fingerprint tokens from package dependencies and branch context. */
  const repoFingerprintTokens = detectRepoFingerprint(ctx.directory);
  const branchName = await detectBranchName(ctx.directory);
  if (branchName !== undefined && branchName.length > 0) {
    currentQueryTokens.push(...tokenizeForQuery(branchName));
    repoFingerprintTokens.push(...tokenizeForQuery(branchName));
  }

  /** Captured tool args keyed by callID (before → after bridge). */
  const pendingToolArgs = new Map<string, unknown>();

  // ---- Hook implementations ------------------------------------------------

  /** Flush conversation buffer to dream evidence when threshold is reached. */
  function flushBufferIfNeeded(): void {
    if (!conversationBuffer.shouldFlush() || dreamRepo === null) {
      return;
    }

    const batch = conversationBuffer.flush();

    if (batch === null) {
      return;
    }

    const callId = `conv-batch-${Date.now()}`;

    dreamRepo.createEvidenceEvent({
      sessionId: batch.sessionId,
      callId,
      toolName: "conversation-batch",
      scopeRef: ".",
      sourceRef: `${batch.sessionId}:${callId}:conversation-batch`,
      title: `Conversation batch (${batch.entryCount} entries)`,
      excerpt: batch.excerpt.length > 4000 ? batch.excerpt.slice(0, 4000) : batch.excerpt,
      args: {},
      topicGuess: "conversation-batch:.:pending-extraction",
      typeGuess: "workflow",
      salience: 0.5,
      novelty: 0.8,
      contradictionSignal: false,
    });

    saveDb();
    log("Flushed conversation buffer:", batch.entryCount, "entries");

    if (auditLog !== null) {
      auditLog.logBufferFlush(batch.sessionId, {
        entryCount: batch.entryCount,
      });
    }
  }

  return {
    /**
     * `chat.message` — fires when a user message arrives.
     * Captures session context and initializes the adapter session.
     */
    "chat.message": async (input, output) => {
      try {
        const adp = await ensureAdapter();
        currentSessionID = input.sessionID;

        const messageText = extractMessageText(output.message, output.parts);
        currentMessageText = messageText;
        currentQueryTokens = messageText === undefined ? [] : tokenizeForQuery(messageText);

        if (branchName !== undefined && branchName.length > 0) {
          currentQueryTokens.push(...tokenizeForQuery(branchName));
        }

        if (input.model !== undefined) {
          currentModel = {
            providerID: input.model.providerID,
            modelID: input.model.modelID,
          };
        }

        adp.initializeSession({
          sessionID: input.sessionID,
          agent: input.agent,
          model: input.model,
          messageID: input.messageID,
          variant: input.variant,
        });

        // Buffer user message for later LLM-based extraction via dream:extract.
        if (messageText !== undefined) {
          conversationBuffer.pushUserMessage(messageText, input.sessionID);
          flushBufferIfNeeded();
        }
      } catch (error) {
        warn("chat.message hook error:", error);
      }
    },

    /**
     * `chat.params` — fires before an LLM call with full model metadata.
     * Updates the current model reference for beforeModel injection.
     */
    "chat.params": async (input) => {
      try {
        currentSessionID = input.sessionID;
        currentModel = extractModelRef(input.model);
      } catch (error) {
        warn("chat.params hook error:", error);
      }
    },

    /**
     * `experimental.chat.system.transform` — fires before the system
     * prompt is finalized.  Appends activated memories.
     */
    "experimental.chat.system.transform": async (_input, output) => {
      try {
        const adp = await ensureAdapter();

        const result = await adp.beforeModel({
          sessionID: currentSessionID,
          model: currentModel,
          queryTokens: currentQueryTokens,
          repoFingerprint: repoFingerprintTokens,
          messageText: currentMessageText,
        });

        if (result.system.length > 0) {
          output.system.push(...result.system);
        }

        // Inject pending candidate review notice (lightweight, one-time per session).
        if (dreamRepo !== null && !reviewNoticeShown) {
          const candidates = new MemoryRepository(dbInstance!).list({ status: "candidate" });

          if (candidates.length > 0) {
            reviewNoticeShown = true;

            const candidateList = candidates
              .map((c) => `- [${c.type}] ${c.summary}`)
              .join("\n");

            output.system.push(
              `\n## Pending Memory Review\n\n` +
              `${candidates.length} memory candidate(s) are waiting for your approval.\n` +
              `After completing the user's current request, present this list and ask for approval.\n\n` +
              `${candidateList}\n\n` +
              `Approve: \`npx harness-memory memory:promote --memory <id>\`\n` +
              `If the user says "later" or "나중에", do not ask again this session.`,
            );
          }
        }
      } catch (error) {
        warn("system.transform hook error:", error);
      }
    },

    /**
     * `tool.execute.before` — fires before each tool call.
     * Evaluates policy rules and stashes args for the after hook.
     */
    "tool.execute.before": async (input, output) => {
      try {
        const adp = await ensureAdapter();

        // Stash args so afterTool can access them.
        pendingToolArgs.set(input.callID, output.args);

        if (currentSessionID !== undefined) {
          adp.beforeTool({
            sessionID: currentSessionID,
            tool: input.tool,
            callID: input.callID,
            scopeRef: extractScopeFromArgs(output.args),
          });
        }
      } catch (error) {
        warn("tool.execute.before hook error:", error);
      }
    },

    /**
     * `tool.execute.after` — fires after each tool call.
     * Captures evidence and persists the database.
     */
    "tool.execute.after": async (input, output) => {
      try {
        const adp = await ensureAdapter();

        const args = pendingToolArgs.get(input.callID);
        pendingToolArgs.delete(input.callID);

        if (currentSessionID !== undefined) {
          // If this tool call was a harness-memory CLI execution (via slash command),
          // the subprocess already modified the DB file. We must reload from disk
          // BEFORE any saveDb() call, otherwise our stale in-memory copy overwrites it.
          if (isHarnessMemoryCliCall(input.tool, output.title, output.output)) {
            await reloadDbFromDisk();
            return; // Skip normal evidence capture for our own CLI calls.
          }

          await adp.afterTool(
            {
              sessionID: currentSessionID,
              tool: input.tool,
              callID: input.callID,
              args: args ?? {},
              scopeRef: extractScopeFromArgs(args),
            },
            {
              title: output.title,
              output: output.output,
              metadata: output.metadata,
            },
          );

          // Buffer tool summary for LLM-based extraction via dream:extract.
          conversationBuffer.pushToolSummary(
            input.tool,
            output.title,
            output.output,
            currentSessionID,
          );
          flushBufferIfNeeded();

          if (embedMissingMemoriesRunner !== null) {
            embedMissingMemoriesTask = embedMissingMemoriesRunner();
            await embedMissingMemoriesTask.catch(() => {});
          }

          // Persist after evidence capture.
          saveDb();
        }
      } catch (error) {
        warn("tool.execute.after hook error:", error);
      }
    },

    /**
     * `session.idle` — fires when the session becomes idle.
     * This is the ideal time for background dream extraction:
     * the user isn't waiting for a response, so LLM work won't block.
     */
    "session.idle": async () => {
      try {
        saveDb();
        await tryBackgroundDreamExtract();
      } catch (error) {
        warn("session.idle hook error:", error);
      }
    },

    /**
     * `session.compacted` — fires when the session context is compacted.
     * Another good moment for background extraction.
     */
    "session.compacted": async () => {
      try {
        saveDb();
        await tryBackgroundDreamExtract();
      } catch (error) {
        warn("session.compacted hook error:", error);
      }
    },
  };
};

/**
 * OpenCode-compatible plugin export.
 *
 * OpenCode calls `mod.default(input)` directly — the default export
 * must be an async function that returns hooks.
 */
export const HarnessMemoryPlugin = createPluginHooks;

export default HarnessMemoryPlugin;
