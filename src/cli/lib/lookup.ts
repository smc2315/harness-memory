/**
 * Id resolution for the CLI: memory and proposal ids are UUID-shaped, so commands accept the full id or a
 * unique prefix of at least MIN_PREFIX characters (`hm memory:show 3f9a`). Ambiguous prefixes are refused
 * with the candidates listed; nothing is ever guessed.
 */

import type { Database as SqlJsDatabase } from "sql.js";

import { ProposalRepository, type ProposalRecord } from "../../db/repositories/proposals";
import { selectAll } from "../../db/sql";
import { MemoryRepository, type MemoryRecord } from "../../memory/repository";
import { CliInputError } from "./cli-error";

export const MIN_PREFIX = 4;
export const SHORT_ID_CHARS = 8;

export function shortId(id: string | null | undefined): string {
  if (id === null || id === undefined) return "-";
  return id.length <= SHORT_ID_CHARS ? id : id.slice(0, SHORT_ID_CHARS);
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

function matchingIds(db: SqlJsDatabase, table: "memories" | "proposals", prefix: string): string[] {
  return selectAll(db, `SELECT id FROM ${table} WHERE id LIKE ? ESCAPE '\\' ORDER BY id LIMIT 6`, [`${escapeLike(prefix)}%`]).map((row) => String(row.id));
}

function resolveRef(db: SqlJsDatabase, table: "memories" | "proposals", ref: string, noun: string): string {
  const trimmed = ref.trim();
  if (trimmed.length === 0) throw new CliInputError(`missing ${noun} id`, { exitCode: 2 });
  const exact = selectAll(db, `SELECT id FROM ${table} WHERE id = ?`, [trimmed]);
  if (exact.length === 1) return String(exact[0]!.id);
  if (trimmed.length < MIN_PREFIX) {
    throw new CliInputError(`no ${noun} with id ${trimmed}`, { hint: `prefixes need at least ${String(MIN_PREFIX)} characters` });
  }
  const matches = matchingIds(db, table, trimmed);
  if (matches.length === 1) return matches[0]!;
  if (matches.length === 0) throw new CliInputError(`no ${noun} with id ${trimmed}`);
  throw new CliInputError(`${noun} id prefix ${trimmed} is ambiguous: ${matches.join(", ")}`, { hint: "use more characters of the id" });
}

/** Full id or unique prefix → MemoryRecord (any status). */
export function resolveMemory(db: SqlJsDatabase, ref: string, repository: MemoryRepository = new MemoryRepository(db)): MemoryRecord {
  const id = resolveRef(db, "memories", ref, "memory");
  const memory = repository.getById(id);
  if (memory === null) throw new CliInputError(`no memory with id ${ref}`);
  return memory;
}

/** Full id or unique prefix → ProposalRecord (any status). */
export function resolveProposal(db: SqlJsDatabase, ref: string, proposals: ProposalRepository = new ProposalRepository(db)): ProposalRecord {
  const id = resolveRef(db, "proposals", ref, "proposal");
  const proposal = proposals.getById(id);
  if (proposal === null) throw new CliInputError(`no proposal with id ${ref}`);
  return proposal;
}
