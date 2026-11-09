/**
 * Replay fixtures (test/fixtures/replay): ledger files `sNN-<slug>.jsonl` (what the hooks recorded for a
 * turn) paired with recorded extractor outputs `sNN.outputs.json` keyed `<session>/<turn_key>`.
 *
 * Recorded outputs cite events by the FIXTURE seq (`e1001`); the harness translates them to the seqs the
 * hooks actually produced. `target_memory_id` may be a placeholder `$created:<session>/<turn_key>[#n]`
 * naming a row an earlier extract step created (seeded rows carry explicit ids and need none).
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import type { ExtractionFact, ExtractionOutput } from "../../core/extraction-types";
import type { LedgerLine } from "../../core/ledger-types";
import { parseLedger, type OffsetLedgerLine } from "../../dream/ledger";

export const REPLAY_FIXTURES_RELATIVE = join("test", "fixtures", "replay");

export type RecordedOutput = ExtractionOutput | string;
export type RecordedOutputs = Record<string, RecordedOutput>;

/** `--fixtures` wins; else `<packageRoot>/test/fixtures/replay`; else `<cwd>/test/fixtures/replay`. */
export function resolveFixturesDir(options: { explicit?: string | null; packageRoot?: string | null; cwd?: string }): string {
  if (options.explicit !== undefined && options.explicit !== null && options.explicit.length > 0) return resolve(options.cwd ?? process.cwd(), options.explicit);
  const candidates: string[] = [];
  if (options.packageRoot !== undefined && options.packageRoot !== null) candidates.push(join(options.packageRoot, REPLAY_FIXTURES_RELATIVE));
  candidates.push(join(options.cwd ?? process.cwd(), REPLAY_FIXTURES_RELATIVE));
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return candidates[candidates.length - 1]!;
}

export interface LoadedLedgerFixture {
  name: string;
  path: string;
  raw: Buffer;
  lines: OffsetLedgerLine[];
  badLines: number;
}

export function loadLedgerFixture(fixturesDir: string, name: string): LoadedLedgerFixture {
  const path = join(fixturesDir, name);
  const raw = readFileSync(path);
  const parsed = parseLedger(raw);
  return { name, path, raw, lines: parsed.lines, badLines: parsed.badLines };
}

/** Lines of one turn (fixture files may hold several turns; `turn_key` separates them). */
export function turnLines(lines: readonly LedgerLine[], turnKey: string): LedgerLine[] {
  return lines.filter((line) => line.turn_key === turnKey);
}

export function turnKeysOf(lines: readonly LedgerLine[]): string[] {
  const keys: string[] = [];
  for (const line of lines) {
    if (line.turn_key.length > 0 && !keys.includes(line.turn_key)) keys.push(line.turn_key);
  }
  return keys;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function loadRecordedOutputs(fixturesDir: string, name: string): RecordedOutputs {
  const path = join(fixturesDir, name);
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord(parsed)) throw new Error(`${path}: expected an object keyed by <session>/<turn_key>`);
  const outputs: RecordedOutputs = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === "string") {
      outputs[key] = value;
    } else if (isRecord(value) && Array.isArray(value.facts)) {
      outputs[key] = value as unknown as ExtractionOutput;
    } else {
      throw new Error(`${path}: entry ${key} is neither a raw string nor an extraction output`);
    }
  }
  return outputs;
}

export const CREATED_PLACEHOLDER = /^\$created:([^#]+)(?:#(\d+))?$/;

export interface MaterializeOptions {
  /**
   * fixture seq → the event id the extraction prompt rendered for the hook-produced line (null when the
   * fixture line has no counterpart; the ref is then left as cited, so V2 rejects it).
   */
  refOf: (fixtureSeq: number) => string | null;
  /** `<session>/<turn_key>` → memory ids created by earlier extract steps, in creation order. */
  created: ReadonlyMap<string, readonly string[]>;
}

/** Resolves `$created:` placeholders and translates `e<seq>` refs; raw strings pass through untouched. */
export function materializeOutput(output: RecordedOutput, options: MaterializeOptions): RecordedOutput {
  if (typeof output === "string") return output;
  const facts: ExtractionFact[] = output.facts.map((fact) => ({
    ...fact,
    target_memory_id: resolvePlaceholder(fact.target_memory_id, options.created),
    evidence_refs: fact.evidence_refs.map((ref) => translateRef(ref, options.refOf)),
    aliases: [...fact.aliases],
    relevant_tools: [...fact.relevant_tools],
    lifecycle_triggers: [...fact.lifecycle_triggers],
    trigger_signature: fact.trigger_signature === null ? null : { ...fact.trigger_signature },
  }));
  return { ...output, facts };
}

export function resolvePlaceholder(value: string | null, created: ReadonlyMap<string, readonly string[]>): string | null {
  if (value === null) return null;
  const match = CREATED_PLACEHOLDER.exec(value);
  if (match === null) return value;
  const ids = created.get(match[1]!);
  const index = match[2] === undefined ? 0 : Number(match[2]);
  const id = ids?.[index];
  if (id === undefined) throw new Error(`placeholder ${value} names a memory no extract step created`);
  return id;
}

export function translateRef(ref: string, refOf: (fixtureSeq: number) => string | null): string {
  const match = /^e(\d+)$/.exec(ref);
  if (match === null) return ref;
  return refOf(Number(match[1])) ?? ref;
}

/** Composes the two maps a replayed turn yields: fixture seq → produced seq → rendered event id. */
export function refResolver(seqMap: ReadonlyMap<number, number>, refMap: ReadonlyMap<number, string>): (fixtureSeq: number) => string | null {
  return (fixtureSeq) => {
    const produced = seqMap.get(fixtureSeq);
    if (produced === undefined) return null;
    return refMap.get(produced) ?? null;
  };
}
