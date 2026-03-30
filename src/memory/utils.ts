import { createHash } from "crypto";

import type { LifecycleTrigger, MemoryType } from "../db/schema/types";

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
