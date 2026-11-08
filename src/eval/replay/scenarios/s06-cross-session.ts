/**
 * s06 — (§13.2 (c), §13.1 s06) session A learns a bash-only pitfall whose signature names the manager that
 * failed (`npm test`); in session B it fires on the path-less `npm test`, `npm run test` and the PowerShell
 * `& npm.cmd test`, and NOT on `pnpm test` / `yarn test`: the fix the user asked for is never blocked
 * (verification round — a literal manager in a cmd pattern pins it). A seeded advise row written with the
 * family form `pm test` still fires on every manager, and `npm run build` is a signature_mismatch for both
 * (scope alone never rescues a signatured row).
 */

import { defineScenario } from "../scenario";
import { autoRow, cmdSignature } from "./seeds";
import { suppressionKindOf } from "./util";

const FAMILY = "mem-family";

const VARIANTS: Array<{ turn: string; command: string; learnedFires: boolean }> = [
  { turn: "p61", command: "npm test", learnedFires: true },
  { turn: "p62", command: "pnpm test", learnedFires: false },
  { turn: "p63", command: "yarn test", learnedFires: false },
  { turn: "p64", command: "npm run test", learnedFires: true },
];

function sorted(values: readonly string[] | undefined): string[] | null {
  return values === undefined ? null : [...values].sort();
}

export const s06 = defineScenario({
  id: "s06",
  title: "a pitfall learned in session A fires on the manager it names in session B; the family form covers every manager",
  asserts: ["c", "13.1:s06", "13.1:powershell"],
  async run(run) {
    const learn = await run.turn("A", "s01-correction-only.jsonl");
    run.checkTurn(learn);
    const result = await run.extract({ outputs: "s01.outputs.json" });
    run.checkWorker(result, "extract", { processed: 1, statuses: ["ok"] });
    const id = run.createdFor("A", "p1")[0];
    if (id === undefined) {
      run.fail("(c) session A learned a pitfall", "nothing created");
      return;
    }
    const learned = await run.memory(id);
    run.equal("(c) the learned signature names the manager that failed", learned?.signatureKey, "bash|command|cmd|npm test");

    await run.seed([
      autoRow({ id: FAMILY, summary: "Run the test suite from packages/api whichever package manager drives it.", signature: cmdSignature("pm test"), enforcement: "advise" }),
    ]);

    run.advance({ minutes: 5 });
    for (const variant of VARIANTS) {
      const turn = await run.turn("B", "s06-cross-session.jsonl", { turnKey: variant.turn });
      run.checkTurn(turn);
      const pre = turn.calls.find((call) => call.event === "pre-tool");
      const expectedActivated = variant.learnedFires ? [FAMILY, id].sort() : [FAMILY];
      run.equal(
        `(c) \`${variant.command}\` in session B → ${variant.learnedFires ? "deny by the learned pitfall (plus the family advise)" : "the family advise only; the learned npm pitfall stays quiet"}`,
        [pre?.result?.decision, sorted(pre?.result?.activated)],
        [variant.learnedFires ? "deny" : "none", expectedActivated]
      );
      if (!variant.learnedFires) {
        run.equal(`(c) \`${variant.command}\`: the learned pitfall is a signature_mismatch`, pre === undefined ? null : suppressionKindOf(pre, id), "signature_mismatch");
      }
      const fired = turn.producedLines.filter((line) => line.kind === "fired");
      const expectedKeys = variant.learnedFires ? ["bash|command|cmd|npm test", "bash|command|cmd|pm test"] : ["bash|command|cmd|pm test"];
      run.equal(`(c) \`${variant.command}\` left one fired line with the canonical keys`, fired.map((line) => (line.kind === "fired" ? sorted(line.signature_keys) : null)), [expectedKeys]);
    }

    const mismatch = await run.turn("B", "s06-cross-session.jsonl", { turnKey: "p65" });
    run.checkTurn(mismatch);
    const mismatchPre = mismatch.calls.find((call) => call.event === "pre-tool");
    run.equal("s06: `npm run build` fires nothing", [mismatchPre?.result?.decision, mismatchPre?.result?.activated], ["none", []]);
    run.equal("s06: the suppression kind is signature_mismatch", mismatchPre === undefined ? null : suppressionKindOf(mismatchPre, id), "signature_mismatch");
    run.equal("s06: no fired line was written for the mismatch", mismatch.producedLines.filter((line) => line.kind === "fired").length, 0);

    const powershell = await run.turn("B", "s06-cross-session.jsonl", { turnKey: "p66" });
    run.checkTurn(powershell);
    const psPre = powershell.calls.find((call) => call.event === "pre-tool");
    run.equal("PowerShell `& npm.cmd test` → deny (canonical npm test)", [psPre?.result?.decision, psPre?.result?.tool, sorted(psPre?.result?.activated)], ["deny", "bash", [FAMILY, id].sort()]);

    const after = await run.memory(id);
    run.equal("the learned row is still active auto after firing", [after?.status, after?.authority], ["active", "auto"]);
  },
});
