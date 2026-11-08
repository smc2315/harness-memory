/**
 * Ledger lines: serialization with field limits and credential redaction, tolerant parsing with byte
 * offsets, tail / range reads, and the per-turn state the hooks derive from the tail
 * (spec §5.1, §5.2, §6.2 step 4). No database access; the only I/O is the explicit file helpers.
 */

import { appendFileSync, closeSync, fstatSync, mkdirSync, openSync, readSync } from "node:fs";
import { dirname } from "node:path";

import {
  LEDGER_LIMITS,
  type LedgerLine,
  type ToolFailLine,
  type ToolOkLine,
} from "../core/ledger-types";
import { detectCorrection as detectCorrectionText, detectRemember, redactCredentials } from "../core/signals";
import type { FailureClass } from "../core/vocabulary";

export { detectRemember };

// ---------------------------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------------------------

const MARKER_DETAIL_CHARS = 500;
const TRIMMABLE_FIELDS = ["output_head", "output_tail", "text", "error", "input_digest", "detail"] as const;
const ARRAY_FIELDS = ["scope_refs", "memory_ids", "rule_codes", "signature_keys"] as const;
const MAX_ARRAY_ITEMS = 50;

function clip(value: string, max: number): string {
  if (max <= 0) return "";
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

function clean(value: unknown, max: number): string {
  const text = typeof value === "string" ? value : value === undefined || value === null ? "" : String(value);
  return clip(redactCredentials(text), max);
}

function prepareLine(line: LedgerLine): LedgerLine {
  switch (line.kind) {
    case "prompt":
      return { ...line, text: clean(line.text, LEDGER_LIMITS.prompt_text) };
    case "assistant":
      return { ...line, text: clean(line.text, LEDGER_LIMITS.assistant_text) };
    case "fired":
      return { ...line, target_digest: clean(line.target_digest, LEDGER_LIMITS.target_digest) };
    case "tool_ok":
      return {
        ...line,
        input_digest: clean(line.input_digest, LEDGER_LIMITS.input_digest),
        output_head: clean(line.output_head, LEDGER_LIMITS.output_head),
        output_tail: clean(line.output_tail, LEDGER_LIMITS.output_tail),
      };
    case "tool_fail":
      return {
        ...line,
        input_digest: clean(line.input_digest, LEDGER_LIMITS.input_digest),
        output_head: clean(line.output_head, LEDGER_LIMITS.output_head),
        output_tail: clean(line.output_tail, LEDGER_LIMITS.output_tail),
        error: clean(line.error, LEDGER_LIMITS.error_text),
      };
    case "marker":
      return line.detail === undefined ? line : { ...line, detail: clean(line.detail, MARKER_DETAIL_CHARS) };
  }
}

/**
 * JSON for one ledger line (no trailing newline): every text field is redacted and truncated to its
 * LEDGER_LIMITS cap, then the whole line is kept under `line_bytes` by halving the longest text field.
 */
export function serializeLine(line: LedgerLine): string {
  const record = prepareLine(line) as unknown as Record<string, unknown>;
  let json = JSON.stringify(record);
  if (Buffer.byteLength(json, "utf8") <= LEDGER_LIMITS.line_bytes) return json;

  for (let guard = 0; guard < 64; guard += 1) {
    let longestKey: string | null = null;
    let longestLength = 0;
    for (const key of TRIMMABLE_FIELDS) {
      const value = record[key];
      if (typeof value === "string" && value.length > longestLength) {
        longestKey = key;
        longestLength = value.length;
      }
    }
    if (longestKey === null || longestLength === 0) break;
    record[longestKey] = clip(record[longestKey] as string, Math.floor(longestLength / 2));
    json = JSON.stringify(record);
    if (Buffer.byteLength(json, "utf8") <= LEDGER_LIMITS.line_bytes) return json;
  }
  for (const key of ARRAY_FIELDS) {
    const value = record[key];
    if (Array.isArray(value) && value.length > MAX_ARRAY_ITEMS) record[key] = value.slice(0, MAX_ARRAY_ITEMS);
  }
  return JSON.stringify(record);
}

/** `mkdirSync` (recursive) + exactly one `appendFileSync`. Returns the number of bytes appended. */
export function appendLedgerLine(file: string, line: LedgerLine): number {
  const payload = `${serializeLine(line)}\n`;
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, payload, "utf8");
  return Buffer.byteLength(payload, "utf8");
}

// ---------------------------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------------------------

/** A parsed line with its byte position: `offset` is absolute, `length` includes the trailing newline when present. */
export type OffsetLedgerLine = LedgerLine & { offset: number; length: number };

export interface ParsedLedger {
  lines: OffsetLedgerLine[];
  /** Chunks that were not valid ledger JSON (torn first/last line, foreign content). */
  badLines: number;
}

const LINE_KINDS: ReadonlySet<string> = new Set(["prompt", "fired", "tool_ok", "tool_fail", "assistant", "marker"]);

export function isLedgerLine(value: unknown): value is LedgerLine {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.kind === "string" &&
    LINE_KINDS.has(record.kind) &&
    typeof record.seq === "number" &&
    typeof record.ts === "string" &&
    typeof record.turn_key === "string"
  );
}

/** Splits on `\n`, parses each chunk, and tolerates a torn first or last line (counted in `badLines`). */
export function parseLedger(input: Buffer | string, options: { baseOffset?: number } = {}): ParsedLedger {
  const buffer = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  const baseOffset = options.baseOffset ?? 0;
  const lines: OffsetLedgerLine[] = [];
  let badLines = 0;
  let start = 0;
  while (start < buffer.length) {
    const newline = buffer.indexOf(0x0a, start);
    const end = newline === -1 ? buffer.length : newline;
    const length = (newline === -1 ? end : end + 1) - start;
    const text = buffer.subarray(start, end).toString("utf8").replace(/\r$/, "");
    if (text.trim().length > 0) {
      let parsed: unknown;
      let ok = true;
      try {
        parsed = JSON.parse(text);
      } catch {
        ok = false;
      }
      if (ok && isLedgerLine(parsed)) {
        lines.push(Object.assign(parsed, { offset: baseOffset + start, length }));
      } else {
        badLines += 1;
      }
    }
    start += length;
  }
  return { lines, badLines };
}

// ---------------------------------------------------------------------------------------------
// File reads (openSync / readSync, never a full read)
// ---------------------------------------------------------------------------------------------

export interface LedgerBytes {
  bytes: Buffer;
  /** Absolute byte offset of `bytes[0]` in the file. */
  baseOffset: number;
  fileSize: number;
}

function openLedger(file: string): number | null {
  try {
    return openSync(file, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function readBetween(fd: number, start: number, end: number): Buffer {
  const length = Math.max(0, end - start);
  const buffer = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    const count = readSync(fd, buffer, read, length - read, start + read);
    if (count === 0) break;
    read += count;
  }
  return read === length ? buffer : buffer.subarray(0, read);
}

/** Last `maxBytes` of the ledger. A missing file yields an empty buffer and `fileSize 0`. */
export function readLedgerTail(file: string, maxBytes: number): LedgerBytes {
  const fd = openLedger(file);
  if (fd === null) return { bytes: Buffer.alloc(0), baseOffset: 0, fileSize: 0 };
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - Math.max(0, maxBytes));
    return { bytes: readBetween(fd, start, size), baseOffset: start, fileSize: size };
  } finally {
    closeSync(fd);
  }
}

/** Bytes `[start, end)` of the ledger, clamped to the file size. */
export function readLedgerRange(file: string, start: number, end: number): LedgerBytes {
  const fd = openLedger(file);
  if (fd === null) return { bytes: Buffer.alloc(0), baseOffset: 0, fileSize: 0 };
  try {
    const size = fstatSync(fd).size;
    const from = Math.min(Math.max(0, start), size);
    const to = Math.min(Math.max(from, end), size);
    return { bytes: readBetween(fd, from, to), baseOffset: from, fileSize: size };
  } finally {
    closeSync(fd);
  }
}

export type ParsedLedgerBytes = ParsedLedger & { baseOffset: number; fileSize: number };

export function readLedgerTailLines(file: string, maxBytes: number): ParsedLedgerBytes {
  const tail = readLedgerTail(file, maxBytes);
  return { ...parseLedger(tail.bytes, { baseOffset: tail.baseOffset }), baseOffset: tail.baseOffset, fileSize: tail.fileSize };
}

export function readLedgerRangeLines(file: string, start: number, end: number): ParsedLedgerBytes {
  const range = readLedgerRange(file, start, end);
  return { ...parseLedger(range.bytes, { baseOffset: range.baseOffset }), baseOffset: range.baseOffset, fileSize: range.fileSize };
}

// ---------------------------------------------------------------------------------------------
// Tail state (§6.2 step 4, §5.1 resolution detection)
// ---------------------------------------------------------------------------------------------

export interface TailState {
  /** `memory_id|tool` of every memory fired in the open turn (soft_deny / confirm once per turn). */
  firedKeys: Set<string>;
  /** `scope_refs[0]` of the newest tool_ok / tool_fail line in the tail. */
  lastScopeRef: string | null;
  /** Failures without a later success for the same `(tool, scope_ref | program token)`. */
  pendingFailures: Map<string, ToolFailLine>;
  /** True when any line lies at or after `turnStartOffset`. */
  openTurnHasLines: boolean;
}

type ToolLine = ToolOkLine | ToolFailLine;

/** `tool|scope_refs[0] ?? program_token` — the key a later success must share to resolve a failure. */
export function failureKeyOf(line: Pick<ToolLine, "tool" | "scope_refs" | "program_token">): string {
  return `${line.tool}|${line.scope_refs[0] ?? line.program_token ?? ""}`;
}

export function firedKey(memoryId: string, tool: string): string {
  return `${memoryId}|${tool}`;
}

export function deriveTailState(lines: readonly OffsetLedgerLine[], options: { turnStartOffset: number }): TailState {
  const firedKeys = new Set<string>();
  const pendingFailures = new Map<string, ToolFailLine>();
  let lastScopeRef: string | null = null;
  let openTurnHasLines = false;

  for (const line of lines) {
    const inTurn = line.offset >= options.turnStartOffset;
    if (inTurn) openTurnHasLines = true;
    switch (line.kind) {
      case "fired":
        if (inTurn) {
          for (const memoryId of line.memory_ids) firedKeys.add(firedKey(memoryId, line.tool));
        }
        break;
      case "tool_fail":
        if (line.scope_refs[0] !== undefined) lastScopeRef = line.scope_refs[0];
        pendingFailures.set(failureKeyOf(line), line);
        break;
      case "tool_ok":
        if (line.scope_refs[0] !== undefined) lastScopeRef = line.scope_refs[0];
        pendingFailures.delete(failureKeyOf(line));
        break;
      default:
        break;
    }
  }
  return { firedKeys, lastScopeRef, pendingFailures, openTurnHasLines };
}

// ---------------------------------------------------------------------------------------------
// Failure classes and signatures (§5.1)
// ---------------------------------------------------------------------------------------------

const EXIT_CODE_LINE = /^\s*exit\s+code[:\s]+(\d+)\b/i;
const ENOENT_TEXT =
  /\benoent\b|command not found|no such file or directory|is not recognized as (?:an internal or external command|the name of a cmdlet)|cannot find (?:path|module|the file)|file does not exist|not found\b/i;
const EACCES_TEXT = /\beacces\b|\beperm\b|permission denied|access is denied|operation not permitted/i;
const TIMEOUT_TEXT = /\betimedout\b|timed out|timeout/i;

/** `Exit code N` on the first line of a Claude Code PostToolUseFailure error, else null. */
export function parseExitCode(error: string | null | undefined): number | null {
  if (typeof error !== "string") return null;
  const firstLine = error.split(/\r?\n/, 1)[0] ?? "";
  const match = EXIT_CODE_LINE.exec(firstLine);
  if (match === null) return null;
  const code = Number(match[1]);
  return Number.isInteger(code) && code >= 0 ? code : null;
}

export interface ClassifyFailureInput {
  error?: string | null;
  exitCode?: number | null;
  isInterrupt?: boolean | null;
}

/**
 * Documented shapes first (`is_interrupt`, explicit exit code, first line `Exit code N`), then a
 * best-effort text table: ENOENT / command not found → enoent, EACCES → eacces, timed out → timeout, else other.
 */
export function classifyFailure(input: ClassifyFailureInput): FailureClass {
  if (input.isInterrupt === true) return "interrupt";
  if (typeof input.exitCode === "number" && Number.isInteger(input.exitCode) && input.exitCode >= 0) {
    return `exit_${input.exitCode}`;
  }
  const parsed = parseExitCode(input.error);
  if (parsed !== null) return `exit_${parsed}`;
  const text = input.error ?? "";
  if (ENOENT_TEXT.test(text)) return "enoent";
  if (EACCES_TEXT.test(text)) return "eacces";
  if (TIMEOUT_TEXT.test(text)) return "timeout";
  return "other";
}

/** `<tool>|<class>|<scope_ref | program token>` (§5.1). */
export function failureSignature(tool: string, cls: FailureClass, scopeRefOrProgram: string | null | undefined): string {
  return `${tool}|${cls}|${scopeRefOrProgram ?? ""}`;
}

/** The pending failure this success resolves (same tool and same scope_ref / program token), else null. */
export function detectResolution(pendingFailures: ReadonlyMap<string, ToolFailLine>, toolOkLine: Pick<ToolOkLine, "tool" | "scope_refs" | "program_token">): string | null {
  const pending = pendingFailures.get(failureKeyOf(toolOkLine));
  return pending === undefined ? null : pending.failure_sig;
}

export interface DetectCorrectionInput {
  /** Lines of the previous turn (any order of kinds; assistant/marker lines after the last tool line are skipped). */
  prevTurnLines: readonly LedgerLine[];
  text: string;
}

/** 1 when the previous turn's last tool_* line is a tool_fail, or the prompt matches the correction vocabulary. */
export function detectCorrection(input: DetectCorrectionInput): 0 | 1 {
  for (let i = input.prevTurnLines.length - 1; i >= 0; i -= 1) {
    const line = input.prevTurnLines[i]!;
    if (line.kind === "tool_fail") return 1;
    if (line.kind === "tool_ok") break;
  }
  return detectCorrectionText(input.text) ? 1 : 0;
}

// ---------------------------------------------------------------------------------------------
// Sequence numbers
// ---------------------------------------------------------------------------------------------

let lastSeq = 0;

/** Monotonic within a process: `Date.now() * 1000 + counter`, never repeating or going backwards. */
export function makeSeq(now: number = Date.now()): number {
  const base = now * 1000;
  lastSeq = base > lastSeq ? base : lastSeq + 1;
  return lastSeq;
}
