/**
 * Deterministic per-episode recall summary (A′ recall layer, `episodes.summary_kind = 'derived'`).
 *
 * The worker builds one for every session episode it inserts, from the queue descriptor and the episode's
 * ledger lines, so recall works for episodes the extractor never summarizes (ineligible / skipped, waiting for
 * a provider, dead, or an extraction whose output carried no `episode_summary`). The extractor's summary
 * replaces it ('extracted') when one arrives and the content scanner clears it. Import episodes (one per
 * CLAUDE.md / auto-memory bullet) get none: `EpisodeRepository.setSummary` refuses `host = 'import'`. Pure:
 * no I/O, no clock, no randomness — the same descriptor and lines always give the same string. Only redacted
 * material goes in (ledger text is redacted before it is written, descriptor fields are derived from it); no
 * new raw text source is read here.
 *
 *   "<prompt ≤ 160 chars>" [correction] | failed exit_1 pm test → resolved | tools bash×3 edit×1 | files src/a.ts, +2
 */

import { stripControlCharacters } from "../activation/injection";
import type { EpisodeDescriptor, FailureSignatureEntry } from "../core/episode-types";
import type { LedgerLine } from "../core/ledger-types";
import { EPISODE_SUMMARY_MAX_CHARS, normalizeEpisodeSummary } from "../db/repositories/episodes";

export const RECALL_SUMMARY_MAX_CHARS = EPISODE_SUMMARY_MAX_CHARS;
export const RECALL_PROMPT_CHARS = 160;
export const RECALL_SCOPE_REFS = 3;
export const RECALL_FAILURES = 3;
export const RECALL_TOOLS = 6;

const PART_SEPARATOR = " | ";

export type RecallSummaryInput = Pick<EpisodeDescriptor, "host" | "tools" | "failure_signatures" | "scope_refs" | "flags"> & {
  prompt_text?: string | null;
};

function oneLine(text: string, max: number): string {
  const flat = stripControlCharacters(text).replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, Math.max(0, max - 1))}…`;
}

function hasAgent(line: LedgerLine): boolean {
  return typeof line.agent_id === "string" && line.agent_id.length > 0;
}

function promptPart(descriptor: RecallSummaryInput, lines: readonly LedgerLine[]): string | null {
  let text = descriptor.prompt_text ?? null;
  if (text === null) {
    const line = lines.find((entry) => entry.kind === "prompt");
    if (line !== undefined && line.kind === "prompt") text = line.text;
  }
  if (text === null) return null;
  const flat = oneLine(text, RECALL_PROMPT_CHARS);
  if (flat.length === 0) return null;
  return descriptor.host === "import" ? `import: "${flat}"` : `"${flat}"`;
}

function flagTags(flags: RecallSummaryInput["flags"]): string {
  const tags: string[] = [];
  if (flags.correction === 1) tags.push("correction");
  if (flags.remember === 1) tags.push("remember");
  if (flags.decision === 1) tags.push("decision");
  return tags.length === 0 ? "" : ` [${tags.join(", ")}]`;
}

/** `exit_1 pm test → resolved`: one entry per (class, program token | scope ref | tool), resolved wins over an open twin. */
function failurePart(failures: readonly FailureSignatureEntry[]): string | null {
  if (failures.length === 0) return null;
  const byKey = new Map<string, { label: string; resolved: boolean }>();
  for (const entry of failures) {
    const token = entry.program_token ?? entry.scope_ref ?? entry.tool;
    const label = `${entry.class} ${oneLine(token, 40)}`;
    const resolved = entry.resolved_seq !== null;
    const existing = byKey.get(label);
    if (existing === undefined) byKey.set(label, { label, resolved });
    else if (resolved) existing.resolved = true;
  }
  const entries = [...byKey.values()];
  const shown = entries.slice(0, RECALL_FAILURES).map((entry) => `${entry.label} → ${entry.resolved ? "resolved" : "unresolved"}`);
  const more = entries.length - shown.length;
  return `failed ${shown.join("; ")}${more > 0 ? `; +${String(more)} more` : ""}`;
}

/** `tools bash×3 edit×1` from the tool lines; the descriptor's tool set (no counts) when no lines were given. */
function toolPart(descriptor: RecallSummaryInput, lines: readonly LedgerLine[]): string | null {
  const counts = new Map<string, number>();
  for (const line of lines) {
    if (hasAgent(line)) continue;
    if (line.kind !== "tool_ok" && line.kind !== "tool_fail") continue;
    counts.set(line.tool, (counts.get(line.tool) ?? 0) + 1);
  }
  let rendered: string[];
  let total: number;
  if (counts.size > 0) {
    const sorted = [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
    total = sorted.length;
    rendered = sorted.slice(0, RECALL_TOOLS).map(([tool, count]) => `${tool}×${String(count)}`);
  } else {
    const tools = [...new Set(descriptor.tools)].sort((left, right) => left.localeCompare(right));
    if (tools.length === 0) return null;
    total = tools.length;
    rendered = tools.slice(0, RECALL_TOOLS);
  }
  const more = total - rendered.length;
  return `tools ${rendered.join(" ")}${more > 0 ? ` +${String(more)}` : ""}`;
}

function filePart(scopeRefs: readonly string[]): string | null {
  const refs = [...new Set(scopeRefs.map((ref) => ref.trim()).filter((ref) => ref.length > 0))];
  if (refs.length === 0) return null;
  const shown = refs.slice(0, RECALL_SCOPE_REFS).map((ref) => oneLine(ref, 80));
  const more = refs.length - shown.length;
  return `files ${shown.join(", ")}${more > 0 ? `, +${String(more)}` : ""}`;
}

/**
 * Builds the derived summary (≤ 400 chars, one line, deterministic). `lines` are the episode's ledger lines
 * when the caller has them (tool counts, prompt text for rows whose descriptor lost it); an empty list falls
 * back to the descriptor alone.
 */
export function buildRecallSummary(descriptor: RecallSummaryInput, lines: readonly LedgerLine[] = []): string {
  const parts: string[] = [];
  const prompt = promptPart(descriptor, lines);
  const tags = flagTags(descriptor.flags);
  if (prompt !== null) parts.push(`${prompt}${tags}`);
  else if (tags.length > 0) parts.push(`(no prompt)${tags}`);
  const failures = failurePart(descriptor.failure_signatures);
  if (failures !== null) parts.push(failures);
  const tools = toolPart(descriptor, lines);
  if (tools !== null) parts.push(tools);
  const files = filePart(descriptor.scope_refs);
  if (files !== null) parts.push(files);
  if (parts.length === 0) parts.push("(empty episode)");
  return normalizeRecallSummary(parts.join(PART_SEPARATOR));
}

/**
 * Storage-boundary normalization shared by both summary kinds: one line, control characters removed, ≤ 400
 * chars. The same function the repository applies in `setSummary`; reconcile runs it before the content scan
 * so what is scanned is what gets stored.
 */
export function normalizeRecallSummary(summary: string): string {
  return normalizeEpisodeSummary(summary);
}
