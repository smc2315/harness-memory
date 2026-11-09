/**
 * Reader for `logs/hooks.log` (one line per hook call, format in src/adapters/hook-io.ts):
 *   `<iso> <event> tool=<tool|-> gen=<n|-> activated=<n> suppressed=<n> decision=<d> delivery=<d> enforcement=<e|-> dur=<ms>ms <status>`
 * `doctor` reports the last call per event and the p95 duration (spec §9.4); debug JSON lines are skipped.
 */

import { closeSync, openSync, readSync, statSync } from "node:fs";

import { HOOK_EVENTS, type HookEvent } from "../../core/vocabulary";

export interface HookLogEntry {
  ts: string;
  event: HookEvent;
  tool: string | null;
  gen: number | null;
  activated: number;
  suppressed: number;
  decision: string;
  delivery: string;
  enforcement: string | null;
  durationMs: number;
  status: string;
}

const EVENT_WORDS = new Set<string>(HOOK_EVENTS);

export function parseHookLogLine(line: string): HookLogEntry | null {
  const trimmed = line.trim();
  if (trimmed.length === 0 || trimmed.startsWith("{")) return null;
  const parts = trimmed.split(/\s+/);
  if (parts.length < 11) return null;
  const [ts, event] = parts;
  if (ts === undefined || event === undefined || !EVENT_WORDS.has(event) || !Number.isFinite(Date.parse(ts))) return null;
  const fields = new Map<string, string>();
  for (const part of parts.slice(2, parts.length - 1)) {
    const eq = part.indexOf("=");
    if (eq > 0) fields.set(part.slice(0, eq), part.slice(eq + 1));
  }
  const dur = fields.get("dur");
  const durationMs = dur === undefined ? Number.NaN : Number(dur.replace(/ms$/, ""));
  if (!Number.isFinite(durationMs)) return null;
  const numeric = (key: string): number => {
    const value = Number(fields.get(key));
    return Number.isFinite(value) ? value : 0;
  };
  const dash = (value: string | undefined): string | null => (value === undefined || value === "-" ? null : value);
  const gen = fields.get("gen");
  return {
    ts,
    event: event as HookEvent,
    tool: dash(fields.get("tool")),
    gen: gen === undefined || gen === "-" ? null : Number(gen),
    activated: numeric("activated"),
    suppressed: numeric("suppressed"),
    decision: fields.get("decision") ?? "none",
    delivery: fields.get("delivery") ?? "none",
    enforcement: dash(fields.get("enforcement")),
    durationMs,
    status: parts[parts.length - 1]!,
  };
}

/** Reads at most `maxBytes` from the end of the file and parses the complete lines in it. */
export function readHookLogTail(file: string, maxBytes = 1024 * 1024): HookLogEntry[] {
  let size: number;
  try {
    size = statSync(file).size;
  } catch {
    return [];
  }
  if (size === 0) return [];
  const start = Math.max(0, size - maxBytes);
  const length = size - start;
  const buffer = Buffer.alloc(length);
  const fd = openSync(file, "r");
  try {
    readSync(fd, buffer, 0, length, start);
  } finally {
    closeSync(fd);
  }
  let text = buffer.toString("utf8");
  if (start > 0) {
    const firstNewline = text.indexOf("\n");
    text = firstNewline === -1 ? "" : text.slice(firstNewline + 1);
  }
  const entries: HookLogEntry[] = [];
  for (const line of text.split("\n")) {
    const entry = parseHookLogLine(line);
    if (entry !== null) entries.push(entry);
  }
  return entries;
}

/** Nearest-rank percentile (p in 0..100) or null for an empty sample. */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[rank]!;
}

export interface HookLogSummary {
  total: number;
  lastByEvent: Partial<Record<HookEvent, HookLogEntry>>;
  p95ByEvent: Partial<Record<HookEvent, number>>;
  /** p95 over `pre-tool` calls (the latency budget of spec §6.2); null when none were logged. */
  p95PreTool: number | null;
  /** p95 over every call when no pre-tool call exists yet. */
  p95All: number | null;
  errors: number;
  statuses: Record<string, number>;
}

export function summarizeHookLog(entries: readonly HookLogEntry[]): HookLogSummary {
  const lastByEvent: Partial<Record<HookEvent, HookLogEntry>> = {};
  const durations: Partial<Record<HookEvent, number[]>> = {};
  const statuses: Record<string, number> = {};
  let errors = 0;
  for (const entry of entries) {
    lastByEvent[entry.event] = entry;
    (durations[entry.event] ??= []).push(entry.durationMs);
    statuses[entry.status] = (statuses[entry.status] ?? 0) + 1;
    if (entry.status.startsWith("error:")) errors += 1;
  }
  const p95ByEvent: Partial<Record<HookEvent, number>> = {};
  for (const [event, values] of Object.entries(durations) as Array<[HookEvent, number[]]>) {
    const value = percentile(values, 95);
    if (value !== null) p95ByEvent[event] = value;
  }
  return {
    total: entries.length,
    lastByEvent,
    p95ByEvent,
    p95PreTool: p95ByEvent["pre-tool"] ?? null,
    p95All: percentile(
      entries.map((entry) => entry.durationMs),
      95
    ),
    errors,
    statuses,
  };
}
