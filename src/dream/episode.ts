/**
 * Episode descriptor builder: turns the ledger lines of one turn segment into the queue file the
 * worker inserts into `episodes` (spec §3.4, §5.2, §5.3, §9.3 B). Pure: no I/O, no database.
 */

import { matchSignatureKey } from "../activation/signature";
import {
  EPISODE_SCHEMA,
  computeEvidenceWeight,
  type EpisodeDescriptor,
  type EpisodeFlags,
  type FailureSignatureEntry,
  type FiredEntry,
} from "../core/episode-types";
import { episodeId } from "../core/ids";
import type { AssistantLine, FiredLine, LedgerLine, PromptLine, ToolFailLine, ToolOkLine } from "../core/ledger-types";
import { detectCorrection as detectCorrectionText, detectDecisionMarker, detectRemember } from "../core/signals";
import type { CanonicalTool, CloseReason, FiredOutcome, Host } from "../core/vocabulary";
import { failureKeyOf } from "./ledger";

export const MAX_EPISODE_SCOPE_REFS = 50;
export const CONTEXT_REF_LINES = 12;
const CONTEXT_FIELD_CHARS = 200;

export interface BuildEpisodeInput {
  host: Host;
  sessionId: string;
  sessionKey: string;
  turnKey: string;
  segment: number;
  /** Lines of the segment in ledger order (offsets optional). */
  lines: readonly LedgerLine[];
  byteStart: number;
  byteEnd: number;
  /** Basename of the ledger file (`<host>-<session_key>.jsonl`). */
  ledgerFileName: string;
  closeReason: CloseReason;
  /** ISO timestamp of the close. */
  now: string;
  correctionFor?: string | null;
  /** Tool lines of the corrected episode, rendered into `context_ref` (never citable). */
  contextLines?: readonly LedgerLine[] | null;
  /** Pre-rendered context (import / replay); wins over `contextLines`. */
  contextRef?: string | null;
  /** Overrides the `ledger/<file>#<start>-<end>` reference (`import:<path>`). */
  ledgerRef?: string;
  /** Subagent lines (`agent_id`) are excluded by default (§3.4). */
  includeAgentLines?: boolean;
}

type ToolLine = ToolOkLine | ToolFailLine;

function isToolLine(line: LedgerLine): line is ToolLine {
  return line.kind === "tool_ok" || line.kind === "tool_fail";
}

function hasAgent(line: LedgerLine): boolean {
  return typeof line.agent_id === "string" && line.agent_id.length > 0;
}

function entryKey(entry: FailureSignatureEntry): string {
  return `${entry.tool}|${entry.scope_ref ?? entry.program_token ?? ""}`;
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/**
 * §9.3 B outcome of a `fired` line: only `soft_deny` lines can be overridden. The next tool_* line
 * decides: same tool and a matching signature → `override` when it is a tool_ok (a matching tool_fail
 * means the warning was right, `none`); any other tool call in between → `heed`; no tool call → `none`.
 */
export function classifyFiredOutcome(lines: readonly LedgerLine[], firedIndex: number): FiredOutcome {
  const fired = lines[firedIndex];
  if (fired === undefined || fired.kind !== "fired") return "none";
  if (fired.enforcement !== "soft_deny") return "none";
  for (let j = firedIndex + 1; j < lines.length; j += 1) {
    const line = lines[j]!;
    if (!isToolLine(line)) continue;
    if (line.tool !== fired.tool) return "heed";
    const keys = fired.signature_keys ?? [];
    const matches =
      keys.length === 0 ||
      keys.some(
        (key) =>
          matchSignatureKey(key, line.input_digest, line.shell_dialect) ||
          (line.scope_refs[0] !== undefined && matchSignatureKey(key, line.scope_refs[0], line.shell_dialect))
      );
    if (!matches) return "heed";
    return line.kind === "tool_ok" ? "override" : "none";
  }
  return "none";
}

/** Last ≤ 12 tool lines of an episode, one per line, for the corrected episode's context (never citable). */
export function renderContextRef(lines: readonly LedgerLine[]): string | null {
  const toolLines = lines.filter(isToolLine).slice(-CONTEXT_REF_LINES);
  if (toolLines.length === 0) return null;
  return toolLines
    .map((line) => {
      const dialect = line.shell_dialect === null ? "" : `(${line.shell_dialect})`;
      let text = `(prev) ${line.kind} ${line.tool}${dialect}: ${oneLine(line.input_digest, CONTEXT_FIELD_CHARS)}`;
      if (line.kind === "tool_fail") {
        text += ` — ${line.failure_class}: ${oneLine(line.error, CONTEXT_FIELD_CHARS)}`;
      } else if (line.resolution_of !== null) {
        text += ` — resolves ${line.resolution_of}`;
      }
      return text;
    })
    .join("\n");
}

export function buildEpisodeDescriptor(input: BuildEpisodeInput): EpisodeDescriptor {
  const lines = input.includeAgentLines === true ? [...input.lines] : input.lines.filter((line) => !hasAgent(line));
  const id = episodeId(input.host, input.sessionId, input.turnKey, input.segment);

  const promptLine = lines.find((line): line is PromptLine => line.kind === "prompt");
  const assistantLines = lines.filter((line): line is AssistantLine => line.kind === "assistant");
  const lastAssistant = assistantLines.length > 0 ? assistantLines[assistantLines.length - 1]!.text : null;

  const scopeRefs: string[] = [];
  const seenRefs = new Set<string>();
  const tools = new Set<CanonicalTool>();
  const failures: FailureSignatureEntry[] = [];

  for (const line of lines) {
    if (line.kind === "fired") {
      tools.add(line.tool);
      continue;
    }
    if (!isToolLine(line)) continue;
    tools.add(line.tool);
    for (const ref of line.scope_refs) {
      if (seenRefs.has(ref) || scopeRefs.length >= MAX_EPISODE_SCOPE_REFS) continue;
      seenRefs.add(ref);
      scopeRefs.push(ref);
    }
    if (line.kind === "tool_fail") {
      const open = failures.find((entry) => entry.sig === line.failure_sig && entry.resolved_seq === null);
      if (open === undefined) {
        failures.push({
          sig: line.failure_sig,
          class: line.failure_class,
          tool: line.tool,
          scope_ref: line.scope_refs[0] ?? null,
          program_token: line.program_token,
          failed_seq: line.seq,
          resolved_seq: null,
        });
      }
    } else {
      const key = failureKeyOf(line);
      for (const entry of failures) {
        if (entry.resolved_seq !== null) continue;
        if ((line.resolution_of !== null && line.resolution_of === entry.sig) || entryKey(entry) === key) {
          entry.resolved_seq = line.seq;
        }
      }
    }
  }

  const correctionFor = input.correctionFor ?? null;
  const flags: EpisodeFlags = {};
  if (promptLine?.correction === 1 || correctionFor !== null || (promptLine !== undefined && detectCorrectionText(promptLine.text))) {
    flags.correction = 1;
  }
  if (promptLine?.remember === 1 || (promptLine !== undefined && detectRemember(promptLine.text))) flags.remember = 1;
  if (lastAssistant !== null && detectDecisionMarker(lastAssistant)) flags.decision = 1;
  if (failures.length > 0) flags.failure = 1;
  if (failures.some((entry) => entry.resolved_seq !== null)) flags.resolution = 1;

  const fired: FiredEntry[] = [];
  lines.forEach((line, index) => {
    if (line.kind !== "fired") return;
    const outcome = classifyFiredOutcome(lines, index);
    for (const memoryId of (line as FiredLine).memory_ids) {
      fired.push({ memory_id: memoryId, enforcement: line.enforcement ?? "advise", outcome, tool: line.tool });
    }
  });

  const contextRef =
    input.contextRef !== undefined && input.contextRef !== null
      ? input.contextRef
      : correctionFor !== null && input.contextLines !== undefined && input.contextLines !== null
        ? renderContextRef(input.contextLines)
        : null;

  return {
    schema: EPISODE_SCHEMA,
    id,
    host: input.host,
    session_id: input.sessionId,
    session_key: input.sessionKey,
    turn_key: input.turnKey,
    segment: input.segment,
    started_at: lines[0]?.ts ?? input.now,
    closed_at: input.now,
    close_reason: input.closeReason,
    ledger_ref: input.ledgerRef ?? `ledger/${input.ledgerFileName}#${input.byteStart}-${input.byteEnd}`,
    correction_for: correctionFor,
    context_ref: contextRef,
    scope_refs: scopeRefs,
    tools: [...tools],
    failure_signatures: failures,
    flags,
    fired,
    evidence_weight: computeEvidenceWeight(flags, failures),
    event_count: lines.length,
    prompt_text: promptLine?.text ?? null,
    last_assistant_message: lastAssistant,
  };
}

export type EligibilityReason = "evidence" | "decision" | "import" | "no_signal";

/** §5.3: `evidence_weight ≥ 1` or a decision marker in the last assistant message; import episodes always qualify. */
export function isEligibleForExtraction(descriptor: Pick<EpisodeDescriptor, "host" | "evidence_weight" | "flags">): {
  eligible: boolean;
  reason: EligibilityReason;
} {
  if (descriptor.host === "import") return { eligible: true, reason: "import" };
  if (descriptor.evidence_weight >= 1) return { eligible: true, reason: "evidence" };
  if (descriptor.flags.decision === 1) return { eligible: true, reason: "decision" };
  return { eligible: false, reason: "no_signal" };
}
