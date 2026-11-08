/**
 * Text rendering shared by the memory commands: one-line rows for tables, the full detail block of
 * `memory:show`, and a JSON projection of `MemoryRecord` without the Float32Array embeddings.
 */

import type { ProposalRecord } from "../../db/repositories/proposals";
import type { TriggerSignature } from "../../core/vocabulary";
import type { MemoryRecord } from "../../memory/repository";
import { renderTable } from "./output";
import { shortId } from "./lookup";

export type MemoryJson = Omit<MemoryRecord, "embedding" | "embeddingSummary"> & {
  embedding: { dims: number } | null;
  embeddingSummary: { dims: number } | null;
};

export function memoryToJson(memory: MemoryRecord): MemoryJson {
  const { embedding, embeddingSummary, ...rest } = memory;
  return {
    ...rest,
    embedding: embedding === null ? null : { dims: embedding.length },
    embeddingSummary: embeddingSummary === null ? null : { dims: embeddingSummary.length },
  };
}

/** `tool:target:kind:pattern` (`!` prefix when negated), `-` when the row has no signature. */
export function formatSignature(signature: TriggerSignature | null): string {
  if (signature === null) return "-";
  return `${signature.negate === true ? "!" : ""}${signature.tool}:${signature.target}:${signature.pattern_kind}:${signature.pattern}`;
}

/** One line, at most `max` characters, `…` when cut. */
export function clip(text: string | null | undefined, max: number): string {
  if (text === null || text === undefined) return "";
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, Math.max(0, max - 1))}…`;
}

export const MEMORY_TABLE_HEADER: readonly string[] = ["ID", "STATUS", "AUTH", "TYPE", "ENF", "SCOPE", "SUMMARY"];

export function memoryTableRow(memory: MemoryRecord, summaryChars = 64): string[] {
  const flags: string[] = [];
  if (memory.importUnconfirmed === 1) flags.push("unconfirmed");
  if (memory.contested === 1) flags.push("contested");
  if (memory.needsScope === 1) flags.push("needs_scope");
  const status = memory.statusReason !== null && memory.statusReason !== "human" && memory.status !== "active" ? `${memory.status}(${memory.statusReason})` : memory.status;
  return [
    shortId(memory.id),
    status,
    memory.authority,
    memory.type,
    memory.enforcement,
    clip(memory.scopeGlob, 24),
    `${clip(memory.summary, summaryChars)}${flags.length > 0 ? ` [${flags.join(",")}]` : ""}`,
  ];
}

export function renderMemoryTable(memories: readonly MemoryRecord[], summaryChars = 64): string[] {
  if (memories.length === 0) return ["no memories match"];
  return renderTable(
    memories.map((memory) => memoryTableRow(memory, summaryChars)),
    MEMORY_TABLE_HEADER
  );
}

/** `<id8> <status>/<authority> <type> <enforcement> <scope> — <summary>` */
export function memoryLine(memory: MemoryRecord, summaryChars = 80): string {
  return `${shortId(memory.id)} ${memory.status}/${memory.authority} ${memory.type} ${memory.enforcement} ${clip(memory.scopeGlob, 30)} — ${clip(memory.summary, summaryChars)}`;
}

function field(label: string, value: string | number | null | undefined): string {
  const text = value === null || value === undefined || value === "" ? "-" : String(value);
  return `  ${label.padEnd(18)} ${text}`;
}

export function renderMemoryDetail(memory: MemoryRecord, extras: { proposals?: readonly ProposalRecord[] } = {}): string[] {
  const lines: string[] = [
    `memory ${memory.id}`,
    field("status", `${memory.status}${memory.statusReason === null ? "" : ` (${memory.statusReason})`}`),
    field("authority", `${memory.authority} / ${memory.sourceKind}${memory.sourceRef === null ? "" : ` (${memory.sourceRef})`}`),
    field("type", `${memory.type}${memory.knowledgeKind === null ? "" : ` / ${memory.knowledgeKind}`}${memory.policySubtype === null ? "" : ` / ${memory.policySubtype}`}`),
    field("enforcement", memory.enforcement),
    field("scope", `${memory.scopeGlob} (${memory.activationClass})`),
    field("triggers", memory.lifecycleTriggers.join(", ")),
    field("signature", formatSignature(memory.triggerSignature)),
    field("relevant_tools", memory.relevantTools === null ? null : memory.relevantTools.join(", ")),
    field("confidence", `${memory.confidence.toFixed(2)} (importance ${memory.importance.toFixed(2)}, validations ${String(memory.validationCount)})`),
    field("evidence", `score ${String(memory.evidenceScore)}, episodes ${String(memory.evidenceCount)}, sessions ${String(memory.distinctSessionCount)}`),
    field("fires", `${String(memory.fireCount)} (overrides ${String(memory.overrideCount)}${memory.lastFiredAt === null ? "" : `, last ${memory.lastFiredAt}`})`),
    field("ttl", memory.ttlExpiresAt === null ? "none" : `${memory.ttlExpiresAt}${memory.revalidateAfter === null ? "" : ` (revalidate after ${memory.revalidateAfter})`}`),
    field("created", memory.createdAt),
    field("updated", memory.updatedAt),
    field("verified", memory.lastVerifiedAt),
  ];
  const flags: string[] = [];
  if (memory.contested === 1) flags.push("contested");
  if (memory.needsScope === 1) flags.push("needs_scope");
  if (memory.importUnconfirmed === 1) flags.push("import_unconfirmed");
  if (memory.openProposalId !== null) flags.push(`open_proposal ${shortId(memory.openProposalId)}`);
  if (memory.supersedesMemoryId !== null) flags.push(`supersedes ${shortId(memory.supersedesMemoryId)}`);
  if (memory.supersededByMemoryId !== null) flags.push(`superseded_by ${shortId(memory.supersededByMemoryId)}`);
  lines.push(field("flags", flags.length === 0 ? "none" : flags.join(", ")));
  if (memory.aliases.length > 0) lines.push(field("aliases", memory.aliases.join(", ")));
  if (memory.failureClasses.length > 0) lines.push(field("failure_classes", memory.failureClasses.join(", ")));
  if (memory.embedding !== null) lines.push(field("embedding", `${String(memory.embedding.length)} dims`));
  lines.push("", `  ${memory.summary}`);
  if (memory.details.trim().length > 0) {
    lines.push("");
    for (const detail of memory.details.split(/\r?\n/)) lines.push(`  ${detail}`);
  }
  if (extras.proposals !== undefined && extras.proposals.length > 0) {
    lines.push("", "  proposals:");
    for (const proposal of extras.proposals) {
      lines.push(`    ${shortId(proposal.id)} ${proposal.kind} ${proposal.status} support ${String(proposal.supportCount)}/${String(proposal.supportSessions)} expires ${proposal.expiresAt}`);
    }
  }
  return lines;
}
