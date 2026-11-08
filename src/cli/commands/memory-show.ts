/**
 * `hm memory:show <id>` (spec §11): the full record (any status; id or unique prefix) plus the proposals
 * that target or replace it.
 */

import type { Database as SqlJsDatabase } from "sql.js";

import { EXIT_CODES } from "../../core/errors";
import { ProposalRepository, type ProposalRecord } from "../../db/repositories/proposals";
import { TransitionRepository } from "../../db/repositories/transitions";
import { REMEMBER_STATUS_REASON, rememberEpisodeOfReason } from "../../promotion/remember";
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
  /** A′: the episode whose remember turn made this row human — the adopting transition's, else the row's own source episode. */
  remember_episode_id?: string | null;
}

/**
 * The remember turn behind a `status_reason = remember` row: a row the turn ADOPTED (an older candidate / stale /
 * active twin) keeps its original source episode, so the turn is read from the newest `remember:episode <id>`
 * transition; a row BORN from the turn has no transition and its source_ref names the episode (memory-render).
 */
export function rememberEpisodeFor(db: SqlJsDatabase, memory: { id: string; statusReason: string | null }): string | null {
  if (memory.statusReason !== REMEMBER_STATUS_REASON) return null;
  const transitions = new TransitionRepository(db).listForMemory(memory.id);
  for (let index = transitions.length - 1; index >= 0; index -= 1) {
    const episodeId = rememberEpisodeOfReason(transitions[index]!.reason);
    if (episodeId !== null) return episodeId;
  }
  return null;
}

export async function runMemoryShow(ctx: CommandContext): Promise<number> {
  return guard(ctx, async () => {
    const ref = requirePositional(ctx, 0, "id");
    const { memory, proposals, rememberEpisodeId } = await readDb(ctx, (db) => {
      const memory = resolveMemory(db, ref);
      return { memory, proposals: new ProposalRepository(db).listForMemory(memory.id), rememberEpisodeId: rememberEpisodeFor(db, memory) };
    });
    const report: MemoryShowReport = { memory: memoryToJson(memory), proposals, ...(memory.statusReason === REMEMBER_STATUS_REASON ? { remember_episode_id: rememberEpisodeId } : {}) };
    ctx.out.result(report, () => renderMemoryDetail(memory, { proposals, rememberEpisodeId }));
    return EXIT_CODES.ok;
  });
}
