/**
 * Claude Code's native auto memory as an import source (phase F A′ §4, src/cli/lib/auto-memory.ts): project slug
 * derivation (Windows and POSIX paths, checked against real `~/.claude/projects` names), config-directory resolution
 * (one rule with ./paths: CLAUDE_CONFIG_DIR, `os.homedir()` semantics per platform), the directory lookup (derived,
 * canonical path, case-insensitive scan, subdirectory scan that checks the real tree, no match → candidates, the
 * located directory canonicalised so a case-different root yields the same refs), frontmatter parsing (nested
 * `metadata.type`, top-level `type`, quoted values with JSON escapes, a BOM, block scalars), the bullet policy for
 * the real feedback-note template (rule bullets minus the dated state log, else the `**How to apply:**` paragraph,
 * else the first context paragraph, else the description), the size caps, MEMORY.md exclusion, the `--sync`
 * universe with its protected files, the memory-directory check `--from <dir>` relies on, and the refs the hooks see.
 */

import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { isHostLoadedFile } from "../src/activation/injection";
import {
  AUTO_MEMORY_MAX_BULLETS_PER_FILE,
  AUTO_MEMORY_MAX_FILE_BYTES,
  AUTO_MEMORY_PARAGRAPH_MAX_CHARS,
  autoMemorySourcePath,
  autoMemorySyncPrefix,
  canonicalDirectory,
  claudeConfigDirectory,
  claudeProjectsDirectory,
  clipText,
  firstParagraph,
  homeDirectory,
  howToApplyParagraph,
  isDirectory,
  isLogLine,
  listAutoMemoryNotes,
  locateAutoMemory,
  looksLikeAutoMemoryDirectory,
  noteBullets,
  noteContextRef,
  parseFrontmatter,
  planAutoMemoryImport,
  projectSlug,
  selectAutoMemoryNotes,
  slugSuffixIsSubdirectory,
  type AutoMemoryNote,
} from "../src/cli/lib/auto-memory";
import { buildImportDescriptor, bulletHash, importEpisodeId, importSourceRef, importSourceRefPrefix } from "../src/cli/lib/import-file";
import { claudeConfigDir } from "../src/cli/lib/paths";
import { sourceFileOf } from "../src/db/snapshot";

let base: string;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "hm-auto-memory-")));
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

interface NoteOptions {
  name?: string;
  description?: string;
  type?: string | null;
  /** false → top-level `type:`; default nests it under `metadata:` like the Claude Code CLI does. */
  nested?: boolean;
  body?: string;
}

/** A topic file the way Claude Code writes it (frontmatter, blank line, body). */
function noteFile(options: NoteOptions): string {
  const lines = ["---"];
  if (options.name !== undefined) lines.push(`name: ${options.name}`);
  if (options.description !== undefined) lines.push(`description: ${JSON.stringify(options.description)}`);
  if (options.type !== null && options.type !== undefined) {
    if (options.nested === false) lines.push(`type: ${options.type}`);
    else lines.push("metadata:", "  node_type: memory", `  type: ${options.type}`, "  originSessionId: ba528706-0b73-4088-805a-a7cf0602b825", "  modified: 2026-11-08T00:00:00.000Z");
  }
  lines.push("---", "");
  return `${lines.join("\n")}${options.body ?? ""}`;
}

function makeNote(dir: string, file: string, options: NoteOptions): AutoMemoryNote {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), noteFile(options), "utf8");
  return listAutoMemoryNotes(dir).notes.find((note) => note.file === join(dir, file))!;
}

function memoryDirFor(configDir: string, slug: string): string {
  const dir = join(configDir, "projects", slug, "memory");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** `isDirectory` that also requires every segment below `base` to match its on-disk spelling (Windows and macOS resolve a case-different name as the same directory). */
function caseSensitiveIsDirectory(path: string): boolean {
  if (!isDirectory(path)) return false;
  let current = path;
  while (current.startsWith(base) && current !== base) {
    const parent = dirname(current);
    if (!readdirSync(parent).includes(basename(current))) return false;
    current = parent;
  }
  return true;
}

/** The feedback-note body Claude Code writes: context → **Why:** → **How to apply:** (+ a dated state log). */
const TEMPLATE_BODY = [
  "During multi-hour workflow runs on 2026-10-31 and 2026-11-01 the user kept checking in: \"하고있니\", \"뭐하니\".",
  "",
  "**Why:** Background workflows show nothing for long stretches, so silence reads as stuck or slow.",
  "",
  "**How to apply:**",
  "- When starting long work, say three things: what is running, roughly how long it takes, and what the user will see next.",
  "- When the user checks in, answer in 2–3 lines with concrete progress before doing anything else.",
  "- State on 2026-11-07 (night): the user approved the set (\"설치하고 진행\"); nothing else changed.",
  "- 2026-11-08 ~17:00: W8 pick-grid workflow done (13 agents, 2.3 h); sheet not sent.",
  "",
  "Related: [[seoro-quiz-previous-session]].",
  "",
].join("\n");

describe("project slug and config directory", () => {
  test("every character outside [A-Za-z0-9] becomes '-' (verified against real ~/.claude/projects names)", () => {
    expect(projectSlug("C:\\Users\\choey")).toBe("C--Users-choey");
    expect(projectSlug("C:\\Users\\choey\\harness-memory-repo")).toBe("C--Users-choey-harness-memory-repo");
    expect(projectSlug("C:\\Users\\choey\\.harness-memory\\worker\\a8da558e19605c28")).toBe("C--Users-choey--harness-memory-worker-a8da558e19605c28");
    expect(projectSlug("/home/me/my app")).toBe("-home-me-my-app");
    expect(projectSlug("/srv/app-2.0")).toBe("-srv-app-2-0");
  });

  test("home follows os.homedir(): USERPROFILE (then HOMEDRIVE+HOMEPATH, never HOME) on Windows, HOME elsewhere; CLAUDE_CONFIG_DIR overrides; one rule with paths.claudeConfigDir", () => {
    expect(homeDirectory({ platform: "win32", env: { USERPROFILE: "C:\\Users\\me", HOME: "/c/Users/me" } })).toBe("C:\\Users\\me");
    expect(homeDirectory({ platform: "win32", env: { HOMEDRIVE: "D:", HOMEPATH: "\\Users\\me", HOME: "/d/Users/me" } })).toBe("D:\\Users\\me");
    // Git Bash exports a POSIX-style HOME that Node's os.homedir() never reads on Windows: fall back to the real home.
    expect(homeDirectory({ platform: "win32", env: { HOME: "/c/Users/me" } })).toBe(homedir());
    expect(homeDirectory({ platform: "linux", env: { HOME: "/home/me", USERPROFILE: "C:\\Users\\me" } })).toBe("/home/me");
    expect(homeDirectory({ platform: "darwin", env: {} })).toBe(homedir());

    expect(claudeConfigDirectory({ platform: "linux", env: { HOME: "/home/me" } })).toBe(join("/home/me", ".claude"));
    expect(claudeConfigDirectory({ platform: "win32", env: { USERPROFILE: "C:\\Users\\me" } })).toBe(join("C:\\Users\\me", ".claude"));
    expect(claudeConfigDirectory({ platform: "win32", env: { HOME: "/c/Users/me" } })).toBe(join(homedir(), ".claude"));
    expect(claudeConfigDirectory({ env: { CLAUDE_CONFIG_DIR: base, HOME: "/elsewhere" } })).toBe(base);
    expect(claudeConfigDirectory({ env: { CLAUDE_CONFIG_DIR: "", HOME: "/home/me" }, platform: "linux" })).toBe(join("/home/me", ".claude"));
    expect(claudeProjectsDirectory({ env: { CLAUDE_CONFIG_DIR: base } })).toBe(join(base, "projects"));
    // Without a platform override the import resolves the config directory exactly like install and the settings writer.
    for (const env of [{}, { CLAUDE_CONFIG_DIR: base }, { HOME: "/c/Users/me" }, { USERPROFILE: "C:\\Users\\me" }] as NodeJS.ProcessEnv[]) {
      expect(claudeConfigDirectory({ env })).toBe(claudeConfigDir(env));
    }
  });
});

describe("locateAutoMemory", () => {
  let root: string;
  let configDir: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    root = join(base, "project");
    mkdirSync(root, { recursive: true });
    configDir = join(base, "claude-config");
    env = { CLAUDE_CONFIG_DIR: configDir };
  });

  test("reports the derived directory when nothing exists, and finds it (canonical spelling) when it does", () => {
    const missing = locateAutoMemory(root, { env });
    expect(missing.location).toBeNull();
    expect(missing.projectsDir).toBe(join(configDir, "projects"));
    expect(missing.slug).toBe(projectSlug(root));
    expect(missing.derived).toBe(join(configDir, "projects", projectSlug(root), "memory"));
    expect(missing.candidates).toEqual([]);

    const dir = memoryDirFor(configDir, projectSlug(root));
    mkdirSync(join(configDir, "projects", "no-memory-here"), { recursive: true });
    const found = locateAutoMemory(root, { env });
    expect(found.location).toEqual({ dir: canonicalDirectory(dir), projectDir: canonicalDirectory(join(configDir, "projects", projectSlug(root))), slug: projectSlug(root), how: "derived" });
    expect(isDirectory(found.location!.dir)).toBe(true);
  });

  test("a case-different spelling of the root yields the same directory, refs and --sync prefix (idempotent imports)", () => {
    const dir = memoryDirFor(configDir, projectSlug(root));
    // Flip only the basename (pure ASCII): both directories the lookup stats — the variant root and its derived memory
    // directory — live in fresh sibling directories under `base`, so they share one case regime whatever the ancestors
    // of tmpdir do.
    const variant = join(dirname(root), "PROJECT");
    expect(variant).not.toBe(root);
    const canonical = locateAutoMemory(root, { env });
    const differentCase = locateAutoMemory(variant, { env });
    // On a case-insensitive volume (Windows, macOS) the variant's derived directory exists under its own spelling
    // ("derived"); on a case-sensitive one (Linux — the two ubuntu CI jobs; macOS and Windows take the derived branch) it does not, and the case-insensitive scan over
    // <projects>/*/memory finds the same directory ("scan_case"). Either way dir, refs and the --sync prefix agree.
    expect(differentCase.location?.how).toBe(isDirectory(differentCase.derived) ? "derived" : "scan_case");
    expect(differentCase.location?.dir).toBe(canonical.location?.dir);
    expect(differentCase.location?.dir).toBe(canonicalDirectory(dir));
    expect(autoMemorySyncPrefix(differentCase.location!.dir)).toBe(autoMemorySyncPrefix(canonical.location!.dir));
    expect(autoMemorySourcePath(join(differentCase.location!.dir, "topic.md"))).toBe(autoMemorySourcePath(join(canonical.location!.dir, "topic.md")));
    expect(canonicalDirectory(join(base, "does-not-exist"))).toBe(join(base, "does-not-exist"));
  });

  test("a symlinked project directory is listed, so the exact slug wins over a case-variant sibling", () => {
    const slug = projectSlug(root);
    const target = join(base, "shared-target");
    mkdirSync(join(target, "memory"), { recursive: true });
    mkdirSync(join(configDir, "projects"), { recursive: true });
    symlinkSync(target, join(configDir, "projects", slug), process.platform === "win32" ? "junction" : "dir");
    // On a case-sensitive volume this is a second, distinct entry that differs from the slug only by case; on a
    // case-insensitive one the path resolves to the link itself and the directory already exists. Before the listing
    // included symlinked directories the exact match missed and the case-insensitive fallback picked the sibling.
    const sibling = slug.toLowerCase() === slug ? slug.toUpperCase() : slug.toLowerCase();
    expect(sibling).not.toBe(slug);
    mkdirSync(join(configDir, "projects", sibling, "memory"), { recursive: true });
    const found = locateAutoMemory(root, { env });
    expect(found.location).toMatchObject({ how: "derived", dir: canonicalDirectory(join(target, "memory")) });
  });

  test("falls back to the canonical path's slug, then to a case-insensitive scan", () => {
    const real = join(base, "real-project");
    mkdirSync(real, { recursive: true });
    const realDir = memoryDirFor(configDir, projectSlug(real));
    const viaRealpath = locateAutoMemory(root, { env, realpath: () => real });
    expect(viaRealpath.location).toMatchObject({ dir: canonicalDirectory(realDir), how: "realpath" });
    rmSync(join(configDir, "projects"), { recursive: true, force: true });

    const slug = projectSlug(root);
    const variant = slug.toLowerCase() === slug ? slug.toUpperCase() : slug.toLowerCase();
    expect(variant).not.toBe(slug);
    const variantDir = memoryDirFor(configDir, variant);
    // On a case-sensitive file system the derived directory is absent and the scan finds the variant.
    const viaScan = locateAutoMemory(root, { env, realpath: () => null, isDirectory: caseSensitiveIsDirectory });
    expect(viaScan.location).toMatchObject({ dir: canonicalDirectory(variantDir), slug: variant, how: "scan_case" });
    // With the real file system a case-insensitive volume (Windows, macOS) already resolves the derived name to it,
    // and the canonical spelling is the on-disk one (the variant), whichever way it was found.
    const native = locateAutoMemory(root, { env, realpath: () => null });
    expect(native.location).not.toBeNull();
    expect(["derived", "scan_case"]).toContain(native.location!.how);
    expect(native.location!.dir).toBe(canonicalDirectory(variantDir));
    expect(isDirectory(native.location!.dir)).toBe(true);
  });

  test("a subdirectory session's slug is accepted only when the subdirectory really exists; otherwise the memory directories become candidates", () => {
    const slug = projectSlug(root);
    const decoy = memoryDirFor(configDir, `${slug}-v2`);
    const none = locateAutoMemory(root, { env, realpath: () => null });
    expect(none.location).toBeNull();
    expect(none.candidates).toEqual([decoy]);

    mkdirSync(join(root, "packages", "app"), { recursive: true });
    const nested = memoryDirFor(configDir, `${slug}-packages-app`);
    const one = locateAutoMemory(root, { env, realpath: () => null });
    expect(one.location).toMatchObject({ dir: canonicalDirectory(nested), how: "scan_subdir" });

    mkdirSync(join(root, "tools"), { recursive: true });
    const second = memoryDirFor(configDir, `${slug}-tools`);
    const ambiguous = locateAutoMemory(root, { env, realpath: () => null });
    expect(ambiguous.location).toBeNull();
    expect(ambiguous.candidates.sort()).toEqual([nested, second].sort());

    expect(slugSuffixIsSubdirectory(root, "packages-app")).toBe(true);
    expect(slugSuffixIsSubdirectory(root, "tools")).toBe(true);
    expect(slugSuffixIsSubdirectory(root, "v2")).toBe(false);
    expect(slugSuffixIsSubdirectory(root, "")).toBe(false);
    mkdirSync(join(root, "my-lib", "src"), { recursive: true });
    expect(slugSuffixIsSubdirectory(root, "my-lib-src")).toBe(true);
  });
});

describe("frontmatter", () => {
  test("reads name, description (quoted, with escapes) and the type nested under metadata", () => {
    const content = noteFile({ name: "no-terminating-terminals", description: 'Never close "user" terminals; ask first', type: "feedback", body: "Body line.\n" });
    const parsed = parseFrontmatter(content);
    expect(parsed).toEqual({ name: "no-terminating-terminals", description: 'Never close "user" terminals; ask first', type: "feedback", descriptionLine: 3, lines: 9 });
    expect(content.split("\n")[parsed.lines - 1]).toBe("---");
    expect(content.split("\n")[parsed.lines]).toBe("Body line.");
  });

  test("accepts a top-level type (which wins over metadata.type), normalizes case, and tolerates missing or unterminated blocks", () => {
    expect(parseFrontmatter(noteFile({ type: "Project", nested: false })).type).toBe("project");
    expect(parseFrontmatter("---\ntype: feedback\nmetadata:\n  type: user\n---\n").type).toBe("feedback");
    expect(parseFrontmatter("---\nmetadata:\n  type: user\ntype: feedback\n---\n").type).toBe("feedback");
    expect(parseFrontmatter("---\nname: 'it''s'\ndescription: plain text, no quotes\n---\n")).toMatchObject({ name: "it's", description: "plain text, no quotes", type: null, lines: 4 });
    expect(parseFrontmatter("Just a body\n- bullet")).toEqual({ name: null, description: null, type: null, descriptionLine: null, lines: 0 });
    expect(parseFrontmatter("---\nname: unterminated\n")).toEqual({ name: null, description: null, type: null, descriptionLine: null, lines: 0 });
    expect(parseFrontmatter("")).toMatchObject({ lines: 0 });
  });

  test("a UTF-8 BOM, JSON escapes in double-quoted values and `>` / `|` block scalars are read like the notes write them", () => {
    const bom = parseFrontmatter("\uFEFF---\nname: with-bom\nmetadata:\n  type: feedback\n---\nBody.\n");
    expect(bom).toMatchObject({ name: "with-bom", type: "feedback", lines: 5 });

    const escaped = parseFrontmatter('---\ndescription: "line one\\nline two \\u2014 dash \\"quoted\\" back\\\\slash"\nmetadata:\n  type: feedback\n---\n');
    expect(escaped.description).toBe('line one\nline two — dash "quoted" back\\slash');
    // Not strict JSON (a lone backslash): the minimal unescape of \" and \\ still applies instead of dropping the value.
    expect(parseFrontmatter('---\ndescription: "C:\\S8Root \\"x\\""\n---\n').description).toBe('C:\\S8Root "x"');

    const folded = parseFrontmatter(["---", "name: block", "description: >", "  Give short progress updates", "  during long runs.", "", "  Unprompted.", "metadata:", "  type: feedback", "---", "Body."].join("\n"));
    expect(folded).toEqual({ name: "block", description: "Give short progress updates during long runs. Unprompted.", type: "feedback", descriptionLine: 3, lines: 10 });
    const literal = parseFrontmatter("---\ndescription: |-\n  first\n  second\ntype: Feedback\n---\n");
    expect(literal).toMatchObject({ description: "first second", type: "feedback", descriptionLine: 2, lines: 6 });
    expect(parseFrontmatter("---\ndescription: >\n---\n").description).toBeNull();
  });
});

describe("notes, selection and bullets", () => {
  test("lists topic files in name order; MEMORY.md and oversized files are reported with their source paths, non-Markdown files are left out", () => {
    const dir = join(base, "memory");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "MEMORY.md"), "- [A](b-feedback.md) — index line\n", "utf8");
    writeFileSync(join(dir, "b-feedback.md"), noteFile({ name: "b", type: "feedback", body: "- Keep it short enough to matter\n" }), "utf8");
    writeFileSync(join(dir, "a-project.md"), noteFile({ type: "project", body: "Project facts.\n" }), "utf8");
    writeFileSync(join(dir, "notes.txt"), "not markdown", "utf8");
    writeFileSync(join(dir, "huge.md"), `${noteFile({ type: "feedback" })}${"x".repeat(AUTO_MEMORY_MAX_FILE_BYTES + 1)}`, "utf8");
    mkdirSync(join(dir, "sub.md"));

    const listing = listAutoMemoryNotes(dir);
    expect(listing.dir).toBe(dir);
    expect(listing.notes.map((note) => note.name)).toEqual(["a-project", "b"]);
    expect(listing.notes[0]).toMatchObject({ file: join(dir, "a-project.md"), type: "project", description: null, frontmatterLines: 7 });
    expect(listing.notes[0]!.sourcePath).toBe(`auto-memory:${join(dir, "a-project.md").split("\\").join("/")}`);
    expect(listing.notes[1]!.body).toBe("- Keep it short enough to matter\n");
    expect(listing.skipped.map((entry) => [entry.file, entry.sourcePath, entry.reason])).toEqual([
      [join(dir, "MEMORY.md"), autoMemorySourcePath(join(dir, "MEMORY.md")), expect.stringContaining("index file Claude Code loads every session")],
      [join(dir, "huge.md"), autoMemorySourcePath(join(dir, "huge.md")), `${String(AUTO_MEMORY_MAX_FILE_BYTES + 149)} bytes exceeds the ${String(AUTO_MEMORY_MAX_FILE_BYTES)}-byte cap`],
    ]);

    // The `--from <directory>` check: an index or a typed note makes a memory directory; anything else does not.
    expect(looksLikeAutoMemoryDirectory(dir)).toBe(true);
    const docs = join(base, "docs");
    mkdirSync(docs);
    writeFileSync(join(docs, "guide.md"), "# Guide\n\n- a bullet long enough\n", "utf8");
    expect(looksLikeAutoMemoryDirectory(docs)).toBe(false);
    writeFileSync(join(docs, "typed.md"), noteFile({ type: "feedback", body: "- a rule\n" }), "utf8");
    expect(looksLikeAutoMemoryDirectory(docs)).toBe(true);
    const indexOnly = join(base, "index-only");
    mkdirSync(indexOnly);
    writeFileSync(join(indexOnly, "MEMORY.md"), "# index\n", "utf8");
    expect(looksLikeAutoMemoryDirectory(indexOnly)).toBe(true);
    expect(looksLikeAutoMemoryDirectory(join(base, "missing"))).toBe(false);
    expect(looksLikeAutoMemoryDirectory(join(docs, "guide.md"))).toBe(false);
  });

  test("selects feedback notes by default, project notes with the flag, and explains every skip", () => {
    const dir = join(base, "memory");
    const feedback = makeNote(dir, "feedback.md", { type: "feedback" });
    const project = makeNote(dir, "project.md", { type: "project" });
    const user = makeNote(dir, "user.md", { type: "user" });
    const reference = makeNote(dir, "reference.md", { type: "reference" });
    const untyped = makeNote(dir, "untyped.md", { type: null });
    const notes = [feedback, project, user, reference, untyped];

    const byDefault = selectAutoMemoryNotes(notes);
    expect(byDefault.selected.map((note) => note.name)).toEqual(["feedback"]);
    expect(byDefault.skipped.map((entry) => [entry.note.name, entry.reason])).toEqual([
      ["project", "type project (pass --include-project)"],
      ["user", "type user (not an import source)"],
      ["reference", "type reference (not an import source)"],
      ["untyped", "no type in the frontmatter"],
    ]);
    expect(selectAutoMemoryNotes(notes, ["feedback", "project"]).selected.map((note) => note.name)).toEqual(["feedback", "project"]);
  });

  test("Markdown bullets become bullets with file line numbers (frontmatter offset applied) up to the per-file cap", () => {
    const dir = join(base, "memory");
    const note = makeNote(dir, "progress.md", {
      name: "progress-updates",
      description: "Give short progress updates",
      type: "feedback",
      body: "During long runs the user checks in.\n\n**How to apply:**\n- Say what is running and how long it takes\n  before starting the work\n- Parallelize independent work instead of running it in sequence\n- tiny\n",
    });
    const result = noteBullets(note);
    expect(result.mode).toBe("bullets");
    expect(result.truncated).toBe(0);
    expect(result.bullets.map((bullet) => bullet.text)).toEqual(["Say what is running and how long it takes before starting the work", "Parallelize independent work instead of running it in sequence"]);
    // Frontmatter: 9 lines; the body starts on file line 10; the first bullet is body line 4 → file line 13.
    expect(note.frontmatterLines).toBe(9);
    expect(result.bullets.map((bullet) => bullet.line)).toEqual([13, 15]);
    expect(result.bullets[0]!.hash).toBe(bulletHash("Say what is running and how long it takes before starting the work"));
    // "During long runs…", "**How to apply:**" and the too-short "tiny" bullet are the skipped lines.
    expect(result.skippedLines).toBe(3);

    const many = makeNote(dir, "many.md", { type: "feedback", body: Array.from({ length: AUTO_MEMORY_MAX_BULLETS_PER_FILE + 10 }, (_, index) => `- Bullet number ${String(index + 1)} of a long list`).join("\n") });
    const capped = noteBullets(many);
    expect(capped.bullets).toHaveLength(AUTO_MEMORY_MAX_BULLETS_PER_FILE);
    expect(capped.truncated).toBe(10);
  });

  test("the real template: dated state-log bullets are dropped, the **How to apply:** bullets are the rules", () => {
    const dir = join(base, "memory");
    const note = makeNote(dir, "progress-updates-during-long-work.md", { name: "progress-updates-during-long-work", description: "User checks in often during long background runs; give short, concrete progress updates unprompted", type: "feedback", body: TEMPLATE_BODY });
    const result = noteBullets(note);
    expect(result.mode).toBe("bullets");
    expect(result.bullets.map((bullet) => bullet.text)).toEqual([
      "When starting long work, say three things: what is running, roughly how long it takes, and what the user will see next.",
      "When the user checks in, answer in 2–3 lines with concrete progress before doing anything else.",
    ]);
    // Body line 6 → file line 15 (9 frontmatter lines).
    expect(result.bullets.map((bullet) => bullet.line)).toEqual([15, 16]);
    // Context, Why, the label, Related and the two log bullets are not rules.
    expect(result.skippedLines).toBe(6);

    expect(isLogLine("2026-11-08 ~17:00: W8 pick-grid workflow done")).toBe(true);
    expect(isLogLine("2026-11-02: \"살짝 아쉬운데\"")).toBe(true);
    expect(isLogLine("State on 2026-11-07 (late): six drafts exist")).toBe(true);
    expect(isLogLine("**State on 2026-11-08 (early morning):** done")).toBe(true);
    expect(isLogLine("**Update 2026-11-08 22:05:** the owner rejected a test")).toBe(true);
    expect(isLogLine("Related: [[seoro-quiz-previous-session]].")).toBe(true);
    expect(isLogLine("Research before drafting when the user asks for analysis (2026-11-07).")).toBe(false);
    expect(isLogLine("Update the README before each release")).toBe(false);
  });

  test("without rule bullets the **How to apply:** paragraph wins (label stripped), else the first context paragraph, else the description; each ≤ 300 chars", () => {
    const dir = join(base, "memory");
    const howToApply = makeNote(dir, "gstack-declined.md", {
      name: "gstack-declined",
      description: "The owner declined adopting gstack on 2026-11-08; do not propose it again",
      type: "feedback",
      body: "On 2026-11-08 the owner asked whether gstack would help; I assessed it and recommended a selective install. The owner answered no.\n\n**Why:** the project's open problems are already covered.\n\n**How to apply:** do not suggest gstack again (or its individual skills)\nunless the owner brings it up. Related: [[use-popular-community-skills]].\n",
    });
    const rule = noteBullets(howToApply);
    expect(rule.mode).toBe("how_to_apply");
    expect(rule.bullets).toHaveLength(1);
    expect(rule.bullets[0]!.text).toBe("do not suggest gstack again (or its individual skills) unless the owner brings it up. Related: [[use-popular-community-skills]].");
    // Body line 5 → file line 14.
    expect(rule.bullets[0]!.line).toBe(14);
    expect(howToApplyParagraph("**How to apply**:\n- a bullet\n")).toBeNull();
    expect(howToApplyParagraph("**How to apply:**\n\nAnswer in Korean, keep the evidence tags.\n")).toEqual({ line: 3, text: "Answer in Korean, keep the evidence tags.", lines: 1 });
    expect(howToApplyParagraph("**How to apply:**\n\n**Why:** nothing\n")).toBeNull();
    expect(howToApplyParagraph("How to apply: plain label works too")).toEqual({ line: 1, text: "plain label works too", lines: 1 });

    const paragraph = makeNote(dir, "terminals.md", {
      name: "no-terminating-terminals",
      description: "Never close terminals without asking",
      type: "feedback",
      body: "# Context\n\nDon't terminate terminal tabs, the user's processes or WSL\nwithout asking first. Only stop processes Claude started itself.\n\n**Why:** the user said so.\n",
    });
    const one = noteBullets(paragraph);
    expect(one.mode).toBe("paragraph");
    expect(one.bullets).toHaveLength(1);
    expect(one.bullets[0]!.text).toBe("Don't terminate terminal tabs, the user's processes or WSL without asking first. Only stop processes Claude started itself.");
    expect(one.bullets[0]!.line).toBe(paragraph.frontmatterLines + 3);
    expect(one.bullets[0]!.heading).toBeNull();
    expect(one.skippedLines).toBe(1);

    // A narrative that is only a dated log plus a Why has no rule paragraph: the description is the last resort.
    const logOnly = makeNote(dir, "log-only.md", { name: "log-only", description: "Show only finished art renders to the owner", type: "feedback", body: "2026-11-08 ~21:20: owner-refs measurement done.\n\n**Why:** three rounds of rejections.\n\nRelated: [[owner-art-taste]].\n" });
    const described = noteBullets(logOnly);
    expect(described.mode).toBe("description");
    expect(described.bullets).toEqual([{ line: 3, text: "Show only finished art renders to the owner", hash: bulletHash("Show only finished art renders to the owner"), heading: null }]);

    const long = makeNote(dir, "long.md", { type: "feedback", body: `${Array.from({ length: 60 }, (_, index) => `word${String(index)}`).join(" ")}\n` });
    const clipped = noteBullets(long);
    expect(clipped.mode).toBe("paragraph");
    expect(clipped.bullets[0]!.text.length).toBeLessThanOrEqual(AUTO_MEMORY_PARAGRAPH_MAX_CHARS);
    expect(clipped.bullets[0]!.text.endsWith("…")).toBe(true);
    expect(clipped.bullets[0]!.text).not.toMatch(/\s…$/);
    expect(clipped.bullets[0]!.text).toMatch(/^word0 word1 /);

    const empty = makeNote(dir, "empty.md", { type: "feedback", body: "```\n- fenced bullet only\n```\n" });
    expect(noteBullets(empty)).toMatchObject({ mode: "empty", bullets: [] });

    expect(firstParagraph("")).toBeNull();
    expect(firstParagraph("## Heading only\n\n---\n")).toBeNull();
    expect(firstParagraph("<!-- comment -->\nreal text here\nsecond line\n\nnext paragraph")).toEqual({ line: 2, text: "real text here second line", lines: 2 });
    expect(firstParagraph("**Why:** rationale first\n\nThe actual rule comes second.\n")).toEqual({ line: 3, text: "The actual rule comes second.", lines: 1 });
    expect(firstParagraph("- a bullet\nnot a continuation? it is indented-less\n")).toEqual({ line: 2, text: "not a continuation? it is indented-less", lines: 1 });
    expect(clipText("short", 10)).toBe("short");
    expect(clipText("alpha beta gamma delta", 16)).toBe("alpha beta…");
    expect(clipText("x".repeat(40), 10)).toBe(`${"x".repeat(9)}…`);
  });

  test("the import plan carries every parsed note's hashes as the --sync universe and protects the files it could not parse", () => {
    const dir = join(base, "memory");
    makeNote(dir, "feedback.md", { type: "feedback", body: "- Feedback bullet long enough\n" });
    makeNote(dir, "project.md", { type: "project", body: "- Project bullet long enough\n" });
    makeNote(dir, "user.md", { type: "user", body: "- User bullet long enough\n" });
    writeFileSync(join(dir, "MEMORY.md"), "- [f](feedback.md) — index\n", "utf8");
    writeFileSync(join(dir, "huge.md"), `${noteFile({ type: "feedback", body: "- Huge bullet long enough\n" })}${"x".repeat(AUTO_MEMORY_MAX_FILE_BYTES)}`, "utf8");
    const plan = planAutoMemoryImport(dir);
    expect(plan.dir).toBe(dir);
    expect(plan.notes.map((entry) => entry.note.name)).toEqual(["feedback"]);
    expect(plan.selection.skipped).toHaveLength(2);
    expect([...plan.syncHashes].sort()).toEqual([bulletHash("Feedback bullet long enough"), bulletHash("Project bullet long enough"), bulletHash("User bullet long enough")].sort());
    expect(plan.syncHashes.has(bulletHash("Huge bullet long enough"))).toBe(false);
    expect(plan.protectedSourcePaths).toEqual([autoMemorySourcePath(join(dir, "MEMORY.md")), autoMemorySourcePath(join(dir, "huge.md"))]);
    expect(plan.protectedSourcePaths.map(importSourceRefPrefix)[1]).toBe(`import:${autoMemorySourcePath(join(dir, "huge.md"))}#L`);
    expect(planAutoMemoryImport(dir, ["feedback", "project"]).notes.map((entry) => entry.note.name)).toEqual(["feedback", "project"]);
  });
});

describe("source refs the pipeline and the hooks see", () => {
  test("import:auto-memory:<file>#L<n> distinguishes the rows; topic files are not host-loaded, CLAUDE.md is", () => {
    const dir = join(base, "memory");
    const note = makeNote(dir, "topic.md", { name: "topic", description: "What the note is about", type: "feedback", body: "- Never force-push to main without asking\n" });
    const forward = join(dir, "topic.md").split("\\").join("/");
    expect(note.sourcePath).toBe(`auto-memory:${forward}`);
    expect(autoMemorySourcePath(join(dir, "topic.md"))).toBe(note.sourcePath);

    const bullet = noteBullets(note).bullets[0]!;
    const ref = importSourceRef(note.sourcePath, bullet.line);
    expect(ref).toBe(`import:auto-memory:${forward}#L${String(bullet.line)}`);
    expect(ref.startsWith(autoMemorySyncPrefix(dir))).toBe(true);
    expect(autoMemorySyncPrefix(dir)).toBe(`import:auto-memory:${dir.split("\\").join("/")}/`);
    expect(importSourceRef("CLAUDE.md", 4).startsWith(autoMemorySyncPrefix(dir))).toBe(false);
    // A plain `--from <dir>/MEMORY.md` import (no marker) never falls under the directory's --sync prefix.
    expect(importSourceRef(`${dir.split("\\").join("/")}/MEMORY.md`, 2).startsWith(autoMemorySyncPrefix(dir))).toBe(false);

    const sourceFile = sourceFileOf(ref);
    expect(sourceFile?.endsWith("/topic.md")).toBe(true);
    expect(isHostLoadedFile("claude-code", sourceFile)).toBe(false);
    expect(isHostLoadedFile("claude-code", sourceFileOf("import:CLAUDE.md#L4"))).toBe(true);

    const descriptor = buildImportDescriptor({ sourcePath: note.sourcePath, bullet, now: "2026-11-08T12:00:00.000Z", root: base, contextRef: noteContextRef(note) });
    expect(descriptor).toMatchObject({ host: "import", close_reason: "import", ledger_ref: ref, prompt_text: "Never force-push to main without asking", context_ref: "(auto-memory) note topic: What the note is about", tools: [] });
    expect(descriptor.id).toBe(importEpisodeId(note.sourcePath, bullet));
    expect(descriptor.session_id).toBe(`import:${note.sourcePath}`);
    expect(buildImportDescriptor({ sourcePath: "CLAUDE.md", bullet: { ...bullet, heading: "Rules" }, now: "2026-11-08T12:00:00.000Z", root: base }).context_ref).toBe("(import) section: Rules");
    expect(noteContextRef({ name: "n", description: null })).toBe("(auto-memory) note n");
    expect(noteContextRef({ name: "n", description: "d ".repeat(300) }).length).toBeLessThanOrEqual(240);
  });
});
