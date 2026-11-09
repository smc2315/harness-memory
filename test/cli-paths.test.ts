/**
 * CLI path helpers: git's exclude file for a plain checkout, a linked worktree (`.git` pointer + `commondir`),
 * a submodule (`.git` pointer, no `commondir`) and a broken pointer; the state directory's `.gitignore`;
 * PATH lookup by absolute path.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { ensureStateGitignore, findExecutable, GIT_EXCLUDE_LINE, gitExcludeFile, hasGitExcludeLine, resolveGitDirPointer, STATE_GITIGNORE_CONTENT, stateGitignoreFile } from "../src/cli/lib/paths";
import { resolvePaths } from "../src/core/paths";

let base: string;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "hm-paths-")));
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("gitExcludeFile", () => {
  test("a plain checkout uses <root>/.git/info/exclude; no .git gives null", () => {
    const root = join(base, "plain");
    mkdirSync(join(root, ".git"), { recursive: true });
    expect(gitExcludeFile(root)).toBe(join(root, ".git", "info", "exclude"));
    expect(gitExcludeFile(join(base, "nowhere"))).toBeNull();
  });

  test("a linked worktree's pointer resolves through commondir to the repository's info/exclude", () => {
    const main = join(base, "main");
    const worktreeGitDir = join(main, ".git", "worktrees", "feature");
    mkdirSync(join(main, ".git", "info"), { recursive: true });
    mkdirSync(worktreeGitDir, { recursive: true });
    writeFileSync(join(worktreeGitDir, "commondir"), "../..\n");
    const worktree = join(base, "feature");
    mkdirSync(worktree, { recursive: true });
    writeFileSync(join(worktree, ".git"), `gitdir: ${worktreeGitDir}\n`);

    expect(resolveGitDirPointer(worktree, join(worktree, ".git"))).toBe(join(main, ".git"));
    expect(gitExcludeFile(worktree)).toBe(join(main, ".git", "info", "exclude"));
  });

  test("a submodule's relative pointer resolves to .git/modules/<name>/info/exclude", () => {
    const superRoot = join(base, "super");
    const moduleDir = join(superRoot, ".git", "modules", "lib");
    mkdirSync(moduleDir, { recursive: true });
    const sub = join(superRoot, "lib");
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, ".git"), "gitdir: ../.git/modules/lib\n");

    expect(gitExcludeFile(sub)).toBe(join(moduleDir, "info", "exclude"));
  });

  test("a pointer to a missing directory or a .git file without gitdir gives null", () => {
    const dangling = join(base, "dangling");
    mkdirSync(dangling, { recursive: true });
    writeFileSync(join(dangling, ".git"), "gitdir: /definitely/not/here\n");
    expect(gitExcludeFile(dangling)).toBeNull();

    const garbage = join(base, "garbage");
    mkdirSync(garbage, { recursive: true });
    writeFileSync(join(garbage, ".git"), "not a pointer\n");
    expect(gitExcludeFile(garbage)).toBeNull();
  });

  test("hasGitExcludeLine accepts the line with or without a leading slash and ignores look-alikes", () => {
    expect(hasGitExcludeLine(`node_modules\n${GIT_EXCLUDE_LINE}\n`)).toBe(true);
    expect(hasGitExcludeLine(`/${GIT_EXCLUDE_LINE}\r\n`)).toBe(true);
    expect(hasGitExcludeLine(`${GIT_EXCLUDE_LINE}.bak\n`)).toBe(false);
    expect(hasGitExcludeLine("")).toBe(false);
  });
});

describe("state directory .gitignore", () => {
  test("ensureStateGitignore writes `*` once and leaves an edited file alone", () => {
    const paths = resolvePaths(join(base, "project"));
    const first = ensureStateGitignore(paths);
    expect(first).toEqual({ path: stateGitignoreFile(paths), created: true });
    expect(readFileSync(first.path, "utf8")).toBe(STATE_GITIGNORE_CONTENT);
    expect(STATE_GITIGNORE_CONTENT.split("\n")).toContain("*");

    writeFileSync(first.path, "*\n!skills/\n");
    const second = ensureStateGitignore(paths);
    expect(second).toEqual({ path: first.path, created: false });
    expect(readFileSync(first.path, "utf8")).toBe("*\n!skills/\n");
  });
});

describe("findExecutable", () => {
  test("returns the first PATH entry holding the name, as an absolute path, or null", () => {
    const first = join(base, "bin one");
    const second = join(base, "bin two");
    mkdirSync(first, { recursive: true });
    mkdirSync(second, { recursive: true });
    writeFileSync(join(second, "tool.cmd"), "@echo off\n");
    const env = { PATH: ["", first, second].join(delimiter) };
    expect(findExecutable(["tool.cmd"], env)).toBe(join(second, "tool.cmd"));
    expect(findExecutable(["missing.exe"], env)).toBeNull();
    expect(existsSync(join(first, "tool.cmd"))).toBe(false);
  });
});
