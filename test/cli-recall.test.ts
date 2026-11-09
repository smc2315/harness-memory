/**
 * `hm recall <query> [--limit <n>] [--since <iso>] [--json]`: searches the recall snapshot when it is fresh,
 * falls back to the database (and says so) when the snapshot is stale, prints date / session / kind / summary
 * with the `hm trace` hint, honours --limit and --since, refuses a missing query, reports `recall.enabled = false`.
 * Recall ships dark (`DEFAULT_CONFIG.recall.enabled = false`): the tests of the enabled layer switch it on in the
 * project's config.json; the last test proves the default end to end (no recall file, no RECALL line, `hm recall` off).
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { createRuntime, runHook } from "../src/adapters/hook-core";
import { normalizeClaudeCode } from "../src/adapters/hosts/claude-code";
import type { RecallReport } from "../src/cli/commands/recall";
import type { StatusReport } from "../src/cli/commands/status";
import { DEFAULT_CONFIG, loadConfig } from "../src/core/config";
import type { ClaudeCodeHookStdin } from "../src/core/hook-types";
import { sessionKey } from "../src/core/paths";
import type { ActiveSnapshot, RecallEpisode, RecallSnapshot } from "../src/core/snapshot-types";
import { EpisodeRepository } from "../src/db/repositories/episodes";
import { buildRecallSnapshot } from "../src/db/snapshot";
import { createCliProject, runHm, type CliProject } from "./helpers/cli-run";
import { CLI_NOW, clockOptions, readProject, seedProject } from "./helpers/cli-seed";
import { insertEpisode } from "./helpers/memory-fixtures";

let project: CliProject;

beforeEach(() => {
  project = createCliProject();
});

afterEach(() => {
  project.cleanup();
});

async function install(): Promise<void> {
  const result = await runHm(project, ["install", "--host", "claude", "--skip-probe", "--skip-self-test"]);
  expect(result.code).toBe(0);
}

/**
 * Switches recall on in the project's config.json, keeping whatever `hm install` wrote there (a project without a
 * config yet gets the minimal file). Called before `seedEpisodes`, whose store write builds the snapshot with the file's config.
 */
function enableRecall(target: CliProject = project): void {
  let current: Record<string, unknown> = { schema: "config.v1" };
  try {
    current = JSON.parse(readFileSync(target.paths.config, "utf8")) as Record<string, unknown>;
  } catch {
    mkdirSync(target.paths.dir, { recursive: true });
  }
  const recall = typeof current.recall === "object" && current.recall !== null ? (current.recall as Record<string, unknown>) : {};
  writeFileSync(target.paths.config, `${JSON.stringify({ ...current, recall: { ...recall, enabled: true } }, null, 2)}\n`, "utf8");
}

async function seedEpisodes(): Promise<void> {
  await seedProject(project, (db) => {
    const episodes = new EpisodeRepository(db);
    insertEpisode(db, { id: "ep-pnpm", session_id: "sess-a", closed_at: "2026-11-06T09:00:00.000Z", tools: ["bash"], scope_refs: [], failure_signatures: [{ sig: "bash|exit_1|pm test", class: "exit_1", tool: "bash", scope_ref: null, program_token: "pm test", failed_seq: 2, resolved_seq: 4 }] }, CLI_NOW);
    episodes.setSummary("ep-pnpm", '"run the tests" | failed exit_1 pm test → resolved | tools bash×3', "extracted");
    insertEpisode(db, { id: "ep-seed", session_id: "sess-b", closed_at: "2026-11-02T09:00:00.000Z", scope_refs: ["scripts/seed.ts"] }, CLI_NOW);
    episodes.setSummary("ep-seed", '"테스트 전에 시드 스크립트를 실행해야 한다" [correction] | tools bash×2 | files scripts/seed.ts', "derived");
    insertEpisode(db, { id: "ep-docs", session_id: "sess-c", closed_at: "2026-11-04T09:00:00.000Z", scope_refs: ["docs/release.md"] }, CLI_NOW);
    episodes.setSummary("ep-docs", '"write the release notes" | tools edit×4 | files docs/release.md', "derived");
    insertEpisode(db, { id: "ep-none", session_id: "sess-d", closed_at: "2026-11-05T09:00:00.000Z" }, CLI_NOW);
  });
}

describe("hm recall", () => {
  test("searches the fresh snapshot and prints date, session, kind, summary and the trace hint", async () => {
    await install();
    enableRecall();
    await seedEpisodes();
    const text = await runHm(project, ["recall", "npm test fails"], clockOptions());
    expect(text.code).toBe(0);
    const lines = text.stdout.trimEnd().split("\n");
    expect(lines[0]).toBe('recall "npm test fails": 1 of 3 episodes (source: snapshot)');
    expect(lines[1]).toMatch(/^ {2}2026-11-06 {2}claude-code-[0-9a-f]{16} {2}\[extracted 0\.\d\d\] {2}"run the tests" \| failed exit_1 pm test → resolved \| tools bash×3$/);
    expect(lines[lines.length - 1]).toMatch(/^hint: hm trace <session> \(e\.g\. hm trace claude-code-[0-9a-f]{16}\) shows the full ledger of a session$/);

    const json = await runHm(project, ["recall", "시드 스크립트", "--json"], clockOptions());
    expect(json.code).toBe(0);
    const report = json.json<RecallReport>();
    expect(report).toMatchObject({ query: "시드 스크립트", enabled: true, source: "snapshot", source_reason: null, since: null, limit: 10, searched: 3 });
    expect(report.hits).toHaveLength(1);
    expect(report.hits[0]).toMatchObject({ episode_id: "ep-seed", host: "claude-code", session_key: sessionKey("claude-code", "sess-b"), session: `claude-code-${sessionKey("claude-code", "sess-b")}`, date: "2026-11-02", kind: "derived" });
    expect(report.hits[0]!.score).toBeGreaterThan(0.5);
  });

  test("--limit and --since narrow the result; the hint is omitted when nothing matches", async () => {
    await install();
    enableRecall();
    await seedEpisodes();
    const all = await runHm(project, ["recall", "tests release seed", "--json"], clockOptions());
    expect(all.json<RecallReport>().hits.length).toBeGreaterThanOrEqual(2);
    const limited = await runHm(project, ["recall", "tests release seed", "--limit", "1", "--json"], clockOptions());
    expect(limited.json<RecallReport>().hits).toHaveLength(1);
    const since = await runHm(project, ["recall", "tests release seed", "--since", "2026-11-05T00:00:00Z", "--json"], clockOptions());
    const sinceReport = since.json<RecallReport>();
    expect(sinceReport.since).toBe("2026-11-05T00:00:00.000Z");
    expect(sinceReport.searched).toBe(1);
    expect(sinceReport.hits.map((hit) => hit.episode_id)).toEqual(["ep-pnpm"]);
    const none = await runHm(project, ["recall", "pancakes"], clockOptions());
    expect(none.code).toBe(0);
    expect(none.stdout).toContain("(no matching episode)");
    expect(none.stdout).not.toContain("hint:");
  });

  test("falls back to the database when the snapshot is stale and says why", async () => {
    await install();
    enableRecall();
    await seedEpisodes();
    appendFileSync(project.paths.db, Buffer.alloc(4096));
    const result = await runHm(project, ["recall", "release notes", "--json"], clockOptions());
    expect(result.code).toBe(0);
    const report = result.json<RecallReport>();
    expect(report.source).toBe("database");
    expect(report.source_reason).toBe("snapshot stale");
    expect(report.searched).toBe(3);
    expect(report.hits[0]).toMatchObject({ episode_id: "ep-docs", kind: "derived" });
    const text = await runHm(project, ["recall", "release notes"], clockOptions());
    expect(text.stdout.split("\n")[0]).toBe('recall "release notes": 1 of 3 episodes (source: database — snapshot stale)');
  });

  test("usage errors, disabled recall and a missing database", async () => {
    await install();
    const missingQuery = await runHm(project, ["recall"]);
    expect(missingQuery.code).toBe(2);
    expect(missingQuery.stderr).toContain("missing <query>");
    const badLimit = await runHm(project, ["recall", "tests", "--limit", "0"]);
    expect(badLimit.code).toBe(2);
    const badSince = await runHm(project, ["recall", "tests", "--since", "yesterday"]);
    expect(badSince.code).toBe(2);
    expect(badSince.stderr).toContain("--since");

    // Disabled is the default: the config `hm install` wrote carries `recall.enabled = false` and nothing switched it on.
    expect(loadConfig(project.paths.config).recall.enabled).toBe(false);
    const disabled = await runHm(project, ["recall", "tests"]);
    expect(disabled.code).toBe(0);
    expect(disabled.stdout).toContain("recall is disabled");
    const disabledJson = await runHm(project, ["recall", "tests", "--json"]);
    expect(disabledJson.json<RecallReport>()).toMatchObject({ enabled: false, source: null, hits: [] });

    const fresh = createCliProject();
    try {
      // With recall on the database is consulted, so its absence is the error.
      enableRecall(fresh);
      const none = await runHm(fresh, ["recall", "tests"]);
      expect(none.code).toBe(1);
      expect(none.stderr).toContain("no database");
    } finally {
      fresh.cleanup();
    }
  });
});

describe("hm status and hm snapshot:rebuild with the recall layer", () => {
  test("hm status reports `recall N episodes` between snapshot and p95 once a summarized episode exists; the part is hidden at zero and when recall is off", async () => {
    await install();
    enableRecall();
    const empty = await runHm(project, ["status", "--json"], clockOptions());
    expect(empty.code).toBe(0);
    const emptyReport = empty.json<StatusReport>();
    expect(emptyReport.recall).toEqual({ enabled: true, episodes: 0 });
    expect(emptyReport.line).not.toContain("recall");

    await seedEpisodes();
    const text = await runHm(project, ["status"], clockOptions());
    expect(text.code).toBe(0);
    // `queue` counts queue files (none here: the episodes were inserted into the database directly).
    expect(text.stdout.split("\n")[0]).toBe("active 0 (auto 0) | candidates 0 | proposals 0 | queue 0 | last extraction never | probe none | snapshot fresh | recall 3 episodes | p95 -");
    const json = await runHm(project, ["status", "--json"], clockOptions());
    expect(json.code).toBe(0);
    expect(json.json<StatusReport>().recall).toEqual({ enabled: true, episodes: 3 });

    writeFileSync(project.paths.config, JSON.stringify({ schema: "config.v1", recall: { enabled: false } }), "utf8");
    const off = await runHm(project, ["status", "--json"], clockOptions());
    expect(off.code).toBe(0);
    const offReport = off.json<StatusReport>();
    expect(offReport.recall).toEqual({ enabled: false, episodes: 0 });
    expect(offReport.line).not.toContain("recall");
  });

  test("hm snapshot:rebuild writes recall.v1.json next to active.v1.json and lexical.v1.json", async () => {
    await install();
    enableRecall();
    await seedEpisodes();
    rmSync(project.paths.snapshotRecall, { force: true });
    expect(existsSync(project.paths.snapshotRecall)).toBe(false);
    const result = await runHm(project, ["snapshot:rebuild"], clockOptions());
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("snapshot rebuilt");
    expect(existsSync(project.paths.snapshotRecall)).toBe(true);
    const recall = JSON.parse(readFileSync(project.paths.snapshotRecall, "utf8")) as RecallSnapshot;
    expect(recall.schema).toBe("recall.v1");
    expect(recall.episodes.map((episode) => episode.id)).toEqual(["ep-pnpm", "ep-docs", "ep-seed"]);
    // `recall.v1.json` is a derived file: a rebuild after switching recall off removes it again.
    writeFileSync(project.paths.config, JSON.stringify({ schema: "config.v1", recall: { enabled: false } }), "utf8");
    expect((await runHm(project, ["snapshot:rebuild"], clockOptions())).code).toBe(0);
    expect(existsSync(project.paths.snapshotRecall)).toBe(false);
  });
});

describe("recall ships dark", () => {
  test("default config: the snapshot builder writes no recall.v1.json, UserPromptSubmit injects no RECALL line, hm recall and hm status report recall off", async () => {
    await install();
    // The default itself, and `hm install` writes the defaults verbatim; nothing below switches recall on.
    expect(DEFAULT_CONFIG.recall).toEqual({ enabled: false, keep_episodes: 300 });
    expect(loadConfig(project.paths.config).recall).toEqual(DEFAULT_CONFIG.recall);

    // The store's build after a write and an explicit rebuild both leave the recall file out …
    await seedEpisodes();
    expect(existsSync(project.paths.snapshotActive)).toBe(true);
    expect(existsSync(project.paths.snapshotLexical)).toBe(true);
    expect(existsSync(project.paths.snapshotRecall)).toBe(false);
    const rebuilt = await runHm(project, ["snapshot:rebuild", "--json"], clockOptions());
    expect(rebuilt.code).toBe(0);
    expect(existsSync(project.paths.snapshotRecall)).toBe(false);
    // … while the summaries are stored all the same: switching recall on later needs only a rebuild, not a re-extraction.
    expect(await readProject(project, (db) => new EpisodeRepository(db).countWithSummary())).toBe(3);

    // The real prompt hook over the same project injects no RECALL line — even with a recall file left behind by an
    // enabled build, holding the episode the enabled hook tests recall for this very prompt.
    const active = JSON.parse(readFileSync(project.paths.snapshotActive, "utf8")) as ActiveSnapshot;
    const leftover: RecallEpisode = {
      id: "ep-pnpm",
      session_key: sessionKey("claude-code", "sess-a"),
      host: "claude-code",
      closed_at: "2026-11-06T09:00:00.000Z",
      summary: '"run the tests" | failed exit_1 pm test → resolved | tools bash×3',
      summary_kind: "extracted",
      tools: ["bash"],
      scope_refs: [],
      failure_classes: ["exit_1"],
    };
    writeFileSync(project.paths.snapshotRecall, JSON.stringify(buildRecallSnapshot({ builtAt: CLI_NOW, dbGeneration: active.db_generation, episodes: [leftover] })), "utf8");
    const runtime = createRuntime(project.paths, loadConfig(project.paths.config), { clock: () => CLI_NOW, spawnWorker: null });
    const stdin: ClaudeCodeHookStdin = {
      session_id: "sess-new",
      transcript_path: join(project.root, "transcript.jsonl"),
      cwd: project.root,
      hook_event_name: "UserPromptSubmit",
      permission_mode: "default",
      prompt: "npm test fails again — what fixed the tests last time?",
      prompt_id: "p-dark-1",
    };
    const prompt = await runHook("prompt", normalizeClaudeCode(stdin, "prompt")!, runtime);
    expect(prompt.status).toBe("ok");
    expect(prompt.detail.recall).toEqual([]);
    expect(prompt.additionalContext ?? "").not.toContain("RECALL");

    // `hm recall` reports the switch instead of searching (exit 0; the message names the config key) …
    const disabled = await runHm(project, ["recall", "npm test fails"], clockOptions());
    expect(disabled.code).toBe(0);
    expect(disabled.stdout).toContain("recall is disabled (config.json: recall.enabled = false)");
    expect(disabled.stdout).not.toContain("hint:");
    const disabledJson = await runHm(project, ["recall", "npm test fails", "--json"], clockOptions());
    expect(disabledJson.code).toBe(0);
    expect(disabledJson.json<RecallReport>()).toMatchObject({ query: "npm test fails", enabled: false, source: null, source_reason: null, searched: 0, hits: [], hint: null });
    // … and `hm status` hides the recall part although three summarized episodes exist.
    const status = await runHm(project, ["status", "--json"], clockOptions());
    expect(status.code).toBe(0);
    const statusReport = status.json<StatusReport>();
    expect(statusReport.recall).toEqual({ enabled: false, episodes: 0 });
    expect(statusReport.line).not.toContain("recall");
  });
});
