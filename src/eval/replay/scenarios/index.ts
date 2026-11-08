/** The thirteen replay scenarios (spec §13.1–13.2 s01–s12, plus s13 for A′ remember-as-human), in order. */

import type { ReplayScenario } from "../scenario";
import { s01 } from "./s01-correction";
import { s02 } from "./s02-bare-failure";
import { s03 } from "./s03-env-confirm";
import { s04 } from "./s04-soft-deny-outcomes";
import { s05 } from "./s05-torn-tail";
import { s06 } from "./s06-cross-session";
import { s07 } from "./s07-powershell";
import { s08 } from "./s08-learn-and-apply";
import { s09 } from "./s09-lifecycle";
import { s10 } from "./s10-proposals";
import { s11 } from "./s11-reinforce";
import { s12 } from "./s12-budget";
import { s13 } from "./s13-remember";

export const REPLAY_SCENARIOS: readonly ReplayScenario[] = [s01, s02, s03, s04, s05, s06, s07, s08, s09, s10, s11, s12, s13];

export function findScenario(id: string): ReplayScenario | null {
  return REPLAY_SCENARIOS.find((scenario) => scenario.id === id) ?? null;
}
