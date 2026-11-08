/**
 * Dependency-free argument parsing for the `hm` dispatcher (spec §11). Every command declares the
 * options it understands; `--key value`, `--key=value`, `--no-key` and short aliases are accepted.
 * Unknown options are reported, never silently swallowed, so a typo cannot change a command's meaning.
 */

export type OptionType = "boolean" | "string" | "number";

export interface OptionSpec {
  type: OptionType;
  description: string;
  /** Short alias without the dash (`y` for `-y`). */
  alias?: string;
  /** Printed in `--help`; purely informational. */
  placeholder?: string;
}

export type OptionSpecs = Record<string, OptionSpec>;

export type FlagValue = string | number | boolean;

export interface ParsedArgs {
  positionals: string[];
  flags: Record<string, FlagValue>;
  /** Options that no spec declared, in the order seen (`--foo`, `-x`). */
  unknown: string[];
  /** Options whose value could not be parsed (`--limit abc` for a number option). */
  invalid: string[];
}

/** Options every command accepts (spec §11: `--json`, `--db`). */
export const GLOBAL_OPTIONS: OptionSpecs = {
  json: { type: "boolean", description: "Print machine-readable JSON instead of text" },
  db: { type: "string", description: "Path to memory.sqlite (default: <project>/.harness-memory/memory.sqlite)", placeholder: "<path>" },
  root: { type: "string", description: "Project root (default: the nearest ancestor holding .harness-memory or .git)", placeholder: "<dir>" },
  help: { type: "boolean", description: "Show help for the command", alias: "h" },
};

function lookupAlias(specs: OptionSpecs, alias: string): string | null {
  for (const [name, spec] of Object.entries(specs)) {
    if (spec.alias === alias) return name;
  }
  return null;
}

function coerce(spec: OptionSpec, raw: string): FlagValue | null {
  switch (spec.type) {
    case "string":
      return raw;
    case "number": {
      const parsed = Number(raw);
      return Number.isFinite(parsed) ? parsed : null;
    }
    case "boolean": {
      const lowered = raw.toLowerCase();
      if (lowered === "true" || lowered === "1" || lowered === "yes") return true;
      if (lowered === "false" || lowered === "0" || lowered === "no") return false;
      return null;
    }
  }
}

/**
 * Parses `argv` (without the command word) against `specs`. A `--` ends option parsing; everything
 * after it is positional. Boolean options take an optional `=value`; string/number options take the
 * next token when it is not itself an option.
 */
export function parseArgs(argv: readonly string[], specs: OptionSpecs): ParsedArgs {
  const result: ParsedArgs = { positionals: [], flags: {}, unknown: [], invalid: [] };
  let index = 0;
  let optionsEnded = false;

  while (index < argv.length) {
    const token = argv[index]!;
    index += 1;

    if (optionsEnded || token === "-" || !token.startsWith("-")) {
      result.positionals.push(token);
      continue;
    }
    if (token === "--") {
      optionsEnded = true;
      continue;
    }

    let name: string;
    let inlineValue: string | null = null;
    if (token.startsWith("--")) {
      const body = token.slice(2);
      const eq = body.indexOf("=");
      name = eq === -1 ? body : body.slice(0, eq);
      inlineValue = eq === -1 ? null : body.slice(eq + 1);
    } else {
      const body = token.slice(1);
      const eq = body.indexOf("=");
      const alias = eq === -1 ? body : body.slice(0, eq);
      inlineValue = eq === -1 ? null : body.slice(eq + 1);
      const resolved = lookupAlias(specs, alias);
      if (resolved === null) {
        result.unknown.push(token);
        continue;
      }
      name = resolved;
    }

    let negated = false;
    let spec = specs[name];
    if (spec === undefined && name.startsWith("no-")) {
      const positive = name.slice(3);
      if (specs[positive]?.type === "boolean") {
        negated = true;
        name = positive;
        spec = specs[positive];
      }
    }
    if (spec === undefined) {
      result.unknown.push(token);
      // A value glued to an unknown option (`--foo bar`) would otherwise become a positional; keep it
      // attached only when written as `--foo=bar`, which the token already carries.
      continue;
    }

    if (spec.type === "boolean") {
      if (inlineValue === null) {
        result.flags[name] = !negated;
      } else {
        const value = coerce(spec, inlineValue);
        if (value === null) result.invalid.push(token);
        else result.flags[name] = negated ? !value : value;
      }
      continue;
    }

    let raw = inlineValue;
    if (raw === null) {
      const next = argv[index];
      if (next !== undefined && (!next.startsWith("-") || next === "-")) {
        raw = next;
        index += 1;
      }
    }
    if (raw === null) {
      result.invalid.push(token);
      continue;
    }
    const value = coerce(spec, raw);
    if (value === null) result.invalid.push(`${token} ${raw}`);
    else result.flags[name] = value;
  }

  return result;
}

export function flagString(args: ParsedArgs, name: string): string | null {
  const value = args.flags[name];
  return typeof value === "string" ? value : null;
}

export function flagBoolean(args: ParsedArgs, name: string): boolean {
  return args.flags[name] === true;
}

export function flagNumber(args: ParsedArgs, name: string): number | null {
  const value = args.flags[name];
  return typeof value === "number" ? value : null;
}

/** One `--name <placeholder>  description` line per option, aligned, for `--help`. */
export function renderOptionsHelp(specs: OptionSpecs): string[] {
  const entries = Object.entries(specs).map(([name, spec]) => {
    const alias = spec.alias === undefined ? "" : `-${spec.alias}, `;
    const placeholder = spec.type === "boolean" ? "" : ` ${spec.placeholder ?? "<value>"}`;
    return { left: `${alias}--${name}${placeholder}`, right: spec.description };
  });
  const width = entries.reduce((max, entry) => Math.max(max, entry.left.length), 0);
  return entries.map((entry) => `  ${entry.left.padEnd(width)}  ${entry.right}`);
}
