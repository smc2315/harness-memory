/**
 * Trigger-signature matcher shared by the writers (compile at reconcile / snapshot time) and the
 * hooks (match precompiled signatures from the snapshot). Spec §4.6 (canonical command grammar),
 * §5.6 V5 (regex safety) and V10 (specificity).
 *
 * Pure module: no database, no file I/O. `minimatch` is loaded lazily through `createRequire` so
 * the hook bundle, which only calls `matchSignature` on precompiled regex sources, never pays for it.
 * The canonical form of a command is memoized per (text, dialect) (`canonicalCommandFor`) because one
 * hook call matches every `cmd` signature and rule against the same target.
 */

import { createRequire } from "node:module";

import type { CompiledSignature } from "../core/snapshot-types";
import {
  PATTERN_KINDS,
  SIGNATURE_TARGETS,
  type PatternKind,
  type ShellDialect,
  type SignatureTarget,
  type TriggerSignature,
} from "../core/vocabulary";

// ---------------------------------------------------------------------------------------------
// Canonical command grammar (§4.6)
// ---------------------------------------------------------------------------------------------

export interface CanonicalCommand {
  /** Canonical tokens per command segment (split on `&&`, `||`, `;`, `|`, newline). */
  segments: string[][];
  /** Literal program per segment (`npm`, `pnpm dlx`, `npx`, `git`): what was actually invoked, kept beside the folded tokens so a cmd pattern can pin one package manager (§4.6). */
  literals: string[];
  /** One entry per segment: the program token, or `pm <script>` / `bin <name>` for folded package-manager calls (§5.1). */
  programTokens: string[];
  /** Segments joined with `; ` — the serialized canonical form used in signature keys. */
  canonical: string;
}

const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun"]);
const BIN_RUNNERS = new Set(["npx", "bunx"]);
const RUN_SUBCOMMANDS = new Set(["run", "run-script"]);
const BIN_SUBCOMMANDS: Readonly<Record<string, ReadonlySet<string>>> = {
  npm: new Set(["exec", "x"]),
  pnpm: new Set(["dlx", "exec"]),
  yarn: new Set(["dlx"]),
  bun: new Set(["x"]),
};
const SCRIPT_ALIASES: Readonly<Record<string, string>> = {
  t: "test",
  tst: "test",
  i: "install",
  in: "install",
  ins: "install",
  inst: "install",
  insta: "install",
  instal: "install",
  isnt: "install",
  isnta: "install",
  isntal: "install",
  isntall: "install",
};
/** npx / pnpm dlx / bunx flags that take a value. */
const BIN_VALUE_FLAGS = new Set(["-p", "--package", "-c", "--call"]);
/** Real wrappers that are stripped, with the flags of each that take a value. */
const WRAPPERS: Readonly<Record<string, ReadonlySet<string>>> = {
  sudo: new Set(["-u", "-g", "-h", "-p", "-C", "-D", "-r", "-t", "-T", "-U"]),
  time: new Set(["-f", "-o"]),
  env: new Set(["-C", "-u", "-S", "-P"]),
  nice: new Set(["-n"]),
  command: new Set(),
  exec: new Set(["-a"]),
};
const ASSIGNMENT_PREFIX = /^[A-Za-z_][A-Za-z0-9_]*=/;
const LAUNCHER_EXTENSION = /\.(exe|cmd|bat)$/i;
const SHELL_NAVIGATION = new Set(["cd", "pushd", "popd", "export", "set", "source", "."]);

type QuoteChar = '"' | "'" | "`";

/**
 * Quote-aware split into segments of raw tokens. Bash/unknown: backslash escapes, `$( … )` kept
 * inside a token, `(`/`)` subshell boundaries split segments, `&` is the background operator
 * (not inside `2>&1` / `&>`). PowerShell: backtick escapes, leading `&` call operator dropped,
 * parentheses kept. cmd: `^` escapes, `&` separates.
 */
function tokenizeShell(command: string, dialect: ShellDialect): string[][] {
  const segments: string[][] = [];
  let tokens: string[] = [];
  let current = "";
  let hasCurrent = false;
  let quote: QuoteChar | null = null;
  let substitutionDepth = 0;
  const isPowerShell = dialect === "powershell";
  const isCmd = dialect === "cmd";
  const escapeChar = isPowerShell ? "`" : isCmd ? "^" : "\\";

  const flushToken = (): void => {
    if (hasCurrent) {
      tokens.push(current);
      current = "";
      hasCurrent = false;
    }
  };
  const flushSegment = (): void => {
    flushToken();
    if (tokens.length > 0) segments.push(tokens);
    tokens = [];
  };

  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i]!;
    const next = command[i + 1];

    if (quote !== null) {
      if (ch === quote) {
        quote = null;
        continue;
      }
      if (quote === '"' && ch === escapeChar && next !== undefined && !isCmd) {
        current += next;
        hasCurrent = true;
        i += 1;
        continue;
      }
      current += ch;
      hasCurrent = true;
      continue;
    }

    if (ch === escapeChar && next !== undefined) {
      i += 1;
      if (next === "\n" || next === "\r") continue; // line continuation
      current += next;
      hasCurrent = true;
      continue;
    }

    if (ch === '"' || ch === "'" || (ch === "`" && !isPowerShell)) {
      quote = ch;
      hasCurrent = true;
      continue;
    }

    if (!isPowerShell && !isCmd && ch === "$" && next === "(") {
      substitutionDepth += 1;
      current += "$(";
      hasCurrent = true;
      i += 1;
      continue;
    }
    if (substitutionDepth > 0) {
      if (ch === "(") substitutionDepth += 1;
      else if (ch === ")") substitutionDepth -= 1;
      current += ch;
      continue;
    }

    if (ch === "\n" || ch === "\r" || ch === ";") {
      flushSegment();
      continue;
    }
    if (ch === "|") {
      if (next === "|") i += 1;
      flushSegment();
      continue;
    }
    if (ch === "&") {
      if (next === "&") {
        i += 1;
        flushSegment();
        continue;
      }
      if (next === ">") {
        current += "&>";
        hasCurrent = true;
        i += 1;
        continue;
      }
      if (current.endsWith(">")) {
        current += "&";
        continue;
      }
      if (isPowerShell && !hasCurrent && tokens.length === 0) {
        continue; // call operator `& npm test`
      }
      flushSegment();
      continue;
    }
    if ((ch === "(" || ch === ")") && !isPowerShell) {
      flushSegment();
      continue;
    }
    if (ch === " " || ch === "\t") {
      flushToken();
      continue;
    }
    current += ch;
    hasCurrent = true;
  }
  flushSegment();
  return segments;
}

/** Basename without a Windows launcher extension, lower-cased (`C:\x\Npm.CMD` → `npm`). */
function normalizeProgram(token: string): string {
  let program = token;
  const slash = Math.max(program.lastIndexOf("/"), program.lastIndexOf("\\"));
  if (slash >= 0 && slash < program.length - 1) program = program.slice(slash + 1);
  program = program.replace(LAUNCHER_EXTENSION, "");
  return program.toLowerCase();
}

/** `vitest@2.1.0` → `vitest`, `@scope/pkg@1` → `@scope/pkg`. */
function stripVersion(token: string): string {
  const match = /^(@[^/@]+\/[^@]+|[^@]+)@[^@]+$/.exec(token);
  return match === null ? token : match[1]!;
}

function foldBin(rest: readonly string[]): string[] {
  let index = 0;
  while (index < rest.length && rest[index]!.startsWith("-")) {
    const flag = rest[index]!;
    index += 1;
    if (BIN_VALUE_FLAGS.has(flag) && index < rest.length) index += 1;
  }
  if (index >= rest.length) return ["bin"];
  return ["bin", stripVersion(rest[index]!), ...rest.slice(index + 1)];
}

/** A canonical segment: the folded tokens plus the literal program that was invoked (`npm`, `pnpm dlx`, `git`). */
interface CanonicalSegment {
  tokens: string[];
  literal: string;
}

function foldPackageManager(program: string, rest: readonly string[]): CanonicalSegment {
  const tokens = [...rest];
  const runIndex = tokens.findIndex((token) => !token.startsWith("-"));
  if (runIndex >= 0 && RUN_SUBCOMMANDS.has(tokens[runIndex]!)) tokens.splice(runIndex, 1);
  const subIndex = tokens.findIndex((token) => !token.startsWith("-"));
  if (subIndex >= 0) {
    const sub = tokens[subIndex]!;
    if (BIN_SUBCOMMANDS[program]?.has(sub) === true) {
      return { tokens: foldBin(tokens.slice(subIndex + 1)), literal: `${program} ${sub}` };
    }
    const alias = SCRIPT_ALIASES[sub];
    if (alias !== undefined) tokens[subIndex] = alias;
  }
  return { tokens: ["pm", ...tokens], literal: program };
}

function canonicalizeSegment(input: readonly string[]): CanonicalSegment | null {
  let tokens = input.filter((token) => token !== "{" && token !== "}");
  for (;;) {
    while (tokens.length > 0 && ASSIGNMENT_PREFIX.test(tokens[0]!)) tokens = tokens.slice(1);
    if (tokens.length === 0) return null;
    const wrapper = WRAPPERS[normalizeProgram(tokens[0]!)];
    if (wrapper === undefined) break;
    let index = 1;
    while (index < tokens.length && tokens[index]!.startsWith("-") && tokens[index] !== "--") {
      const flag = tokens[index]!;
      index += 1;
      if (wrapper.has(flag) && index < tokens.length) index += 1;
    }
    if (index < tokens.length && tokens[index] === "--") index += 1;
    tokens = tokens.slice(index);
  }
  const program = normalizeProgram(tokens[0]!);
  const rest = tokens.slice(1);
  if (BIN_RUNNERS.has(program)) return { tokens: foldBin(rest), literal: program };
  if (PACKAGE_MANAGERS.has(program)) return foldPackageManager(program, rest);
  return { tokens: [program, ...rest], literal: program };
}

/** Program token of a canonical segment: `pm <script>` / `bin <name>` for folded calls, else the first token. */
export function programTokenOf(segment: readonly string[]): string {
  const first = segment[0] ?? "";
  if ((first === "pm" || first === "bin") && segment.length > 1) return `${first} ${segment[1]!}`;
  return first;
}

/**
 * §4.6 canonical form: quote-aware segment split, `VAR=value` and wrapper stripping, package-manager
 * folding (`npm|pnpm|yarn|bun [run] <script>` → `pm <script>`, `npx|pnpm dlx|bunx <bin>` → `bin <bin>`),
 * flags kept as tokens, program token lower-cased and reduced to its basename. The literal program of each
 * segment (`npm`, `pnpm dlx`, `git`) is kept in `literals` so a cmd pattern written with a real manager
 * (`npm test`) pins it while the family word (`pm test`) covers every manager.
 */
export function canonicalizeCommand(command: string, dialect: ShellDialect | null | undefined): CanonicalCommand {
  const segments: string[][] = [];
  const literals: string[] = [];
  for (const raw of tokenizeShell(command, dialect ?? "unknown")) {
    const canonical = canonicalizeSegment(raw);
    if (canonical === null || canonical.tokens.length === 0) continue;
    segments.push(canonical.tokens);
    literals.push(canonical.literal);
  }
  return {
    segments,
    literals,
    programTokens: segments.map(programTokenOf),
    canonical: segments.map((segment) => segment.join(" ")).join("; "),
  };
}

/** Entries kept by `canonicalCommandFor`: a hook call canonicalizes one target (plus the unsliced command). */
export const CANONICAL_CACHE_SIZE = 8;
const CANONICAL_CACHE = new Map<string, CanonicalCommand>();

/**
 * `canonicalizeCommand` memoized per (command, dialect) with least-recently-used eviction. A PreToolUse
 * call matches every `cmd` signature and policy rule against the same ≤ 4 KB target, so the tokenizer
 * runs once per process instead of once per signature. The result is shared: callers must not mutate it.
 */
export function canonicalCommandFor(command: string, dialect: ShellDialect | null | undefined): CanonicalCommand {
  const key = `${dialect ?? "unknown"}\u0000${command}`;
  const cached = CANONICAL_CACHE.get(key);
  if (cached !== undefined) {
    CANONICAL_CACHE.delete(key);
    CANONICAL_CACHE.set(key, cached);
    return cached;
  }
  const canonical = canonicalizeCommand(command, dialect);
  CANONICAL_CACHE.set(key, canonical);
  if (CANONICAL_CACHE.size > CANONICAL_CACHE_SIZE) {
    const oldest = CANONICAL_CACHE.keys().next().value;
    if (oldest !== undefined) CANONICAL_CACHE.delete(oldest);
  }
  return canonical;
}

/**
 * Program token used by ledger lines and failure signatures: the first segment that is not a shell
 * navigation builtin (`cd x && npm test` → `pm test`), falling back to the first segment.
 */
export function primaryProgramToken(command: string, dialect: ShellDialect | null | undefined): string | null {
  const { segments, programTokens } = canonicalCommandFor(command, dialect);
  for (let i = 0; i < segments.length; i += 1) {
    if (!SHELL_NAVIGATION.has(segments[i]![0]!)) return programTokens[i]!;
  }
  return programTokens[0] ?? null;
}

/** Literal program of the primary segment (`cd x && npm test` → `npm`, `pnpm dlx vitest run` → `pnpm dlx`), else null. */
export function primaryLiteralProgram(command: string, dialect: ShellDialect | null | undefined): string | null {
  const { segments, literals } = canonicalCommandFor(command, dialect);
  for (let i = 0; i < segments.length; i += 1) {
    if (!SHELL_NAVIGATION.has(segments[i]![0]!)) return literals[i] ?? null;
  }
  return literals[0] ?? null;
}

const PATH_TOKEN = /[\\/]|^\.{1,2}$|^[\w@.-]+\.[A-Za-z][A-Za-z0-9]{0,7}$/;

/** True when a canonical cmd pattern names a path (reconcile step 2: otherwise scope becomes `**\/*`). */
export function commandPatternHasPath(tokens: readonly string[]): boolean {
  return tokens.slice(1).some((token) => !token.startsWith("-") && PATH_TOKEN.test(token));
}

// ---------------------------------------------------------------------------------------------
// Regex safety (V5)
// ---------------------------------------------------------------------------------------------

/**
 * V5 floor at the 4 KB stage: a sweep over the samples that finishes within this many ms is accepted on any machine.
 * The smaller stages of the ladder (`REGEX_STAGE_BYTES`) scale it down with the sample size.
 */
export const REGEX_BUDGET_MS = 2;
/**
 * V5 ceiling, relative to the machine: above the floor a sweep may cost at most this many times a plain linear scan
 * (`REGEX_REFERENCE`) over samples of the same size, measured in the same process right after the candidate with a
 * timed round as long as the candidate's, so a verdict depends neither on the machine that runs the worker nor on
 * how loaded it is. Calibrated 2026-11-09 at 4 KB (Windows and Linux, Node 20 and 24, native and
 * `--regexp-interpret-all`): realistic unanchored patterns that backtrack from each literal prefix stay well below
 * it (`curl .* \| (ba)?sh` 90–102× native, 34–43× interpreted; `cat .*\.env` 168–179× / 46–58×; `curl .*\|.*sh`
 * 154–171× / 53–63×), patterns that backtrack at every position stay well above it (`[a-z]+\s+[0-9]+`
 * 1 968–2 748× / 1 198–1 402×; `[a-z]+[0-9]*\s+x` 1 904–2 813× / 1 147–1 283×; `.*\.env.*` 4 895–6 690× /
 * 1 759–2 220×). On a quadratic pattern the ratio roughly halves with each smaller stage of the ladder, so such a
 * pattern is refused at the first stage where its ratio crosses the line (`.*\.env.*` at 512 B, the pair above at
 * 1–2 KB) and the accepted ones never come near it below 4 KB; the smallest stages also keep patterns of a higher
 * degree from getting expensive.
 */
export const REGEX_BUDGET_RATIO = 500;
/** Timed sweeps `fastestSweepMs` tries before it gives up on reaching `stopAtMs`; the fastest one counts. */
export const REGEX_BUDGET_ROUNDS = 5;
/**
 * Sample sizes of the V5 ladder, smallest first. From the second stage on each stage bounds the cost of the next: a
 * pattern of polynomial degree d costs at most 2^d times its budget at the previous size. The first stage is bounded
 * by `withinBudget` itself: a first sweep beyond any stall-explicable multiple of the budget ends the stage after that
 * one sweep (REGEX_HOPELESS_RATIO, REGEX_HOPELESS_MS). Starting at 128 B keeps that one sweep cheap for dense
 * patterns of a high degree (`a.*b.*c.*d.*e.*f\.g` costs 1.8 ms per sweep at 128 B and 2.6 s at 512 B).
 */
export const REGEX_STAGE_BYTES: readonly number[] = [128, 256, 512, 1024, 2048, 4096];
/** A first sweep this many times over the budget (and over REGEX_HOPELESS_MS) is refused without further rounds. */
export const REGEX_HOPELESS_RATIO = 50;
/** … but never below this many ms: a stall of this size on a sub-millisecond sweep is not a plausible explanation. */
export const REGEX_HOPELESS_MS = 250;
const REGEX_SAMPLE_BYTES = 4096;
/** Short mixed subject run twice before the timed sweeps so V8's regexp interpreter and tier-up are not timed. */
const REGEX_WARMUP_SUBJECT = "ab ".repeat(22);
/** The linear scan the ratio is measured against: one character class and one literal per position, no quantifier. */
const REGEX_REFERENCE = /[a-z]!/;
/** Text swept per quick reference round (several passes over small samples) so the reference is not timer noise. */
const REGEX_REFERENCE_BYTES_PER_ROUND = 131_072;
/** Longest timed round the matched reference is sized to; past a few scheduler slices the inflation has converged. */
const REGEX_REFERENCE_MAX_ROUND_MS = 25;
/** Upper bound on the sweeps per matched-reference round, should the quick reference ever measure near zero. */
const REGEX_REFERENCE_MAX_PASSES = 100_000;
const OPTIONAL_RUN_LIMIT = 4;

type ClassKind = "word" | "digit" | "space" | "nonword" | "nondigit" | "nonspace";
type SetItem = { kind: "range"; lo: number; hi: number } | { kind: "class"; cls: ClassKind };
type AtomClass =
  | { kind: "any" }
  | { kind: "class"; cls: ClassKind }
  | { kind: "lit"; ch: string }
  | { kind: "set"; negated: boolean; items: SetItem[] }
  | { kind: "group"; first: AtomClass[]; last: AtomClass[] };

interface Atom {
  cls: AtomClass;
  min: number;
  max: number;
}

interface ParsedRegex {
  /** Every alternation branch at every nesting level, flattened for adjacency analysis. */
  branches: Atom[][];
  /** A quantified group that itself contains a quantifier or an alternation (`(a+)+`, `(a|aa)*`). */
  nested: boolean;
}

const CLASS_REGEX: Readonly<Record<ClassKind, RegExp>> = {
  word: /\w/,
  digit: /\d/,
  space: /\s/,
  nonword: /\W/,
  nondigit: /\D/,
  nonspace: /\S/,
};
const ESCAPE_CLASSES: Readonly<Record<string, ClassKind>> = { d: "digit", w: "word", s: "space", D: "nondigit", W: "nonword", S: "nonspace" };
const CONTROL_ESCAPES: Readonly<Record<string, string>> = { n: "\n", t: "\t", r: "\r", f: "\f", v: "\v", 0: "\0" };
const DISJOINT_CLASSES: ReadonlySet<string> = new Set([
  "word:space",
  "space:word",
  "word:nonword",
  "nonword:word",
  "digit:space",
  "space:digit",
  "digit:nonword",
  "nonword:digit",
  "digit:nondigit",
  "nondigit:digit",
  "space:nonspace",
  "nonspace:space",
]);

function classKindsOverlap(a: ClassKind, b: ClassKind): boolean {
  return !DISJOINT_CLASSES.has(`${a}:${b}`);
}

function charInClass(ch: string, cls: ClassKind): boolean {
  return CLASS_REGEX[cls].test(ch);
}

function rangeOverlapsClass(lo: number, hi: number, cls: ClassKind): boolean {
  if (hi - lo > 512) return true;
  for (let code = lo; code <= hi; code += 1) {
    if (charInClass(String.fromCodePoint(code), cls)) return true;
  }
  return false;
}

function setItemOverlaps(item: SetItem, other: AtomClass): boolean {
  switch (other.kind) {
    case "lit": {
      const code = other.ch.codePointAt(0) ?? -1;
      return item.kind === "range" ? code >= item.lo && code <= item.hi : charInClass(other.ch, item.cls);
    }
    case "class":
      return item.kind === "range" ? rangeOverlapsClass(item.lo, item.hi, other.cls) : classKindsOverlap(item.cls, other.cls);
    case "set":
      if (other.negated) return true;
      return other.items.some((otherItem) => {
        if (item.kind === "range" && otherItem.kind === "range") return item.lo <= otherItem.hi && otherItem.lo <= item.hi;
        if (item.kind === "range" && otherItem.kind === "class") return rangeOverlapsClass(item.lo, item.hi, otherItem.cls);
        if (item.kind === "class" && otherItem.kind === "range") return rangeOverlapsClass(otherItem.lo, otherItem.hi, item.cls);
        return item.kind === "class" && otherItem.kind === "class" && classKindsOverlap(item.cls, otherItem.cls);
      });
    default:
      return true;
  }
}

/** Can the last character consumed by `a` also be the first character consumed by `b` (a precedes b)? */
function classesOverlap(a: AtomClass, b: AtomClass): boolean {
  if (a.kind === "group") return a.last.some((cls) => classesOverlap(cls, b));
  if (b.kind === "group") return b.first.some((cls) => classesOverlap(a, cls));
  if (a.kind === "any" || b.kind === "any") return true;
  if (a.kind === "set") return a.negated ? true : a.items.some((item) => setItemOverlaps(item, b));
  if (b.kind === "set") return b.negated ? true : b.items.some((item) => setItemOverlaps(item, a));
  if (a.kind === "lit" && b.kind === "lit") return a.ch === b.ch;
  if (a.kind === "lit") return charInClass(a.ch, (b as { cls: ClassKind }).cls);
  if (b.kind === "lit") return charInClass(b.ch, a.cls);
  return classKindsOverlap(a.cls, b.cls);
}

function escapedChar(esc: string): string {
  return CONTROL_ESCAPES[esc] ?? esc;
}

/** Parses `[...]` starting just after `[`; returns the class and the position after `]`. */
function parseCharClass(source: string, start: number): { cls: AtomClass; pos: number } {
  let pos = start;
  let negated = false;
  if (source[pos] === "^") {
    negated = true;
    pos += 1;
  }
  const items: SetItem[] = [];
  let first = true;
  const readChar = (): { code: number; classKind: ClassKind | null } => {
    if (source[pos] === "\\") {
      const esc = source[pos + 1] ?? "";
      pos += 2;
      const classKind = ESCAPE_CLASSES[esc];
      if (classKind !== undefined) return { code: -1, classKind };
      return { code: escapedChar(esc).codePointAt(0) ?? 0, classKind: null };
    }
    const code = source.codePointAt(pos) ?? 0;
    pos += code > 0xffff ? 2 : 1;
    return { code, classKind: null };
  };
  while (pos < source.length && (source[pos] !== "]" || first)) {
    first = false;
    const lo = readChar();
    if (lo.classKind !== null) {
      items.push({ kind: "class", cls: lo.classKind });
      continue;
    }
    if (source[pos] === "-" && pos + 1 < source.length && source[pos + 1] !== "]") {
      pos += 1;
      const hi = readChar();
      if (hi.classKind !== null) {
        items.push({ kind: "range", lo: lo.code, hi: lo.code }, { kind: "range", lo: 45, hi: 45 }, { kind: "class", cls: hi.classKind });
      } else {
        items.push({ kind: "range", lo: Math.min(lo.code, hi.code), hi: Math.max(lo.code, hi.code) });
      }
      continue;
    }
    items.push({ kind: "range", lo: lo.code, hi: lo.code });
  }
  pos += 1; // closing ]
  return { cls: { kind: "set", negated, items }, pos };
}

/** Parses a regex source into atom sequences and flags quantified groups that contain a quantifier or alternation. */
function parseRegexAtoms(source: string): ParsedRegex {
  const branches: Atom[][] = [];
  let nested = false;
  let pos = 0;

  const readQuantifier = (): { min: number; max: number } | null => {
    const ch = source[pos];
    if (ch === "*" || ch === "+" || ch === "?") {
      pos += 1;
      if (source[pos] === "?") pos += 1;
      if (ch === "*") return { min: 0, max: Infinity };
      if (ch === "+") return { min: 1, max: Infinity };
      return { min: 0, max: 1 };
    }
    if (ch === "{") {
      const match = /^\{(\d+)(,(\d*))?\}/.exec(source.slice(pos));
      if (match !== null) {
        pos += match[0].length;
        if (source[pos] === "?") pos += 1;
        const min = Number(match[1]);
        const max = match[2] === undefined ? min : match[3] === undefined || match[3] === "" ? Infinity : Number(match[3]);
        return { min, max };
      }
    }
    return null;
  };

  const parseSequence = (): { branchAtoms: Atom[][]; hasQuantifier: boolean; hasAlternation: boolean } => {
    const branchAtoms: Atom[][] = [[]];
    let hasQuantifier = false;
    let hasAlternation = false;

    while (pos < source.length) {
      const ch = source[pos]!;
      if (ch === ")") break;
      if (ch === "|") {
        hasAlternation = true;
        branchAtoms.push([]);
        pos += 1;
        continue;
      }
      let cls: AtomClass | null = null;
      let group: ReturnType<typeof parseSequence> | null = null;
      let groupRepeatsUnsafely = false;
      if (ch === "\\") {
        const esc = source[pos + 1] ?? "";
        pos += 2;
        const classKind = ESCAPE_CLASSES[esc];
        if (classKind !== undefined) cls = { kind: "class", cls: classKind };
        else if (esc === "b" || esc === "B") cls = null; // zero-width anchors
        else if (esc === "x" || esc === "u" || esc === "p" || esc === "P" || esc === "c") cls = { kind: "set", negated: true, items: [] };
        else cls = { kind: "lit", ch: escapedChar(esc) };
        if (cls === null) continue;
      } else if (ch === "[") {
        const parsed = parseCharClass(source, pos + 1);
        cls = parsed.cls;
        pos = parsed.pos;
      } else if (ch === "(") {
        pos += 1;
        if (source[pos] === "?") {
          if (source[pos + 1] === "<" && source[pos + 2] !== "=" && source[pos + 2] !== "!") {
            const close = source.indexOf(">", pos);
            pos = close === -1 ? source.length : close + 1;
          } else {
            pos += source[pos + 1] === "<" ? 3 : 2;
          }
        }
        group = parseSequence();
        if (source[pos] === ")") pos += 1;
        const first: AtomClass[] = [];
        const last: AtomClass[] = [];
        const branchFirsts: AtomClass[][] = [];
        let nullable = false;
        for (const atoms of group.branchAtoms) {
          const firsts: AtomClass[] = [];
          let mandatory = false;
          for (const atom of atoms) {
            firsts.push(atom.cls);
            first.push(atom.cls);
            if (atom.min >= 1) {
              mandatory = true;
              break;
            }
          }
          if (!mandatory) nullable = true;
          branchFirsts.push(firsts);
          for (let k = atoms.length - 1; k >= 0; k -= 1) {
            last.push(atoms[k]!.cls);
            if (atoms[k]!.min >= 1) break;
          }
        }
        // Alternatives that can start with the same character (`a|aa`) make a repeated group ambiguous.
        let overlappingBranches = false;
        for (let i = 0; i < branchFirsts.length && !overlappingBranches; i += 1) {
          for (let j = i + 1; j < branchFirsts.length; j += 1) {
            if (branchFirsts[i]!.some((a) => branchFirsts[j]!.some((b) => classesOverlap(a, b)))) {
              overlappingBranches = true;
              break;
            }
          }
        }
        groupRepeatsUnsafely = group.hasQuantifier || nullable || overlappingBranches;
        cls = { kind: "group", first, last };
      } else if (ch === "^" || ch === "$") {
        pos += 1;
        continue;
      } else if (ch === ".") {
        pos += 1;
        cls = { kind: "any" };
      } else {
        pos += 1;
        cls = { kind: "lit", ch };
      }

      const quantifier = readQuantifier();
      if (quantifier !== null) hasQuantifier = true;
      if (group !== null) {
        if (group.hasQuantifier) hasQuantifier = true;
        if (quantifier !== null && quantifier.max > 1 && groupRepeatsUnsafely) nested = true;
      }
      branchAtoms[branchAtoms.length - 1]!.push({ cls, min: quantifier?.min ?? 1, max: quantifier?.max ?? 1 });
    }

    for (const atoms of branchAtoms) branches.push(atoms);
    return { branchAtoms, hasQuantifier, hasAlternation };
  };

  parseSequence();
  return { branches, nested };
}

/**
 * Static part of V5: nested quantifiers (`(a+)+`, `(.*)*`, `(a|aa)+`) and runs of overlapping
 * quantified atoms with nothing mandatory between them (`\w*\d*\w*`, `\s*\s*`, `a?a?a?a?`).
 */
export function regexLooksUnsafe(source: string): boolean {
  let parsed: ParsedRegex;
  try {
    parsed = parseRegexAtoms(source);
  } catch {
    return true;
  }
  if (parsed.nested) return true;
  for (const atoms of parsed.branches) {
    for (let i = 0; i < atoms.length; i += 1) {
      const a = atoms[i]!;
      if (a.max <= 1 && a.min >= 1) continue;
      let optionalRun = a.min === 0 ? 1 : 0;
      for (let j = i + 1; j < atoms.length; j += 1) {
        const b = atoms[j]!;
        const quantified = b.max > 1 || b.min === 0;
        if (quantified && classesOverlap(a.cls, b.cls)) {
          if (a.max === Infinity || b.max === Infinity) return true;
          optionalRun += 1;
          if (optionalRun >= OPTIONAL_RUN_LIMIT) return true;
        }
        if (b.min >= 1) break; // a mandatory atom separates the run
      }
    }
  }
  return false;
}

function regexSamples(source: string, size: number): string[] {
  const literal = source.replace(/\\[dwsDWSbB]|[\\^$.*+?()[\]{}|]/g, "");
  const seed = literal.length > 0 ? literal : "a";
  return [
    "a".repeat(size),
    `${"a".repeat(size - 1)}!`,
    " ".repeat(size),
    "ab ".repeat(Math.ceil(size / 3)).slice(0, size),
    `${seed.repeat(Math.ceil(size / seed.length)).slice(0, size - 1)}\u0001`,
  ];
}

/** Options of `fastestSweepMs`; `now` is injectable so the loop can be tested without a clock. */
export interface SweepOptions {
  /** Timed rounds to try (default REGEX_BUDGET_ROUNDS). */
  rounds?: number;
  /** Stop as soon as a sweep is within this many ms; with the default 0 only an immeasurably fast sweep stops early. */
  stopAtMs?: number;
  /** Sweeps per timed round; the measured time is divided by it (default 1). */
  passes?: number;
  now?: () => number;
}

/**
 * The fastest of up to `rounds` timed sweeps of `regex` over `samples`, in ms per sweep. A sweep can only be slowed
 * down from the outside — a preempted thread, a GC pause, a regex V8 has not compiled to native code yet — so the
 * fastest sweep is the one that measures the pattern, and a pattern that is slow by construction never gets a fast
 * one. Two warm-up runs on a short subject take the interpreter and the tier-up compile out of the timed rounds.
 */
export function fastestSweepMs(regex: RegExp, samples: readonly string[], options: SweepOptions = {}): number {
  const rounds = Math.max(1, options.rounds ?? REGEX_BUDGET_ROUNDS);
  const stopAtMs = options.stopAtMs ?? 0;
  const passes = Math.max(1, options.passes ?? 1);
  const now = options.now ?? (() => performance.now());
  for (let warm = 0; warm < 2; warm += 1) {
    regex.lastIndex = 0;
    regex.test(REGEX_WARMUP_SUBJECT);
  }
  let best = Infinity;
  for (let round = 0; round < rounds; round += 1) {
    const start = now();
    for (let pass = 0; pass < passes; pass += 1) {
      for (const sample of samples) {
        regex.lastIndex = 0;
        regex.test(sample);
      }
    }
    const elapsed = (now() - start) / passes;
    if (elapsed < best) best = elapsed;
    if (best <= stopAtMs) break;
  }
  return best;
}

/** The V5 floor for a stage of `size` bytes: REGEX_BUDGET_MS at 4 KB, proportionally less on the smaller samples. */
export function regexFloorMs(size: number): number {
  return (REGEX_BUDGET_MS * size) / REGEX_SAMPLE_BYTES;
}

/** The V5 budget in ms per sweep: the stage's floor, or REGEX_BUDGET_RATIO × the linear reference's sweep if larger. */
export function regexBudgetMs(referenceMs: number, floorMs: number = REGEX_BUDGET_MS): number {
  return Math.max(floorMs, REGEX_BUDGET_RATIO * referenceMs);
}

/**
 * Ms per sweep of the linear reference over `size`-byte samples, measured now. `passes` sweeps make one timed round;
 * the default covers REGEX_REFERENCE_BYTES_PER_ROUND so a quick reference is not timer noise.
 */
export function referenceSweepMs(size: number, options: { passes?: number; now?: () => number } = {}): number {
  const samples = regexSamples("x", size);
  const passes = Math.max(1, options.passes ?? Math.ceil(REGEX_REFERENCE_BYTES_PER_ROUND / (samples.length * size)));
  return fastestSweepMs(REGEX_REFERENCE, samples, { passes, now: options.now });
}

/**
 * One V5 stage over `size`-byte samples. One timed sweep within the stage's floor passes at once (the common case:
 * microseconds). Otherwise the linear reference is measured in the same process — quickly first, then with a timed
 * round as long as the candidate's sweep (capped at REGEX_REFERENCE_MAX_ROUND_MS): on a loaded host a round longer
 * than a scheduler slice always carries a wait while a microsecond round slips into a clean slice, and comparing
 * minimum to minimum at equal round lengths keeps the ratio honest (measured: 4–6× inflation at 6:1 oversubscription
 * without this, none with it). A first sweep within the resulting budget passes; one beyond REGEX_HOPELESS_RATIO
 * times the budget (and REGEX_HOPELESS_MS) is refused at once, since no stall explains it; in between the remaining
 * rounds run against the budget, stopping at the first sweep inside it, and the fastest sweep decides. Cost: an
 * accepted pattern over the floor pays one sweep plus two reference measurements, a refused one up to
 * REGEX_BUDGET_ROUNDS sweeps plus the two.
 */
function withinBudget(regex: RegExp, source: string, size: number): { ok: true } | { ok: false; detail: string } {
  const samples = regexSamples(source, size);
  const floor = regexFloorMs(size);
  const first = fastestSweepMs(regex, samples, { rounds: 1 });
  if (first <= floor) return { ok: true };
  const quick = referenceSweepMs(size);
  const passes = Math.min(REGEX_REFERENCE_MAX_PASSES, Math.max(1, Math.ceil(Math.min(first, REGEX_REFERENCE_MAX_ROUND_MS) / Math.max(quick, 1e-4))));
  const reference = referenceSweepMs(size, { passes });
  const budget = regexBudgetMs(reference, floor);
  if (first <= budget) return { ok: true };
  const hopeless = first > Math.max(REGEX_HOPELESS_RATIO * budget, REGEX_HOPELESS_MS);
  const rest = !hopeless && REGEX_BUDGET_ROUNDS > 1 ? fastestSweepMs(regex, samples, { rounds: REGEX_BUDGET_ROUNDS - 1, stopAtMs: budget }) : Infinity;
  const sweep = Math.min(first, rest);
  if (sweep <= budget) return { ok: true };
  return {
    ok: false,
    detail:
      `exceeded the budget on a ${size} B sample: ${sweep.toFixed(2)} ms per sweep, budget ${budget.toFixed(2)} ms ` +
      `(max of the ${floor} ms floor and ${REGEX_BUDGET_RATIO}× a linear scan at ${reference.toFixed(4)} ms)`,
  };
}

/**
 * V5: compiles, no nested quantifiers, and the samples of every stage of the ladder (128 B … 4 KB) match or fail
 * within the budget — the stage's floor (2 ms at 4 KB) on any machine, or REGEX_BUDGET_RATIO times a linear scan
 * measured alongside on a slower or loaded one. Static first: an exponential pattern is never executed.
 */
export function checkRegexSafety(source: string): { ok: true; regex: RegExp } | { ok: false; code: "regex_unsafe" | "invalid"; detail: string } {
  if (source.length === 0 || source.length > 200) return { ok: false, code: "invalid", detail: "regex length must be 1..200" };
  let regex: RegExp;
  try {
    regex = new RegExp(source);
  } catch (error) {
    return { ok: false, code: "invalid", detail: `regex does not compile: ${String(error)}` };
  }
  if (regexLooksUnsafe(source)) return { ok: false, code: "regex_unsafe", detail: "nested or overlapping quantifiers" };
  for (const size of REGEX_STAGE_BYTES) {
    const stage = withinBudget(regex, source, size);
    if (!stage.ok) return { ok: false, code: "regex_unsafe", detail: stage.detail };
  }
  return { ok: true, regex };
}

// ---------------------------------------------------------------------------------------------
// Glob compilation (lazy minimatch)
// ---------------------------------------------------------------------------------------------

type MakeRe = (pattern: string, options?: { dot?: boolean; nocase?: boolean }) => false | RegExp;

let makeReCached: MakeRe | null = null;

function loadMakeRe(): MakeRe {
  if (makeReCached === null) {
    const requireFn = createRequire(import.meta.url);
    const mod = requireFn("minimatch") as { makeRe: MakeRe };
    makeReCached = mod.makeRe;
  }
  return makeReCached;
}

export function normalizeGlobPattern(pattern: string): string {
  return pattern.trim().replace(/\\/g, "/").replace(/^(\.\/)+/, "");
}

function normalizeGlobTarget(target: string): string {
  return target.trim().replace(/\\/g, "/").replace(/^(\.\/)+/, "");
}

/** Flags used for glob-derived regexes: case-insensitive on Windows (`nocase`), like the compile step. */
export function globRegexFlags(): string {
  return process.platform === "win32" ? "i" : "";
}

/** `minimatch.makeRe(pattern, {dot: true, nocase: win32})` source, or null when the glob is invalid. */
export function compileGlobSource(pattern: string): string | null {
  const normalized = normalizeGlobPattern(pattern);
  if (normalized.length === 0) return null;
  const regex = loadMakeRe()(normalized, { dot: true, nocase: process.platform === "win32" });
  return regex === false ? null : regex.source;
}

/** Precompiled RegExp for a glob (cached per source), or null when the glob is invalid. */
export function globToRegExp(pattern: string): RegExp | null {
  const source = compileGlobSource(pattern);
  return source === null ? null : cachedRegExp(source, globRegexFlags());
}

/** Does `glob` match `path` with minimatch semantics (`dot: true`)? Directory-like globs without magic also match their descendants. */
export function globMatchesPath(glob: string, path: string): boolean {
  const normalizedGlob = normalizeGlobPattern(glob);
  const normalizedPath = normalizeGlobTarget(path);
  const regex = globToRegExp(normalizedGlob);
  if (regex !== null && regex.test(normalizedPath)) return true;
  if (!/[*?[\]{}!]/.test(normalizedGlob)) {
    const prefix = normalizedGlob.replace(/\/+$/, "");
    return normalizedPath === prefix || normalizedPath.startsWith(`${prefix}/`);
  }
  return false;
}

// ---------------------------------------------------------------------------------------------
// Compile / specificity / key
// ---------------------------------------------------------------------------------------------

export type SignatureRejectCode = "regex_unsafe" | "signature_unspecific" | "invalid";

export type CompileSignatureResult =
  | { ok: true; compiled: CompiledSignature }
  | { ok: false; code: SignatureRejectCode; detail: string };

const TOOL_GLOB_PATTERN = /^[a-z0-9_*|:/.-]+$/i;
const UNSPECIFIC_GLOBS = new Set(["*", "**", "**/*", "**/**"]);
const SUBSTRING_MIN_CHARS = 8;

export function normalizeSignatureTool(tool: string): string {
  return tool.trim().toLowerCase().replace(/\s+/g, "");
}

export function buildSignatureKey(tool: string, target: SignatureTarget, kind: PatternKind, canonicalPattern: string, negate: boolean): string {
  return `${normalizeSignatureTool(tool)}|${target}|${kind}|${canonicalPattern}${negate ? "|!" : ""}`;
}

/** V10 specificity on a compiled signature (also applied inside `compileSignature`). */
export function checkSpecificity(
  compiled: Pick<CompiledSignature, "pattern_kind" | "pattern" | "tokens" | "regex_source">
): { ok: true } | { ok: false; code: "signature_unspecific"; detail: string } {
  switch (compiled.pattern_kind) {
    case "cmd": {
      const tokens = compiled.tokens ?? [];
      if (tokens.length < 2) return { ok: false, code: "signature_unspecific", detail: "cmd signature needs at least 2 canonical tokens" };
      return { ok: true };
    }
    case "substring":
      if (compiled.pattern.length < SUBSTRING_MIN_CHARS) {
        return { ok: false, code: "signature_unspecific", detail: `substring signature needs at least ${SUBSTRING_MIN_CHARS} chars` };
      }
      return { ok: true };
    case "glob": {
      const pattern = normalizeGlobPattern(compiled.pattern);
      if (UNSPECIFIC_GLOBS.has(pattern)) return { ok: false, code: "signature_unspecific", detail: "glob matches everything" };
      const fragment = pattern.replace(/[*?[\]{}!(),|]/g, "");
      if (!/[A-Za-z0-9]/.test(fragment)) return { ok: false, code: "signature_unspecific", detail: "glob has no path fragment" };
      return { ok: true };
    }
    case "regex": {
      const source = compiled.regex_source ?? compiled.pattern;
      try {
        if (new RegExp(source).test("")) return { ok: false, code: "signature_unspecific", detail: "regex matches the empty string" };
      } catch {
        return { ok: false, code: "signature_unspecific", detail: "regex does not compile" };
      }
      return { ok: true };
    }
  }
}

/** Compiles a stored TriggerSignature (V5 + V10); the result is what the snapshot stores and the hooks match. */
export function compileSignature(sig: TriggerSignature): CompileSignatureResult {
  if (typeof sig !== "object" || sig === null) return { ok: false, code: "invalid", detail: "signature is not an object" };
  const tool = typeof sig.tool === "string" ? normalizeSignatureTool(sig.tool) : "";
  if (tool.length === 0 || tool.length > 60 || !TOOL_GLOB_PATTERN.test(tool)) {
    return { ok: false, code: "invalid", detail: "tool must be a glob over canonical tool names" };
  }
  if (!(SIGNATURE_TARGETS as readonly string[]).includes(sig.target)) return { ok: false, code: "invalid", detail: `unknown target ${String(sig.target)}` };
  if (!(PATTERN_KINDS as readonly string[]).includes(sig.pattern_kind)) {
    return { ok: false, code: "invalid", detail: `unknown pattern_kind ${String(sig.pattern_kind)}` };
  }
  if (typeof sig.pattern !== "string" || sig.pattern.trim().length === 0 || sig.pattern.length > 200) {
    return { ok: false, code: "invalid", detail: "pattern must be a string of 1..200 chars" };
  }
  if (sig.negate !== undefined && typeof sig.negate !== "boolean") return { ok: false, code: "invalid", detail: "negate must be boolean" };
  const negate = sig.negate === true;

  let tokens: string[] | null = null;
  let regexSource: string | null = null;
  let canonicalPattern: string;
  let program: string | null = null;

  switch (sig.pattern_kind) {
    case "cmd": {
      const command = canonicalizeCommand(sig.pattern, "bash");
      if (command.segments.length !== 1) return { ok: false, code: "invalid", detail: "cmd signature must be a single command" };
      tokens = command.segments[0]!;
      // A folded call written with a real manager / runner (`npm test`, `pnpm dlx vitest`) pins that literal; the
      // family words (`pm test`, `bin vitest`) leave `program` unset and match every manager (§4.6).
      const literal = command.literals[0]!;
      if (literal !== tokens[0]) program = literal;
      canonicalPattern = program === null ? tokens.join(" ") : [program, ...tokens.slice(1)].join(" ");
      break;
    }
    case "glob": {
      canonicalPattern = normalizeGlobPattern(sig.pattern);
      regexSource = compileGlobSource(canonicalPattern);
      if (regexSource === null) return { ok: false, code: "invalid", detail: "glob does not compile" };
      break;
    }
    case "regex": {
      const safety = checkRegexSafety(sig.pattern);
      if (!safety.ok) return safety;
      canonicalPattern = sig.pattern;
      regexSource = sig.pattern;
      break;
    }
    case "substring":
      canonicalPattern = sig.pattern.trim().toLowerCase();
      break;
  }

  const compiled: CompiledSignature = {
    tool,
    target: sig.target,
    pattern_kind: sig.pattern_kind,
    pattern: canonicalPattern,
    negate,
    tokens,
    ...(program === null ? {} : { program }),
    regex_source: regexSource,
    signature_key: buildSignatureKey(tool, sig.target, sig.pattern_kind, canonicalPattern, negate),
  };
  const specificity = checkSpecificity(compiled);
  if (!specificity.ok) return specificity;
  return { ok: true, compiled };
}

/** `tool|target|kind|canonical pattern` (+ `|!` when negated). */
export function signatureKey(compiled: CompiledSignature): string {
  return buildSignatureKey(compiled.tool, compiled.target, compiled.pattern_kind, compiled.pattern, compiled.negate);
}

const SIGNATURE_KEY_PATTERN = /^(.+?)\|(command|path|url|any)\|(cmd|glob|regex|substring)\|([\s\S]*?)(\|!)?$/;

export interface ParsedSignatureKey {
  tool: string;
  target: SignatureTarget;
  pattern_kind: PatternKind;
  pattern: string;
  negate: boolean;
}

export function parseSignatureKey(key: string): ParsedSignatureKey | null {
  const match = SIGNATURE_KEY_PATTERN.exec(key);
  if (match === null) return null;
  return {
    tool: match[1]!,
    target: match[2] as SignatureTarget,
    pattern_kind: match[3] as PatternKind,
    pattern: match[4]!,
    negate: match[5] !== undefined,
  };
}

// ---------------------------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------------------------

const REGEX_CACHE = new Map<string, RegExp>();
/** Targets longer than this are cut before regex / substring matching (§6.2 step 6: target ≤ 4 KB). */
export const MATCH_TARGET_CHARS = 4096;

function cachedRegExp(source: string, flags: string): RegExp {
  const key = `${flags}:${source}`;
  let regex = REGEX_CACHE.get(key);
  if (regex === undefined) {
    regex = new RegExp(source, flags);
    REGEX_CACHE.set(key, regex);
  }
  return regex;
}

function segmentMatches(segment: readonly string[], tokens: readonly string[], caseInsensitive: boolean): boolean {
  const fold = (value: string): string => (caseInsensitive ? value.toLowerCase() : value);
  if (segment.length === 0 || fold(segment[0]!) !== fold(tokens[0]!)) return false;
  const available = segment.map(fold);
  return tokens.slice(1).every((token) => available.includes(fold(token)));
}

/**
 * cmd: canonicalize the target with the call's dialect (memoized, see `canonicalCommandFor`); any segment
 * whose program equals the first pattern token, whose literal program equals `program` when the pattern pinned
 * one, and which contains every remaining token matches. glob/regex:
 * precompiled RegExp on the target. substring: case-insensitive includes. `negate` inverts the result.
 */
export function matchSignature(compiled: CompiledSignature, target: string, dialect: ShellDialect | null | undefined): boolean {
  const text = target.length > MATCH_TARGET_CHARS ? target.slice(0, MATCH_TARGET_CHARS) : target;
  let result: boolean;
  switch (compiled.pattern_kind) {
    case "cmd": {
      const tokens = compiled.tokens ?? [];
      if (tokens.length === 0) {
        result = false;
        break;
      }
      const caseInsensitive = dialect === "powershell" || dialect === "cmd";
      const command = canonicalCommandFor(text, dialect);
      const pinned = compiled.program === undefined || compiled.program === null ? null : compiled.program.toLowerCase();
      result = command.segments.some((segment, index) => segmentMatches(segment, tokens, caseInsensitive) && (pinned === null || command.literals[index]?.toLowerCase() === pinned));
      break;
    }
    case "glob": {
      if (compiled.regex_source === null) {
        result = false;
        break;
      }
      result = cachedRegExp(compiled.regex_source, globRegexFlags()).test(normalizeGlobTarget(text));
      break;
    }
    case "regex": {
      if (compiled.regex_source === null) {
        result = false;
        break;
      }
      const regex = cachedRegExp(compiled.regex_source, "");
      regex.lastIndex = 0;
      result = regex.test(text);
      break;
    }
    case "substring":
      result = text.toLowerCase().includes(compiled.pattern);
      break;
  }
  return compiled.negate ? !result : result;
}

/** Rebuilds a matcher from a stored signature_key (used by the stop hook for override/heed, §9.3 B). */
export function compileSignatureKey(key: string): CompiledSignature | null {
  const parsed = parseSignatureKey(key);
  if (parsed === null) return null;
  let tokens: string[] | null = null;
  let regexSource: string | null = null;
  let program: string | null = null;
  switch (parsed.pattern_kind) {
    case "cmd": {
      // The key stores the literal form (`npm test`, `pnpm dlx vitest run`, `pm test`): fold it the way compileSignature
      // does so a pinned manager is honoured by matchSignatureKey (fire outcomes, roll-ups, resolution checks).
      const command = canonicalizeCommand(parsed.pattern, "bash");
      if (command.segments.length !== 1) return null;
      tokens = command.segments[0]!;
      if (tokens.length === 0) return null;
      const literal = command.literals[0]!;
      if (literal !== tokens[0]) program = literal;
      break;
    }
    case "glob":
      regexSource = compileGlobSource(parsed.pattern);
      if (regexSource === null) return null;
      break;
    case "regex":
      try {
        new RegExp(parsed.pattern);
      } catch {
        return null;
      }
      regexSource = parsed.pattern;
      break;
    case "substring":
      break;
  }
  return {
    tool: parsed.tool,
    target: parsed.target,
    pattern_kind: parsed.pattern_kind,
    pattern: parsed.pattern,
    negate: parsed.negate,
    tokens,
    ...(program === null ? {} : { program }),
    regex_source: regexSource,
    signature_key: key,
  };
}

export function matchSignatureKey(key: string, target: string, dialect: ShellDialect | null | undefined): boolean {
  const compiled = compileSignatureKey(key);
  return compiled === null ? false : matchSignature(compiled, target, dialect);
}
