/**
 * s05 — torn tail: the session ledger already holds > 256 KB, so every pre-tool / post-tool tail read
 * starts in the middle of a line. The hooks must stay `ok`, record the turn correctly, and a turn without
 * any signal is skipped by the worker (`no_signal`), never sent to the extractor.
 */

import { LEDGER_LIMITS, type ToolOkLine } from "../../../core/ledger-types";
import { EpisodeRepository } from "../../../db/repositories/episodes";
import { appendLedgerLine, makeSeq, readLedgerTailLines } from "../../../dream/ledger";
import { defineScenario } from "../scenario";
import { autoRow, cmdSignature } from "./seeds";

export const s05 = defineScenario({
  id: "s05",
  title: "torn tail read (> 256 KB ledger) and a no-signal turn",
  asserts: ["13.1:torn-tail", "5.3:no_signal"],
  async run(run) {
    await run.seed([autoRow({ id: "mem-tests", summary: "Run the suite with pnpm test; npm test has no script here.", signature: cmdSignature("npm test") })]);

    // A long-closed earlier turn: enough tool_ok lines with 2 KB outputs to push the tail read past its window.
    const ledger = run.ledgerPath("A");
    const filler = "x".repeat(LEDGER_LIMITS.output_head);
    let bytes = 0;
    for (let index = 0; bytes < LEDGER_LIMITS.tail_read_bytes + 64 * 1024; index += 1) {
      const line: ToolOkLine = {
        kind: "tool_ok",
        ts: run.now(),
        seq: makeSeq(run.nowMs()),
        turn_key: "p50",
        tool_use_id: `filler-${String(index)}`,
        tool: "bash",
        host_tool: "Bash",
        shell_dialect: "bash",
        input_digest: `echo ${String(index)}`,
        scope_refs: [],
        program_token: "echo",
        output_head: filler,
        output_tail: "",
        resolution_of: null,
      };
      bytes += appendLedgerLine(ledger, line);
    }
    const tail = readLedgerTailLines(ledger, LEDGER_LIMITS.tail_read_bytes);
    run.check("the tail window starts inside a line (torn first chunk)", tail.badLines >= 1 && tail.baseOffset > 0, `badLines=${String(tail.badLines)} base=${String(tail.baseOffset)}`);

    const turn = await run.turn("A", "s05-torn-tail.jsonl");
    run.checkTurn(turn);
    const statuses = turn.calls.map((call) => call.result?.status ?? "null");
    run.check("every hook call on the torn ledger reported ok", statuses.every((status) => status === "ok" || status === "skipped:no_tool"), statuses.join(","));
    run.equal("the episode holds exactly the turn's three lines", turn.descriptor?.event_count, 3);
    run.equal("scope_refs captured from the Read tool", turn.descriptor?.scope_refs, ["pnpm-lock.yaml"]);
    run.equal("a read-only turn has no signal", turn.descriptor?.evidence_weight, 0);

    // A soft_deny row still fires on the torn tail (the tail state is derived from the parsable remainder).
    const pre = await run.preTool("A", { tool: "Bash", command: "npm test" });
    run.equal("pre-tool on the torn tail still decides deny", pre.result?.decision, "deny");

    const result = await run.extract();
    run.checkWorker(result, "extract", { processed: 0 });
    run.equal("the no-signal episode was skipped", result.skipped, turn.episodeId === null ? [] : [turn.episodeId]);
    await run.read((db) => {
      const episode = turn.episodeId === null ? null : new EpisodeRepository(db).getById(turn.episodeId);
      run.equal("episode status skipped / no_signal", [episode?.status, episode?.skipReason], ["skipped", "no_signal"]);
    });
  },
});
