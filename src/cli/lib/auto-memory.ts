/**
 * Claude Code's native auto memory as an import source for `hm import --from auto-memory` (phase F, direction A′ §4).
 *
 * Layout (https://code.claude.com/docs/en/memory, checked against `~/.claude/projects/` on this machine, 2026-11-08):
 * `<config>/projects/<slug>/memory/` holds `MEMORY.md` — the index Claude Code loads (its first 200 lines) at every
 * session start — and one topic file per note with YAML frontmatter: `name`, `description` and a `type` of
 * `user | feedback | project | reference` (the CLI writes `type` nested under `metadata:`; both spellings are read).
 * `<config>` is `CLAUDE_CONFIG_DIR` when set, else `<home>/.claude` — the same `claudeConfigDir` rule install and
 * the settings writer use (`os.homedir()`: `USERPROFILE` on Windows, `HOME` elsewhere). `<slug>` is the project path
 * with every character outside `[A-Za-z0-9]` replaced by `-`: `C:\Users\me\app` → `C--Users-me-app`,
 * `/home/me/app` → `-home-me-app`. The derivation was confirmed against existing directories (`C:\Users\choey` →
 * `C--Users-choey`; `C:\Users\choey\.harness-memory\worker\<hash>` → `C--Users-choey--harness-memory-worker-<hash>`).
 * When the derived directory is absent the projects directory is scanned: a case-insensitive slug match first, then
 * a slug of a real subdirectory of the project (a session started inside `packages/app` writes to
 * `<slug>-packages-app`), otherwise the memory directories found become the candidates the error message lists for
 * `--memory-dir`. The directory that is finally used is canonicalised (`realpathSync.native`: on-disk case, 8.3
 * names, symlinks), so refs do not depend on how the caller spelled the project root (review M-2).
 *
 * Only topic files are imported: type `feedback` by default, plus `project` with `--include-project`; `user` and
 * `reference` notes are profile / lookup material, not rules. A note's body becomes import bullets by the rule that
 * fits the template Claude Code writes (context paragraph → `**Why:**` → `**How to apply:**` → dated state log):
 * its Markdown bullets minus log lines (dated entries, `State on …`, `Update …`, `Related:`), else the
 * `**How to apply:**` paragraph, else the first paragraph that is neither a `**Why:**` nor a log paragraph, else the
 * frontmatter description — one bullet ≤ 300 chars in the paragraph cases. The description also travels as the
 * episode's `context_ref` (uncitable context for the extractor). Every bullet then runs through the ordinary import
 * pipeline (src/cli/commands/import.ts) with `sourcePath = auto-memory:<topic file>`, so `ledger_ref` / `source_ref`
 * read `import:auto-memory:<topic file>#L<n>` — the `auto-memory:` marker is what tells these rows apart from
 * CLAUDE.md imports (`import:CLAUDE.md#L<n>`) and keeps a directory-wide `--sync` from touching rows imported from
 * other files; `source_kind` stays `import` and the rows are human like any import.
 *
 * Skip rule for the hooks (native de-duplication at session_start / before_model, `isHostLoadedFile` on the row's
 * `source_file`): topic files are NOT loaded by Claude Code by default, so their rows are injected like any other
 * import and enforce at before_tool. MEMORY.md is loaded every session; this source never imports it (it is the
 * index of the topic files). A plain `hm import --from <…>/memory/MEMORY.md` is only skipped at session_start /
 * before_model once `isHostLoadedFile` recognises `<config>/projects/<slug>/memory/MEMORY.md` — that change lives in
 * src/activation/injection.ts and is requested, not yet in the tree; today only `CLAUDE.md` / `CLAUDE.local.md`
 * basenames are host-loaded. Nothing under the config directory is ever written or deleted here — read only.
 */

import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, join, resolve } from "node:path";

import { bulletHash, IMPORT_MIN_BULLET_CHARS, parseImportBullets, type ImportBullet } from "./import-file";
import { claudeConfigDir } from "./paths";

/** `hm import --from auto-memory` selects this source. */
export const AUTO_MEMORY_SOURCE = "auto-memory" as const;
/** Prefix of the import `sourcePath` of a topic file → `source_ref = import:auto-memory:<file>#L<n>`. */
export const AUTO_MEMORY_SOURCE_PREFIX = `${AUTO_MEMORY_SOURCE}:`;
export const AUTO_MEMORY_INDEX_FILE = "MEMORY.md";
export const AUTO_MEMORY_NOTE_TYPES = ["user", "feedback", "project", "reference"] as const;
export type AutoMemoryNoteType = (typeof AUTO_MEMORY_NOTE_TYPES)[number];
/** Types imported without `--include-project`. */
export const AUTO_MEMORY_DEFAULT_TYPES: readonly string[] = ["feedback"];
/** A body without rule bullets becomes one bullet from a paragraph, clipped to this many characters. */
export const AUTO_MEMORY_PARAGRAPH_MAX_CHARS = 300;
/** Topic files larger than this are skipped (a note is a page, not a transcript). */
export const AUTO_MEMORY_MAX_FILE_BYTES = 128 * 1024;
/** Bullets per topic file beyond this count are dropped (and counted as `truncated`). */
export const AUTO_MEMORY_MAX_BULLETS_PER_FILE = 50;
/** `context_ref` carried on every import episode of a note (uncitable context for the extractor). */
export const AUTO_MEMORY_CONTEXT_MAX_CHARS = 240;
/** How many memory directories a failed lookup lists. */
export const AUTO_MEMORY_MAX_CANDIDATES = 20;
/** How deep the subdirectory check of the scan fallback walks under the project root. */
const SUBDIR_SCAN_DEPTH = 6;

export interface AutoMemoryEnvOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

function nonEmpty(value: string | undefined): string | null {
  return value !== undefined && value.length > 0 ? value : null;
}

/**
 * The user's home the way Node (and therefore Claude Code) resolves it — `os.homedir()`: `USERPROFILE`, then
 * `HOMEDRIVE` + `HOMEPATH` on Windows; `HOME` elsewhere; the OS account database as the last resort. `HOME` is
 * deliberately ignored on Windows (Git Bash exports a POSIX-style `HOME` that `os.homedir()` never reads).
 */
export function homeDirectory(options: AutoMemoryEnvOptions = {}): string {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    const profile = nonEmpty(env.USERPROFILE);
    if (profile !== null) return profile;
    const drive = nonEmpty(env.HOMEDRIVE);
    const homePath = nonEmpty(env.HOMEPATH);
    if (drive !== null && homePath !== null) return `${drive}${homePath}`;
    return homedir();
  }
  return nonEmpty(env.HOME) ?? homedir();
}

/**
 * `CLAUDE_CONFIG_DIR` when set (Claude Code honours it), else `<home>/.claude`. Without a `platform` override this
 * is exactly `claudeConfigDir` from ./paths (one resolver for install, settings and the import); the platform rule
 * above exists so tests can pin the Windows and POSIX behaviour from any host.
 */
export function claudeConfigDirectory(options: AutoMemoryEnvOptions = {}): string {
  const env = options.env ?? process.env;
  if (options.platform === undefined) return claudeConfigDir(env);
  const override = nonEmpty(env.CLAUDE_CONFIG_DIR);
  if (override !== null) return resolve(override);
  return join(homeDirectory(options), ".claude");
}

export function claudeProjectsDirectory(options: AutoMemoryEnvOptions = {}): string {
  return join(claudeConfigDirectory(options), "projects");
}

/** Claude Code's project directory name: every character outside `[A-Za-z0-9]` becomes `-` (separators, `:`, `.` and spaces alike). */
export function projectSlug(projectPath: string): string {
  return projectPath.replace(/[^A-Za-z0-9]/g, "-");
}

export type AutoMemoryLocated = "derived" | "realpath" | "scan_case" | "scan_subdir" | "explicit";

export interface AutoMemoryLocation {
  /** `<projects>/<slug>/memory`, canonical spelling (realpath). */
  dir: string;
  projectDir: string;
  /** The directory's on-disk name. */
  slug: string;
  how: AutoMemoryLocated;
}

export interface AutoMemoryLookup {
  projectsDir: string;
  /** Slug derived from the project root. */
  slug: string;
  /** The derived memory directory, whether or not it exists. */
  derived: string;
  location: AutoMemoryLocation | null;
  /** Memory directories the scan found when none matched (for the error message), at most AUTO_MEMORY_MAX_CANDIDATES. */
  candidates: string[];
}

export interface LocateAutoMemoryOptions extends AutoMemoryEnvOptions {
  /** Canonical path of the project root (symlinks, 8.3 names, drive case); null when unavailable. Defaults to `realpathSync.native`. */
  realpath?: (path: string) => string | null;
  /** Directory test; tests inject a case-sensitive one (Windows and macOS resolve a case-different name as the derived directory itself). */
  isDirectory?: (path: string) => boolean;
}

export function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function nativeRealpath(path: string): string | null {
  try {
    return realpathSync.native(path);
  } catch {
    return null;
  }
}

/**
 * The on-disk spelling of a directory (`realpathSync.native`: case, 8.3 short names, symlinks); the resolved input
 * when the path cannot be canonicalised. Every ref written for a memory directory is built from this spelling, so a
 * run from `c:\users\…` and one from `C:\Users\…` produce the same `source_ref`s and the same `--sync` prefix.
 */
export function canonicalDirectory(path: string): string {
  const absolute = resolve(path);
  return nativeRealpath(absolute) ?? absolute;
}

function listDirectories(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * Does `suffix` (the part of a slug after `<root slug>-`) spell a real subdirectory of `root`? Both `/` and `-` map
 * to `-`, so `packages-app` is checked against the directory tree instead of being trusted: an unrelated sibling
 * project `app-v2` must not be mistaken for a session started inside `app/v2`.
 */
export function slugSuffixIsSubdirectory(root: string, suffix: string, depth = SUBDIR_SCAN_DEPTH): boolean {
  if (suffix.length === 0 || depth <= 0) return false;
  for (const name of listDirectories(root)) {
    const slug = projectSlug(name);
    if (slug === suffix) return true;
    if (suffix.startsWith(`${slug}-`) && slugSuffixIsSubdirectory(join(root, name), suffix.slice(slug.length + 1), depth - 1)) return true;
  }
  return false;
}

/**
 * The project's auto memory directory: derived from `root`, else from its canonical path, else found by scanning
 * every `<projects>/<name>/memory/` (case-insensitive slug, then a slug of a real subdirectory of the project). The
 * returned `dir` is canonical (see `canonicalDirectory`). Never writes.
 */
export function locateAutoMemory(root: string, options: LocateAutoMemoryOptions = {}): AutoMemoryLookup {
  const projectsDir = claudeProjectsDirectory(options);
  const dirExists = options.isDirectory ?? isDirectory;
  const absoluteRoot = resolve(root);
  const slug = projectSlug(absoluteRoot);
  const derived = join(projectsDir, slug, "memory");
  const found = (dirSlug: string, how: AutoMemoryLocated): AutoMemoryLookup => {
    const dir = canonicalDirectory(join(projectsDir, dirSlug, "memory"));
    const projectDir = resolve(dir, "..");
    return { projectsDir, slug, derived, location: { dir, projectDir, slug: basename(projectDir), how }, candidates: [] };
  };
  if (dirExists(derived)) return found(slug, "derived");

  const real = (options.realpath ?? nativeRealpath)(absoluteRoot);
  const realSlug = real === null ? null : projectSlug(real);
  if (realSlug !== null && realSlug !== slug && dirExists(join(projectsDir, realSlug, "memory"))) return found(realSlug, "realpath");

  const withMemory = listDirectories(projectsDir).filter((name) => dirExists(join(projectsDir, name, "memory")));
  const roots: Array<{ path: string; slug: string }> = [{ path: absoluteRoot, slug }];
  if (real !== null && realSlug !== null && realSlug !== slug) roots.push({ path: real, slug: realSlug });

  const exact = withMemory.find((name) => roots.some((entry) => entry.slug.toLowerCase() === name.toLowerCase()));
  if (exact !== undefined) return found(exact, "scan_case");

  const subdirectories = withMemory.filter((name) =>
    roots.some((entry) => {
      const prefix = `${entry.slug.toLowerCase()}-`;
      return name.toLowerCase().startsWith(prefix) && slugSuffixIsSubdirectory(entry.path, name.slice(prefix.length));
    })
  );
  if (subdirectories.length === 1) return found(subdirectories[0]!, "scan_subdir");

  const candidates = (subdirectories.length > 1 ? subdirectories : withMemory).slice(0, AUTO_MEMORY_MAX_CANDIDATES).map((name) => join(projectsDir, name, "memory"));
  return { projectsDir, slug, derived, location: null, candidates };
}

export interface AutoMemoryFrontmatter {
  name: string | null;
  description: string | null;
  /** Lower-cased `type` (top-level, else `metadata.type`); null when absent. */
  type: string | null;
  /** 1-based file line of the `description:` entry, when present. */
  descriptionLine: number | null;
  /** Lines the frontmatter block occupies, both `---` fences included; 0 when the file has none. */
  lines: number;
}

const BYTE_ORDER_MARK = "\uFEFF";
const FRONTMATTER_FENCE = /^---\s*$/;
const FRONTMATTER_ENTRY = /^(\s*)([A-Za-z_][\w.-]*)\s*:(?:\s+(.*)|\s*)$/;
/** `>` / `|` with optional chomping indicator: the value is the indented block that follows. */
const BLOCK_SCALAR = /^[>|][+-]?\s*$/;

/**
 * A YAML scalar as the notes write them: a double-quoted value is parsed as JSON (so `\"`, `\\`, `\n`, `\u2014`
 * all unescape; a value JSON rejects falls back to unescaping `\"` and `\\` only), a single-quoted one unescapes
 * `''`, anything else is taken verbatim.
 */
function unquote(raw: string): string {
  const value = raw.trim();
  if (value.length >= 2) {
    const quote = value[0];
    if (quote === '"' && value.endsWith('"')) {
      try {
        const parsed: unknown = JSON.parse(value);
        if (typeof parsed === "string") return parsed;
      } catch {
        // not strict JSON (e.g. a stray backslash): minimal unescape below
      }
      return value.slice(1, -1).replace(/\\(["\\])/g, "$1");
    }
    if (quote === "'" && value.endsWith("'")) return value.slice(1, -1).replace(/''/g, "'");
  }
  return value;
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

/**
 * Minimal YAML front matter reader: top-level `key: value` entries plus the entries nested under `metadata:`.
 * A UTF-8 byte order mark before the first fence is ignored; `>` / `|` block scalars take the following
 * more-indented lines (joined into one line).
 */
export function parseFrontmatter(content: string): AutoMemoryFrontmatter {
  const none: AutoMemoryFrontmatter = { name: null, description: null, type: null, descriptionLine: null, lines: 0 };
  const text = content.startsWith(BYTE_ORDER_MARK) ? content.slice(BYTE_ORDER_MARK.length) : content;
  const lines = text.split(/\r?\n/);
  if (lines.length === 0 || !FRONTMATTER_FENCE.test(lines[0]!)) return none;
  const end = lines.findIndex((line, index) => index > 0 && FRONTMATTER_FENCE.test(line));
  if (end === -1) return none;
  const result: AutoMemoryFrontmatter = { ...none, lines: end + 1 };
  let inMetadata = false;
  let topLevelType = false;
  let index = 1;
  while (index < end) {
    const match = FRONTMATTER_ENTRY.exec(lines[index]!);
    if (match === null) {
      index += 1;
      continue;
    }
    const indent = match[1]!.length;
    const key = match[2]!;
    let raw = match[3] ?? "";
    const entryLine = index + 1;
    if (BLOCK_SCALAR.test(raw.trim())) {
      const parts: string[] = [];
      let next = index + 1;
      while (next < end) {
        const line = lines[next]!;
        if (line.trim().length === 0) {
          next += 1;
          continue;
        }
        if (indentOf(line) <= indent) break;
        parts.push(line.trim());
        next += 1;
      }
      raw = parts.join(" ");
      index = next;
    } else {
      index += 1;
    }
    if (indent === 0) {
      inMetadata = key === "metadata" && raw.trim().length === 0;
      if (key === "name") result.name = unquote(raw) || null;
      else if (key === "description") {
        result.description = unquote(raw) || null;
        result.descriptionLine = entryLine;
      } else if (key === "type") {
        result.type = unquote(raw).toLowerCase() || null;
        topLevelType = result.type !== null;
      }
    } else if (inMetadata && key === "type" && !topLevelType) {
      result.type = unquote(raw).toLowerCase() || null;
    }
  }
  return result;
}

export interface AutoMemoryNote {
  /** Absolute path, native separators. */
  file: string;
  /** `auto-memory:<forward-slash absolute path>` — the import `sourcePath` of this note. */
  sourcePath: string;
  /** Frontmatter `name`, else the file name without `.md`. */
  name: string;
  description: string | null;
  /** 1-based file line of the frontmatter `description:` entry (the line a description-mode bullet cites). */
  descriptionLine: number | null;
  type: string | null;
  bytes: number;
  frontmatterLines: number;
  /** File content after the frontmatter. */
  body: string;
}

export interface AutoMemorySkippedFile {
  file: string;
  /** The import `sourcePath` the file would have had; rows under it are protected from a `--sync` sweep. */
  sourcePath: string;
  reason: string;
}

export interface AutoMemoryListing {
  dir: string;
  /** Topic files in name order. */
  notes: AutoMemoryNote[];
  /** MEMORY.md, files over the size cap and unreadable files. */
  skipped: AutoMemorySkippedFile[];
}

function forwardSlashes(path: string): string {
  return path.split("\\").join("/");
}

export function autoMemorySourcePath(file: string): string {
  return `${AUTO_MEMORY_SOURCE_PREFIX}${forwardSlashes(resolve(file))}`;
}

export function isAutoMemorySourcePath(sourcePath: string): boolean {
  return sourcePath.startsWith(AUTO_MEMORY_SOURCE_PREFIX);
}

/** `import:auto-memory:<dir>/` — prefix of every `source_ref` written for the notes of one memory directory (`--sync`). */
export function autoMemorySyncPrefix(dir: string): string {
  return `import:${AUTO_MEMORY_SOURCE_PREFIX}${forwardSlashes(resolve(dir))}/`;
}

/** Reads the topic files of one memory directory; MEMORY.md, oversized and unreadable files are reported, not read. */
export function listAutoMemoryNotes(dir: string): AutoMemoryListing {
  const listing: AutoMemoryListing = { dir: resolve(dir), notes: [], skipped: [] };
  const entries = readdirSync(listing.dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"))
    .map((entry) => entry.name)
    .sort();
  for (const name of entries) {
    const file = join(listing.dir, name);
    const sourcePath = autoMemorySourcePath(file);
    if (name.toUpperCase() === AUTO_MEMORY_INDEX_FILE.toUpperCase()) {
      listing.skipped.push({ file, sourcePath, reason: "index file Claude Code loads every session; not imported through this source" });
      continue;
    }
    let bytes: number;
    let content: string;
    try {
      bytes = statSync(file).size;
      if (bytes > AUTO_MEMORY_MAX_FILE_BYTES) {
        listing.skipped.push({ file, sourcePath, reason: `${String(bytes)} bytes exceeds the ${String(AUTO_MEMORY_MAX_FILE_BYTES)}-byte cap` });
        continue;
      }
      content = readFileSync(file, "utf8");
    } catch (error) {
      listing.skipped.push({ file, sourcePath, reason: `unreadable: ${error instanceof Error ? error.message : String(error)}` });
      continue;
    }
    const frontmatter = parseFrontmatter(content);
    listing.notes.push({
      file,
      sourcePath,
      name: frontmatter.name ?? basename(name, extname(name)),
      description: frontmatter.description,
      descriptionLine: frontmatter.descriptionLine,
      type: frontmatter.type,
      bytes,
      frontmatterLines: frontmatter.lines,
      body: content.split(/\r?\n/).slice(frontmatter.lines).join("\n"),
    });
  }
  return listing;
}

/**
 * Does `dir` hold Claude Code auto memory — a MEMORY.md index or at least one `.md` note with a frontmatter `type`?
 * `hm import --from <directory>` accepts only such a directory, so a mistyped path never switches the mode silently.
 */
export function looksLikeAutoMemoryDirectory(dir: string): boolean {
  if (!isDirectory(dir)) return false;
  try {
    const listing = listAutoMemoryNotes(dir);
    return listing.skipped.some((entry) => basename(entry.file).toUpperCase() === AUTO_MEMORY_INDEX_FILE.toUpperCase()) || listing.notes.some((note) => note.type !== null);
  } catch {
    return false;
  }
}

export interface AutoMemorySelection {
  selected: AutoMemoryNote[];
  skipped: Array<{ note: AutoMemoryNote; reason: string }>;
}

/** Keeps the notes whose frontmatter `type` is in `types`; the others carry the reason the report shows. */
export function selectAutoMemoryNotes(notes: readonly AutoMemoryNote[], types: readonly string[] = AUTO_MEMORY_DEFAULT_TYPES): AutoMemorySelection {
  const selection: AutoMemorySelection = { selected: [], skipped: [] };
  for (const note of notes) {
    if (note.type === null) {
      selection.skipped.push({ note, reason: "no type in the frontmatter" });
    } else if (types.includes(note.type)) {
      selection.selected.push(note);
    } else if (note.type === "project") {
      selection.skipped.push({ note, reason: "type project (pass --include-project)" });
    } else {
      selection.skipped.push({ note, reason: `type ${note.type} (not an import source)` });
    }
  }
  return selection;
}

export type AutoMemoryBulletMode = "bullets" | "how_to_apply" | "paragraph" | "description" | "empty";

export interface AutoMemoryNoteBullets {
  note: AutoMemoryNote;
  /** Line numbers are file lines (the frontmatter offset is applied). */
  bullets: ImportBullet[];
  /** Non-bullet lines plus the log bullets the filter dropped. */
  skippedLines: number;
  mode: AutoMemoryBulletMode;
  /** Bullets beyond AUTO_MEMORY_MAX_BULLETS_PER_FILE that were dropped. */
  truncated: number;
}

export interface FirstParagraph {
  /** 1-based line within the text passed in. */
  line: number;
  text: string;
  /** Source lines the paragraph spans. */
  lines: number;
}

/**
 * Lines the feedback-note template accumulates as a state log, never as rules: dated entries (`2026-11-08 ~17:00:`),
 * `State on 2026-11-07 (late): …`, `**Update 2026-11-08 22:05:** …` and `Related: [[…]]` link lines.
 */
const LOG_LINE = /^(?:\*\*)?(?:\d{4}-\d{2}-\d{2}\b|state on\b|update\b[^:\n]{0,40}?\d{4}-\d{2}-\d{2}|related:)/i;
/** The `**Why:**` paragraph is the note's rationale, not its rule. */
const WHY_LABEL = /^(?:\*\*)?why:?(?:\*\*)?:?(?:\s|$)/i;
/** `**How to apply:** <text>` — the template's rule section; the text may continue on the following lines. */
const HOW_TO_APPLY_LABEL = /^(?:\*\*)?how to apply:?(?:\*\*)?:?\s*(.*)$/i;
const BULLET_LINE = /^\s*(?:[-*+]|\d+[.)])\s+/;
const HEADING_LINE = /^#{1,6}\s/;
const RULE_LINE = /^(?:---|\*\*\*|___)\s*$/;

export function isLogLine(text: string): boolean {
  return LOG_LINE.test(text.trim());
}

interface Paragraph {
  /** 1-based line within the text passed in. */
  line: number;
  /** Trimmed source lines. */
  parts: string[];
}

/** Blocks of consecutive non-blank lines that are neither headings, rules, HTML comments, bullets nor fenced code. */
function paragraphsOf(text: string): Paragraph[] {
  const lines = text.split(/\r?\n/);
  const result: Paragraph[] = [];
  let inFence = false;
  let current: Paragraph | null = null;
  const flush = (): void => {
    if (current !== null) result.push(current);
    current = null;
  };
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index]!;
    if (/^\s*(```|~~~)/.test(raw)) {
      flush();
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const trimmed = raw.trim();
    if (trimmed.length === 0 || HEADING_LINE.test(trimmed) || RULE_LINE.test(trimmed) || trimmed.startsWith("<!--") || BULLET_LINE.test(raw)) {
      flush();
      continue;
    }
    if (current === null) current = { line: index + 1, parts: [] };
    current.parts.push(trimmed);
  }
  flush();
  return result;
}

function paragraphText(paragraph: Paragraph): string {
  return paragraph.parts.join(" ").replace(/\s+/g, " ").trim();
}

function toFirstParagraph(paragraph: Paragraph, text = paragraphText(paragraph)): FirstParagraph | null {
  return text.length === 0 ? null : { line: paragraph.line, text, lines: paragraph.parts.length };
}

/**
 * First paragraph that is neither a heading, a rule, an HTML comment, fenced code, a `**Why:**` rationale nor a log
 * line (dated entry, `State on …`, `Related:`). The `**How to apply:**` paragraph is skipped too: `howToApplyParagraph`
 * reads it, and it is preferred over this one.
 */
export function firstParagraph(text: string): FirstParagraph | null {
  for (const paragraph of paragraphsOf(text)) {
    const first = paragraph.parts[0]!;
    if (WHY_LABEL.test(first) || HOW_TO_APPLY_LABEL.test(first) || isLogLine(first)) continue;
    const result = toFirstParagraph(paragraph);
    if (result !== null) return result;
  }
  return null;
}

/**
 * The `**How to apply:**` paragraph with its label removed: the text after the label on the same line plus the
 * paragraph's remaining lines; when the label stands alone, the next paragraph (unless that is a label or a log).
 * Null when the section is absent or holds bullets instead (those are imported as bullets).
 */
export function howToApplyParagraph(text: string): FirstParagraph | null {
  const paragraphs = paragraphsOf(text);
  for (let index = 0; index < paragraphs.length; index += 1) {
    const paragraph = paragraphs[index]!;
    const match = HOW_TO_APPLY_LABEL.exec(paragraph.parts[0]!);
    if (match === null) continue;
    const rest = match[1]!.trim();
    const parts = [rest, ...paragraph.parts.slice(1)].filter((part) => part.length > 0);
    if (parts.length > 0) return toFirstParagraph({ line: paragraph.line, parts }, parts.join(" ").replace(/\s+/g, " ").trim());
    const next = paragraphs[index + 1];
    if (next === undefined) return null;
    const first = next.parts[0]!;
    if (WHY_LABEL.test(first) || HOW_TO_APPLY_LABEL.test(first) || isLogLine(first)) return null;
    return toFirstParagraph(next);
  }
  return null;
}

/** Clips at a word boundary with an ellipsis when `text` is longer than `max`. */
export function clipText(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

function singleBullet(line: number, text: string): ImportBullet {
  return { line, text, hash: bulletHash(text), heading: null };
}

/**
 * The import bullets of one note, by the template rule: its Markdown bullets minus log lines; else the
 * `**How to apply:**` paragraph; else the first context paragraph; else the frontmatter description (Claude Code's
 * index line — compact, but without the quoted commands the signature validator needs, hence the last resort).
 * Paragraph-mode bullets are clipped to AUTO_MEMORY_PARAGRAPH_MAX_CHARS.
 */
export function noteBullets(note: AutoMemoryNote): AutoMemoryNoteBullets {
  const offset = note.frontmatterLines;
  const parsed = parseImportBullets(note.body);
  const rules = parsed.bullets.filter((bullet) => !isLogLine(bullet.text));
  const logBullets = parsed.bullets.length - rules.length;
  if (rules.length > 0) {
    const kept = rules.slice(0, AUTO_MEMORY_MAX_BULLETS_PER_FILE).map((bullet) => ({ ...bullet, line: bullet.line + offset }));
    return { note, bullets: kept, skippedLines: parsed.skippedLines + logBullets, mode: "bullets", truncated: rules.length - kept.length };
  }
  const skippedLines = parsed.skippedLines + logBullets;
  const paragraphBullet = (paragraph: FirstParagraph | null, mode: AutoMemoryBulletMode): AutoMemoryNoteBullets | null => {
    if (paragraph === null) return null;
    const text = clipText(paragraph.text, AUTO_MEMORY_PARAGRAPH_MAX_CHARS);
    if (text.length < IMPORT_MIN_BULLET_CHARS) return null;
    return { note, bullets: [singleBullet(paragraph.line + offset, text)], skippedLines: Math.max(0, skippedLines - paragraph.lines), mode, truncated: 0 };
  };
  const fromHowToApply = paragraphBullet(howToApplyParagraph(note.body), "how_to_apply");
  if (fromHowToApply !== null) return fromHowToApply;
  const fromParagraph = paragraphBullet(firstParagraph(note.body), "paragraph");
  if (fromParagraph !== null) return fromParagraph;
  if (note.description !== null) {
    const text = clipText(note.description.replace(/\s+/g, " ").trim(), AUTO_MEMORY_PARAGRAPH_MAX_CHARS);
    if (text.length >= IMPORT_MIN_BULLET_CHARS) {
      return { note, bullets: [singleBullet(note.descriptionLine ?? 1, text)], skippedLines, mode: "description", truncated: 0 };
    }
  }
  return { note, bullets: [], skippedLines, mode: "empty", truncated: 0 };
}

/** `(auto-memory) note <name>: <description>` — uncitable context for the extractor, clipped. */
export function noteContextRef(note: Pick<AutoMemoryNote, "name" | "description">): string {
  const head = `(${AUTO_MEMORY_SOURCE}) note ${note.name}`;
  const text = note.description === null ? head : `${head}: ${note.description.replace(/\s+/g, " ").trim()}`;
  return clipText(text, AUTO_MEMORY_CONTEXT_MAX_CHARS);
}

export interface AutoMemoryImportPlan {
  dir: string;
  listing: AutoMemoryListing;
  selection: AutoMemorySelection;
  /** Selected notes with their bullets, in file-name order. */
  notes: AutoMemoryNoteBullets[];
  /**
   * Bullet hashes of every parsed note, whatever its type: the `--sync` universe of the directory. A row whose
   * bullet is in no current note (file edited or deleted) is staled; a note that merely fell out of the type filter
   * keeps its rows.
   */
  syncHashes: Set<string>;
  /**
   * Import `sourcePath`s of the files that are present but were not parsed (over the size cap, unreadable, the
   * index): their rows are still backed by a file, so a `--sync` sweep must leave them alone.
   */
  protectedSourcePaths: string[];
}

export function planAutoMemoryImport(dir: string, types: readonly string[] = AUTO_MEMORY_DEFAULT_TYPES): AutoMemoryImportPlan {
  const listing = listAutoMemoryNotes(dir);
  const selection = selectAutoMemoryNotes(listing.notes, types);
  const syncHashes = new Set<string>();
  const byFile = new Map<string, AutoMemoryNoteBullets>();
  for (const note of listing.notes) {
    const bullets = noteBullets(note);
    byFile.set(note.file, bullets);
    for (const bullet of bullets.bullets) syncHashes.add(bullet.hash);
  }
  return {
    dir: listing.dir,
    listing,
    selection,
    notes: selection.selected.map((note) => byFile.get(note.file)!),
    syncHashes,
    protectedSourcePaths: listing.skipped.map((entry) => entry.sourcePath),
  };
}
