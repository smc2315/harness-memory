/**
 * Database access for the Phase C commands: every read goes through `Store.read` (no lock, no migration;
 * a pending migration or a newer schema is refused with a plain message), every write through
 * `Store.withWriteLock` with a `WriteOp` whose id records what the human did (`<kind>:<subject>:<now>:<nonce>`).
 * The nonce keeps repeated identical commands from colliding in `write_ops` (the store would otherwise treat
 * the second one as already applied); proposal decisions keep the `decision:<proposalId>:<now>` form B1 asked for.
 */

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type { Database as SqlJsDatabase } from "sql.js";

import { TARGET_USER_VERSION } from "../../core/paths";
import type { ReadContext, Store, WriteContext, WriteOp, WriteResult } from "../../db/store";
import type { CommandContext } from "../context";
import { CliInputError } from "./cli-error";
import { CLI_LOCK_WAIT_MS, createCliStore } from "./store";

export function openStore(ctx: CommandContext): Store {
  return createCliStore({ paths: ctx.paths, config: ctx.config, clock: ctx.clock, stderr: ctx.stderr });
}

/** Mutating commands refuse to conjure a database: install / db:migrate create it on purpose. */
export function requireDatabase(ctx: CommandContext): void {
  if (!existsSync(ctx.paths.db)) {
    throw new CliInputError(`no database at ${ctx.paths.db}`, { hint: "run `hm install --host claude` (or `hm db:migrate`) first" });
  }
}

/** Read-only access; refuses a schema the repositories cannot read. */
export async function readDb<T>(ctx: CommandContext, fn: (db: SqlJsDatabase, read: ReadContext) => T | Promise<T>): Promise<T> {
  const store = openStore(ctx);
  return store.read(async (db, read) => {
    if (read.newerThanCode) {
      throw new CliInputError(`database v${String(read.userVersion)} is newer than this build (v${String(TARGET_USER_VERSION)})`, {
        hint: "upgrade harness-memory before touching this database",
      });
    }
    if (read.migrationNeeded) {
      throw new CliInputError(`database v${String(read.userVersion)} needs migration to v${String(TARGET_USER_VERSION)}`, {
        hint: "run `hm db:migrate` first",
      });
    }
    return fn(db, read);
  });
}

export function cliOpId(kind: string, subject: string, now: string): string {
  return `${kind}:${subject}:${now}:${randomUUID().slice(0, 8)}`;
}

export interface WriteDbOptions<T> {
  /** Lock purpose shown in locks/db.lock owner.json. */
  purpose: string;
  /** write_ops kind. */
  kind: string;
  /** Subject for the default op id (memory id, proposal id, file …). */
  subject: string;
  /** Explicit op id, or a function of the body's result (proposal decisions use `decision:<proposalId>:<now>`). */
  opId?: string | ((value: T, now: string) => string);
}

export type WriteBody<T> = (db: SqlJsDatabase, write: WriteContext) => T | Promise<T>;

export interface WriteDbResult<T> {
  value: T;
  result: WriteResult;
}

/**
 * Runs `body` inside one lock session and commits it as a non-noop write (derived rules, generation bump,
 * write_ops row, save, snapshot). `noopWhen(value)` true → nothing is saved (ROLLBACK of an empty session).
 */
export async function writeDb<T>(
  ctx: CommandContext,
  options: WriteDbOptions<T>,
  body: WriteBody<T>,
  noopWhen: (value: T) => boolean = () => false
): Promise<WriteDbResult<T>> {
  requireDatabase(ctx);
  const store = openStore(ctx);
  let value!: T;
  const result = await store.withWriteLock(options.purpose, CLI_LOCK_WAIT_MS, async (db, write) => {
    value = await body(db, write);
    if (noopWhen(value)) return { id: null, kind: options.kind, noop: true, wrote: false } satisfies WriteOp;
    const id = typeof options.opId === "function" ? options.opId(value, write.now) : (options.opId ?? cliOpId(options.kind, options.subject, write.now));
    return { id, kind: options.kind, noop: false, wrote: true } satisfies WriteOp;
  });
  return { value, result };
}
