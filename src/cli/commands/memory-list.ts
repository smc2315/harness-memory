/**
 * `hm memory:list [--status <s>] [--type <t>] [--authority <a>] [--source <k>] [--scope <glob>] [--limit <n>]`
 * (spec §11). Live rows (candidate/active/stale) by default; `--status all` shows every status. Text mode is a
 * table, `--json` the records without embeddings.
 */

import { EXIT_CODES } from "../../core/errors";
import {
  AUTHORITIES,
  LIVE_STATUSES,
  MEMORY_STATUSES,
  MEMORY_TYPES,
  SOURCE_KINDS,
  type Authority,
  type MemoryStatus,
  type MemoryType,
  type SourceKind,
} from "../../core/vocabulary";
import { MemoryRepository, type ListMemoriesInput } from "../../memory/repository";
import type { CommandContext } from "../context";
import { flagBoolean, flagNumber, flagString, type OptionSpecs } from "../lib/args";
import { guard, usageError } from "../lib/cli-error";
import { readDb } from "../lib/db-access";
import { memoryToJson, renderMemoryTable, type MemoryJson } from "../lib/memory-render";
import { parseEnumList, splitList } from "../lib/options";

export const memoryListOptions: OptionSpecs = {
  status: { type: "string", description: "Comma list of statuses (default: candidate,active,stale; `all` for every status)", placeholder: "<s>" },
  type: { type: "string", description: "Comma list of memory types", placeholder: "<t>" },
  authority: { type: "string", description: "human | auto", placeholder: "<a>" },
  source: { type: "string", description: "Comma list of source kinds (manual, import, extraction, legacy)", placeholder: "<k>" },
  scope: { type: "string", description: "Exact scope_glob match", placeholder: "<glob>" },
  unconfirmed: { type: "boolean", description: "Only unconfirmed imports (import_unconfirmed = 1)" },
  contested: { type: "boolean", description: "Only rows with an open contradicting proposal" },
  limit: { type: "number", description: "Maximum rows (default 200)", placeholder: "<n>" },
};

export const MEMORY_LIST_DEFAULT_LIMIT = 200;

export interface MemoryListReport {
  filter: ListMemoriesInput;
  total: number;
  memories: MemoryJson[];
}

export function parseMemoryListFilter(ctx: CommandContext): ListMemoriesInput {
  const statusRaw = flagString(ctx.args, "status");
  let status: MemoryStatus[] | undefined;
  if (statusRaw === null) status = [...LIVE_STATUSES];
  else if (splitList(statusRaw).some((part) => part === "all")) status = undefined;
  else status = parseEnumList<MemoryStatus>(statusRaw, MEMORY_STATUSES, "--status");

  const limit = flagNumber(ctx.args, "limit");
  if (limit !== null && (!Number.isInteger(limit) || limit < 1)) throw usageError("--limit must be a positive integer");

  const filter: ListMemoriesInput = {
    ...(status === undefined ? {} : { status }),
    limit: limit ?? MEMORY_LIST_DEFAULT_LIMIT,
  };
  const types = parseEnumList<MemoryType>(flagString(ctx.args, "type"), MEMORY_TYPES, "--type");
  if (types.length > 0) filter.type = types;
  const authorities = parseEnumList<Authority>(flagString(ctx.args, "authority"), AUTHORITIES, "--authority");
  if (authorities.length > 0) filter.authority = authorities;
  const sources = parseEnumList<SourceKind>(flagString(ctx.args, "source"), SOURCE_KINDS, "--source");
  if (sources.length > 0) filter.sourceKind = sources;
  const scope = flagString(ctx.args, "scope");
  if (scope !== null) filter.scopeGlob = scope;
  if (flagBoolean(ctx.args, "unconfirmed")) filter.importUnconfirmed = 1;
  if (flagBoolean(ctx.args, "contested")) filter.contested = 1;
  return filter;
}

export async function runMemoryList(ctx: CommandContext): Promise<number> {
  return guard(ctx, async () => {
    const filter = parseMemoryListFilter(ctx);
    const memories = await readDb(ctx, (db) => new MemoryRepository(db).list(filter));
    const report: MemoryListReport = { filter, total: memories.length, memories: memories.map(memoryToJson) };
    ctx.out.result(report, () => {
      const lines = renderMemoryTable(memories);
      if (memories.length >= (filter.limit ?? MEMORY_LIST_DEFAULT_LIMIT)) lines.push(`(showing the first ${String(memories.length)}; raise --limit for more)`);
      return lines;
    });
    return EXIT_CODES.ok;
  });
}
