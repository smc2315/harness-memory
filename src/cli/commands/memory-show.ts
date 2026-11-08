/**
 * `hm memory:show <id>` (spec §11): the full record (any status; id or unique prefix) plus the proposals
 * that target or replace it.
 */

import { EXIT_CODES } from "../../core/errors";
import { ProposalRepository, type ProposalRecord } from "../../db/repositories/proposals";
import type { CommandContext } from "../context";
import type { OptionSpecs } from "../lib/args";
import { guard } from "../lib/cli-error";
import { readDb } from "../lib/db-access";
import { resolveMemory } from "../lib/lookup";
import { memoryToJson, renderMemoryDetail, type MemoryJson } from "../lib/memory-render";
import { requirePositional } from "../lib/options";

export const memoryShowOptions: OptionSpecs = {};

export interface MemoryShowReport {
  memory: MemoryJson;
  proposals: ProposalRecord[];
}

export async function runMemoryShow(ctx: CommandContext): Promise<number> {
  return guard(ctx, async () => {
    const ref = requirePositional(ctx, 0, "id");
    const { memory, proposals } = await readDb(ctx, (db) => {
      const memory = resolveMemory(db, ref);
      return { memory, proposals: new ProposalRepository(db).listForMemory(memory.id) };
    });
    const report: MemoryShowReport = { memory: memoryToJson(memory), proposals };
    ctx.out.result(report, () => renderMemoryDetail(memory, { proposals }));
    return EXIT_CODES.ok;
  });
}
