/**
 * s06 — (§13.2 (c), §13.1 s06) session A learns a bash-only pitfall; in session B it fires on the
 * path-less `npm test`, `pnpm test`, `yarn test`, `npm run test` and on the PowerShell `& npm.cmd test`,
 * while `npm run build` is a signature_mismatch (scope alone never rescues a signatured row).
 */

import { defineScenario } from "../scenario";
import { suppressionKindOf } from "./util";

const VARIANTS: Array<{ turn: string; command: string }> = [
  { turn: "p61", command: "npm test" },
  { turn: "p62", command: "pnpm test" },
  { turn: "p63", command: "yarn test" },
  { turn: "p64", command: "npm run test" },
];

export const s06 = defineScenario({
  id: "s06",
  title: "a pitfall learned in session A fires on every test-command variant in session B",
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

    run.advance({ minutes: 5 });
    for (const variant of VARIANTS) {
      const turn = await run.turn("B", "s06-cross-session.jsonl", { turnKey: variant.turn });
      run.checkTurn(turn);
      const pre = turn.calls.find((call) => call.event === "pre-tool");
      run.equal(`(c) \`${variant.command}\` in session B → deny by the learned pitfall`, [pre?.result?.decision, pre?.result?.activated], ["deny", [id]]);
      const fired = turn.producedLines.filter((line) => line.kind === "fired");
      run.equal(`(c) \`${variant.command}\` left one fired line with the canonical key`, fired.map((line) => (line.kind === "fired" ? line.signature_keys : null)), [["bash|command|cmd|pm test"]]);
    }

    const mismatch = await run.turn("B", "s06-cross-session.jsonl", { turnKey: "p65" });
    run.checkTurn(mismatch);
    const mismatchPre = mismatch.calls.find((call) => call.event === "pre-tool");
    run.equal("s06: `npm run build` does not fire", [mismatchPre?.result?.decision, mismatchPre?.result?.activated], ["none", []]);
    run.equal("s06: the suppression kind is signature_mismatch", mismatchPre === undefined ? null : suppressionKindOf(mismatchPre, id), "signature_mismatch");
    run.equal("s06: no fired line was written for the mismatch", mismatch.producedLines.filter((line) => line.kind === "fired").length, 0);

    const powershell = await run.turn("B", "s06-cross-session.jsonl", { turnKey: "p66" });
    run.checkTurn(powershell);
    const psPre = powershell.calls.find((call) => call.event === "pre-tool");
    run.equal("PowerShell `& npm.cmd test` → deny (canonical pm test)", [psPre?.result?.decision, psPre?.result?.tool, psPre?.result?.activated], ["deny", "bash", [id]]);

    const learned = await run.memory(id);
    run.equal("the learned row is still active auto after firing", [learned?.status, learned?.authority], ["active", "auto"]);
  },
});
