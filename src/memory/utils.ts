import { createHash } from "crypto";

import type { LifecycleTrigger, MemoryType } from "../db/schema/types";
import {
  PATTERN_KINDS,
  SIGNATURE_TARGETS,
  type TriggerSignature,
} from "../core/vocabulary";

const LIFECYCLE_TRIGGER_ORDER: readonly LifecycleTrigger[] = [
  "session_start",
  "before_model",
  "before_tool",
  "after_tool",
];

const LIFECYCLE_TRIGGER_INDEX = new Map<LifecycleTrigger, number>(
  LIFECYCLE_TRIGGER_ORDER.map((trigger, index) => [trigger, index])
);

const LIFECYCLE_TRIGGER_SET = new Set<string>(LIFECYCLE_TRIGGER_ORDER);

export interface MemoryContentInput {
  summary: string;
  details: string;
}

export interface MemoryIdentityInput extends MemoryContentInput {
  type: MemoryType;
  scopeGlob: string;
  lifecycleTriggers: readonly LifecycleTrigger[];
}

function normalizeContentText(value: string): string {
  return value.replace(/\r\n/g, "\n");
}

function isLifecycleTrigger(value: string): value is LifecycleTrigger {
  return LIFECYCLE_TRIGGER_SET.has(value);
}

function formatUuidFromBytes(bytes: Uint8Array): string {
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

export function sortLifecycleTriggers(
  triggers: readonly LifecycleTrigger[]
): LifecycleTrigger[] {
  return Array.from(new Set(triggers)).sort((left, right) => {
    return LIFECYCLE_TRIGGER_INDEX.get(left)! - LIFECYCLE_TRIGGER_INDEX.get(right)!;
  });
}

export function serializeLifecycleTriggers(
  triggers: readonly LifecycleTrigger[]
): string {
  return JSON.stringify(sortLifecycleTriggers(triggers));
}

export function parseLifecycleTriggers(serialized: string): LifecycleTrigger[] {
  let parsed: unknown;

  try {
    parsed = JSON.parse(serialized);
  } catch (error) {
    throw new Error(`Invalid lifecycle_triggers JSON: ${String(error)}`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error("Invalid lifecycle_triggers JSON: expected an array");
  }

  const triggers: LifecycleTrigger[] = [];

  for (const value of parsed) {
    if (typeof value !== "string" || !isLifecycleTrigger(value)) {
      throw new Error(`Invalid lifecycle trigger value: ${String(value)}`);
    }

    triggers.push(value);
  }

  return sortLifecycleTriggers(triggers);
}

export function serializeRelevantTools(
  tools: readonly string[] | null
): string | null {
  if (tools === null || tools.length === 0) {
    return null;
  }

  return JSON.stringify([...new Set(tools)].sort());
}

export function parseRelevantTools(serialized: string | null): string[] | null {
  if (serialized === null) {
    return null;
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(serialized);
  } catch (error) {
    throw new Error(`Invalid relevant_tools_json JSON: ${String(error)}`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error("Invalid relevant_tools_json JSON: expected an array");
  }

  const tools: string[] = [];

  for (const value of parsed) {
    if (typeof value !== "string") {
      throw new Error(`Invalid relevant tool value: ${String(value)}`);
    }

    tools.push(value);
  }

  return [...new Set(tools)].sort();
}

export function createMemoryContentHash(input: MemoryContentInput): string {
  const normalized = JSON.stringify({
    summary: normalizeContentText(input.summary),
    details: normalizeContentText(input.details),
  });

  return createHash("sha256").update(normalized, "utf8").digest("hex");
}

export function createMemoryIdentityKey(input: MemoryIdentityInput): string {
  const normalized = JSON.stringify({
    type: input.type,
    summary: normalizeContentText(input.summary),
    details: normalizeContentText(input.details),
    scopeGlob: normalizeContentText(input.scopeGlob),
    lifecycleTriggers: sortLifecycleTriggers(input.lifecycleTriggers),
  });

  return createHash("sha256").update(normalized, "utf8").digest("hex");
}

export function createDeterministicId(seed: string): string {
  const digest = createHash("sha256").update(seed, "utf8").digest();
  const bytes = Uint8Array.from(digest.subarray(0, 16));

  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  return formatUuidFromBytes(bytes);
}

export function createMemoryId(contentHash: string): string {
  return createDeterministicId(`memory:${contentHash}`);
}

/**
 * Id of a row that revives a fact whose earlier rows are all terminal (rejected/superseded):
 * `memory:<identity_key>:<count of rows already carrying that identity_key>` (spec §5.7 step 4, R5).
 */
export function createRevivedMemoryId(identityKey: string, existingRowCount: number): string {
  return createDeterministicId(`memory:${identityKey}:${String(existingRowCount)}`);
}

/** Sorted, de-duplicated, trimmed, empty strings dropped. Always a JSON array (never null). */
export function serializeStringArray(values: readonly string[] | null | undefined): string {
  if (values === null || values === undefined) {
    return "[]";
  }

  const cleaned = values.map((value) => value.trim()).filter((value) => value.length > 0);

  return JSON.stringify([...new Set(cleaned)].sort());
}

export function parseStringArray(serialized: string | null, column: string): string[] {
  if (serialized === null || serialized === "") {
    return [];
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(serialized);
  } catch (error) {
    throw new Error(`Invalid ${column} JSON: ${String(error)}`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error(`Invalid ${column} JSON: expected an array`);
  }

  const values: string[] = [];

  for (const value of parsed) {
    if (typeof value !== "string") {
      throw new Error(`Invalid ${column} value: ${String(value)}`);
    }

    values.push(value);
  }

  return values;
}

export function serializeTriggerSignature(signature: TriggerSignature | null | undefined): string | null {
  if (signature === null || signature === undefined) {
    return null;
  }

  const normalized: TriggerSignature = {
    tool: signature.tool,
    target: signature.target,
    pattern_kind: signature.pattern_kind,
    pattern: signature.pattern,
  };

  if (signature.negate === true) {
    normalized.negate = true;
  }

  return JSON.stringify(normalized);
}

export function parseTriggerSignature(serialized: string | null): TriggerSignature | null {
  if (serialized === null || serialized === "") {
    return null;
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(serialized);
  } catch (error) {
    throw new Error(`Invalid trigger_signature_json: ${String(error)}`);
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Invalid trigger_signature_json: expected an object");
  }

  const record = parsed as Record<string, unknown>;
  const tool = record.tool;
  const target = record.target;
  const patternKind = record.pattern_kind;
  const pattern = record.pattern;

  if (typeof tool !== "string" || tool.length === 0) {
    throw new Error("Invalid trigger_signature_json: tool must be a non-empty string");
  }

  if (typeof target !== "string" || !(SIGNATURE_TARGETS as readonly string[]).includes(target)) {
    throw new Error(`Invalid trigger_signature_json: unknown target ${String(target)}`);
  }

  if (typeof patternKind !== "string" || !(PATTERN_KINDS as readonly string[]).includes(patternKind)) {
    throw new Error(`Invalid trigger_signature_json: unknown pattern_kind ${String(patternKind)}`);
  }

  if (typeof pattern !== "string" || pattern.length === 0) {
    throw new Error("Invalid trigger_signature_json: pattern must be a non-empty string");
  }

  const signature: TriggerSignature = {
    tool,
    target: target as TriggerSignature["target"],
    pattern_kind: patternKind as TriggerSignature["pattern_kind"],
    pattern,
  };

  if (record.negate === true) {
    signature.negate = true;
  }

  return signature;
}

/**
 * Fallback signature key when the caller did not pass the canonical one from
 * `activation/signature.ts` (`tool|target|kind|pattern`, `|!` appended for negated signatures).
 * Reconcile always passes the compiled key; this keeps manual/import rows consistent.
 */
export function fallbackSignatureKey(signature: TriggerSignature | null | undefined): string {
  if (signature === null || signature === undefined) {
    return "";
  }

  const pattern =
    signature.pattern_kind === "substring" ? signature.pattern.toLowerCase() : signature.pattern;
  const key = [signature.tool, signature.target, signature.pattern_kind, pattern].join("|");

  return signature.negate === true ? `${key}|!` : key;
}
