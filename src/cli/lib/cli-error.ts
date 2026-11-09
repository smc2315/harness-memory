/**
 * Input / state errors a command raises on purpose (unknown id, invalid option value, wrong status for the
 * requested transition). `guard` turns them into one stderr line + the intended exit code so command modules
 * can `throw` from deep inside a lock session without sprinkling exit-code bookkeeping everywhere.
 * Every other error keeps propagating to the dispatcher, which maps it through `describeFailure`.
 */

import { AuthorityViolationError, EXIT_CODES } from "../../core/errors";
import { DuplicateMemoryContentError, InvalidMemoryTransitionError, MemoryNotFoundError } from "../../memory/repository";
import type { CommandContext } from "../context";
import { EXIT_USAGE } from "./store";

export interface CliInputErrorOptions {
  /** 2 for usage problems (missing argument, bad enum), 1 for state problems (not found, wrong status). */
  exitCode?: number;
  hint?: string | null;
}

export class CliInputError extends Error {
  readonly exitCode: number;
  readonly hint: string | null;

  constructor(message: string, options: CliInputErrorOptions = {}) {
    super(message);
    this.name = "CliInputError";
    this.exitCode = options.exitCode ?? EXIT_CODES.error;
    this.hint = options.hint ?? null;
  }
}

export function usageError(message: string, hint: string | null = null): CliInputError {
  return new CliInputError(message, { exitCode: EXIT_USAGE, hint });
}

/** Domain errors from the repositories / transitions become plain messages (exit 1) instead of stack traces. */
export function describeDomainError(error: unknown): { message: string; hint: string | null } | null {
  if (error instanceof CliInputError) return { message: error.message, hint: error.hint };
  if (error instanceof MemoryNotFoundError) return { message: error.message, hint: "run `hm memory:list` to see the ids" };
  if (error instanceof InvalidMemoryTransitionError) return { message: error.message, hint: "see the §4.7 edge table: promote candidate|stale, demote active, reject candidate, restore superseded|stale" };
  if (error instanceof AuthorityViolationError) return { message: error.message, hint: null };
  if (error instanceof DuplicateMemoryContentError) {
    return { message: `${error.message}`, hint: `a live memory already holds this fact: hm memory:show ${error.existingMemoryId}` };
  }
  return null;
}

/** Runs a command body; CliInputError and domain errors become one error line and an exit code. */
export async function guard(ctx: CommandContext, body: () => Promise<number>): Promise<number> {
  try {
    return await body();
  } catch (error) {
    const described = describeDomainError(error);
    if (described === null) throw error;
    ctx.out.error(described.message);
    if (described.hint !== null) ctx.out.note(`hint: ${described.hint}`);
    return error instanceof CliInputError ? error.exitCode : EXIT_CODES.error;
  }
}
