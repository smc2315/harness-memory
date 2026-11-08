/**
 * `hm eval:latency` (spec §11, §13.3): spawns `dist/hook.js pre-tool` against a generated 300-memory
 * fixture and reports min/p50/p95/max. Placeholder registration; the implementation lands in Phase C2.
 */

import type { CommandContext } from "../context";
import type { OptionSpecs } from "../lib/args";

export const evalLatencyOptions: OptionSpecs = {};

export async function runEvalLatency(ctx: CommandContext): Promise<number> {
  ctx.stderr("eval:latency is not implemented in this build\n");
  return 2;
}
