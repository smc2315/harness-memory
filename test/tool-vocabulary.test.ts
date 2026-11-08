import { describe, expect, test } from "vitest";

import {
  canonicalizeHostTool,
  extractScopeRefs,
  pickTarget,
  relativizeToRoot,
  toolGlobFamilies,
  toolGlobMatches,
} from "../src/activation/tool-vocabulary";
import { CANONICAL_TOOL_FAMILIES } from "../src/core/vocabulary";

describe("canonicalizeHostTool (§8.5)", () => {
  test.each([
    ["Bash", "bash", "bash"],
    ["PowerShell", "bash", "powershell"],
    ["Edit", "edit", null],
    ["MultiEdit", "edit", null],
    ["NotebookEdit", "edit", null],
    ["Write", "write", null],
    ["Read", "read", null],
    ["Grep", "grep", null],
    ["Glob", "glob", null],
    ["WebFetch", "fetch", null],
    ["WebSearch", "other", null],
    ["Task", "task", null],
    ["Agent", "task", null],
    ["TodoWrite", "other", null],
    ["SomethingNew", "other", null],
  ])("claude-code %s → %s / %s", (hostTool, canonical, dialect) => {
    expect(canonicalizeHostTool("claude-code", hostTool)).toEqual({ canonical, shellDialect: dialect });
  });

  test("mcp__server__tool → mcp:server/tool (lower-cased, underscores kept)", () => {
    expect(canonicalizeHostTool("claude-code", "mcp__github__create_issue")).toEqual({ canonical: "mcp:github/create_issue", shellDialect: null });
    expect(canonicalizeHostTool("claude-code", "mcp__My_Server__Do__Thing")).toEqual({ canonical: "mcp:my_server/do__thing", shellDialect: null });
    expect(canonicalizeHostTool("codex", "mcp__fs__read")).toEqual({ canonical: "mcp:fs/read", shellDialect: null });
  });

  test("codex, opencode and import hosts", () => {
    expect(canonicalizeHostTool("codex", "apply_patch")).toEqual({ canonical: "edit", shellDialect: null });
    expect(canonicalizeHostTool("codex", "Bash")).toEqual({ canonical: "bash", shellDialect: "bash" });
    expect(canonicalizeHostTool("opencode", "webfetch")).toEqual({ canonical: "fetch", shellDialect: null });
    expect(canonicalizeHostTool("opencode", "bash")).toEqual({ canonical: "bash", shellDialect: "bash" });
    expect(canonicalizeHostTool("opencode", "mystery")).toEqual({ canonical: "other", shellDialect: null });
    expect(canonicalizeHostTool("import", "bash")).toEqual({ canonical: "bash", shellDialect: null });
    expect(canonicalizeHostTool("import", "mcp:github/x")).toEqual({ canonical: "mcp:github/x", shellDialect: null });
    expect(canonicalizeHostTool("import", "mcp")).toEqual({ canonical: "other", shellDialect: null });
  });
});

describe("extractScopeRefs", () => {
  test("strips quotes, ./ and flags; drops URLs and absolute paths outside the repo", () => {
    expect(
      extractScopeRefs(`cat "./src/a.ts" --file=src/b.ts -v https://example.com/x.ts /etc/passwd 'docs/x y.md' src/c.ts.`, "/repo")
    ).toEqual(["src/a.ts", "src/b.ts", "docs/x y.md", "src/c.ts"]);
  });

  test("relativizes absolute paths under the root (POSIX, Windows, Git Bash)", () => {
    expect(extractScopeRefs("/repo/src/a.ts /other/b.ts", "/repo")).toEqual(["src/a.ts"]);
    expect(extractScopeRefs("C:\\Repo\\src\\b.ts c:/repo/src/d.ts", "C:/repo")).toEqual(["src/b.ts", "src/d.ts"]);
    expect(extractScopeRefs("/c/repo/src/a.ts", "C:/repo")).toEqual(["src/a.ts"]);
    expect(extractScopeRefs("/repo/src/a.ts")).toEqual([]);
    expect(relativizeToRoot("C:/repo", "C:/repo")).toBeNull();
    expect(relativizeToRoot("C:/repo/src/x.ts", "C:\\repo\\")).toBe("src/x.ts");
  });

  test("strips :line:col and #L suffixes and trailing punctuation", () => {
    expect(extractScopeRefs("see src/a.ts:12:3, src/b.ts#L4-L9 and (src/c.ts).")).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
  });

  test("cuts glob tails, drops .. segments, variables and e.g.", () => {
    expect(extractScopeRefs("ls src/**/*.ts ../x.ts e.g. package.json .env $HOME/x.ts *.md dist/")).toEqual(["src", "package.json", ".env", "dist"]);
  });

  test("works on JSON tool input", () => {
    expect(extractScopeRefs(JSON.stringify({ path: "src/db/store.ts", pattern: "foo", limit: 10 }))).toEqual(["src/db/store.ts"]);
  });

  test("dedupes in first-appearance order and caps at 50", () => {
    expect(extractScopeRefs("src/a.ts src/b.ts src/a.ts")).toEqual(["src/a.ts", "src/b.ts"]);
    const many = Array.from({ length: 80 }, (_, i) => `src/f${i}.ts`).join(" ");
    expect(extractScopeRefs(many)).toHaveLength(50);
  });

  test("plain words and numbers are not paths", () => {
    expect(extractScopeRefs("run the tests 3.14 v1.2 again")).toEqual([]);
  });
});

describe("pickTarget (§6.2 step 2)", () => {
  test("bash: command text, scope refs and canonical program token", () => {
    const picked = pickTarget("bash", { command: "cd src && npm test -- src/a.test.ts" }, { dialect: "bash", root: "C:/repo" });
    expect(picked.kind).toBe("command");
    expect(picked.target).toBe("cd src && npm test -- src/a.test.ts");
    expect(picked.scopeRefs).toEqual(["src/a.test.ts"]); // a bare `src` word is not path-like
    expect(picked.programToken).toBe("pm test");
  });

  test("bash without a command string", () => {
    expect(pickTarget("bash", {})).toEqual({ kind: "command", target: null, scopeRefs: [], programToken: null });
    expect(pickTarget("bash", null)).toEqual({ kind: "command", target: null, scopeRefs: [], programToken: null });
  });

  test("bash targets are capped at 4,000 chars", () => {
    const picked = pickTarget("bash", { command: `echo ${"x".repeat(6000)}` });
    expect(picked.target?.length).toBe(4000);
  });

  test("edit/write/read: repository-relative path", () => {
    const inside = pickTarget("edit", { file_path: "C:\\repo\\src\\index.ts" }, { root: "C:/repo" });
    expect(inside).toEqual({ kind: "path", target: "src/index.ts", scopeRefs: ["src/index.ts"], programToken: null });
    const outside = pickTarget("write", { file_path: "C:\\other\\x.ts" }, { root: "C:/repo" });
    expect(outside.target).toBe("C:/other/x.ts");
    expect(outside.scopeRefs).toEqual([]);
    expect(pickTarget("read", { path: "./docs/readme.md" })).toEqual({ kind: "path", target: "docs/readme.md", scopeRefs: ["docs/readme.md"], programToken: null });
    expect(pickTarget("edit", { notebook_path: "nb/a.ipynb" }).target).toBe("nb/a.ipynb");
    expect(pickTarget("grep", { pattern: "x" })).toEqual({ kind: "path", target: null, scopeRefs: [], programToken: null });
  });

  test("fetch: url", () => {
    expect(pickTarget("fetch", { url: "https://example.com/a" })).toEqual({ kind: "url", target: "https://example.com/a", scopeRefs: [], programToken: null });
  });

  test("mcp/task/other: JSON digest ≤ 2,000 chars with path tokens as scope refs", () => {
    const picked = pickTarget("mcp:fs/read", { path: "src/db/store.ts", mode: "text" });
    expect(picked.kind).toBe("any");
    expect(picked.target).toBe(JSON.stringify({ path: "src/db/store.ts", mode: "text" }));
    expect(picked.scopeRefs).toEqual(["src/db/store.ts"]);
    expect(pickTarget("task", { prompt: "x".repeat(5000) }).target?.length).toBe(2000);
    expect(pickTarget("other", { query: "weather" }).kind).toBe("any");
  });
});

describe("toolGlobMatches", () => {
  test.each([
    ["*", "bash", true],
    ["*", "mcp:github/x", true],
    ["bash", "bash", true],
    ["Bash", "bash", true],
    ["bash", "edit", false],
    ["edit|write", "edit", true],
    ["edit|write", "write", true],
    ["edit|write", "read", false],
    ["mcp:github/*", "mcp:github/create_issue", true],
    ["mcp:github/*", "mcp:other/x", false],
    ["mcp", "mcp:other/x", true],
    ["mcp", "bash", false],
    ["ba*", "bash", true],
  ])("%s vs %s → %s", (pattern, canonical, expected) => {
    expect(toolGlobMatches(pattern, canonical)).toBe(expected);
  });

  test("toolGlobFamilies resolves a glob to canonical families", () => {
    expect(toolGlobFamilies("edit|read")).toEqual(["edit", "read"]);
    expect(toolGlobFamilies("mcp:github/*")).toEqual(["mcp"]);
    expect(toolGlobFamilies("*")).toEqual([...CANONICAL_TOOL_FAMILIES]);
    expect(toolGlobFamilies("nothing")).toEqual([]);
  });
});
