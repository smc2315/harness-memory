/**
 * `hm eval:replay` (spec §11, §13.1–13.2): drives the recorded ledger fixtures through the hook entry and
 * the worker with the replay provider and asserts the scenario outcomes. Placeholder registration; the
 * implementation lands in Phase C2.
 */

import type { CommandContext } from "../context";
import type { OptionSpecs } from "../lib/args";

export const evalReplayOptions: OptionSpecs = {};

export async function runEvalReplay(ctx: CommandContext): Promise<number> {
  ctx.stderr("eval:replay is not implemented in this build\n");
  return 2;
}
