/**
 * Small option helpers for the Phase C commands: enum validation with the allowed values in the error,
 * comma-separated lists, required positionals.
 */

import type { CommandContext } from "../context";
import { usageError } from "./cli-error";

export function splitList(value: string | null): string[] {
  if (value === null) return [];
  return value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

export function parseEnum<T extends string>(value: string, allowed: readonly T[], optionName: string): T {
  const normalized = value.trim();
  if (!(allowed as readonly string[]).includes(normalized)) {
    throw usageError(`invalid value '${value}' for ${optionName}`, `allowed: ${allowed.join(", ")}`);
  }
  return normalized as T;
}

export function parseEnumList<T extends string>(value: string | null, allowed: readonly T[], optionName: string): T[] {
  return splitList(value).map((part) => parseEnum(part, allowed, optionName));
}

/** The n-th positional argument (0-based) or a usage error naming it. */
export function requirePositional(ctx: CommandContext, index: number, name: string): string {
  const value = ctx.args.positionals[index];
  if (value === undefined || value.trim().length === 0) {
    throw usageError(`missing <${name}>`, `usage: hm ${ctx.name} — run \`hm ${ctx.name} --help\``);
  }
  return value.trim();
}
