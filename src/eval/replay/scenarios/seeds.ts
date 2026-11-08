/**
 * Seed-row builders for the replay scenarios (rows that exist before the hooks run). Every row carries
 * the REQUIRED authority / sourceKind and an explicit id so fixtures and recorded outputs can name it.
 */

import { compileSignature } from "../../../activation/signature";
import type { TriggerSignature } from "../../../core/vocabulary";
import type { CreateMemoryInput } from "../../../memory/repository";

export function cmdSignature(pattern: string): TriggerSignature {
  return { tool: "bash", target: "command", pattern_kind: "cmd", pattern };
}

export function pathSignature(tool: string, pattern: string): TriggerSignature {
  return { tool, target: "path", pattern_kind: "glob", pattern };
}

/** Canonical signature key (A3's compiled form) so seeded rows look exactly like extracted ones. */
export function signatureKeyOf(signature: TriggerSignature): string {
  const compiled = compileSignature(signature);
  if (!compiled.ok) throw new Error(`seed signature rejected (${compiled.code}): ${compiled.detail}`);
  return compiled.compiled.signature_key;
}

export interface SeedOptions {
  id: string;
  summary: string;
  details?: string;
  scopeGlob?: string;
  signature?: TriggerSignature | null;
  lifecycleTriggers?: CreateMemoryInput["lifecycleTriggers"];
  enforcement?: CreateMemoryInput["enforcement"];
  knowledgeKind?: CreateMemoryInput["knowledgeKind"];
  status?: CreateMemoryInput["status"];
  confidence?: number;
  importance?: number;
  ttlExpiresAt?: string | null;
  createdAt?: string;
  aliases?: readonly string[];
  relevantTools?: readonly string[] | null;
  activationClass?: CreateMemoryInput["activationClass"];
  policySubtype?: CreateMemoryInput["policySubtype"];
}

function base(options: SeedOptions): Pick<CreateMemoryInput, "id" | "summary" | "details" | "scopeGlob" | "triggerSignature" | "signatureKey" | "aliases" | "relevantTools" | "activationClass" | "ttlExpiresAt" | "createdAt" | "updatedAt" | "confidence" | "importance"> {
  const signature = options.signature ?? null;
  return {
    id: options.id,
    summary: options.summary,
    details: options.details ?? `${options.summary} (seeded for the replay scenario).`,
    scopeGlob: options.scopeGlob ?? "**/*",
    triggerSignature: signature,
    signatureKey: signature === null ? "" : signatureKeyOf(signature),
    aliases: options.aliases ?? [],
    relevantTools: options.relevantTools ?? (signature === null ? null : [signature.tool.split("|")[0] ?? "bash"]),
    activationClass: options.activationClass ?? (signature !== null && signature.target === "command" ? "event" : "scoped"),
    ttlExpiresAt: options.ttlExpiresAt ?? null,
    ...(options.createdAt !== undefined ? { createdAt: options.createdAt, updatedAt: options.createdAt } : {}),
    confidence: options.confidence ?? 0.85,
    importance: options.importance ?? 0.7,
  };
}

/** An extraction-born auto row (active by default; `status: "candidate"` for a pending one). */
export function autoRow(options: SeedOptions & { type?: CreateMemoryInput["type"] }): CreateMemoryInput {
  return {
    ...base(options),
    type: options.type ?? "pitfall",
    lifecycleTriggers: options.lifecycleTriggers ?? ["before_tool"],
    status: options.status ?? "active",
    authority: "auto",
    sourceKind: "extraction",
    knowledgeKind: options.knowledgeKind ?? "correction",
    enforcement: options.enforcement ?? "soft_deny",
    promotionSource: "auto",
    sourceRef: "episode:seed",
  };
}

/** A human row (manual, no TTL). */
export function humanRow(options: SeedOptions & { type?: CreateMemoryInput["type"] }): CreateMemoryInput {
  return {
    ...base(options),
    type: options.type ?? "policy",
    lifecycleTriggers: options.lifecycleTriggers ?? ["before_tool", "before_model"],
    status: options.status ?? "active",
    authority: "human",
    sourceKind: "manual",
    knowledgeKind: options.knowledgeKind ?? "manual",
    enforcement: options.enforcement ?? "advise",
    policySubtype: options.policySubtype ?? null,
    promotionSource: "manual",
  };
}
