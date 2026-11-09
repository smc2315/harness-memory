/**
 * Builders and loaders for ledger-line tests (A3 modules). Fixtures live in test/fixtures/ledger
 * and test/fixtures/extraction; builders fill every required field so tests only state what matters.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import type {
  AssistantLine,
  FiredLine,
  LedgerLine,
  MarkerKind,
  MarkerLine,
  PromptLine,
  ToolFailLine,
  ToolOkLine,
} from "../../src/core/ledger-types";
import { failureSignature, parseLedger, serializeLine, type OffsetLedgerLine, type ParsedLedger } from "../../src/dream/ledger";

export const FIXTURES_DIR = fileURLToPath(new URL("../fixtures/", import.meta.url));

export function fixturePath(...parts: string[]): string {
  return join(FIXTURES_DIR, ...parts);
}

export function readFixture(...parts: string[]): string {
  return readFileSync(fixturePath(...parts), "utf8");
}

export function loadLedgerFixture(name: string): ParsedLedger & { raw: Buffer } {
  const raw = readFileSync(fixturePath("ledger", name));
  return { ...parseLedger(raw), raw };
}

export function loadExtractionFixture(name: string): string {
  return readFixture("extraction", name);
}

let seqCounter = 1;
const BASE_TS = Date.UTC(2026, 10, 8, 9, 0, 0);

function nextSeq(): number {
  seqCounter += 1;
  return seqCounter;
}

function tsFor(seq: number): string {
  return new Date(BASE_TS + seq * 1000).toISOString();
}

type Base = { ts?: string; seq?: number; turn_key?: string; agent_id?: string };

function base(overrides: Base): { ts: string; seq: number; turn_key: string; agent_id?: string } {
  const seq = overrides.seq ?? nextSeq();
  return {
    ts: overrides.ts ?? tsFor(seq),
    seq,
    turn_key: overrides.turn_key ?? "t1",
    ...(overrides.agent_id !== undefined ? { agent_id: overrides.agent_id } : {}),
  };
}

export function promptLine(text: string, overrides: Partial<PromptLine> = {}): PromptLine {
  return {
    kind: "prompt",
    ...base(overrides),
    text,
    correction: overrides.correction ?? 0,
    remember: overrides.remember ?? 0,
    ...(overrides.prompt_id !== undefined ? { prompt_id: overrides.prompt_id } : {}),
  };
}

export function toolOkLine(inputDigest: string, overrides: Partial<ToolOkLine> = {}): ToolOkLine {
  return {
    kind: "tool_ok",
    ...base(overrides),
    tool_use_id: overrides.tool_use_id ?? null,
    tool: overrides.tool ?? "bash",
    host_tool: overrides.host_tool ?? "Bash",
    shell_dialect: overrides.shell_dialect === undefined ? "bash" : overrides.shell_dialect,
    input_digest: inputDigest,
    scope_refs: overrides.scope_refs ?? [],
    program_token: overrides.program_token ?? null,
    output_head: overrides.output_head ?? "",
    output_tail: overrides.output_tail ?? "",
    resolution_of: overrides.resolution_of ?? null,
  };
}

export function toolFailLine(inputDigest: string, error: string, overrides: Partial<ToolFailLine> = {}): ToolFailLine {
  const tool = overrides.tool ?? "bash";
  const scopeRefs = overrides.scope_refs ?? [];
  const programToken = overrides.program_token ?? null;
  const failureClass = overrides.failure_class ?? "other";
  return {
    kind: "tool_fail",
    ...base(overrides),
    tool_use_id: overrides.tool_use_id ?? null,
    tool,
    host_tool: overrides.host_tool ?? "Bash",
    shell_dialect: overrides.shell_dialect === undefined ? "bash" : overrides.shell_dialect,
    input_digest: inputDigest,
    scope_refs: scopeRefs,
    program_token: programToken,
    output_head: overrides.output_head ?? "",
    output_tail: overrides.output_tail ?? "",
    error,
    is_interrupt: overrides.is_interrupt ?? false,
    exit_code: overrides.exit_code === undefined ? null : overrides.exit_code,
    failure_class: failureClass,
    failure_sig: overrides.failure_sig ?? failureSignature(tool, failureClass, scopeRefs[0] ?? programToken),
  };
}

export function firedLine(memoryIds: string[], overrides: Partial<FiredLine> = {}): FiredLine {
  return {
    kind: "fired",
    ...base(overrides),
    memory_ids: memoryIds,
    rule_codes: overrides.rule_codes ?? [],
    tool: overrides.tool ?? "bash",
    target_digest: overrides.target_digest ?? "",
    delivery: overrides.delivery ?? "before",
    decision: overrides.decision ?? "deny",
    enforcement: overrides.enforcement === undefined ? "soft_deny" : overrides.enforcement,
    ...(overrides.signature_keys !== undefined ? { signature_keys: overrides.signature_keys } : {}),
  };
}

export function assistantLine(text: string, overrides: Partial<AssistantLine> = {}): AssistantLine {
  return {
    kind: "assistant",
    ...base(overrides),
    text,
    ...(overrides.stop_hook_active !== undefined ? { stop_hook_active: overrides.stop_hook_active } : {}),
  };
}

export function markerLine(marker: MarkerKind, overrides: Partial<MarkerLine> = {}): MarkerLine {
  return {
    kind: "marker",
    ...base(overrides),
    marker,
    ...(overrides.detail !== undefined ? { detail: overrides.detail } : {}),
  };
}

/** Assigns byte offsets as if the lines had been appended in order starting at `start`. */
export function withOffsets(lines: readonly LedgerLine[], start = 0): OffsetLedgerLine[] {
  let offset = start;
  return lines.map((line) => {
    const length = Buffer.byteLength(serializeLine(line), "utf8") + 1;
    const result = Object.assign({ ...line }, { offset, length }) as OffsetLedgerLine;
    offset += length;
    return result;
  });
}

/** `e<seq>` map over the given lines, as the prompt builder would produce for a full render. */
export function seqMapOf(lines: readonly LedgerLine[]): Map<string, LedgerLine> {
  return new Map(lines.map((line) => [`e${line.seq}`, line]));
}
