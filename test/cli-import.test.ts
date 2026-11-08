/**
 * `hm import` (spec §11, §5.6 import mode, §7.1): bullets → import episodes → extraction pipeline (replay
 * provider) → human/import rows with source_ref `import:<file>#L<n>`; --dry-run; --yes keeps rows unconfirmed
 * with enforcement advise and opens supersede proposals for near-identical rows; a TTY confirmation clears the
 * flag, recomputes the enforcement and supersedes near-identical older rows; --sync stales removed bullets;
 * re-runs are idempotent; no TTY and no --yes is a usage error.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import type { ImportReport } from "../src/cli/commands/import";
import { bulletHash, buildImportDescriptor, importEpisodeId, importSourcePath, parseImportBullets } from "../src/cli/lib/import-file";
import type { ExtractionFact } from "../src/core/extraction-types";
import { EpisodeRepository } from "../src/db/repositories/episodes";
import { ProposalRepository } from "../src/db/repositories/proposals";
import { ProvenanceRepository } from "../src/db/repositories/provenance";
import { createReplayProvider, type ExtractionProvider } from "../src/dream/extract/providers";
import { MemoryRepository } from "../src/memory/repository";
import { createCliProject, runHm, type CliProject } from "./helpers/cli-run";
import { CLI_NOW, clockOptions, readProject, seedProject } from "./helpers/cli-seed";
import { humanMemory } from "./helpers/memory-fixtures";
import { factFixture, outputFixture } from "./helpers/replay-run";

let project: CliProject;

beforeEach(() => {
  project = createCliProject();
});

afterEach(() => {
  project.cleanup();
});

const BULLET_TEST = "Never run `npm test` here; the scripts only work with pnpm";
const BULLET_COMMIT = "Keep commit messages in English";
const CLAUDE_MD = ["# Project rules", "", "## Testing", `- ${BULLET_TEST}`, `- ${BULLET_COMMIT}`, "", "Some paragraph that is not a bullet and is skipped.", "", "```", "- not a bullet: inside a fence", "```", ""].join("\n");

function writeClaudeMd(content: string = CLAUDE_MD): string {
  const file = join(project.root, "CLAUDE.md");
  writeFileSync(file, content, "utf8");
  return file;
}

function pitfallFact(summary: string): ExtractionFact {
  return factFixture({
    summary,
    details: "npm test fails in this repository; pnpm test runs the suite.",
    evidence_refs: ["e1"],
    knowledge_kind: "convention",
    aliases: ["pnpm test"],
  });
}

function policyFact(): ExtractionFact {
  return factFixture({
    type: "policy",
    summary: "Write commit messages in English for this repository",
    details: "Commit messages are read by an international team.",
    trigger_signature: null,
    relevant_tools: [],
    lifecycle_triggers: ["before_model"],
    evidence_refs: ["e1"],
    knowledge_kind: "convention",
    aliases: [],
  });
}

/** Replay answers keyed by the deterministic import episode ids of the two bullets. */
function importProvider(testSummary = "Use pnpm test rather than npm test to run the suite in this repository"): ExtractionProvider {
  const sourcePath = importSourcePath(project.root, join(project.root, "CLAUDE.md"));
  return createReplayProvider({
    answers: {
      [importEpisodeId(sourcePath, { hash: bulletHash(BULLET_TEST) })]: outputFixture([pitfallFact(testSummary)], "Testing conventions."),
      [importEpisodeId(sourcePath, { hash: bulletHash(BULLET_COMMIT) })]: outputFixture([policyFact()], "Commit conventions."),
    },
  });
}

describe("import file parsing", () => {
  test("splits bullets (continuations joined, fences and paragraphs skipped) and keys them by text hash", () => {
    const parsed = parseImportBullets(["# Title", "- first bullet is long enough", "  continued here", "* second bullet, also long", "1. numbered bullet text", "- [ ] checkbox bullet text", "- tiny", "plain paragraph line", "```", "- fenced bullet", "```"].join("\n"));
    expect(parsed.bullets.map((bullet) => bullet.text)).toEqual(["first bullet is long enough continued here", "second bullet, also long", "numbered bullet text", "checkbox bullet text"]);
    expect(parsed.bullets.map((bullet) => bullet.line)).toEqual([2, 4, 5, 6]);
    expect(parsed.bullets[0]!.heading).toBe("Title");
    expect(parsed.skippedLines).toBe(2);
    expect(bulletHash("Keep it SIMPLE.")).toBe(bulletHash("keep it simple"));

    const descriptor = buildImportDescriptor({ sourcePath: "CLAUDE.md", bullet: parsed.bullets[0]!, now: CLI_NOW, root: project.root });
    expect(descriptor).toMatchObject({ host: "import", close_reason: "import", ledger_ref: "import:CLAUDE.md#L2", tools: [], evidence_weight: 1, prompt_text: "first bullet is long enough continued here", context_ref: "(import) section: Title" });
    expect(descriptor.id).toBe(importEpisodeId("CLAUDE.md", parsed.bullets[0]!));
    expect(importSourcePath(project.root, join(project.root, "docs", "RULES.md"))).toBe("docs/RULES.md");
  });
});

describe("hm import", () => {
  test("--dry-run lists the bullets without touching anything; no terminal and no --yes is a usage error", async () => {
    writeClaudeMd();
    const dry = await runHm(project, ["import", "--dry-run", "--json"], clockOptions());
    expect(dry.code).toBe(0);
    const report = dry.json<ImportReport>();
    expect(report).toMatchObject({ source_path: "CLAUDE.md", bullets: 2, skipped_lines: 1, dry_run: true });
    expect(report.rows.map((row) => row.line)).toEqual([4, 5]);
    expect(existsSync(project.paths.db)).toBe(false);

    const refused = await runHm(project, ["import"], clockOptions());
    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain("--yes");
    expect((await runHm(project, ["import", "--from", "missing.md", "--yes"])).code).toBe(1);
  });

  test("--yes imports unconfirmed human rows with source_ref import:<file>#L<n>, enforcement advise; re-runs are idempotent", async () => {
    writeClaudeMd();
    await seedProject(project, () => {});
    const provider = importProvider();

    const result = await runHm(project, ["import", "--yes", "--json"], clockOptions(CLI_NOW, { seams: { provider } }));
    expect(result.code).toBe(0);
    const report = result.json<ImportReport>();
    expect(report.worker).toMatchObject({ busy: false, processed: 2, waiting: null });
    expect(report.created).toHaveLength(2);
    expect(report.confirmation).toBe("unconfirmed");
    expect(report.unconfirmed).toHaveLength(2);
    expect(report.rows.map((row) => row.run_status)).toEqual(["ok", "ok"]);

    await readProject(project, (db) => {
      const memories = new MemoryRepository(db).list({ status: "active" });
      expect(memories).toHaveLength(2);
      const byLine = new Map(memories.map((memory) => [memory.sourceRef, memory]));
      const pitfall = byLine.get("import:CLAUDE.md#L4")!;
      const policy = byLine.get("import:CLAUDE.md#L5")!;
      expect(pitfall).toMatchObject({ authority: "human", sourceKind: "import", knowledgeKind: "import", importUnconfirmed: 1, enforcement: "advise", type: "pitfall", status: "active" });
      expect(pitfall.triggerSignature).toMatchObject({ tool: "bash", pattern: "npm test" });
      expect(policy).toMatchObject({ authority: "human", sourceKind: "import", importUnconfirmed: 1, enforcement: "advise", type: "policy" });
      const provenance = new ProvenanceRepository(db).listForMemory(pitfall.id);
      expect(provenance).toHaveLength(1);
      expect(provenance[0]!.relation).toBe("import");
      const episode = new EpisodeRepository(db).getById(provenance[0]!.episodeId)!;
      expect(episode).toMatchObject({ host: "import", closeReason: "import", status: "extracted", ledgerRef: "import:CLAUDE.md#L4" });
    });
    const snapshot = JSON.parse(readFileSync(project.paths.snapshotActive, "utf8")) as { memories: Array<{ source_file: string | null; import_unconfirmed: number }> };
    expect(snapshot.memories.every((memory) => memory.source_file === "CLAUDE.md" && memory.import_unconfirmed === 1)).toBe(true);

    const again = await runHm(project, ["import", "--yes", "--json"], clockOptions(CLI_NOW, { seams: { provider } }));
    expect(again.code).toBe(0);
    const againReport = again.json<ImportReport>();
    expect(againReport.worker?.processed).toBe(0);
    expect(await readProject(project, (db) => new MemoryRepository(db).list().length)).toBe(2);

    const text = await runHm(project, ["import", "--yes"], clockOptions(CLI_NOW, { seams: { provider } }));
    expect(text.stdout).toContain("import CLAUDE.md: 2 bullets");
    expect(text.stdout).toContain("imported");
  });

  test("a TTY confirmation clears the flag, recomputes the enforcement and supersedes near-identical older rows", async () => {
    writeClaudeMd();
    const summary = "Never invoke npm test; use pnpm test for the suite in this repository";
    let oldId = "";
    await seedProject(project, (db) => {
      oldId = new MemoryRepository(db, { clock: () => CLI_NOW }).create(humanMemory({ summary: `${summary}!`, type: "pitfall", scopeGlob: "**/*", sourceKind: "legacy", sourceRef: "import:legacy" })).id;
    });
    const provider = importProvider(summary);
    const questions: string[] = [];
    const result = await runHm(project, ["import", "--json"], clockOptions(CLI_NOW, { seams: { provider }, isTTY: true, confirm: async (question) => (questions.push(question), true) }));
    expect(result.code).toBe(0);
    const report = result.json<ImportReport>();
    expect(questions).toHaveLength(1);
    expect(report.confirmation).toBe("confirmed");
    expect(report.confirmed).toHaveLength(2);
    expect(report.superseded).toEqual([oldId]);

    await readProject(project, (db) => {
      const memories = new MemoryRepository(db);
      const pitfall = memories.list({ status: "active", type: "pitfall" })[0]!;
      expect(pitfall).toMatchObject({ importUnconfirmed: 0, enforcement: "confirm", authority: "human" });
      const policy = memories.list({ status: "active", type: "policy" })[0]!;
      expect(policy).toMatchObject({ importUnconfirmed: 0, enforcement: "advise" });
      expect(memories.getById(oldId)).toMatchObject({ status: "superseded", supersededByMemoryId: pitfall.id, statusReason: "import" });
    });
  });

  test("declining the table leaves the rows unconfirmed; --yes opens supersede proposals for near-identical rows", async () => {
    writeClaudeMd();
    const summary = "Never invoke npm test; use pnpm test for the suite in this repository";
    let oldId = "";
    await seedProject(project, (db) => {
      oldId = new MemoryRepository(db, { clock: () => CLI_NOW }).create(humanMemory({ summary: `${summary}.`, type: "pitfall", scopeGlob: "**/*" })).id;
    });
    const provider = importProvider(summary);
    const declined = await runHm(project, ["import", "--json"], clockOptions(CLI_NOW, { seams: { provider }, isTTY: true, confirm: async () => false }));
    expect(declined.code).toBe(0);
    expect(declined.json<ImportReport>().confirmation).toBe("declined");
    expect(await readProject(project, (db) => new MemoryRepository(db).list({ importUnconfirmed: 1 }).length)).toBe(2);
    expect(await readProject(project, (db) => new MemoryRepository(db).getById(oldId)?.status)).toBe("active");

    // A second project: the --yes path proposes instead of superseding.
    const other = createCliProject();
    try {
      writeFileSync(join(other.root, "CLAUDE.md"), CLAUDE_MD, "utf8");
      let otherOld = "";
      await seedProject(other, (db) => {
        otherOld = new MemoryRepository(db, { clock: () => CLI_NOW }).create(humanMemory({ summary: `${summary}.`, type: "pitfall", scopeGlob: "**/*" })).id;
      });
      const sourcePath = importSourcePath(other.root, join(other.root, "CLAUDE.md"));
      const otherProvider = createReplayProvider({
        answers: {
          [importEpisodeId(sourcePath, { hash: bulletHash(BULLET_TEST) })]: outputFixture([pitfallFact(summary)]),
          [importEpisodeId(sourcePath, { hash: bulletHash(BULLET_COMMIT) })]: outputFixture([policyFact()]),
        },
      });
      const yes = await runHm(other, ["import", "--yes", "--json"], clockOptions(CLI_NOW, { seams: { provider: otherProvider } }));
      expect(yes.code).toBe(0);
      const report = yes.json<ImportReport>();
      expect(report.upgrade_proposals).toHaveLength(1);
      const store = await readProject(other, (db) => ({ proposal: new ProposalRepository(db).getById(report.upgrade_proposals[0]!), old: new MemoryRepository(db).getById(otherOld) }));
      expect(store.proposal).toMatchObject({ kind: "supersede", targetMemoryId: otherOld, createdBy: "import", status: "open" });
      expect(store.old?.status).toBe("active");
    } finally {
      other.cleanup();
    }
  });

  test("--sync stales the live rows whose bullets disappeared and keeps the ones still present", async () => {
    writeClaudeMd();
    await seedProject(project, () => {});
    const provider = importProvider();
    expect((await runHm(project, ["import", "--yes"], clockOptions(CLI_NOW, { seams: { provider } }))).code).toBe(0);

    writeClaudeMd(["# Project rules", `- ${BULLET_TEST}`, ""].join("\n"));
    const synced = await runHm(project, ["import", "--yes", "--sync", "--json"], clockOptions(CLI_NOW, { seams: { provider } }));
    expect(synced.code).toBe(0);
    const report = synced.json<ImportReport>();
    expect(report.synced_stale).toHaveLength(1);
    await readProject(project, (db) => {
      const memories = new MemoryRepository(db);
      const staled = memories.getById(report.synced_stale[0]!)!;
      expect(staled).toMatchObject({ status: "stale", statusReason: "import_sync", type: "policy" });
      expect(memories.list({ status: "active" })).toHaveLength(1);
      expect(memories.list({ status: "active" })[0]!.type).toBe("pitfall");
    });
    const text = await runHm(project, ["import", "--yes", "--sync"], clockOptions(CLI_NOW, { seams: { provider } }));
    expect(text.code).toBe(0);
    expect(text.stdout).not.toContain("sync: staled");
  });

  test("without a provider the bullets stay queued and the report says so", async () => {
    writeClaudeMd();
    await seedProject(project, () => {});
    const result = await runHm(project, ["import", "--yes", "--json"], clockOptions(CLI_NOW, { seams: { provider: null } }));
    expect(result.code).toBe(0);
    const report = result.json<ImportReport>();
    expect(report.worker?.waiting).toEqual({ count: 2, reason: "no_provider" });
    expect(report.created).toEqual([]);
    expect(report.rows.every((row) => row.episode_status === "queued")).toBe(true);
    const text = await runHm(project, ["import", "--yes"], clockOptions(CLI_NOW, { seams: { provider: null } }));
    expect(text.stdout).toContain("waiting: 2 episodes (no_provider)");
  });
});
