/**
 * `hm import --from auto-memory` (phase F A′ §4): Claude Code's `~/.claude/projects/<slug>/memory/*.md` feedback notes
 * (under a temp CLAUDE_CONFIG_DIR), written in the real template (context → **Why:** → **How to apply:** → dated
 * state log), go through the ordinary import pipeline — replay provider, human / import rows with
 * `source_ref = import:auto-memory:<topic file>#L<n>`, `--dry-run`, `--yes`, `--include-project`, idempotent re-runs,
 * enforcement at before_tool (`hm memory:why`), injection at before_model and session_start (no host_loaded
 * suppression for topic files), directory-wide `--sync` that leaves an oversized note's rows alone, explicit
 * `--memory-dir` / `--from <memory dir>`, the usage errors for other directories and mixed flags, the scan fallback,
 * the lookup error that lists the candidates, and the login-optional path: without an extraction CLI the bullets become
 * verbatim rows that a later run with a provider retypes. Nothing under the config directory is modified.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { activateBeforeModel } from "../src/activation/before-model";
import { selectSessionStartItems } from "../src/activation/session-start";
import { readActiveSnapshot, readLexicalSnapshot } from "../src/activation/snapshot-reader";
import { IMPORT_VERBATIM_SKIP_REASON, type ImportReport } from "../src/cli/commands/import";
import type { MemoryWhyReport } from "../src/cli/commands/memory-why";
import { AUTO_MEMORY_MAX_FILE_BYTES, autoMemorySourcePath, canonicalDirectory, projectSlug } from "../src/cli/lib/auto-memory";
import { bulletHash, importEpisodeId, importSourceRef } from "../src/cli/lib/import-file";
import { DEFAULT_CONFIG } from "../src/core/config";
import type { ExtractionFact } from "../src/core/extraction-types";
import { EpisodeRepository } from "../src/db/repositories/episodes";
import { ProvenanceRepository } from "../src/db/repositories/provenance";
import { sourceFileOf } from "../src/db/snapshot";
import { createReplayProvider, type ExtractionProvider } from "../src/dream/extract/providers";
import { MemoryRepository } from "../src/memory/repository";
import { createCliProject, runHm, type CliProject } from "./helpers/cli-run";
import { CLI_NOW, clockOptions, readProject, seedProject } from "./helpers/cli-seed";
import { factFixture, outputFixture } from "./helpers/replay-run";

let project: CliProject;

beforeEach(() => {
  project = createCliProject();
});

afterEach(() => {
  project.cleanup();
});

const TERMINALS_TEXT = "Don't terminate terminal tabs, the user's processes or WSL (no `wsl --shutdown`) without asking first. Only stop processes Claude started itself.";
const PROGRESS_BULLET_1 = "When starting long work, say what is running, roughly how long it takes and what the user will see next";
const PROGRESS_BULLET_2 = "Parallelize independent work instead of running it in sequence";
const PROGRESS_LOG_BULLET = "State on 2026-11-08 (night): the user approved the status format; nothing else changed.";
const GSTACK_RULE = "do not suggest gstack again (or its individual skills) unless the owner brings it up; use the existing verification workflows for pre-launch QA.";
const PROJECT_BULLET = "Keep commit messages in English for this repository";

function noteFile(options: { name: string; description: string; type: string; body: string }): string {
  return ["---", `name: ${options.name}`, `description: ${JSON.stringify(options.description)}`, "metadata:", "  node_type: memory", `  type: ${options.type}`, "  originSessionId: ba528706-0b73-4088-805a-a7cf0602b825", "  modified: 2026-11-08T00:00:00.000Z", "---", "", options.body].join("\n");
}

// Frontmatter 9 lines + blank line 10: the body starts on file line 11.
const TERMINALS_NOTE = noteFile({ name: "no-terminating-terminals", description: "Never close terminal tabs, user processes or WSL without asking", type: "feedback", body: `${TERMINALS_TEXT}\n\n**Why:** the user said so when WSL terminals kept dying.\n` });
const PROGRESS_NOTE = (bullets: readonly string[] = [PROGRESS_BULLET_1, PROGRESS_BULLET_2]): string =>
  noteFile({
    name: "progress-updates",
    description: "User checks in during long runs; give short concrete status unprompted",
    type: "feedback",
    body: `During long runs the user keeps checking in.\n\n**Why:** silence reads as stuck.\n\n**How to apply:**\n${[...bullets, PROGRESS_LOG_BULLET].map((bullet) => `- ${bullet}`).join("\n")}\n`,
  });
const GSTACK_NOTE = noteFile({
  name: "gstack-declined",
  description: "The owner declined adopting gstack on 2026-11-08; do not propose it again",
  type: "feedback",
  body: `On 2026-11-08 the owner asked whether gstack would help; I assessed it and recommended a selective install. The owner answered no.\n\n**Why:** the open problems are already covered by the session's own workflows.\n\n**How to apply:** ${GSTACK_RULE}\n`,
});
const USER_NOTE = noteFile({ name: "user-profile", description: "Who the user is", type: "user", body: "Korean-speaking solo developer on Windows 11.\n" });
const PROJECT_NOTE = noteFile({ name: "project-conventions", description: "Repository conventions", type: "project", body: `- ${PROJECT_BULLET}\n` });
const MEMORY_INDEX = "# Memory index\n\n- [Terminals](no-terminating-terminals.md) — never close terminals without asking\n- [Progress](progress-updates.md) — short status unprompted\n";
const NOTE_FILES = ["MEMORY.md", "gstack-declined.md", "no-terminating-terminals.md", "progress-updates.md", "user-profile.md", "project-conventions.md"] as const;

/** Expected bullets per topic file (file line, text) under the template rule; `--include-project` adds the project note. */
const FEEDBACK_BULLETS: ReadonlyArray<[file: string, line: number, text: string]> = [
  ["gstack-declined.md", 15, GSTACK_RULE],
  ["no-terminating-terminals.md", 11, TERMINALS_TEXT],
  ["progress-updates.md", 16, PROGRESS_BULLET_1],
  ["progress-updates.md", 17, PROGRESS_BULLET_2],
];
const PROJECT_BULLETS: ReadonlyArray<[file: string, line: number, text: string]> = [["project-conventions.md", 11, PROJECT_BULLET]];

/** Writes the fixture notes into `<configDir>/projects/<slug>/memory` and returns that directory (canonical spelling). */
function writeNotes(target: CliProject, slug: string = projectSlug(target.root)): string {
  const dir = join(target.configDir, "projects", slug, "memory");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "MEMORY.md"), MEMORY_INDEX, "utf8");
  writeFileSync(join(dir, "gstack-declined.md"), GSTACK_NOTE, "utf8");
  writeFileSync(join(dir, "no-terminating-terminals.md"), TERMINALS_NOTE, "utf8");
  writeFileSync(join(dir, "progress-updates.md"), PROGRESS_NOTE(), "utf8");
  writeFileSync(join(dir, "user-profile.md"), USER_NOTE, "utf8");
  writeFileSync(join(dir, "project-conventions.md"), PROJECT_NOTE, "utf8");
  return canonicalDirectory(dir);
}

function snapshotOfDir(dir: string): Map<string, string> {
  return new Map(NOTE_FILES.map((name) => [name, existsSync(join(dir, name)) ? readFileSync(join(dir, name), "utf8") : "<missing>"]));
}

function terminalsFact(): ExtractionFact {
  return factFixture({
    type: "pitfall",
    summary: "Ask before running wsl --shutdown or stopping a process Claude did not start",
    details: "The user's WSL terminals and processes must not be killed without an explicit OK.",
    trigger_signature: { tool: "bash", target: "command", pattern_kind: "cmd", pattern: "wsl --shutdown" },
    relevant_tools: ["bash"],
    lifecycle_triggers: ["before_tool"],
    evidence_refs: ["e1"],
    knowledge_kind: "convention",
    aliases: ["터미널 종료"],
  });
}

function workflowFact(): ExtractionFact {
  return factFixture({
    type: "workflow",
    summary: "Open every multi-step task with a status line: current step, expected duration, next visible output",
    details: "The user checks in during long runs; the opening message sets expectations.",
    scope_glob: "**/*",
    trigger_signature: null,
    relevant_tools: [],
    lifecycle_triggers: ["session_start", "before_model"],
    evidence_refs: ["e1"],
    knowledge_kind: "convention",
    aliases: [],
  });
}

function policyFact(summary: string, details: string): ExtractionFact {
  return factFixture({
    type: "policy",
    summary,
    details,
    scope_glob: "**/*",
    trigger_signature: null,
    relevant_tools: [],
    lifecycle_triggers: ["before_model"],
    evidence_refs: ["e1"],
    knowledge_kind: "convention",
    aliases: [],
  });
}

const PARALLEL_SUMMARY = "Run independent work in parallel rather than in sequence";

/** Replay answers keyed by the deterministic import episode ids of the fixture bullets. */
function notesProvider(dir: string): ExtractionProvider {
  const id = (file: string, text: string): string => importEpisodeId(autoMemorySourcePath(join(dir, file)), { hash: bulletHash(text) });
  return createReplayProvider({
    answers: {
      [id("gstack-declined.md", GSTACK_RULE)]: outputFixture([policyFact("Stop recommending gstack; the owner turned it down on 2026-11-08", "Assessed and declined; existing verification workflows cover pre-launch QA.")], "gstack declined."),
      [id("no-terminating-terminals.md", TERMINALS_TEXT)]: outputFixture([terminalsFact()], "Never kill the user's terminals."),
      [id("progress-updates.md", PROGRESS_BULLET_1)]: outputFixture([workflowFact()], "Progress expectations."),
      [id("progress-updates.md", PROGRESS_BULLET_2)]: outputFixture([policyFact(PARALLEL_SUMMARY, "Sequential runs made the user wait.")], "Parallel work."),
      [id("project-conventions.md", PROJECT_BULLET)]: outputFixture([policyFact("Author git commit text in English rather than Korean", "The team reads English.")], "Commit conventions."),
    },
  });
}

async function whyBash(target: string): Promise<MemoryWhyReport> {
  const result = await runHm(project, ["memory:why", "--tool", "Bash", "--target", target, "--json"], clockOptions());
  expect(result.code).toBe(0);
  return result.json<MemoryWhyReport>();
}

describe("hm import --from auto-memory", () => {
  test("--dry-run lists the notes (template rule: How-to-apply paragraph, context paragraph, rule bullets minus the state log), the skipped files with reasons and the bullets with file labels; nothing is written", async () => {
    const dir = writeNotes(project);
    const before = snapshotOfDir(dir);
    const dry = await runHm(project, ["import", "--from", "auto-memory", "--dry-run", "--json"], clockOptions());
    expect(dry.code).toBe(0);
    const report = dry.json<ImportReport>();
    expect(report).toMatchObject({ source_kind: "auto-memory", file: dir, source_path: `auto-memory:${dir.split("\\").join("/")}`, located: "derived", bullets: 4, dry_run: true, verbatim: [], retyped: [] });
    expect(report.files!.filter((file) => file.selected).map((file) => [file.name, file.type, file.mode, file.bullets])).toEqual([
      ["gstack-declined", "feedback", "how_to_apply", 1],
      ["no-terminating-terminals", "feedback", "paragraph", 1],
      ["progress-updates", "feedback", "bullets", 2],
    ]);
    // The dated state-log bullet of the progress note is dropped, not imported.
    expect(report.files!.find((file) => file.name === "progress-updates")!.skipped_lines).toBe(4);
    expect(report.files!.filter((file) => !file.selected).map((file) => [file.name, file.reason])).toEqual([
      ["MEMORY", expect.stringContaining("index file Claude Code loads every session")],
      ["project-conventions", "type project (pass --include-project)"],
      ["user-profile", "type user (not an import source)"],
    ]);
    expect(report.rows.map((row) => [row.file, row.line, row.text, row.verbatim])).toEqual(FEEDBACK_BULLETS.map(([file, line, text]) => [join(dir, file), line, text, false]));
    expect(report.rows.some((row) => row.text.includes(PROGRESS_LOG_BULLET.slice(0, 20)))).toBe(false);
    expect(existsSync(project.paths.db)).toBe(false);

    const text = await runHm(project, ["import", "--auto-memory", "--dry-run"], clockOptions());
    expect(text.code).toBe(0);
    expect(text.stdout).toContain(`import auto-memory ${dir}: 3 notes → 4 bullets`);
    expect(text.stdout).toContain("gstack-declined.md (feedback, how to apply: 1 bullet)");
    expect(text.stdout).toContain("no-terminating-terminals.md (feedback, paragraph: 1 bullet)");
    expect(text.stdout).toContain("progress-updates.md (feedback, bullets: 2 bullets)");
    expect(text.stdout).toContain("skipped MEMORY.md (");
    expect(text.stdout).toContain("project-conventions.md (type project (pass --include-project))");
    expect(text.stdout).toContain("progress-updates.md:L16");
    expect(text.stdout).toContain("gstack-declined.md:L15");
    expect(text.stdout).toContain("dry run: nothing written");

    const withProject = await runHm(project, ["import", "auto-memory", "--include-project", "--dry-run", "--json"], clockOptions());
    expect(withProject.code).toBe(0);
    expect(withProject.json<ImportReport>().bullets).toBe(5);
    expect(withProject.json<ImportReport>().files!.find((file) => file.name === "project-conventions")).toMatchObject({ selected: true, mode: "bullets", bullets: 1 });
    expect(snapshotOfDir(dir)).toEqual(before);
  });

  test("--yes imports human rows with import:auto-memory refs that enforce at before_tool, inject at before_model and session_start (never host-loaded); re-runs are idempotent", async () => {
    const dir = writeNotes(project);
    const before = snapshotOfDir(dir);
    await seedProject(project, () => {});
    const provider = notesProvider(dir);

    const result = await runHm(project, ["import", "--from", "auto-memory", "--include-project", "--yes", "--json"], clockOptions(CLI_NOW, { seams: { provider } }));
    expect(result.code).toBe(0);
    const report = result.json<ImportReport>();
    expect(report.worker).toMatchObject({ busy: false, processed: 5, waiting: null });
    expect(report.rows.map((row) => row.run_status)).toEqual(["ok", "ok", "ok", "ok", "ok"]);
    expect(report.rows.every((row) => !row.verbatim)).toBe(true);
    expect(report.created, JSON.stringify(report.rows.map((row) => [row.text.slice(0, 24), row.outcomes]))).toHaveLength(5);
    expect(report.verbatim).toEqual([]);
    expect(report.retyped).toEqual([]);
    expect(report.confirmation).toBe("unconfirmed");
    expect(report.unconfirmed).toHaveLength(5);
    const expectedRefs = [...FEEDBACK_BULLETS, ...PROJECT_BULLETS].map(([file, line]) => importSourceRef(autoMemorySourcePath(join(dir, file)), line)).sort();
    expect(report.rows.map((row) => importSourceRef(autoMemorySourcePath(row.file!), row.line)).sort()).toEqual(expectedRefs);

    const { workflowId, refById } = await readProject(project, (db) => {
      const memories = new MemoryRepository(db).list({ status: "active" });
      expect(memories).toHaveLength(5);
      expect(memories.map((memory) => memory.sourceRef).sort()).toEqual(expectedRefs);
      for (const memory of memories) {
        expect(memory).toMatchObject({ authority: "human", sourceKind: "import", knowledgeKind: "import", importUnconfirmed: 1, enforcement: "advise", status: "active" });
      }
      const pitfall = memories.find((memory) => memory.type === "pitfall")!;
      expect(pitfall.triggerSignature).toMatchObject({ tool: "bash", pattern: "wsl --shutdown" });
      expect(pitfall.sourceRef).toBe(importSourceRef(autoMemorySourcePath(join(dir, "no-terminating-terminals.md")), 11));
      const workflow = memories.find((memory) => memory.type === "workflow")!;
      expect(workflow.lifecycleTriggers).toContain("session_start");
      const episodes = new EpisodeRepository(db);
      const episode = episodes.getById(importEpisodeId(autoMemorySourcePath(join(dir, "progress-updates.md")), { hash: bulletHash(PROGRESS_BULLET_1) }))!;
      expect(episode).toMatchObject({ host: "import", closeReason: "import", status: "extracted", ledgerRef: workflow.sourceRef });
      expect(episode.contextRef).toBe("(auto-memory) note progress-updates: User checks in during long runs; give short concrete status unprompted");
      const gstack = episodes.getById(importEpisodeId(autoMemorySourcePath(join(dir, "gstack-declined.md")), { hash: bulletHash(GSTACK_RULE) }))!;
      expect(gstack).toMatchObject({ status: "extracted", ledgerRef: importSourceRef(autoMemorySourcePath(join(dir, "gstack-declined.md")), 15) });
      return { workflowId: workflow.id, refById: new Map(memories.map((memory) => [memory.id, memory.sourceRef!])) };
    });

    // The snapshot's source_file is derived from the ref (today `auto-memory:<topic file>`; the request on
    // src/db/snapshot.ts strips the marker) and names the topic file, never CLAUDE.md or MEMORY.md: topic files are
    // not loaded by the host, so session_start and before_model keep the rows (only MEMORY.md itself is host-loaded).
    const snapshot = JSON.parse(readFileSync(project.paths.snapshotActive, "utf8")) as { memories: Array<{ id: string; source_file: string | null; import_unconfirmed: number }> };
    expect(snapshot.memories).toHaveLength(5);
    for (const memory of snapshot.memories) {
      expect(memory.import_unconfirmed).toBe(1);
      expect(memory.source_file).toBe(sourceFileOf(refById.get(memory.id)!));
      expect(memory.source_file!.replace(/^auto-memory:/, "")).toMatch(new RegExp(`^${dir.split("\\").join("/").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/(gstack-declined|no-terminating-terminals|progress-updates|project-conventions)\\.md$`));
    }
    const loaded = readActiveSnapshot(project.paths, { spawnWorker: null, checkStale: false })!;
    const session = selectSessionStartItems({ loaded, host: "claude-code", config: DEFAULT_CONFIG, now: CLI_NOW });
    expect(session.items.map((item) => item.id)).toContain(workflowId);
    expect(session.suppressed.filter((entry) => entry.kind === "host_loaded")).toEqual([]);

    // before_tool: the pitfall's signature fires on the command it names and on nothing else.
    const fired = await whyBash("wsl --shutdown");
    expect(fired.decision.activated).toHaveLength(1);
    expect(fired.decision.activated[0]).toMatchObject({ type: "pitfall", authority: "human", enforcement: "advise", source: "signature", signatureMatched: true, unconfirmed: true });
    expect(fired.decision.enforcement).toBe("advise");
    const quiet = await whyBash("git status");
    expect(quiet.decision.activated).toEqual([]);

    // before_model: the global policy rows are injected for a prompt; nothing is suppressed as host-loaded.
    const lexical = await readLexicalSnapshot(project.paths);
    expect(lexical).not.toBeNull();
    const beforeModel = await activateBeforeModel({ loaded, lexical, prompt: "Should I run the independent test suites in sequence, one after another?", lastScopeRef: null, host: "claude-code", config: DEFAULT_CONFIG, now: CLI_NOW });
    expect(beforeModel.items.map((item) => [item.type, item.summary])).toContainEqual(["policy", PARALLEL_SUMMARY]);
    expect(beforeModel.items.every((item) => item.authority === "human" && item.unconfirmed)).toBe(true);
    expect(beforeModel.suppressed.filter((entry) => entry.kind === "host_loaded")).toEqual([]);

    const again = await runHm(project, ["import", "--auto-memory", "--include-project", "--yes", "--json"], clockOptions(CLI_NOW, { seams: { provider } }));
    expect(again.code).toBe(0);
    expect(again.json<ImportReport>().worker?.processed).toBe(0);
    expect(again.json<ImportReport>().retyped).toEqual([]);
    expect(await readProject(project, (db) => new MemoryRepository(db).list().length)).toBe(5);

    const text = await runHm(project, ["import", "--auto-memory", "--include-project", "--yes"], clockOptions(CLI_NOW, { seams: { provider } }));
    expect(text.code).toBe(0);
    expect(text.stdout).toContain(`import auto-memory ${dir}: 4 notes → 5 bullets`);
    expect(text.stdout).toContain("no-terminating-terminals.md:L11");
    expect(text.stdout).toContain("imported");
    expect(text.stdout).not.toContain("verbatim");
    expect(snapshotOfDir(dir)).toEqual(before);
  });

  test.todo("a plain `--from <dir>/MEMORY.md` import is suppressed as host_loaded at session_start / before_model — needs isHostLoadedFile to recognise <config>/projects/<slug>/memory/MEMORY.md (requested in src/activation/injection.ts)");

  test("without an extraction CLI the bullets become verbatim rows (policy, advise, unconfirmed) that inject at before_model; a later run with a provider retypes them", async () => {
    const dir = writeNotes(project);
    const before = snapshotOfDir(dir);
    await seedProject(project, () => {});

    const verbatim = await runHm(project, ["import", "--from", "auto-memory", "--include-project", "--yes", "--json"], clockOptions(CLI_NOW, { seams: { provider: null } }));
    expect(verbatim.code).toBe(0);
    const report = verbatim.json<ImportReport>();
    expect(report.worker).toMatchObject({ busy: false, processed: 0, waiting: { count: 5, reason: "no_provider" } });
    expect(report.verbatim).toHaveLength(5);
    expect(report.created.sort()).toEqual([...report.verbatim].sort());
    expect(report.confirmation).toBe("unconfirmed");
    expect(report.unconfirmed).toHaveLength(5);
    for (const row of report.rows) {
      expect(row).toMatchObject({ verbatim: true, episode_status: "skipped", run_status: null, outcomes: [] });
      expect(row.memories).toHaveLength(1);
      expect(row.memories[0]).toMatchObject({ type: "policy", authority: "human", enforcement: "advise", importUnconfirmed: 1, summary: row.text, scopeGlob: "**/*" });
    }
    const expectedRefs = [...FEEDBACK_BULLETS, ...PROJECT_BULLETS].map(([file, line]) => importSourceRef(autoMemorySourcePath(join(dir, file)), line)).sort();
    await readProject(project, (db) => {
      const memories = new MemoryRepository(db).list({ status: "active" });
      expect(memories).toHaveLength(5);
      expect(memories.map((memory) => memory.sourceRef).sort()).toEqual(expectedRefs);
      for (const memory of memories) {
        expect(memory).toMatchObject({ type: "policy", authority: "human", sourceKind: "import", knowledgeKind: "import", importUnconfirmed: 1, enforcement: "advise", status: "active", triggerSignature: null, lifecycleTriggers: ["before_model"] });
        const provenance = new ProvenanceRepository(db).listForMemory(memory.id);
        expect(provenance).toHaveLength(1);
        expect(provenance[0]).toMatchObject({ relation: "import", extractionRunId: null });
        expect(new EpisodeRepository(db).getById(provenance[0]!.episodeId)).toMatchObject({ status: "skipped", skipReason: IMPORT_VERBATIM_SKIP_REASON });
      }
    });

    // The hooks see them right away: injected at before_model (no login involved), nothing at before_tool yet
    // (a verbatim row has no signature; the extractor adds one later).
    const loaded = readActiveSnapshot(project.paths, { spawnWorker: null, checkStale: false })!;
    expect(loaded.snapshot.memories).toHaveLength(5);
    const beforeModel = await activateBeforeModel({ loaded, lexical: await readLexicalSnapshot(project.paths), prompt: "Should I run the independent test suites in sequence?", lastScopeRef: null, host: "claude-code", config: DEFAULT_CONFIG, now: CLI_NOW });
    expect(beforeModel.items.map((item) => item.summary)).toContain(PROGRESS_BULLET_2);
    expect(beforeModel.suppressed.filter((entry) => entry.kind === "host_loaded")).toEqual([]);
    expect((await whyBash("wsl --shutdown")).decision.activated).toEqual([]);

    const text = await runHm(project, ["import", "--auto-memory", "--include-project", "--yes"], clockOptions(CLI_NOW, { seams: { provider: null } }));
    expect(text.code).toBe(0);
    expect(text.stdout).toContain("no-terminating-terminals.md:L11");
    expect(text.stdout).toContain("verbatim");
    // Idempotent: the parked episodes are not imported twice.
    expect(await readProject(project, (db) => new MemoryRepository(db).list().length)).toBe(5);
    expect(text.stdout).not.toContain("extraction CLI unavailable");

    // After the login: the same command requeues the parked bullets, the extractor types them and the typed rows
    // supersede the verbatim ones.
    const provider = notesProvider(dir);
    const retyped = await runHm(project, ["import", "--auto-memory", "--include-project", "--yes", "--json"], clockOptions(CLI_NOW, { seams: { provider } }));
    expect(retyped.code).toBe(0);
    const retypedReport = retyped.json<ImportReport>();
    expect(retypedReport.worker).toMatchObject({ busy: false, processed: 5, waiting: null });
    expect(retypedReport.retyped.sort()).toEqual([...report.verbatim].sort());
    expect(retypedReport.verbatim).toEqual([]);
    expect(retypedReport.created).toHaveLength(5);
    expect(retypedReport.rows.every((row) => !row.verbatim && row.run_status === "ok")).toBe(true);
    await readProject(project, (db) => {
      const repository = new MemoryRepository(db);
      const active = repository.list({ status: "active" });
      expect(active.map((memory) => memory.type).sort()).toEqual(["pitfall", "policy", "policy", "policy", "workflow"]);
      expect(active.map((memory) => memory.sourceRef).sort()).toEqual(expectedRefs);
      for (const id of report.verbatim) {
        const old = repository.getById(id)!;
        expect(old).toMatchObject({ status: "superseded", statusReason: "import" });
        expect(active.some((memory) => memory.id === old.supersededByMemoryId && memory.sourceRef === old.sourceRef)).toBe(true);
      }
    });
    expect((await whyBash("wsl --shutdown")).decision.activated).toHaveLength(1);
    const retypedText = await runHm(project, ["import", "--auto-memory", "--include-project", "--yes"], clockOptions(CLI_NOW, { seams: { provider } }));
    expect(retypedText.code).toBe(0);
    expect(retypedText.stdout).not.toContain("retyped:");
    expect(await readProject(project, (db) => new MemoryRepository(db).list({ status: "active" }).length)).toBe(5);
    expect(snapshotOfDir(dir)).toEqual(before);
  });

  test("--sync stales rows whose bullets left the directory (edited or deleted notes), keeps rows of notes that only fell out of the type filter and of a note over the size cap", async () => {
    const dir = writeNotes(project);
    await seedProject(project, () => {});
    const provider = notesProvider(dir);
    expect((await runHm(project, ["import", "--auto-memory", "--include-project", "--yes"], clockOptions(CLI_NOW, { seams: { provider } }))).code).toBe(0);

    // Without --include-project the project note is not imported, but its bullet is still in the directory: no stale.
    const filtered = await runHm(project, ["import", "--auto-memory", "--yes", "--sync", "--json"], clockOptions(CLI_NOW, { seams: { provider } }));
    expect(filtered.code).toBe(0);
    expect(filtered.json<ImportReport>().synced_stale).toEqual([]);
    expect(await readProject(project, (db) => new MemoryRepository(db).list({ status: "active" }).length)).toBe(5);

    // A note that grew past the size cap is still present: its rows are protected, not staled.
    const progressNote = readFileSync(join(dir, "progress-updates.md"), "utf8");
    appendFileSync(join(dir, "progress-updates.md"), `\n${"x".repeat(AUTO_MEMORY_MAX_FILE_BYTES)}\n`, "utf8");
    const oversized = await runHm(project, ["import", "--auto-memory", "--include-project", "--yes", "--sync", "--json"], clockOptions(CLI_NOW, { seams: { provider } }));
    expect(oversized.code).toBe(0);
    const oversizedReport = oversized.json<ImportReport>();
    expect(oversizedReport.synced_stale).toEqual([]);
    expect(oversizedReport.files!.find((file) => file.name === "progress-updates")).toMatchObject({ selected: false, reason: expect.stringContaining("exceeds the") });
    expect(await readProject(project, (db) => new MemoryRepository(db).list({ status: "active" }).length)).toBe(5);
    writeFileSync(join(dir, "progress-updates.md"), progressNote, "utf8");

    writeFileSync(join(dir, "progress-updates.md"), PROGRESS_NOTE([PROGRESS_BULLET_1]), "utf8");
    rmSync(join(dir, "project-conventions.md"));
    const synced = await runHm(project, ["import", "--auto-memory", "--include-project", "--yes", "--sync", "--json"], clockOptions(CLI_NOW, { seams: { provider } }));
    expect(synced.code).toBe(0);
    const report = synced.json<ImportReport>();
    expect(report.synced_stale).toHaveLength(2);
    await readProject(project, (db) => {
      const memories = new MemoryRepository(db);
      const staled = report.synced_stale.map((id) => memories.getById(id)!);
      expect(staled.map((memory) => memory.summary).sort()).toEqual(["Author git commit text in English rather than Korean", PARALLEL_SUMMARY]);
      for (const memory of staled) expect(memory).toMatchObject({ status: "stale", statusReason: "import_sync" });
      expect(memories.list({ status: "active" }).map((memory) => memory.type).sort()).toEqual(["pitfall", "policy", "workflow"]);
    });
    const text = await runHm(project, ["import", "--auto-memory", "--include-project", "--yes", "--sync"], clockOptions(CLI_NOW, { seams: { provider } }));
    expect(text.code).toBe(0);
    expect(text.stdout).not.toContain("sync: staled");
  });

  test("--memory-dir and --from <memory directory> read an explicit directory; other directories, mixed flags and missing directories are errors; a missing lookup lists the candidates", async () => {
    const other = writeNotes(project, "Z--elsewhere-project");
    const missing = await runHm(project, ["import", "--from", "auto-memory", "--yes"], clockOptions());
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain(`no auto memory found for ${project.root}`);
    expect(missing.stderr).toContain("Z--elsewhere-project");
    expect(missing.stderr).toContain("--memory-dir");

    const explicit = await runHm(project, ["import", "--memory-dir", other, "--dry-run", "--json"], clockOptions());
    expect(explicit.code).toBe(0);
    expect(explicit.json<ImportReport>()).toMatchObject({ source_kind: "auto-memory", file: other, located: "explicit", bullets: 4 });
    const viaFrom = await runHm(project, ["import", "--from", other, "--dry-run", "--json"], clockOptions());
    expect(viaFrom.code).toBe(0);
    expect(viaFrom.json<ImportReport>()).toMatchObject({ file: other, located: "explicit", bullets: 4 });
    const both = await runHm(project, ["import", "--from", other, "--memory-dir", other, "--dry-run", "--json"], clockOptions());
    expect(both.code).toBe(0);
    expect(both.json<ImportReport>()).toMatchObject({ file: other, located: "explicit", bullets: 4 });

    // `--from <directory>` never switches the mode for a directory without auto-memory notes (a mistyped path, `docs/`).
    const docs = join(project.root, "docs");
    mkdirSync(docs);
    writeFileSync(join(docs, "guide.md"), "# Guide\n\n- A bullet in the docs folder that is not a memory note\n", "utf8");
    const notMemory = await runHm(project, ["import", "--from", "docs", "--dry-run"], clockOptions());
    expect(notMemory.code).toBe(2);
    expect(notMemory.stderr).toContain("without auto-memory notes");
    expect(notMemory.stderr).toContain("--memory-dir");
    // …unless --memory-dir names it explicitly: then it is read as auto memory (and finds no typed note).
    const forced = await runHm(project, ["import", "--memory-dir", docs, "--dry-run", "--json"], clockOptions());
    expect(forced.code).toBe(0);
    expect(forced.json<ImportReport>()).toMatchObject({ source_kind: "auto-memory", bullets: 0 });
    expect(forced.json<ImportReport>().files!.map((file) => [file.name, file.reason])).toEqual([["guide", "no type in the frontmatter"]]);

    writeFileSync(join(project.root, "CLAUDE.md"), "- Keep commit messages in English\n", "utf8");
    const mixed = await runHm(project, ["import", "--from", "CLAUDE.md", "--auto-memory", "--dry-run"], clockOptions());
    expect(mixed.code).toBe(2);
    expect(mixed.stderr).toContain("--auto-memory");
    const differentDirs = await runHm(project, ["import", "--from", other, "--memory-dir", docs, "--dry-run"], clockOptions());
    expect(differentDirs.code).toBe(2);
    expect(differentDirs.stderr).toContain("name different directories");
    const plain = await runHm(project, ["import", "--from", "CLAUDE.md", "--dry-run", "--json"], clockOptions());
    expect(plain.code).toBe(0);
    expect(plain.json<ImportReport>()).toMatchObject({ source_kind: "file", source_path: "CLAUDE.md", located: null, files: null, bullets: 1 });
    expect(plain.json<ImportReport>().rows[0]!.file).toBeNull();

    const gone = await runHm(project, ["import", "--memory-dir", join(project.root, "nope"), "--yes"], clockOptions());
    expect(gone.code).toBe(1);
    expect(gone.stderr).toContain("auto-memory directory not found");

    const empty = createCliProject();
    try {
      const none = await runHm(empty, ["import", "--auto-memory", "--yes"], clockOptions());
      expect(none.code).toBe(1);
      expect(none.stderr).toContain("none has notes yet");
    } finally {
      empty.cleanup();
    }
  });

  test("the scan fallback finds the directory of a session started in a subdirectory of the project and says so", async () => {
    mkdirSync(join(project.root, "packages", "app"), { recursive: true });
    const dir = writeNotes(project, `${projectSlug(project.root)}-packages-app`);
    const result = await runHm(project, ["import", "--from", "auto-memory", "--dry-run", "--json"], clockOptions());
    expect(result.code).toBe(0);
    expect(result.json<ImportReport>()).toMatchObject({ file: dir, located: "scan_subdir", bullets: 4 });
    const text = await runHm(project, ["import", "--from", "auto-memory", "--dry-run"], clockOptions());
    expect(text.stdout).toContain("(directory found by scan subdir)");
  });
});
