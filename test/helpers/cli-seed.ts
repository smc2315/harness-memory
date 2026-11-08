/**
 * Seeding for the Phase C CLI tests: writes go through the same Store the CLI composes (createCliStore →
 * Store.withWriteLock, which creates / migrates the temp database, bumps the generation and builds the
 * snapshot), reads through Store.read. A fixed clock keeps every stamp deterministic.
 */

import type { Database as SqlJsDatabase } from "sql.js";

import { createCliStore } from "../../src/cli/lib/store";
import { loadConfig } from "../../src/core/config";
import type { WriteContext } from "../../src/db/store";
import type { CliProject, RunHmOptions } from "./cli-run";

export const CLI_NOW = "2026-11-08T12:00:00.000Z";
export const CLI_NOW_MS = Date.parse(CLI_NOW);

let seedCounter = 0;

/** Runs `fn` inside one store write (non-noop): the database is created at v21 when missing and the snapshot is rebuilt. */
export async function seedProject(project: CliProject, fn: (db: SqlJsDatabase, write: WriteContext) => void | Promise<void>, now: string = CLI_NOW): Promise<void> {
  const store = createCliStore({ paths: project.paths, config: loadConfig(project.paths.config), clock: () => now });
  seedCounter += 1;
  const id = `seed:${String(seedCounter)}:${now}`;
  await store.withWriteLock("seed", 5_000, async (db, write) => {
    await fn(db, write);
    return { id, kind: "seed", noop: false, wrote: true };
  });
}

export async function readProject<T>(project: CliProject, fn: (db: SqlJsDatabase) => T): Promise<T> {
  const store = createCliStore({ paths: project.paths, config: loadConfig(project.paths.config), clock: () => CLI_NOW });
  return store.read((db) => fn(db));
}

/** runHm options with the fixed clock (and wall clock for relative times). */
export function clockOptions(now: string = CLI_NOW, extra: RunHmOptions = {}): RunHmOptions {
  return { clock: () => now, ...extra, seams: { nowMs: () => Date.parse(now), ...extra.seams } };
}
