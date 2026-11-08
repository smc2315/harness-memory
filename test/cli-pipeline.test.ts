/**
 * `hm queue`, `hm extract` (replay provider, in-process worker), `hm dream`, `hm trace` and `hm memory:why`
 * (spec §9.3, §9.4 F3, §6.2, §11) against a temp `.harness-memory` created through the Store.
 */

import { existsSync, rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import type { ExtractDryRunReport } from "../src/cli/commands/extract";
import type { MemoryListReport } from "../src/cli/commands/memory-list";
import type { MemoryWhyReport } from "../src/cli/commands/memory-why";
import type { QueueListReport, QueueMutationReport, QueueShowReport } from "../src/cli/commands/queue";
import type { TraceReport } from "../src/cli/commands/trace";
import { createSessionState, writeQueueFile, writeSessionState } from "../src/adapters/session-state";
import type { EpisodeDescriptor } from "../src/core/episode-types";
import type { LedgerLine } from "../src/core/ledger-types";
import { ledgerFile, queueFile, sessionKey, stateFile } from "../src/core/paths";
import { EpisodeRepository } from "../src/db/repositories/episodes";
import { buildEpisodeDescriptor } from "../src/dream/episode";
import { buildExtractionPrompt } from "../src/dream/extract/prompt";
import { createReplayProvider } from "../src/dream/extract/providers";
import { appendLedgerLine } from "../src/dream/ledger";
import type { WorkerResult } from "../src/dream/worker";
import { MemoryRepository } from "../src/memory/repository";
import { createCliProject, runHm, type CliProject } from "./helpers/cli-run";
import { CLI_NOW, clockOptions, readProject, seedProject } from "./helpers/cli-seed";
import { assistantLine, loadLedgerFixture, promptLine, toolFailLine, toolOkLine, withOffsets } from "./helpers/ledger-fixture";
import { autoMemory, humanMemory, insertEpisode } from "./helpers/memory-fixtures";
import { factFixture, outputFixture } from "./helpers/replay-run";

let project: CliProject;

beforeEach(() => {
  project = createCliProject();
});

afterEach(() => {
  project.cleanup();
});

const SESSION_ID = "session-cli-1";
const SESSION_KEY = sessionKey("claude-code", SESSION_ID);

/** Appends the lines to the session ledger and queues the descriptor the stop hook would have written. */
function queueFromLedger(lines: readonly LedgerLine[], now: string = CLI_NOW): EpisodeDescriptor {
  const file = ledgerFile(project.paths, "claude-code", SESSION_KEY);
  for (const line of lines) appendLedgerLine(file, line);
  const offsets = withOffsets(lines, 0);
  const last = offsets[offsets.length - 1]!;
  const descriptor = buildEpisodeDescriptor({
    host: "claude-code",
    sessionId: SESSION_ID,
    sessionKey: SESSION_KEY,
    turnKey: lines[0]!.turn_key,
    segment: 0,
    lines,
    byteStart: 0,
    byteEnd: last.offset + last.length,
    ledgerFileName: `claude-code-${SESSION_KEY}.jsonl`,
    closeReason: "stop",
    now,
  });
  writeQueueFile(project.paths, descriptor);
  return descriptor;
}

const s01 = loadLedgerFixture("s01-correction-only.jsonl").lines.filter((line) => line.turn_key === "p1");

/** The `e<…>` ref the extraction prompt gives the s01 prompt line (independent of the numbering scheme). */
function promptRefOf(descriptor: EpisodeDescriptor, lines: readonly LedgerLine[]): string {
  const built = buildExtractionPrompt({ descriptor, lines, host: "claude-code" });
  const entry = [...built.seqMap.entries()].find(([, line]) => line.kind === "prompt");
  if (entry === undefined) throw new Error("the prompt line is not citable");
  return entry[0];
}

describe("hm queue", () => {
  test("lists queue files and episodes, shows one, retries failed/dead rows and drops files or rows", async () => {
    let failedId = "";
    let deadId = "";
    let extractedId = "";
    await seedProject(project, (db) => {
      const episodes = new EpisodeRepository(db);
      failedId = insertEpisode(db, { session_id: "s-failed" }, CLI_NOW).id;
      episodes.markFailed(failedId, "provider timed out", { retryAt: "2026-11-09T00:00:00.000Z" });
      deadId = insertEpisode(db, { session_id: "s-dead" }, CLI_NOW).id;
      episodes.markFailed(deadId, "gave up", { retryAt: null, dead: true });
      db.run("UPDATE episodes SET attempt_count = 3 WHERE id = ?", [deadId]);
      extractedId = insertEpisode(db, { session_id: "s-done" }, CLI_NOW).id;
      episodes.markExtracted(extractedId, "run-done");
    });
    const pending = queueFromLedger(s01);

    const list = await runHm(project, ["queue", "--json"], clockOptions());
    expect(list.code).toBe(0);
    const report = list.json<QueueListReport>();
    expect(report.files).toHaveLength(1);
    expect(report.files[0]).toMatchObject({ id: pending.id, eligible: true, inserted: false });
    expect(report.episodes.map((episode) => episode.status).sort()).toEqual(["dead", "failed"]);
    expect(report.counts).toMatchObject({ failed: 1, dead: 1, extracted: 1 });
    const text = await runHm(project, ["queue", "list"], clockOptions());
    expect(text.stdout).toContain("pending queue files");
    expect(text.stdout).toContain("provider timed out");

    const shown = await runHm(project, ["queue", "show", failedId.slice(0, 8), "--json"]);
    expect(shown.code).toBe(0);
    expect(shown.json<QueueShowReport>().episode?.id).toBe(failedId);
    const shownFile = await runHm(project, ["queue", "show", pending.id, "--json"]);
    expect(shownFile.json<QueueShowReport>()).toMatchObject({ episode: null, queue_file: queueFile(project.paths, pending.id) });
    expect(shownFile.json<QueueShowReport>().descriptor?.id).toBe(pending.id);

    const retried = await runHm(project, ["queue", "retry", failedId, "--json"], clockOptions());
    expect(retried.code).toBe(0);
    expect(retried.json<QueueMutationReport>()).toMatchObject({ action: "retry", before: "failed", after: "queued" });
    const retriedDead = await runHm(project, ["queue", "retry", deadId, "--json"], clockOptions());
    expect(retriedDead.json<QueueMutationReport>()).toMatchObject({ before: "dead", after: "queued" });
    const deadRow = await readProject(project, (db) => new EpisodeRepository(db).getById(deadId));
    expect(deadRow).toMatchObject({ status: "queued", attemptCount: 0, nextAttemptAt: CLI_NOW });
    const retryDone = await runHm(project, ["queue", "retry", extractedId]);
    expect(retryDone.code).toBe(1);
    expect(retryDone.stderr).toContain("extracted");

    const droppedFile = await runHm(project, ["queue", "drop", pending.id, "--json"], clockOptions());
    expect(droppedFile.code).toBe(0);
    expect(droppedFile.json<QueueMutationReport>().removed_file).toBe(queueFile(project.paths, pending.id));
    expect(existsSync(queueFile(project.paths, pending.id))).toBe(false);
    const droppedRow = await runHm(project, ["queue", "drop", failedId, "--json"], clockOptions());
    expect(droppedRow.json<QueueMutationReport>()).toMatchObject({ before: "queued", after: "skipped" });
    expect(await readProject(project, (db) => new EpisodeRepository(db).getById(failedId)?.skipReason)).toBe("dropped");

    expect((await runHm(project, ["queue", "drop", "nothing-here"])).code).toBe(1);
    expect((await runHm(project, ["queue", "retry"])).code).toBe(2);
    expect((await runHm(project, ["queue", "flush"])).code).toBe(2);
  });
});

describe("hm extract / hm dream", () => {
  test("--dry-run lists pending files and due episodes; extract runs the worker in-process with the replay provider", async () => {
    await seedProject(project, () => {});
    const descriptor = queueFromLedger(s01);
    const provider = createReplayProvider({ answers: { [descriptor.id]: outputFixture([factFixture({ evidence_refs: [promptRefOf(descriptor, s01)] })]) } });

    const dry = await runHm(project, ["extract", "--dry-run", "--json"], clockOptions(CLI_NOW, { seams: { provider } }));
    expect(dry.code).toBe(0);
    const dryReport = dry.json<ExtractDryRunReport>();
    expect(dryReport.provider).toBe("replay");
    expect(dryReport.queue_files).toHaveLength(1);
    expect(dryReport.queue_files[0]).toMatchObject({ id: descriptor.id, eligible: true, inserted: false });
    expect(dryReport.due).toEqual([]);
    expect(existsSync(queueFile(project.paths, descriptor.id))).toBe(true);

    const run = await runHm(project, ["extract", "--now", "--json"], clockOptions(CLI_NOW, { seams: { provider } }));
    expect(run.code).toBe(0);
    const result = run.json<WorkerResult>();
    expect(result.command).toBe("extract");
    expect(result.inserted).toBe(1);
    expect(result.processed).toHaveLength(1);
    expect(result.processed[0]).toMatchObject({ episodeId: descriptor.id, status: "ok", created: [expect.any(String)], activated: [expect.any(String)] });
    expect(existsSync(queueFile(project.paths, descriptor.id))).toBe(false);
    const memories = (await runHm(project, ["memory:list", "--json"])).json<MemoryListReport>();
    expect(memories.memories).toHaveLength(1);
    expect(memories.memories[0]).toMatchObject({ status: "active", authority: "auto", type: "pitfall", enforcement: "soft_deny" });
    const text = await runHm(project, ["extract"], clockOptions(CLI_NOW, { seams: { provider } }));
    expect(text.code).toBe(0);
    expect(text.stdout).toContain("extract: provider replay");
  });

  test("without a provider the episodes wait and the guidance is printed; unknown --provider is a usage error", async () => {
    await seedProject(project, () => {});
    queueFromLedger(s01);
    const result = await runHm(project, ["extract", "--json"], clockOptions(CLI_NOW, { seams: { provider: null } }));
    expect(result.code).toBe(0);
    const report = result.json<WorkerResult>();
    expect(report.inserted).toBe(1);
    expect(report.processed).toEqual([]);
    expect(report.waiting).toEqual({ count: 1, reason: "no_provider" });
    const text = await runHm(project, ["extract"], clockOptions(CLI_NOW, { seams: { provider: null } }));
    expect(text.stdout).toContain("no extraction CLI found");
    expect((await runHm(project, ["extract", "--provider", "nope"])).code).toBe(2);
    // Without the test seam the flag is resolved for real: opencode has no provider in this release.
    const opencode = await runHm(project, ["extract", "--provider", "opencode"], { seams: { provider: undefined } });
    expect(opencode.code).toBe(1);
    expect(opencode.stderr).toContain("not available");
  });

  test("extract refuses to run without a database; dream runs consolidation and reports", async () => {
    const missing = await runHm(project, ["extract"], clockOptions(CLI_NOW, { seams: { provider: null } }));
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("no database");

    await seedProject(project, (db) => {
      // A convention row: an expired TTL stales it (correction rows get a revalidate proposal instead, §5.8).
      new MemoryRepository(db, { clock: () => CLI_NOW }).create(autoMemory({ summary: "Expired auto row for dream", status: "active", knowledgeKind: "convention", ttlExpiresAt: "2026-11-01T00:00:00.000Z" }));
    });
    const dream = await runHm(project, ["dream", "--json"], clockOptions(CLI_NOW, { seams: { provider: null } }));
    expect(dream.code).toBe(0);
    const result = dream.json<WorkerResult>();
    expect(result.command).toBe("dream");
    expect(result.dream).not.toBeNull();
    expect(result.dream!.staled).toHaveLength(1);
    const text = await runHm(project, ["dream"], clockOptions(CLI_NOW, { seams: { provider: null } }));
    expect(text.stdout).toContain("dream:");
  });
});

describe("hm trace", () => {
  test("prints the ledger timeline grouped by turn with the state and the session's episodes", async () => {
    const lines: LedgerLine[] = [
      promptLine("fix the failing build", { turn_key: "t1", seq: 1 }),
      toolFailLine("npm run build", "Exit code 1\nmissing script", { turn_key: "t1", seq: 2 }),
      toolOkLine("pnpm run build", { turn_key: "t1", seq: 3 }),
      assistantLine("Built with pnpm.", { turn_key: "t1", seq: 4 }),
      promptLine("now run the tests", { turn_key: "t2", seq: 5 }),
    ];
    const file = ledgerFile(project.paths, "claude-code", SESSION_KEY);
    let offset = 0;
    for (const line of lines) offset += appendLedgerLine(file, line);
    const state = createSessionState("claude-code", SESSION_ID, SESSION_KEY, CLI_NOW);
    writeSessionState(stateFile(project.paths, "claude-code", SESSION_KEY), { ...state, turn_key: "t2", segment: 1, turn_start_offset: offset });
    await seedProject(project, (db) => {
      insertEpisode(db, { session_id: SESSION_ID, turn_key: "t1" }, CLI_NOW);
    });

    const traced = await runHm(project, ["trace", SESSION_KEY, "--json"]);
    expect(traced.code).toBe(0);
    const report = traced.json<TraceReport>();
    expect(report).toMatchObject({ host: "claude-code", session_key: SESSION_KEY, total_lines: 5, bad_lines: 0 });
    expect(report.state?.session_id).toBe(SESSION_ID);
    expect(report.lines.map((line) => line.kind)).toEqual(["prompt", "tool_fail", "tool_ok", "assistant", "prompt"]);
    expect(report.episodes).toHaveLength(1);

    const text = await runHm(project, ["trace", `claude-code-${SESSION_KEY}`]);
    expect(text.stdout).toContain("--- turn t1 ---");
    expect(text.stdout).toContain("--- turn t2 ---");
    expect(text.stdout).toContain("tool_fail bash");
    const limited = (await runHm(project, ["trace", SESSION_ID, "--limit", "2", "--json"])).json<TraceReport>();
    expect(limited.lines).toHaveLength(2);
    expect(limited.lines[0]!.kind).toBe("assistant");

    const unknown = await runHm(project, ["trace", "0123456789abcdef"]);
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain(`claude-code-${SESSION_KEY}`);
    expect((await runHm(project, ["trace"])).code).toBe(2);
  });
});

describe("hm memory:why", () => {
  test("replays the before_tool decision over the snapshot and explains suppressions", async () => {
    let pitfallId = "";
    let policyId = "";
    await seedProject(project, (db) => {
      const memories = new MemoryRepository(db, { clock: () => CLI_NOW });
      pitfallId = memories.create(
        autoMemory({
          summary: "Run pnpm test instead of npm test",
          status: "active",
          enforcement: "soft_deny",
          triggerSignature: { tool: "bash", target: "command", pattern_kind: "cmd", pattern: "npm test" },
          signatureKey: "bash|command|cmd|pm test",
          relevantTools: ["bash"],
        })
      ).id;
      policyId = memories.create(
        humanMemory({
          summary: "Confirm before editing the lockfile",
          type: "policy",
          policySubtype: "hard",
          enforcement: "confirm",
          scopeGlob: "**/*",
          lifecycleTriggers: ["before_tool"],
          triggerSignature: { tool: "edit", target: "path", pattern_kind: "glob", pattern: "**/pnpm-lock.yaml" },
        })
      ).id;
    });

    const fired = await runHm(project, ["memory:why", "--tool", "Bash", "--target", "npm test", "--json"], clockOptions());
    expect(fired.code).toBe(0);
    const report = fired.json<MemoryWhyReport>();
    expect(report.tool).toEqual({ host_name: "Bash", canonical: "bash", dialect: "bash" });
    expect(report.snapshot.source).toBe("file");
    expect(report.decision.decision).toBe("deny");
    expect(report.decision.enforcement).toBe("soft_deny");
    expect(report.decision.activated.map((item) => item.id)).toEqual([pitfallId]);
    expect(report.decision.suppressed.find((entry) => entry.id === policyId)?.kind).toBe("signature_mismatch");
    expect(report.decision.fired?.signature_keys).toEqual(["bash|command|cmd|npm test"]);

    const miss = (await runHm(project, ["memory:why", "--tool", "bash", "--target", "npm run build", "--json"], clockOptions())).json<MemoryWhyReport>();
    expect(miss.decision.decision).toBe("none");
    expect(miss.decision.suppressed.find((entry) => entry.id === pitfallId)?.kind).toBe("signature_mismatch");

    const confirm = (await runHm(project, ["memory:why", "--tool", "Edit", "--target", "pnpm-lock.yaml", "--json"], clockOptions())).json<MemoryWhyReport>();
    expect(confirm.decision.decision).toBe("ask");
    expect(confirm.decision.activated.map((item) => item.id)).toEqual([policyId]);
    const downgraded = (await runHm(project, ["memory:why", "--tool", "Edit", "--target", "pnpm-lock.yaml", "--permission-mode", "bypassPermissions", "--json"], clockOptions())).json<MemoryWhyReport>();
    expect(downgraded.decision).toMatchObject({ decision: "deny", enforcement: "soft_deny", downgraded: true, delivery: "before_downgraded" });

    const text = await runHm(project, ["memory:why", "--tool", "Bash", "--target", "npm test"], clockOptions());
    expect(text.stdout).toContain("decision: deny (soft_deny)");
    expect(text.stdout).toContain("signature_mismatch");

    rmSync(project.paths.snapshotActive);
    const fromDb = (await runHm(project, ["memory:why", "--tool", "Bash", "--target", "npm test", "--json"], clockOptions())).json<MemoryWhyReport>();
    expect(fromDb.snapshot.source).toBe("database");
    expect(fromDb.decision.activated.map((item) => item.id)).toEqual([pitfallId]);

    expect((await runHm(project, ["memory:why", "--target", "npm test"])).code).toBe(2);
    expect((await runHm(project, ["memory:why", "--tool", "Bash"])).code).toBe(2);
    expect((await runHm(project, ["memory:why", "--tool", "Bash", "--input", "not json"])).code).toBe(2);
  });

  test("--session derives already_fired from the session's ledger tail", async () => {
    let pitfallId = "";
    await seedProject(project, (db) => {
      pitfallId = new MemoryRepository(db, { clock: () => CLI_NOW }).create(
        autoMemory({
          summary: "Run pnpm test instead of npm test",
          status: "active",
          enforcement: "soft_deny",
          triggerSignature: { tool: "bash", target: "command", pattern_kind: "cmd", pattern: "npm test" },
          signatureKey: "bash|command|cmd|pm test",
          relevantTools: ["bash"],
        })
      ).id;
    });
    const file = ledgerFile(project.paths, "claude-code", SESSION_KEY);
    appendLedgerLine(file, promptLine("run the tests", { turn_key: "t1", seq: 1 }));
    appendLedgerLine(file, {
      kind: "fired",
      ts: CLI_NOW,
      seq: 2,
      turn_key: "t1",
      memory_ids: [pitfallId],
      rule_codes: [],
      tool: "bash",
      target_digest: "npm test",
      delivery: "before",
      decision: "deny",
      enforcement: "soft_deny",
      signature_keys: ["bash|command|cmd|pm test"],
    });
    writeSessionState(stateFile(project.paths, "claude-code", SESSION_KEY), { ...createSessionState("claude-code", SESSION_ID, SESSION_KEY, CLI_NOW), turn_key: "t1", turn_start_offset: 0 });

    const report = (await runHm(project, ["memory:why", "--tool", "Bash", "--target", "npm test", "--session", SESSION_KEY, "--json"], clockOptions())).json<MemoryWhyReport>();
    expect(report.tail.fired_keys).toEqual([`${pitfallId}|bash`]);
    expect(report.decision.decision).toBe("none");
    expect(report.decision.suppressed.find((entry) => entry.id === pitfallId)?.kind).toBe("already_fired");
  });
});
