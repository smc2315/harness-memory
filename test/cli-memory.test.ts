/**
 * `hm memory:*` (spec §4.7, §7.1, §11): add (human candidate, --active, signature, duplicates), list filters,
 * show by prefix, promote / demote / reject / restore / enforce through transitionMemory with actor human,
 * history + trace (transitions, provenance, episodes), stats, export (deterministic SQL) and export-skill.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import type { MemoryAddReport } from "../src/cli/commands/memory-add";
import type { MemoryExportReport, MemoryExportSkillReport } from "../src/cli/commands/memory-export";
import type { MemoryHistoryReport, MemoryTraceReport } from "../src/cli/commands/memory-history";
import type { MemoryListReport } from "../src/cli/commands/memory-list";
import type { MemoryShowReport } from "../src/cli/commands/memory-show";
import type { MemoryStatsReport } from "../src/cli/commands/memory-stats";
import type { MemoryTransitionReport } from "../src/cli/commands/memory-transitions";
import { TARGET_USER_VERSION } from "../src/core/paths";
import { hasWriteOp } from "../src/db/meta";
import { ProvenanceRepository } from "../src/db/repositories/provenance";
import { TransitionRepository } from "../src/db/repositories/transitions";
import { MemoryRepository } from "../src/memory/repository";
import { rememberTransitionReason } from "../src/promotion/remember";
import { adoptActiveMemory } from "../src/promotion/transitions";
import { createCliProject, runHm, type CliProject } from "./helpers/cli-run";
import { CLI_NOW, clockOptions, readProject, seedProject } from "./helpers/cli-seed";
import { autoMemory, humanMemory, insertEpisode } from "./helpers/memory-fixtures";

let project: CliProject;

beforeEach(() => {
  project = createCliProject();
});

afterEach(() => {
  project.cleanup();
});

async function memoryById(id: string) {
  return readProject(project, (db) => new MemoryRepository(db).getById(id));
}

describe("hm memory:add", () => {
  // Mutations never conjure a database (install / db:migrate do); every test starts from an empty v22 store.
  beforeEach(async () => {
    await seedProject(project, () => {});
  });

  test("creates a human manual candidate with a compiled signature; --active promotes it through transitionMemory", async () => {
    const added = await runHm(project, ["memory:add", "--type", "pitfall", "--summary", "Run pnpm test instead of npm test in this repository", "--signature", "bash:command:cmd:npm test", "--json"], clockOptions());
    expect(added.code).toBe(0);
    const report = added.json<MemoryAddReport>();
    expect(report.memory).toMatchObject({ status: "candidate", authority: "human", sourceKind: "manual", knowledgeKind: "manual", enforcement: "advise", activationClass: "event", lifecycleTriggers: ["before_tool"] });
    expect(report.memory.triggerSignature).toEqual({ tool: "bash", target: "command", pattern_kind: "cmd", pattern: "npm test" });
    expect(report.signature_key.startsWith("bash|command|cmd|")).toBe(true);
    expect(report.memory.relevantTools).toEqual(["bash"]);
    expect(report.promoted).toBe(false);

    const active = await runHm(project, ["memory:add", "--type", "decision", "--summary", "We use vitest for every test in this repository", "--active", "--json"], clockOptions());
    expect(active.code).toBe(0);
    const promoted = active.json<MemoryAddReport>();
    expect(promoted.memory).toMatchObject({ status: "active", authority: "human", activationClass: "baseline", lifecycleTriggers: ["session_start", "before_model"] });
    const transitions = await readProject(project, (db) => new TransitionRepository(db).listForMemory(promoted.memory.id));
    expect(transitions).toHaveLength(1);
    expect(transitions[0]).toMatchObject({ fromStatus: "candidate", toStatus: "active", actor: "human" });

    // The snapshot the hooks read is rebuilt by the write.
    expect(existsSync(project.paths.snapshotActive)).toBe(true);
    const snapshot = JSON.parse(readFileSync(project.paths.snapshotActive, "utf8")) as { memories: Array<{ id: string }> };
    expect(snapshot.memories.map((memory) => memory.id)).toEqual([promoted.memory.id]);
  });

  test("rejects usage errors (missing type, unspecific signature) and duplicates", async () => {
    expect((await runHm(project, ["memory:add", "--summary", "A summary long enough to pass"])).code).toBe(2);
    expect((await runHm(project, ["memory:add", "--type", "pitfall", "--summary", "short"])).code).toBe(2);
    const unspecific = await runHm(project, ["memory:add", "--type", "pitfall", "--summary", "Single token signatures are rejected by V10", "--signature", "bash:command:cmd:npm"]);
    expect(unspecific.code).toBe(2);
    expect(unspecific.stderr).toContain("signature rejected");
    const bogus = await runHm(project, ["memory:add", "--type", "nope", "--summary", "A summary long enough to pass"]);
    expect(bogus.code).toBe(2);
    expect(bogus.stderr).toContain("allowed: policy");

    const first = await runHm(project, ["memory:add", "--type", "workflow", "--summary", "Commit messages are written in English here", "--json"]);
    expect(first.code).toBe(0);
    const second = await runHm(project, ["memory:add", "--type", "workflow", "--summary", "Commit messages are written in English here"]);
    expect(second.code).toBe(1);
    expect(second.stderr).toContain("already");
  });

  test("re-adding a rejected fact revives it instead of failing", async () => {
    const first = (await runHm(project, ["memory:add", "--type", "workflow", "--summary", "Rebase onto main before opening a pull request", "--json"])).json<MemoryAddReport>();
    expect((await runHm(project, ["memory:reject", first.memory.id])).code).toBe(0);
    const again = await runHm(project, ["memory:add", "--type", "workflow", "--summary", "Rebase onto main before opening a pull request", "--json"]);
    expect(again.code).toBe(0);
    const revived = again.json<MemoryAddReport>();
    expect(revived.memory.id).not.toBe(first.memory.id);
    expect(revived.memory.status).toBe("candidate");
  });
});

describe("hm memory:list / memory:show", () => {
  test("lists live rows by default, filters by status/type/authority, shows a row by id prefix", async () => {
    let activeId = "";
    let candidateId = "";
    let rejectedId = "";
    await seedProject(project, (db) => {
      const memories = new MemoryRepository(db, { clock: () => CLI_NOW });
      activeId = memories.create(humanMemory({ summary: "Keep the public API backwards compatible", type: "policy" })).id;
      candidateId = memories.create(autoMemory({ summary: "Prefer pnpm over npm for installs", type: "pitfall" })).id;
      rejectedId = memories.create(humanMemory({ summary: "A rejected row of the past", status: "rejected", type: "workflow" })).id;
    });

    const live = (await runHm(project, ["memory:list", "--json"])).json<MemoryListReport>();
    expect(live.total).toBe(2);
    expect(live.memories.map((memory) => memory.id).sort()).toEqual([activeId, candidateId].sort());
    expect(live.memories.every((memory) => !("embedding" in memory) || memory.embedding === null)).toBe(true);

    const all = (await runHm(project, ["memory:list", "--status", "all", "--json"])).json<MemoryListReport>();
    expect(all.total).toBe(3);
    const rejected = (await runHm(project, ["memory:list", "--status", "rejected", "--json"])).json<MemoryListReport>();
    expect(rejected.memories.map((memory) => memory.id)).toEqual([rejectedId]);
    const policies = (await runHm(project, ["memory:list", "--type", "policy", "--authority", "human", "--json"])).json<MemoryListReport>();
    expect(policies.memories.map((memory) => memory.id)).toEqual([activeId]);

    const text = await runHm(project, ["memory:list"]);
    expect(text.code).toBe(0);
    expect(text.stdout).toContain("ID");
    expect(text.stdout).toContain("Keep the public API");

    expect((await runHm(project, ["memory:list", "--status", "weird"])).code).toBe(2);

    const shown = await runHm(project, ["memory:show", activeId.slice(0, 8), "--json"]);
    expect(shown.code).toBe(0);
    expect(shown.json<MemoryShowReport>().memory.id).toBe(activeId);
    const shownText = await runHm(project, ["memory:show", activeId]);
    expect(shownText.stdout).toContain(`memory ${activeId}`);
    expect(shownText.stdout).toContain("Keep the public API");

    const missing = await runHm(project, ["memory:show", "ffffffff"]);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("no memory with id");
    expect((await runHm(project, ["memory:show"])).code).toBe(2);
  });
});

describe("hm memory:promote|demote|reject|restore|enforce", () => {
  test("walks the §4.7 human edges and refuses the edges that do not exist", async () => {
    let candidateId = "";
    let autoActiveId = "";
    await seedProject(project, (db) => {
      const memories = new MemoryRepository(db, { clock: () => CLI_NOW });
      candidateId = memories.create(humanMemory({ summary: "Document every public function", status: "candidate" })).id;
      autoActiveId = memories.create(autoMemory({ summary: "Do not run npm test here", status: "active", ttlExpiresAt: "2026-12-01T00:00:00.000Z" })).id;
    });

    const promoted = await runHm(project, ["memory:promote", candidateId.slice(0, 8), "--json"], clockOptions());
    expect(promoted.code).toBe(0);
    expect(promoted.json<MemoryTransitionReport>().after).toMatchObject({ status: "active", authority: "human" });

    const demoted = await runHm(project, ["memory:demote", candidateId, "--json"], clockOptions());
    expect(demoted.code).toBe(0);
    expect(demoted.json<MemoryTransitionReport>().after).toMatchObject({ status: "stale", statusReason: "human" });

    const restored = await runHm(project, ["memory:restore", candidateId, "--json"], clockOptions());
    expect(restored.code).toBe(0);
    expect(restored.json<MemoryTransitionReport>().after.status).toBe("active");

    const rejectActive = await runHm(project, ["memory:reject", candidateId]);
    expect(rejectActive.code).toBe(1);
    expect(rejectActive.stderr).toContain("memory:demote");

    const demoteStale = await runHm(project, ["memory:demote", candidateId]);
    expect(demoteStale.code).toBe(0);
    expect((await runHm(project, ["memory:demote", candidateId])).code).toBe(1);

    const enforced = await runHm(project, ["memory:enforce", autoActiveId, "deny", "--json"], clockOptions());
    expect(enforced.code).toBe(0);
    const enforcedRow = enforced.json<MemoryTransitionReport>().after;
    expect(enforcedRow).toMatchObject({ enforcement: "deny", authority: "human", ttlExpiresAt: null });
    expect((await runHm(project, ["memory:enforce", autoActiveId, "loud"])).code).toBe(2);
    expect((await runHm(project, ["memory:enforce", autoActiveId])).code).toBe(2);

    // Same fixed clock on every command → equal created_at; compare as a multiset.
    const transitions = await readProject(project, (db) => new TransitionRepository(db).listForMemory(candidateId));
    expect(transitions.map((transition) => `${transition.fromStatus}>${transition.toStatus}`).sort()).toEqual(["active>stale", "active>stale", "candidate>active", "stale>active"]);
    expect(transitions.every((transition) => transition.actor === "human")).toBe(true);
  });

  test("reject keeps the note as manual evidence; restore refuses rejected rows", async () => {
    let candidateId = "";
    await seedProject(project, (db) => {
      candidateId = new MemoryRepository(db, { clock: () => CLI_NOW }).create(humanMemory({ summary: "A candidate nobody wants", status: "candidate" })).id;
    });
    const rejected = await runHm(project, ["memory:reject", candidateId, "--note", "duplicate of the README", "--json"], clockOptions());
    expect(rejected.code).toBe(0);
    expect(rejected.json<MemoryTransitionReport>().after.status).toBe("rejected");
    const history = (await runHm(project, ["memory:history", candidateId, "--json"])).json<MemoryHistoryReport>();
    expect(history.evidence).toHaveLength(1);
    expect(history.evidence[0]).toMatchObject({ sourceKind: "manual_note", excerpt: "duplicate of the README" });
    const restore = await runHm(project, ["memory:restore", candidateId]);
    expect(restore.code).toBe(1);
    expect(restore.stderr).toContain("memory:add");
  });

  test("mutations refuse to run without a database and record a write_ops row when they do", async () => {
    const missing = await runHm(project, ["memory:promote", "abcdef12"]);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("no database");

    let id = "";
    await seedProject(project, (db) => {
      id = new MemoryRepository(db, { clock: () => CLI_NOW }).create(humanMemory({ status: "candidate" })).id;
    });
    expect((await runHm(project, ["memory:promote", id], clockOptions())).code).toBe(0);
    const recorded = await readProject(project, (db) => {
      const rows = db.exec("SELECT id FROM write_ops WHERE kind = 'memory:promote'");
      return rows.length === 0 ? [] : rows[0]!.values.map((row) => String(row[0]));
    });
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.startsWith(`memory:promote:${id}:${CLI_NOW}:`)).toBe(true);
    expect(await readProject(project, (db) => hasWriteOp(db, recorded[0]!))).toBe(true);
  });
});

describe("hm memory:history / memory:trace / memory:stats", () => {
  test("history lists transitions and provenance; trace groups episodes with their runs", async () => {
    let id = "";
    let episodeId = "";
    await seedProject(project, (db) => {
      const memories = new MemoryRepository(db, { clock: () => CLI_NOW });
      id = memories.create(autoMemory({ summary: "Run pnpm test rather than npm test", status: "active" })).id;
      const episode = insertEpisode(db, {}, CLI_NOW);
      episodeId = episode.id;
      new ProvenanceRepository(db).insert({ memoryId: id, episodeId: episode.id, eventSeq: 1001, relation: "origin", confidence: 0.85, excerpt: "e1001 prompt: use pnpm", extractionRunId: null, createdAt: CLI_NOW });
    });
    expect((await runHm(project, ["memory:demote", id], clockOptions())).code).toBe(0);

    const history = await runHm(project, ["memory:history", id, "--json"]);
    expect(history.code).toBe(0);
    const report = history.json<MemoryHistoryReport>();
    expect(report.transitions).toHaveLength(1);
    expect(report.provenance).toHaveLength(1);
    expect(report.legacy.available).toBe(true);
    expect(report.legacy.links).toEqual([]);
    const historyText = await runHm(project, ["memory:history", id]);
    expect(historyText.stdout).toContain("active → stale");
    expect(historyText.stdout).toContain("origin");

    const trace = await runHm(project, ["memory:trace", id, "--json"]);
    expect(trace.code).toBe(0);
    const traced = trace.json<MemoryTraceReport>();
    expect(traced.episodes).toHaveLength(1);
    expect(traced.episodes[0]!.episode_id).toBe(episodeId);
    expect(traced.episodes[0]!.episode?.status).toBe("queued");
    expect((await runHm(project, ["memory:trace", id])).stdout).toContain("episode");
  });

  test("stats report counts, review load and recent activations", async () => {
    await seedProject(project, (db) => {
      const memories = new MemoryRepository(db, { clock: () => CLI_NOW });
      memories.create(humanMemory({ summary: "Active human policy", status: "active" }));
      memories.create(humanMemory({ summary: "Human candidate for review", status: "candidate" }));
      const noisy = memories.create(autoMemory({ summary: "Noisy auto pitfall", status: "active" }));
      memories.recordFire(noisy.id, { at: CLI_NOW, count: 4, overrideDelta: 2 });
      insertEpisode(db, {}, CLI_NOW);
    });
    const stats = await runHm(project, ["memory:stats", "--since", "2026-11-01", "--json"], clockOptions());
    expect(stats.code).toBe(0);
    const report = stats.json<MemoryStatsReport>();
    expect(report.since).toBe("2026-11-01T00:00:00.000Z");
    expect(report.memories.by_status).toMatchObject({ active: 2, candidate: 1 });
    expect(report.memories.by_authority).toEqual({ human: 2, auto: 1 });
    expect(report.review.items).toBe(2);
    expect(report.review.by_group).toMatchObject({ human_candidate: 1, noisy_auto: 1 });
    expect(report.fires).toMatchObject({ fires: 4, overrides: 2 });
    expect(report.fires.noisy).toHaveLength(1);
    expect(report.episodes.by_status.queued).toBe(1);
    const text = await runHm(project, ["memory:stats"], clockOptions());
    expect(text.code).toBe(0);
    expect(text.stdout).toContain("review load");
    expect((await runHm(project, ["memory:stats", "--since", "yesterday"])).code).toBe(2);
  });
});

describe("hm memory:export / memory:export-skill", () => {
  test("export is a deterministic SQL dump (stdout or --out)", async () => {
    await seedProject(project, (db) => {
      new MemoryRepository(db, { clock: () => CLI_NOW }).create(humanMemory({ summary: "Exported human policy" }));
    });
    const first = await runHm(project, ["memory:export", "--json"]);
    expect(first.code).toBe(0);
    const dump = first.json<MemoryExportReport>();
    expect(dump.sql).toContain("CREATE TABLE");
    expect(dump.sql).toContain("Exported human policy");
    expect(dump.sql).toContain(`PRAGMA user_version = ${String(TARGET_USER_VERSION)};`);
    const second = await runHm(project, ["memory:export", "--json"]);
    expect(second.json<MemoryExportReport>().sql).toBe(dump.sql);

    const out = join(project.root, "dump", "memory.sql");
    const written = await runHm(project, ["memory:export", "--out", out, "--json"]);
    expect(written.code).toBe(0);
    expect(written.json<MemoryExportReport>().out).toBe(out);
    expect(readFileSync(out, "utf8")).toBe(`${dump.sql}\n`);

    const text = await runHm(project, ["memory:export"]);
    expect(text.stdout.startsWith("BEGIN TRANSACTION;")).toBe(true);
  });

  test("export-skill writes SKILL.md files for mature active memories only", async () => {
    await seedProject(project, (db) => {
      const memories = new MemoryRepository(db, { clock: () => CLI_NOW });
      memories.create(humanMemory({ summary: "Run the full test suite before every commit", confidence: 0.95, importance: 0.9 }));
      memories.create(humanMemory({ summary: "A weak row below the importance threshold", confidence: 0.95, importance: 0.1 }));
      memories.create(humanMemory({ summary: "A candidate is never exported", status: "candidate", confidence: 0.95, importance: 0.9 }));
    });
    const out = join(project.root, "skills");
    const result = await runHm(project, ["memory:export-skill", "--out", out, "--json"]);
    expect(result.code).toBe(0);
    const report = result.json<MemoryExportSkillReport>();
    expect(report.considered).toBe(2);
    expect(report.files).toHaveLength(1);
    expect(readdirSync(out)).toEqual(["run-the-full-test-suite-before-every-commit.md"]);
    const skill = readFileSync(report.files[0]!.file, "utf8");
    expect(skill.startsWith("---\nname:")).toBe(true);
    expect(skill).toContain("source: harness-memory");

    const lowered = await runHm(project, ["memory:export-skill", "--out", out, "--min-importance", "0.05", "--json"]);
    expect(lowered.json<MemoryExportSkillReport>().files).toHaveLength(2);
    expect((await runHm(project, ["memory:export-skill", "--min-importance", "7"])).code).toBe(2);
  });
});

describe("A′ in the CLI: remember rows and the escalation ladder", () => {
  test("memory:list tags [remember], memory:show prints the remember authority line, memory:history shows the escalation and the adoption", async () => {
    let rememberId = "";
    let ladderId = "";
    let adoptedId = "";
    await seedProject(project, (db) => {
      const memories = new MemoryRepository(db, { clock: () => CLI_NOW });
      rememberId = memories.create(
        humanMemory({
          type: "policy",
          summary: "Run pnpm lint before every git commit in this repository",
          status: "active",
          statusReason: "remember",
          sourceKind: "extraction",
          knowledgeKind: "convention",
          sourceRef: "episode:ep-remember-0001",
          enforcement: "confirm",
          policySubtype: "hard",
        })
      ).id;
      ladderId = memories.create(autoMemory({ summary: "Run pnpm test instead of npm test here", status: "active", enforcement: "soft_deny" })).id;
      new TransitionRepository(db).insert({ memoryId: ladderId, fromStatus: "candidate", toStatus: "active", actor: "auto_rule", reason: "decideTier", createdAt: CLI_NOW });
      new TransitionRepository(db).insert({ memoryId: ladderId, fromStatus: "active", toStatus: "active", actor: "auto_rule", extractionRunId: "run-escalate", reason: "auto_escalation: advise → soft_deny (2 sessions)", createdAt: CLI_NOW });
      // An active auto row a later remember turn adopted (src/dream/reconcile.ts adoptRememberTwin → adoptActiveMemory):
      // its source episode stays the original one; the remember turn is read from the adoption transition.
      adoptedId = memories.create(autoMemory({ summary: "Never push to main directly in this repository", status: "active", enforcement: "advise", sourceRef: "episode:ep-origin-0001" })).id;
      new TransitionRepository(db).insert({ memoryId: adoptedId, fromStatus: "candidate", toStatus: "active", actor: "auto_rule", reason: "decideTier", createdAt: CLI_NOW });
      adoptActiveMemory(db, { memoryId: adoptedId, reason: rememberTransitionReason("ep-remember-0002"), now: CLI_NOW, runId: "run-adopt", statusReason: "remember" });
    });

    const list = await runHm(project, ["memory:list"]);
    expect(list.code).toBe(0);
    const rememberLine = list.stdout.split("\n").find((line) => line.includes("Run pnpm lint before every git commit")) ?? "";
    expect(rememberLine).toContain("[remember]");
    expect(rememberLine).toContain(" active ");
    const ladderLine = list.stdout.split("\n").find((line) => line.includes("Run pnpm test instead of npm test")) ?? "";
    expect(ladderLine).not.toContain("[remember]");
    const adoptedLine = list.stdout.split("\n").find((line) => line.includes("Never push to main directly")) ?? "";
    expect(adoptedLine).toContain("[remember]");
    expect(adoptedLine).toContain(" human ");
    const json = (await runHm(project, ["memory:list", "--json"])).json<MemoryListReport>();
    expect(json.memories.find((memory) => memory.id === rememberId)).toMatchObject({ statusReason: "remember", authority: "human" });
    expect(json.memories.find((memory) => memory.id === adoptedId)).toMatchObject({ statusReason: "remember", authority: "human", promotionSource: "manual" });

    const show = await runHm(project, ["memory:show", rememberId]);
    expect(show.code).toBe(0);
    expect(show.stdout).toContain("status             active (remember)");
    expect(show.stdout).toContain("authority          human (remember, episode ep-remem) / extraction");
    expect((await runHm(project, ["memory:show", rememberId, "--json"])).json<MemoryShowReport>().remember_episode_id).toBeNull();
    const shownAdopted = await runHm(project, ["memory:show", adoptedId]);
    expect(shownAdopted.stdout).toContain("authority          human (remember, episode ep-remem) / extraction");
    expect(shownAdopted.stdout).not.toContain("ep-origi");
    expect((await runHm(project, ["memory:show", adoptedId, "--json"])).json<MemoryShowReport>().remember_episode_id).toBe("ep-remember-0002");
    const shownAuto = await runHm(project, ["memory:show", ladderId]);
    expect(shownAuto.stdout).toContain("authority          auto / extraction (episode:ep-1)");
    expect((await runHm(project, ["memory:show", ladderId, "--json"])).json<MemoryShowReport>()).not.toHaveProperty("remember_episode_id");

    const adoptedHistory = await runHm(project, ["memory:history", adoptedId]);
    expect(adoptedHistory.code).toBe(0);
    expect(adoptedHistory.stdout).toContain("candidate → active  by auto_rule  decideTier");
    expect(adoptedHistory.stdout).toContain("active (authority)  by human  remember:episode ep-remember-0002  (run run-adop)");

    const history = await runHm(project, ["memory:history", ladderId]);
    expect(history.code).toBe(0);
    expect(history.stdout).toContain("candidate → active  by auto_rule  decideTier");
    expect(history.stdout).toContain("active (enforcement)  by auto_rule  auto_escalation: advise → soft_deny (2 sessions)  (run run-esca)");
    const historyJson = (await runHm(project, ["memory:history", ladderId, "--json"])).json<MemoryHistoryReport>();
    expect(historyJson.transitions.map((transition) => [transition.fromStatus, transition.toStatus, transition.reason.split(":")[0]])).toEqual([
      ["candidate", "active", "decideTier"],
      ["active", "active", "auto_escalation"],
    ]);
  });
});
