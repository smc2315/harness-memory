/**
 * Extraction prompt builder (spec §5.4, §5.5 prompt rules). Pure: renders a closed episode and the
 * intersecting existing memories into one text with every ledger line numbered `e<seq>`, and
 * returns the `seqMap` the validator uses for V2. Hard cap EXTRACTION_LIMITS.prompt_chars.
 */

import type { EpisodeDescriptor } from "../../core/episode-types";
import { EXTRACTION_LIMITS } from "../../core/extraction-types";
import type { LedgerLine, ToolFailLine, ToolOkLine } from "../../core/ledger-types";
import type { Authority, Host, MemoryStatus, MemoryType } from "../../core/vocabulary";
import { renderContextRef } from "../episode";

export interface PromptMemory {
  id: string;
  type: MemoryType;
  status: MemoryStatus;
  authority: Authority;
  scopeGlob: string;
  signatureKey: string;
  summary: string;
}

export interface BuildExtractionPromptInput {
  descriptor: EpisodeDescriptor;
  /** Lines of the episode in ledger order (subagent lines are skipped). */
  lines: readonly LedgerLine[];
  /** Tool lines of the corrected episode; falls back to `descriptor.context_ref`. */
  contextLines?: readonly LedgerLine[] | null;
  /** Existing memories whose scope intersects the episode (≤ 40 are rendered). */
  existingMemories?: readonly PromptMemory[];
  host?: Host;
}

export interface BuiltExtractionPrompt {
  prompt: string;
  /** `e<seq>` → line, for every line that is actually rendered (dropped lines are not citable). */
  seqMap: Map<string, LedgerLine>;
  /** Lines removed to respect the character cap (oldest non-failure lines first). */
  droppedLines: number;
}

const SUMMARY_LINE_CHARS = 240;
const ASSISTANT_LINE_CHARS = 600;
const OUTPUT_CHARS = 1_200;
const LAST_ASSISTANT_CHARS = 2_000;
const MEMORY_SUMMARY_CHARS = 200;
const NON_ASCII_LETTER = /[^\u0000-\u007f]/;
const HANGUL = /[ᄀ-ᇿ㄰-㆏가-힯]/;

interface KeptLine {
  line: LedgerLine;
  protectedLine: boolean;
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

function block(text: string, max: number): string {
  const trimmed = text.trim();
  const clipped = trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
  return clipped
    .split(/\r?\n/)
    .map((row) => `    ${row}`)
    .join("\n");
}

function hasAgent(line: LedgerLine): boolean {
  return typeof line.agent_id === "string" && line.agent_id.length > 0;
}

function isProtected(line: LedgerLine): boolean {
  if (line.kind === "prompt" || line.kind === "tool_fail") return true;
  return line.kind === "tool_ok" && line.resolution_of !== null;
}

export function seqRef(line: Pick<LedgerLine, "seq">): string {
  return `e${line.seq}`;
}

function renderToolHeader(line: ToolOkLine | ToolFailLine): string {
  const dialect = line.shell_dialect === null ? "" : `(${line.shell_dialect})`;
  return `${line.tool}${dialect}`;
}

/** One rendered event: failures and resolutions in full, everything else on one summarized line. */
export function renderEventLine(line: LedgerLine): string {
  const ref = seqRef(line);
  switch (line.kind) {
    case "prompt":
      return `${ref} [prompt] correction=${line.correction} remember=${line.remember}\n${block(line.text, EXTRACTION_LIMITS.prompt_chars)}`;
    case "fired":
      return `${ref} [fired] tool=${line.tool} decision=${line.decision} enforcement=${line.enforcement ?? "none"} memories=${line.memory_ids.join(",") || "-"} target=${oneLine(line.target_digest, 120)}`;
    case "tool_fail": {
      const parts = [
        `${ref} [tool_fail] ${renderToolHeader(line)} class=${line.failure_class} sig=${line.failure_sig}`,
        `    input: ${oneLine(line.input_digest, 500)}`,
        `    error:\n${block(line.error, OUTPUT_CHARS)}`,
      ];
      if (line.output_head.trim().length > 0) parts.push(`    output_head:\n${block(line.output_head, OUTPUT_CHARS)}`);
      if (line.output_tail.trim().length > 0) parts.push(`    output_tail:\n${block(line.output_tail, OUTPUT_CHARS)}`);
      return parts.join("\n");
    }
    case "tool_ok": {
      if (line.resolution_of !== null) {
        const parts = [
          `${ref} [tool_ok] ${renderToolHeader(line)} resolves=${line.resolution_of}`,
          `    input: ${oneLine(line.input_digest, 500)}`,
        ];
        if (line.output_head.trim().length > 0) parts.push(`    output_head:\n${block(line.output_head, OUTPUT_CHARS)}`);
        if (line.output_tail.trim().length > 0) parts.push(`    output_tail:\n${block(line.output_tail, OUTPUT_CHARS)}`);
        return parts.join("\n");
      }
      const output = line.output_head.trim().length > 0 ? ` → ${oneLine(line.output_head, 160)}` : " → ok";
      return `${ref} [tool_ok] ${renderToolHeader(line)}: ${oneLine(line.input_digest, SUMMARY_LINE_CHARS)}${output}`;
    }
    case "assistant":
      return `${ref} [assistant] ${oneLine(line.text, ASSISTANT_LINE_CHARS)}`;
    case "marker":
      return `${ref} [marker] ${line.marker}${line.detail === undefined ? "" : ` ${oneLine(line.detail, 120)}`}`;
  }
}

function renderFlags(descriptor: EpisodeDescriptor): string {
  const flags = Object.entries(descriptor.flags)
    .filter(([, value]) => value === 1)
    .map(([key]) => key);
  return flags.length === 0 ? "none" : flags.join(", ");
}

function renderMemories(memories: readonly PromptMemory[]): string {
  if (memories.length === 0) return "(none)";
  return memories
    .map(
      (memory) =>
        `[M:${memory.id}] [${memory.type}] [${memory.status}/${memory.authority}] scope=${memory.scopeGlob} sig=${memory.signatureKey.length > 0 ? memory.signatureKey : "-"} — ${oneLine(memory.summary, MEMORY_SUMMARY_CHARS)}`
    )
    .join("\n");
}

function languageHint(descriptor: EpisodeDescriptor): string {
  const text = `${descriptor.prompt_text ?? ""}`;
  if (HANGUL.test(text)) return "The user wrote in Korean: include Korean aliases alongside English ones.";
  if (NON_ASCII_LETTER.test(text)) return "The user did not write in English: include aliases in the user's language alongside English ones.";
  return "";
}

const INSTRUCTIONS = `# Canonical tool vocabulary
bash, edit, write, read, grep, glob, fetch, task, mcp:<server>/<tool>, other. Bash and PowerShell calls are both "bash".
Command patterns use the canonical form: "npm|pnpm|yarn|bun [run] <script>" → "pm <script>", "npx|pnpm dlx|bunx <bin>" → "bin <bin>"; flags stay as tokens (e.g. "pm test", "git push --force", "bin vitest run").

# What to extract
Only knowledge that changes what a future turn should do in this repository. Every fact cites at least one e<seq> event that shows it; previous-turn context lines are not citable.
Types:
- pitfall: an action → consequence pair learned from a failure or a user correction, with a trigger_signature so it surfaces right before the same action.
- policy: a standing rule that spans tools or has no specific signature.
- workflow: a multi-step procedure that worked and will be needed again.
- architecture_constraint: a structural fact about the codebase that constrains changes.
- decision: an explicit decision ("we'll use X", "switch to Y").
Boundary rules:
- Knowledge that must surface right before a tool call gets a trigger_signature and lifecycle_triggers that include before_tool. The signature tool must be a tool used in this episode. pattern_kind: cmd for commands (canonical tokens, at least 2, e.g. "pm test"), glob for paths (e.g. "**/.env*"), substring (at least 8 chars) or regex (simple, no nested quantifiers).
- before_tool without a signature is allowed only for policy and pitfall. decision and architecture_constraint use session_start and/or before_model.
- scope_glob is the narrowest glob that is true (e.g. "src/db/**"). A command signature carries its own precision: when the command pattern names no path, use scope_glob "**/*". Without a signature, scope_glob must cover files touched in this episode; "**/*" without a signature is only for decision and architecture_constraint.
- knowledge_kind: correction (the user corrected the agent), failure_resolution (a tool failed and a later call fixed it), convention (an observed repository convention), decision.
- Same claim as an existing memory → action "reinforce" with its target_memory_id. Existing memory is wrong or outdated → "propose_supersede" (with the replacement as this fact) or "propose_stale"; you can never edit or delete memories.
- confidence = P(true AND lasting AND right scope). Omit facts below 0.6.
- Write summary and details in a normalized imperative voice ("Use pnpm test; npm test fails because ..."). Never use "from now on", "always do", "remember to" or other instruction-like phrasing, and do not copy the user's prompt verbatim.
- Never create facts about harness-memory itself, its CLI (hm ...) or memory ids.
- aliases: up to 8 short synonyms or keywords a user might type to recall this fact.
- nothing_to_learn: true with an empty facts array when the episode teaches nothing durable (routine read-only work, generic knowledge).

# Output
Return only JSON matching the provided schema: {"episode_summary": string (≤ 400 chars), "nothing_to_learn": boolean, "facts": [{"action", "target_memory_id", "type", "summary" (12–160 chars), "details" (≤ 1200), "scope_glob", "relevant_tools", "trigger_signature" | null, "lifecycle_triggers", "confidence", "evidence_refs": ["e<seq>"], "knowledge_kind", "rationale" (≤ 300), "aliases"}]}. No prose outside the JSON.`;

function render(
  descriptor: EpisodeDescriptor,
  host: Host,
  kept: readonly KeptLine[],
  contextText: string | null,
  memories: readonly PromptMemory[]
): string {
  const sections: string[] = [];
  sections.push(
    "You are the memory extractor of a project-memory layer for coding agents. You read ONE closed episode (a single user turn: the user's prompt, tool calls, failures and the assistant's last message) and return durable, reusable knowledge about THIS repository as JSON."
  );
  sections.push(
    [
      "# Episode",
      `host: ${host} | close_reason: ${descriptor.close_reason} | evidence_weight: ${descriptor.evidence_weight}`,
      `flags: ${renderFlags(descriptor)}`,
      `tools used: ${descriptor.tools.length === 0 ? "none" : descriptor.tools.join(", ")}`,
      `files touched: ${descriptor.scope_refs.length === 0 ? "none" : descriptor.scope_refs.join(", ")}`,
      `corrects a previous episode: ${descriptor.correction_for === null ? "no" : "yes"}`,
    ].join("\n")
  );
  if (contextText !== null) {
    sections.push(`# Previous turn (context only — NOT citable, no e<seq> ids)\n${contextText}`);
  }
  sections.push(
    `# Events (cite these ids in evidence_refs)\n${kept.length === 0 ? "(none)" : kept.map((entry) => renderEventLine(entry.line)).join("\n")}`
  );
  sections.push(
    `# Last assistant message\n${descriptor.last_assistant_message === null ? "(none)" : oneLine(descriptor.last_assistant_message, LAST_ASSISTANT_CHARS)}`
  );
  sections.push(`# Existing memories (scope intersects this episode)\n${renderMemories(memories)}`);
  const hint = languageHint(descriptor);
  sections.push(hint.length === 0 ? INSTRUCTIONS : `${INSTRUCTIONS}\n${hint}`);
  return sections.join("\n\n");
}

function toSeqMap(kept: readonly KeptLine[]): Map<string, LedgerLine> {
  const map = new Map<string, LedgerLine>();
  for (const entry of kept) map.set(seqRef(entry.line), entry.line);
  return map;
}

/**
 * Renders the prompt and the citable line map. When the text exceeds the cap, the oldest
 * non-failure lines are dropped first, then half of the existing memories, then the context block,
 * then the oldest failure/resolution lines (the prompt line last).
 */
export function buildExtractionPrompt(input: BuildExtractionPromptInput): BuiltExtractionPrompt {
  const host = input.host ?? input.descriptor.host;
  const kept: KeptLine[] = input.lines
    .filter((line) => !hasAgent(line))
    .map((line) => ({ line, protectedLine: isProtected(line) }));
  let memories = (input.existingMemories ?? []).slice(0, EXTRACTION_LIMITS.existing_memories);
  let contextText: string | null =
    input.contextLines !== undefined && input.contextLines !== null ? renderContextRef(input.contextLines) : input.descriptor.context_ref;
  let dropped = 0;

  for (;;) {
    const prompt = render(input.descriptor, host, kept, contextText, memories);
    if (prompt.length <= EXTRACTION_LIMITS.prompt_chars) {
      return { prompt, seqMap: toSeqMap(kept), droppedLines: dropped };
    }
    const unprotected = kept.findIndex((entry) => !entry.protectedLine);
    if (unprotected !== -1) {
      kept.splice(unprotected, 1);
      dropped += 1;
      continue;
    }
    if (memories.length > 0) {
      memories = memories.slice(0, Math.floor(memories.length / 2));
      continue;
    }
    if (contextText !== null) {
      contextText = null;
      continue;
    }
    const nonPrompt = kept.findIndex((entry) => entry.line.kind !== "prompt");
    if (nonPrompt !== -1) {
      kept.splice(nonPrompt, 1);
      dropped += 1;
      continue;
    }
    return { prompt: prompt.slice(0, EXTRACTION_LIMITS.prompt_chars), seqMap: toSeqMap(kept), droppedLines: dropped };
  }
}
