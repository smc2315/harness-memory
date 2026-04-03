/**
 * LLM-based memory extraction via OpenCode SDK.
 *
 * Uses `@opencode-ai/sdk` to programmatically call the LLM through
 * OpenCode's server, avoiding subprocess spawning and shell escaping.
 *
 * The LLM receives conversation batches + existing memory context and
 * returns structured JSON with extraction actions (create/reinforce/
 * supersede/stale).
 */

import type { MemoryRecord, MemoryRepository, CreateMemoryInput } from "../memory";
import type { DreamEvidenceEventRecord } from "./types";
import type {
  DreamExtractionResult,
  DreamExtractedFact,
  DreamExtractionAction,
} from "./types";

// ---------------------------------------------------------------------------
// Extraction prompt builder
// ---------------------------------------------------------------------------

export const EXTRACTION_SYSTEM_PROMPT = `You are a memory extraction assistant for a coding project.
Your ONLY job is to analyze conversation logs and output a JSON object.
All summaries and details MUST be written in English, regardless of the input language.
If the conversation is in another language, translate the key facts to English.
Do NOT use any tools. Do NOT run any commands.
Respond with ONLY a valid JSON object — no markdown, no explanation.`;

/**
 * Build the user prompt for LLM extraction.
 *
 * @public Exported for testing.
 */
export function buildExtractionUserPrompt(
  batches: readonly DreamEvidenceEventRecord[],
  existingMemories: Array<{ id: string; type: string; summary: string; status: string }>,
): string {
  const conversationText = batches
    .map((batch) => batch.excerpt)
    .join("\n---\n");

  const memoryList =
    existingMemories.length > 0
      ? existingMemories
          .map((m) => `- [${m.id}] [${m.type}] [${m.status}] ${m.summary}`)
          .join("\n")
      : "(none)";

  return `## Task
Analyze the conversation below and extract facts worth remembering long-term.

## What to extract
- User preferences (coding style, UI style, tooling choices)
- Architecture decisions (patterns, frameworks, deployment targets)
- Project constraints (what NOT to use, requirements)
- Recurring workflows or conventions

IMPORTANT: All output text (summary, details) MUST be in English. If the conversation contains non-English text, translate the facts to English.

## What to IGNORE
- One-off commands ("check this file", "run tests")
- Temporary information (branch names, one-time errors already fixed)
- Discarded hypotheses ("maybe X... actually no")
- Information already covered by existing memories
- Greetings, acknowledgments, casual chat

## Actions
For each fact, choose one action:
- "create" — new fact, not covered by any existing memory
- "reinforce" — confirms an existing memory (provide targetMemoryId)
- "supersede" — replaces an existing memory with updated info (provide targetMemoryId)
- "stale" — an existing memory is no longer valid (provide targetMemoryId)

## Existing memories (for dedup and lifecycle)
${memoryList}

## Conversation to analyze
${conversationText}

## Output format
Respond with ONLY this JSON (no markdown, no \`\`\`):
{
  "facts": [
    {
      "action": "create",
      "type": "policy",
      "summary": "one-line summary",
      "details": "detailed explanation",
      "confidence": 0.85
    },
    {
      "action": "reinforce",
      "targetMemoryId": "mem_xxx",
      "summary": "confirmed: ...",
      "details": "...",
      "confidence": 0.9
    }
  ]
}

If nothing is worth remembering, respond: {"facts": []}`;
}

// ---------------------------------------------------------------------------
// Response parser
// ---------------------------------------------------------------------------

const VALID_ACTIONS = new Set<DreamExtractionAction>(["create", "reinforce", "supersede", "stale"]);
const VALID_TYPES = new Set(["policy", "workflow", "pitfall", "architecture_constraint", "decision"]);

/**
 * Parse the LLM response text into structured extraction results.
 * Handles markdown-wrapped JSON and partial/malformed responses.
 *
 * @public Exported for testing.
 */
export function parseExtractionResponse(responseText: string): DreamExtractionResult {
  // Strip markdown code fences if present
  let cleaned = responseText.trim();

  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
  }

  // Find JSON object boundaries
  const jsonStart = cleaned.indexOf("{");
  const jsonEnd = cleaned.lastIndexOf("}");

  if (jsonStart === -1 || jsonEnd === -1) {
    return { facts: [] };
  }

  cleaned = cleaned.slice(jsonStart, jsonEnd + 1);

  let parsed: unknown;

  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return { facts: [] };
  }

  if (parsed === null || typeof parsed !== "object") {
    return { facts: [] };
  }

  const raw = parsed as Record<string, unknown>;

  if (!Array.isArray(raw.facts)) {
    return { facts: [] };
  }

  const facts: DreamExtractedFact[] = [];

  for (const item of raw.facts) {
    if (item === null || typeof item !== "object") {
      continue;
    }

    const fact = item as Record<string, unknown>;

    if (typeof fact.action !== "string" || !VALID_ACTIONS.has(fact.action as DreamExtractionAction)) {
      continue;
    }

    if (typeof fact.summary !== "string" || fact.summary.length === 0) {
      continue;
    }

    const extracted: DreamExtractedFact = {
      action: fact.action as DreamExtractionAction,
      summary: fact.summary,
      details: typeof fact.details === "string" ? fact.details : fact.summary,
    };

    if (typeof fact.type === "string" && VALID_TYPES.has(fact.type)) {
      extracted.type = fact.type as DreamExtractedFact["type"];
    }

    if (typeof fact.targetMemoryId === "string" && fact.targetMemoryId.length > 0) {
      extracted.targetMemoryId = fact.targetMemoryId;
    }

    if (typeof fact.confidence === "number" && fact.confidence >= 0 && fact.confidence <= 1) {
      extracted.confidence = fact.confidence;
    }

    facts.push(extracted);
  }

  return { facts };
}

// ---------------------------------------------------------------------------
// SDK-based LLM call
// ---------------------------------------------------------------------------

/**
 * Call the LLM via OpenCode SDK and extract memories.
 *
 * Creates a temporary OpenCode server, sends the extraction prompt,
 * parses the structured response, and shuts down.
 */
export async function callLlmForExtraction(
  batches: readonly DreamEvidenceEventRecord[],
  existingMemories: Array<{ id: string; type: string; summary: string; status: string }>,
): Promise<DreamExtractionResult> {
  // Dynamic import to handle cases where SDK is not available
  const { createOpencode } = await import("@opencode-ai/sdk");
  const { client, server } = await createOpencode();

  try {
    // Create a dedicated session for extraction
    const session = await client.session.create({
      body: { title: "harness-memory dream:extract" },
    });

    if (session.error !== undefined) {
      throw new Error(`Failed to create session: ${JSON.stringify(session.error)}`);
    }

    const sessionId = session.data.id;
    const userPrompt = buildExtractionUserPrompt(batches, existingMemories);

    // Send extraction prompt with custom system instructions
    const response = await client.session.prompt({
      path: { id: sessionId },
      body: {
        system: EXTRACTION_SYSTEM_PROMPT,
        parts: [{ type: "text", text: userPrompt }],
        // Disable all tools — we want pure text/JSON output
        tools: {},
        noReply: false,
      },
    });

    if (response.error !== undefined) {
      throw new Error(`LLM prompt failed: ${JSON.stringify(response.error)}`);
    }

    // Extract text from response parts
    const responseText = response.data.parts
      .filter((p) => p !== null && typeof p === "object" && "type" in p && p.type === "text")
      .map((p) => {
        const part = p as Record<string, unknown>;
        return typeof part.text === "string" ? part.text : "";
      })
      .join("\n");

    // Clean up the session
    await client.session.delete({ path: { id: sessionId } }).catch(() => {
      // Non-critical — session cleanup failure is OK
    });

    return parseExtractionResponse(responseText);
  } finally {
    server.close();
  }
}

// ---------------------------------------------------------------------------
// Action handlers
// ---------------------------------------------------------------------------

export interface ActionHandlerDeps {
  memoryRepository: MemoryRepository;
  embeddingService?: {
    embedPassage(text: string): Promise<Float32Array>;
  };
  cosineSimilarity?: (a: Float32Array, b: Float32Array) => number;
}

export interface ActionResult {
  action: DreamExtractionAction;
  memoryId: string;
  summary: string;
  skipped: boolean;
  reason?: string;
}

const DEDUP_THRESHOLD = 0.85;

/**
 * Execute extraction actions against the memory repository.
 *
 * - create → check embedding dedup → create as candidate
 * - reinforce → bump confidence on existing memory
 * - supersede → mark old as superseded, create new as candidate
 * - stale → mark existing as stale
 */
export async function executeExtractionActions(
  facts: readonly DreamExtractedFact[],
  deps: ActionHandlerDeps,
): Promise<ActionResult[]> {
  const results: ActionResult[] = [];

  for (const fact of facts) {
    switch (fact.action) {
      case "create": {
        // Embedding-based dedup check
        if (deps.embeddingService !== undefined && deps.cosineSimilarity !== undefined) {
          const existingMemories = deps.memoryRepository.list({});
          const memoriesWithEmbeddings = existingMemories.filter(
            (m) => m.embedding !== null && (m.status === "active" || m.status === "candidate"),
          );

          if (memoriesWithEmbeddings.length > 0) {
            try {
              const newEmbedding = await deps.embeddingService.embedPassage(
                `${fact.summary} ${fact.details}`,
              );

              let maxSim = 0;
              let similarSummary = "";

              for (const existing of memoriesWithEmbeddings) {
                if (existing.embedding === null) continue;
                const sim = deps.cosineSimilarity(newEmbedding, existing.embedding);
                if (sim > maxSim) {
                  maxSim = sim;
                  similarSummary = existing.summary;
                }
              }

              if (maxSim > DEDUP_THRESHOLD) {
                results.push({
                  action: "create",
                  memoryId: "",
                  summary: fact.summary,
                  skipped: true,
                  reason: `Duplicate (similarity=${maxSim.toFixed(3)}, "${similarSummary}")`,
                });
                continue;
              }
            } catch {
              // Embedding not available — proceed without dedup
            }
          }
        }

        const memory = deps.memoryRepository.create({
          type: fact.type ?? "workflow",
          summary: fact.summary,
          details: fact.details,
          scopeGlob: "**/*",
          lifecycleTriggers: ["before_model"],
          status: "candidate",
          activationClass: "scoped",
          confidence: fact.confidence ?? 0.7,
          importance: 0.7,
        });

        results.push({
          action: "create",
          memoryId: memory.id,
          summary: fact.summary,
          skipped: false,
        });
        break;
      }

      case "reinforce": {
        if (fact.targetMemoryId === undefined) {
          results.push({
            action: "reinforce",
            memoryId: "",
            summary: fact.summary,
            skipped: true,
            reason: "No targetMemoryId provided",
          });
          continue;
        }

        const existing = deps.memoryRepository.getById(fact.targetMemoryId);

        if (existing === null) {
          results.push({
            action: "reinforce",
            memoryId: fact.targetMemoryId,
            summary: fact.summary,
            skipped: true,
            reason: `Memory ${fact.targetMemoryId} not found`,
          });
          continue;
        }

        const newConfidence = Math.min(0.99, existing.confidence + 0.05);
        deps.memoryRepository.update(fact.targetMemoryId, {
          confidence: newConfidence,
          lastVerifiedAt: new Date().toISOString(),
        });

        results.push({
          action: "reinforce",
          memoryId: fact.targetMemoryId,
          summary: `Reinforced: ${existing.summary} (confidence ${existing.confidence.toFixed(2)} → ${newConfidence.toFixed(2)})`,
          skipped: false,
        });
        break;
      }

      case "supersede": {
        if (fact.targetMemoryId === undefined) {
          results.push({
            action: "supersede",
            memoryId: "",
            summary: fact.summary,
            skipped: true,
            reason: "No targetMemoryId provided",
          });
          continue;
        }

        const oldMemory = deps.memoryRepository.getById(fact.targetMemoryId);

        if (oldMemory === null) {
          results.push({
            action: "supersede",
            memoryId: fact.targetMemoryId,
            summary: fact.summary,
            skipped: true,
            reason: `Memory ${fact.targetMemoryId} not found`,
          });
          continue;
        }

        // Mark old as superseded
        deps.memoryRepository.update(fact.targetMemoryId, {
          status: "superseded",
        });

        // Create replacement as candidate
        const replacement = deps.memoryRepository.create({
          type: fact.type ?? oldMemory.type,
          summary: fact.summary,
          details: fact.details,
          scopeGlob: oldMemory.scopeGlob,
          lifecycleTriggers: oldMemory.lifecycleTriggers,
          status: "candidate",
          activationClass: oldMemory.activationClass,
          confidence: fact.confidence ?? oldMemory.confidence,
          importance: oldMemory.importance,
          supersedesMemoryId: fact.targetMemoryId,
        });

        results.push({
          action: "supersede",
          memoryId: replacement.id,
          summary: `Superseded ${fact.targetMemoryId} → ${replacement.id}: ${fact.summary}`,
          skipped: false,
        });
        break;
      }

      case "stale": {
        if (fact.targetMemoryId === undefined) {
          results.push({
            action: "stale",
            memoryId: "",
            summary: fact.summary,
            skipped: true,
            reason: "No targetMemoryId provided",
          });
          continue;
        }

        const target = deps.memoryRepository.getById(fact.targetMemoryId);

        if (target === null) {
          results.push({
            action: "stale",
            memoryId: fact.targetMemoryId,
            summary: fact.summary,
            skipped: true,
            reason: `Memory ${fact.targetMemoryId} not found`,
          });
          continue;
        }

        deps.memoryRepository.update(fact.targetMemoryId, {
          status: "stale",
        });

        results.push({
          action: "stale",
          memoryId: fact.targetMemoryId,
          summary: `Marked stale: ${target.summary}`,
          skipped: false,
        });
        break;
      }
    }
  }

  return results;
}
