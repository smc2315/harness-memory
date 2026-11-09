/**
 * `hm memory:promote|demote|reject|restore <id>` and `hm memory:enforce <id> <level>` (spec §4.7, §7.1, §11).
 * Each is one lock session: resolve the row (id or unique prefix) → transitionMemory(actor human) or
 * setEnforcement + setAuthority(human) → save → snapshot. The before/after line is printed (JSON: both records).
 */

import type { Database as SqlJsDatabase } from "sql.js";

import { EXIT_CODES } from "../../core/errors";
import { ENFORCEMENTS, type Enforcement } from "../../core/vocabulary";
import type { MemoryRecord } from "../../memory/repository";
import type { CommandContext } from "../context";
import { flagString, type OptionSpecs } from "../lib/args";
import { guard } from "../lib/cli-error";
import { writeDb } from "../lib/db-access";
import { resolveMemory } from "../lib/lookup";
import { demoteMemory, enforceMemory, promoteMemory, rejectMemory, restoreMemory } from "../lib/memory-actions";
import { memoryLine, memoryToJson, type MemoryJson } from "../lib/memory-render";
import { parseEnum, requirePositional } from "../lib/options";

export const memoryPromoteOptions: OptionSpecs = {};
export const memoryDemoteOptions: OptionSpecs = {};
export const memoryRejectOptions: OptionSpecs = {
  note: { type: "string", description: "Why it was rejected (kept as a manual evidence note)", placeholder: "<text>" },
};
export const memoryRestoreOptions: OptionSpecs = {};
export const memoryEnforceOptions: OptionSpecs = {};

export interface MemoryTransitionReport {
  action: "promote" | "demote" | "reject" | "restore" | "enforce";
  before: MemoryJson;
  after: MemoryJson;
}

type Mutation = (ctx: CommandContext, memory: MemoryRecord, now: string, db: SqlJsDatabase) => MemoryRecord;

async function runTransition(ctx: CommandContext, action: MemoryTransitionReport["action"], mutate: Mutation): Promise<number> {
  return guard(ctx, async () => {
    const ref = requirePositional(ctx, 0, "id");
    const { value } = await writeDb(ctx, { purpose: `memory:${action}`, kind: `memory:${action}`, subject: ref }, (db, write) => {
      const before = resolveMemory(db, ref);
      const after = mutate(ctx, before, write.now, db);
      return { before, after };
    });
    const report: MemoryTransitionReport = { action, before: memoryToJson(value.before), after: memoryToJson(value.after) };
    ctx.out.result(report, () => [`${action}: ${value.before.status}/${value.before.authority} → ${value.after.status}/${value.after.authority}`, `  ${memoryLine(value.after)}`]);
    return EXIT_CODES.ok;
  });
}

export function runMemoryPromote(ctx: CommandContext): Promise<number> {
  return runTransition(ctx, "promote", (_ctx, memory, now, db) => promoteMemory(db, memory, now));
}

export function runMemoryDemote(ctx: CommandContext): Promise<number> {
  return runTransition(ctx, "demote", (_ctx, memory, now, db) => demoteMemory(db, memory, now));
}

export function runMemoryReject(ctx: CommandContext): Promise<number> {
  return runTransition(ctx, "reject", (c, memory, now, db) => rejectMemory(db, memory, now, { note: flagString(c.args, "note") }));
}

export function runMemoryRestore(ctx: CommandContext): Promise<number> {
  return runTransition(ctx, "restore", (_ctx, memory, now, db) => restoreMemory(db, memory, now));
}

export function runMemoryEnforce(ctx: CommandContext): Promise<number> {
  return runTransition(ctx, "enforce", (c, memory, now, db) => {
    const level = parseEnum<Enforcement>(requirePositional(c, 1, "level"), ENFORCEMENTS, "<level>");
    return enforceMemory(db, memory, level, now);
  });
}
