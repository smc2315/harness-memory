/**
 * Where the CLI finds things: the project (`--root`, `--db`, or spec §3.4 discovery), the package it
 * runs from (hook script `dist/hook.js`, version), Claude Code's settings files and the git exclude file.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { DB_FILE_NAME, findProjectRoot, HARNESS_DIR_NAME, resolvePaths, type HarnessPaths } from "../../core/paths";

export const PACKAGE_NAME = "harness-memory";
export const HOOK_SCRIPT_NAME = "hook.js";
export const WORKER_SCRIPT_NAME = "worker.js";
export const EMBED_HELPER_SCRIPT_NAME = "embed-helper.js";

export interface CliPathOptions {
  cwd: string;
  /** `--root`: the project directory (its `.harness-memory/` is used or created). */
  root?: string | null;
  /** `--db`: an explicit database file. Inside a `.harness-memory/` directory it also fixes the root. */
  db?: string | null;
}

/**
 * `--db <x>/.harness-memory/memory.sqlite` → project `<x>`; any other `--db` keeps the discovered
 * project but points `db` / `.prev` / `.bak-v<N>` at the given file. Without `--db`/`--root` the project
 * is the nearest ancestor with `.harness-memory/`, else with `.git/`, else `cwd` (spec §3.4).
 */
export function resolveCliPaths(options: CliPathOptions): HarnessPaths {
  const dbOverride = options.db === undefined || options.db === null || options.db.length === 0 ? null : resolve(options.cwd, options.db);
  let root: string;
  if (options.root !== undefined && options.root !== null && options.root.length > 0) {
    root = resolve(options.cwd, options.root);
  } else if (dbOverride !== null && basename(dirname(dbOverride)) === HARNESS_DIR_NAME) {
    root = dirname(dirname(dbOverride));
  } else {
    root = findProjectRoot(options.cwd);
  }
  const paths = resolvePaths(root);
  if (dbOverride === null || dbOverride === paths.db) return paths;
  return {
    ...paths,
    db: dbOverride,
    dbPrev: `${dbOverride}.prev`,
    dbBackup: (userVersion: number) => `${dbOverride}.bak-v${userVersion}`,
  };
}

function selfDirectory(): string {
  return dirname(fileURLToPath(import.meta.url));
}

function isPackageRoot(dir: string): boolean {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    return typeof parsed === "object" && parsed !== null && (parsed as { name?: unknown }).name === PACKAGE_NAME;
  } catch {
    return false;
  }
}

/** The harness-memory package directory this code runs from (dist bundle or source tree), or null. */
export function findPackageRoot(start: string = selfDirectory()): string | null {
  let current = resolve(start);
  for (let depth = 0; depth < 8; depth += 1) {
    if (isPackageRoot(current)) return current;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

export function readPackageVersion(packageRoot: string | null = findPackageRoot()): string {
  if (packageRoot === null) return "unknown";
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
    const version = (parsed as { version?: unknown }).version;
    return typeof version === "string" ? version : "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * `dist/hook.js` of this package. In the bundle the CLI lives in `dist/bin/`, so the launcher is the
 * parent directory's `hook.js`; from the source tree (tests, ts-node) it is `<package>/dist/hook.js`.
 * The returned path may not exist yet (`install` verifies and says so).
 */
export function resolveHookScript(): string {
  const self = selfDirectory();
  const candidates = [resolve(self, "..", HOOK_SCRIPT_NAME), resolve(self, HOOK_SCRIPT_NAME)];
  const packageRoot = findPackageRoot(self);
  if (packageRoot !== null) candidates.push(join(packageRoot, "dist", HOOK_SCRIPT_NAME));
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return candidates[candidates.length - 1]!;
}

/** Sibling bundles the hook spawns; `doctor` checks they exist next to the hook script. */
export function siblingScripts(hookScript: string): { worker: string; embedHelper: string; hookBundle: string } {
  const dir = dirname(hookScript);
  return {
    worker: join(dir, WORKER_SCRIPT_NAME),
    embedHelper: join(dir, EMBED_HELPER_SCRIPT_NAME),
    hookBundle: join(dir, "hook-bundle.js"),
  };
}

/** `CLAUDE_CONFIG_DIR` when set (Claude Code honours it), else `~/.claude`. */
export function claudeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.CLAUDE_CONFIG_DIR;
  if (override !== undefined && override.length > 0) return resolve(override);
  return join(homedir(), ".claude");
}

export function projectSettingsFile(root: string): string {
  return join(root, ".claude", "settings.local.json");
}

export function userSettingsFile(env: NodeJS.ProcessEnv = process.env): string {
  return join(claudeConfigDir(env), "settings.json");
}

/**
 * First `<dir>/<name>` on PATH that exists, so tools are spawned by absolute path: a bare name is looked
 * up in the cwd first by cmd.exe (and by libuv on Windows), which a repository could plant a binary in.
 */
export function findExecutable(names: readonly string[], env: NodeJS.ProcessEnv = process.env): string | null {
  const pathValue = env.PATH ?? env.Path ?? "";
  for (const dir of pathValue.split(delimiter)) {
    if (dir.length === 0) continue;
    for (const name of names) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/** Relative path recorded in `.git/info/exclude`. */
export const GIT_EXCLUDE_LINE = ".claude/settings.local.json";

/** True when an exclude/ignore file's content already lists GIT_EXCLUDE_LINE (with or without a leading slash). */
export function hasGitExcludeLine(content: string): boolean {
  return content.split(/\r?\n/).some((line) => {
    const trimmed = line.trim();
    return trimmed === GIT_EXCLUDE_LINE || trimmed === `/${GIT_EXCLUDE_LINE}`;
  });
}

export interface GitDirInfo {
  /** `<root>/.git` */
  path: string;
  /** True for a worktree / submodule where `.git` is a file pointing elsewhere. */
  isFile: boolean;
}

export function gitDirectory(root: string): GitDirInfo | null {
  const path = join(root, ".git");
  try {
    const stat = statSync(path);
    return { path, isFile: stat.isFile() };
  } catch {
    return null;
  }
}

/**
 * Follows a `.git` pointer file (`gitdir: <path>`, what git writes for a linked worktree or a submodule)
 * to the directory whose `info/exclude` git reads for that work tree: the gitdir's `commondir` when it
 * names one (a worktree shares `info/` with its repository), else the gitdir itself (a submodule). Null
 * when the file is not a pointer or the directory it names does not exist.
 */
export function resolveGitDirPointer(root: string, pointerFile: string): string | null {
  let content: string;
  try {
    content = readFileSync(pointerFile, "utf8");
  } catch {
    return null;
  }
  const match = content.match(/^gitdir:[ \t]*(.+?)[ \t]*$/m);
  if (match === null) return null;
  const gitDir = resolve(root, match[1]!);
  if (!existsSync(gitDir)) return null;
  try {
    const common = readFileSync(join(gitDir, "commondir"), "utf8").trim();
    if (common.length > 0) {
      const commonDir = resolve(gitDir, common);
      if (existsSync(commonDir)) return commonDir;
    }
  } catch {
    // no commondir file: the gitdir is the repository itself (submodule) and holds info/ directly
  }
  return gitDir;
}

/**
 * The `info/exclude` file git consults for the work tree at `root`: `<root>/.git/info/exclude`, or, when
 * `.git` is a worktree / submodule pointer file, the pointed-at repository's. Null without a `.git`, or when
 * the pointer cannot be resolved (install then warns and leaves the exclusion to the user).
 */
export function gitExcludeFile(root: string): string | null {
  const info = gitDirectory(root);
  if (info === null) return null;
  const gitDir = info.isFile ? resolveGitDirPointer(root, info.path) : info.path;
  return gitDir === null ? null : join(gitDir, "info", "exclude");
}

/**
 * Content of `.harness-memory/.gitignore`. The state directory holds the last 14 days of prompts and tool
 * output (ledgers), the database with its provenance excerpts, raw provider answers and logs, so install
 * ignores all of it from inside the directory: that covers every scope and checkout layout (`.git/info/exclude`
 * is skipped for `--user` installs and unresolvable worktree pointers) and needs no manifest bookkeeping.
 */
export const STATE_GITIGNORE_CONTENT = "# harness-memory state (prompts, tool output, memory.sqlite): never commit this directory\n*\n";

export function stateGitignoreFile(paths: Pick<HarnessPaths, "dir">): string {
  return join(paths.dir, ".gitignore");
}

/** Writes `.harness-memory/.gitignore` when it is missing; an existing file (perhaps edited to publish `skills/`) is left alone. */
export function ensureStateGitignore(paths: Pick<HarnessPaths, "dir">): { path: string; created: boolean } {
  const path = stateGitignoreFile(paths);
  if (existsSync(path)) return { path, created: false };
  mkdirSync(paths.dir, { recursive: true });
  writeFileSync(path, STATE_GITIGNORE_CONTENT, "utf8");
  return { path, created: true };
}

/** `memory.sqlite.bak-v<N>` files next to the database, newest version first. */
export function listDbBackups(paths: Pick<HarnessPaths, "db">): Array<{ version: number; path: string }> {
  const dir = dirname(paths.db);
  const prefix = `${basename(paths.db)}.bak-v`;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const backups: Array<{ version: number; path: string }> = [];
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    const version = Number(name.slice(prefix.length));
    if (Number.isInteger(version) && version >= 0) backups.push({ version, path: join(dir, name) });
  }
  return backups.sort((left, right) => right.version - left.version);
}

export const DEFAULT_DB_FILE_NAME = DB_FILE_NAME;
