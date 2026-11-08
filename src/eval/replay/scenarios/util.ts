/** Small helpers shared by the scenario bodies. */

import type { HookCall } from "../types";

export const DAY_MS = 24 * 60 * 60 * 1000;

export function isoPlus(iso: string, offset: { days?: number; hours?: number; minutes?: number; seconds?: number }): string {
  const ms = (offset.days ?? 0) * DAY_MS + (offset.hours ?? 0) * 3_600_000 + (offset.minutes ?? 0) * 60_000 + (offset.seconds ?? 0) * 1000;
  return new Date(Date.parse(iso) + ms).toISOString();
}

/** Suppression kinds the hook reported for a pre-tool call (`detail.suppressed` = [{id, kind, reason}]). */
export function suppressionKinds(call: HookCall): string[] {
  const list = call.result?.detail.suppressed;
  if (!Array.isArray(list)) return [];
  return list.map((entry) => (typeof entry === "object" && entry !== null && "kind" in entry ? String((entry as { kind: unknown }).kind) : "?"));
}

export function suppressionKindOf(call: HookCall, memoryId: string): string | null {
  const list = call.result?.detail.suppressed;
  if (!Array.isArray(list)) return null;
  for (const entry of list) {
    if (typeof entry === "object" && entry !== null && (entry as { id?: unknown }).id === memoryId) return String((entry as { kind: unknown }).kind);
  }
  return null;
}

export function utf8Bytes(text: string | null | undefined): number {
  return text === null || text === undefined ? 0 : Buffer.byteLength(text, "utf8");
}
