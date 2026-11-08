import { performance } from "node:perf_hooks";

import { describe, expect, test } from "vitest";

import {
  canonicalizeCommand,
  checkRegexSafety,
  checkSpecificity,
  commandPatternHasPath,
  compileSignature,
  compileSignatureKey,
  globMatchesPath,
  matchSignature,
  matchSignatureKey,
  parseSignatureKey,
  primaryProgramToken,
  regexLooksUnsafe,
  signatureKey,
} from "../src/activation/signature";
import type { CompiledSignature } from "../src/core/snapshot-types";
import type { TriggerSignature } from "../src/core/vocabulary";

function cmd(pattern: string, extra: Partial<TriggerSignature> = {}): TriggerSignature {
  return { tool: "bash", target: "command", pattern_kind: "cmd", pattern, ...extra };
}

function compiled(sig: TriggerSignature): CompiledSignature {
  const result = compileSignature(sig);
  if (!result.ok) throw new Error(`expected ${sig.pattern} to compile: ${result.code} ${result.detail}`);
  return result.compiled;
}

describe("canonicalizeCommand (§4.6 grammar)", () => {
  test.each([
    ["npm test", "pm test"],
    ["pnpm test", "pm test"],
    ["yarn test", "pm test"],
    ["bun test", "pm test"],
    ["npm run test", "pm test"],
    ["pnpm run test", "pm test"],
    ["yarn run test", "pm test"],
    ["npm run-script test", "pm test"],
    ["npm t", "pm test"],
    ["npm i", "pm install"],
    ["pnpm install", "pm install"],
    ["npx vitest run", "bin vitest run"],
    ["pnpm dlx vitest run", "bin vitest run"],
    ["bunx vitest run", "bin vitest run"],
    ["npx -y vitest@2 run", "bin vitest run"],
    ["npx -p typescript tsc --noEmit", "bin tsc --noEmit"],
    ["FOO=1 sudo npm test", "pm test"],
    ["FOO=1 BAR=2 npm test", "pm test"],
    ["env FOO=1 npm test", "pm test"],
    ["time npm test", "pm test"],
    ["nice -n 10 npm test", "pm test"],
    ["sudo -u root npm test", "pm test"],
    ["command -v git", "git"],
    ["exec npm test", "pm test"],
    ["npm run build -- --watch", "pm build -- --watch"],
    ["git push --force origin main", "git push --force origin main"],
  ])("%s → %s", (command, canonical) => {
    expect(canonicalizeCommand(command, "bash").canonical).toBe(canonical);
  });

  test("splits on &&, ||, ;, | and newline while respecting quotes", () => {
    const result = canonicalizeCommand(`echo "a && b" && git status; ls | grep x || true\nnpm test`, "bash");
    expect(result.segments).toEqual([["echo", "a && b"], ["git", "status"], ["ls"], ["grep", "x"], ["true"], ["pm", "test"]]);
    expect(result.programTokens).toEqual(["echo", "git", "ls", "grep", "true", "pm test"]);
    expect(result.canonical).toBe("echo a && b; git status; ls; grep x; true; pm test");
  });

  test("PowerShell: & call operator, ; separators, backtick escapes, .cmd launcher", () => {
    expect(canonicalizeCommand("& npm test; git status", "powershell").segments).toEqual([["pm", "test"], ["git", "status"]]);
    const escaped = canonicalizeCommand("Write-Output `\"hi`\"; & 'C:\\Program Files\\nodejs\\npm.cmd' run build", "powershell");
    expect(escaped.segments).toEqual([["write-output", '"hi"'], ["pm", "build"]]);
    expect(canonicalizeCommand("C:\\x\\Npm.CMD test", "powershell").segments).toEqual([["pm", "test"]]);
  });

  test("redirections are not separators, a single & is the background operator", () => {
    expect(canonicalizeCommand("npm test 2>&1 & ls", "bash").segments).toEqual([["pm", "test", "2>&1"], ["ls"]]);
    expect(canonicalizeCommand("npm test &> out.log", "bash").segments).toEqual([["pm", "test", "&>", "out.log"]]);
  });

  test("subshell parentheses split segments, $( ) stays inside a token", () => {
    expect(canonicalizeCommand("(cd pkg && npm test) && echo $(date +%s)", "bash").segments).toEqual([
      ["cd", "pkg"],
      ["pm", "test"],
      ["echo", "$(date +%s)"],
    ]);
  });

  test("program token is the lower-cased basename", () => {
    expect(canonicalizeCommand("/usr/bin/git status", "bash").segments[0]).toEqual(["git", "status"]);
    expect(canonicalizeCommand("Git Status", "bash").segments[0]).toEqual(["git", "Status"]);
  });

  test("empty and whitespace-only commands yield no segments", () => {
    expect(canonicalizeCommand("", "bash").segments).toEqual([]);
    expect(canonicalizeCommand("   \n  ", "bash").canonical).toBe("");
  });

  test("primaryProgramToken skips shell navigation and folds package managers", () => {
    expect(primaryProgramToken("cd pkg && npm test", "bash")).toBe("pm test");
    expect(primaryProgramToken("npx vitest run", "bash")).toBe("bin vitest");
    expect(primaryProgramToken("git status", null)).toBe("git");
    expect(primaryProgramToken("cd pkg", "bash")).toBe("cd");
    expect(primaryProgramToken("", "bash")).toBeNull();
  });

  test("commandPatternHasPath", () => {
    expect(commandPatternHasPath(["pm", "test"])).toBe(false);
    expect(commandPatternHasPath(["rm", "-rf", "dist"])).toBe(false);
    expect(commandPatternHasPath(["git", "add", "src/index.ts"])).toBe(true);
    expect(commandPatternHasPath(["cat", "package.json"])).toBe(true);
    expect(commandPatternHasPath(["bin", "vitest", "run", "test/a.test.ts"])).toBe(true);
  });
});

describe("compileSignature / signatureKey", () => {
  test("cmd patterns share one canonical key", () => {
    const keys = ["npm test", "pnpm test", "yarn test", "bun test", "npm run test"].map((pattern) => compiled(cmd(pattern)).signature_key);
    expect(new Set(keys)).toEqual(new Set(["bash|command|cmd|pm test"]));
    expect(compiled(cmd("npm test")).tokens).toEqual(["pm", "test"]);
  });

  test("negate is part of the key and round-trips through parseSignatureKey", () => {
    const sig = compiled(cmd("npm test", { negate: true }));
    expect(sig.signature_key).toBe("bash|command|cmd|pm test|!");
    expect(signatureKey(sig)).toBe(sig.signature_key);
    expect(parseSignatureKey(sig.signature_key)).toEqual({ tool: "bash", target: "command", pattern_kind: "cmd", pattern: "pm test", negate: true });
  });

  test("tool globs and regex alternations survive the key format", () => {
    const glob = compiled({ tool: "Edit | write", target: "path", pattern_kind: "glob", pattern: "./**/.env*" });
    expect(glob.tool).toBe("edit|write");
    expect(glob.pattern).toBe("**/.env*");
    expect(glob.regex_source).not.toBeNull();
    expect(parseSignatureKey(glob.signature_key)).toEqual({ tool: "edit|write", target: "path", pattern_kind: "glob", pattern: "**/.env*", negate: false });
    const regex = compiled({ tool: "bash", target: "command", pattern_kind: "regex", pattern: "rm -rf|del /s" });
    expect(parseSignatureKey(regex.signature_key)).toMatchObject({ tool: "bash", pattern_kind: "regex", pattern: "rm -rf|del /s", negate: false });
  });

  test("substring is lower-cased", () => {
    expect(compiled({ tool: "fetch", target: "url", pattern_kind: "substring", pattern: "Api.Internal.Example" }).pattern).toBe("api.internal.example");
  });

  test.each<[TriggerSignature, string]>([
    [{ tool: "", target: "command", pattern_kind: "cmd", pattern: "npm test" }, "invalid"],
    [{ tool: "bash", target: "nope" as never, pattern_kind: "cmd", pattern: "npm test" }, "invalid"],
    [{ tool: "bash", target: "command", pattern_kind: "weird" as never, pattern: "npm test" }, "invalid"],
    [cmd("   "), "invalid"],
    [cmd("npm test && rm -rf /"), "invalid"],
    [{ tool: "bash", target: "command", pattern_kind: "regex", pattern: "(" }, "invalid"],
    [cmd("npm"), "signature_unspecific"],
    [cmd("git"), "signature_unspecific"],
    [{ tool: "fetch", target: "url", pattern_kind: "substring", pattern: "short" }, "signature_unspecific"],
    [{ tool: "edit", target: "path", pattern_kind: "glob", pattern: "**/*" }, "signature_unspecific"],
    [{ tool: "edit", target: "path", pattern_kind: "glob", pattern: "*" }, "signature_unspecific"],
    [{ tool: "edit", target: "path", pattern_kind: "glob", pattern: "**" }, "signature_unspecific"],
    [{ tool: "edit", target: "path", pattern_kind: "glob", pattern: "*/*/*" }, "signature_unspecific"],
    [{ tool: "bash", target: "command", pattern_kind: "regex", pattern: "a*" }, "signature_unspecific"],
  ])("rejects %j with %s", (sig, code) => {
    expect(compileSignature(sig)).toMatchObject({ ok: false, code });
  });

  test("V10 accepts specific patterns", () => {
    expect(compileSignature({ tool: "edit", target: "path", pattern_kind: "glob", pattern: "*.ts" })).toMatchObject({ ok: true });
    expect(compileSignature({ tool: "fetch", target: "url", pattern_kind: "substring", pattern: "node_modules/" })).toMatchObject({ ok: true });
    expect(checkSpecificity({ pattern_kind: "cmd", pattern: "pm test", tokens: ["pm", "test"], regex_source: null })).toEqual({ ok: true });
    expect(checkSpecificity({ pattern_kind: "cmd", pattern: "pm", tokens: ["pm"], regex_source: null })).toMatchObject({ ok: false, code: "signature_unspecific" });
  });
});

describe("V5 regex safety", () => {
  test.each(["(a+)+$", "(.*)*x", "(a|aa)+$", "(\\w+\\s?)+$", "\\w*\\d*\\w*x", "\\s*\\s*x", "a?a?a?a?a?aaaa", "(x+x+)+y", "[a-z]+[a-m]*k"])(
    "rejects %s statically",
    (pattern) => {
      expect(regexLooksUnsafe(pattern)).toBe(true);
      expect(compileSignature({ tool: "bash", target: "command", pattern_kind: "regex", pattern })).toMatchObject({ ok: false, code: "regex_unsafe" });
    }
  );

  test.each([
    "^npm\\s+(run\\s+)?test\\b",
    "rm\\s+-rf\\s+/",
    "git push.*--force",
    "(foo|bar)\\.ts$",
    "\\d+\\s+\\d+",
    "^[a-z]+\\s+[0-9]+",
    "^DROP TABLE",
    "(foo|bar)+\\s*=",
    "curl .* \\| (ba)?sh",
  ])("accepts %s", (pattern) => {
    expect(regexLooksUnsafe(pattern)).toBe(false);
    expect(compileSignature({ tool: "bash", target: "command", pattern_kind: "regex", pattern })).toMatchObject({ ok: true });
  });

  test("a catastrophic pattern is rejected without running it on the 4 KB sample", () => {
    const start = performance.now();
    const result = checkRegexSafety("(a+)+$");
    expect(result).toMatchObject({ ok: false, code: "regex_unsafe" });
    expect(performance.now() - start).toBeLessThan(500);
  });

  test("a safe pattern stays within the 2 ms budget on the 4 KB samples", () => {
    expect(checkRegexSafety("^npm\\s+(run\\s+)?test\\b")).toMatchObject({ ok: true });
  });

  test("an unanchored quadratic pattern passes the static check but trips the 4 KB / 2 ms budget", () => {
    expect(regexLooksUnsafe("[a-z]+\\s+[0-9]+")).toBe(false);
    expect(checkRegexSafety("[a-z]+\\s+[0-9]+")).toMatchObject({ ok: false, code: "regex_unsafe", detail: expect.stringContaining("exceeded") });
  });
});

describe("matchSignature", () => {
  const pmTest = compiled(cmd("npm test"));
  const forcePush = compiled(cmd("git push --force"));

  test.each([
    ["npm test", "bash", true],
    ["pnpm test", "bash", true],
    ["yarn test", "bash", true],
    ["bun test", "bash", true],
    ["npm run test", "bash", true],
    ["cd packages/a && npm test", "bash", true],
    ["FOO=1 npm test -- --watch", "bash", true],
    ["& npm test", "powershell", true],
    ["npm test; git status", "powershell", true],
    ["npm run build", "bash", false],
    ["npm install", "bash", false],
    ["echo 'npm test'", "bash", false],
    ["ls", "bash", false],
    ["", "bash", false],
  ])("pm test vs %s (%s) → %s", (command, dialect, expected) => {
    expect(matchSignature(pmTest, command, dialect as "bash" | "powershell")).toBe(expected);
  });

  test("remaining tokens must all be present, order-insensitive", () => {
    expect(matchSignature(forcePush, "git push origin main --force", "bash")).toBe(true);
    expect(matchSignature(forcePush, "git push --force-with-lease", "bash")).toBe(false);
    expect(matchSignature(forcePush, "git push", "bash")).toBe(false);
  });

  test("negate inverts the result", () => {
    const notPmTest = compiled(cmd("npm test", { negate: true }));
    expect(matchSignature(notPmTest, "npm test", "bash")).toBe(false);
    expect(matchSignature(notPmTest, "ls", "bash")).toBe(true);
  });

  test("glob signatures match repository paths with dot files", () => {
    const env = compiled({ tool: "edit|write", target: "path", pattern_kind: "glob", pattern: "**/.env*" });
    expect(matchSignature(env, ".env", null)).toBe(true);
    expect(matchSignature(env, "apps/web/.env.local", null)).toBe(true);
    expect(matchSignature(env, "apps\\web\\.env", null)).toBe(true);
    expect(matchSignature(env, "src/env.ts", null)).toBe(false);
    const migrations = compiled({ tool: "edit", target: "path", pattern_kind: "glob", pattern: "src/db/migrations/*.sql" });
    expect(matchSignature(migrations, "./src/db/migrations/017_memories_authority.sql", null)).toBe(true);
    expect(matchSignature(migrations, "src/db/store.ts", null)).toBe(false);
  });

  test("regex and substring signatures", () => {
    const regex = compiled({ tool: "bash", target: "command", pattern_kind: "regex", pattern: "rm\\s+-rf\\s+/" });
    expect(matchSignature(regex, "rm -rf /tmp/x", "bash")).toBe(true);
    expect(matchSignature(regex, "rm -rf dist", "bash")).toBe(false);
    const substring = compiled({ tool: "fetch", target: "url", pattern_kind: "substring", pattern: "Internal.Example.com" });
    expect(matchSignature(substring, "https://api.internal.example.com/v1", null)).toBe(true);
    expect(matchSignature(substring, "https://example.org", null)).toBe(false);
  });

  test("targets longer than 4 KB are cut before matching", () => {
    const regex = compiled({ tool: "bash", target: "command", pattern_kind: "regex", pattern: "needle$" });
    expect(matchSignature(regex, `${"x".repeat(5000)}needle`, "bash")).toBe(false);
    expect(matchSignature(regex, `${"x".repeat(100)}needle`, "bash")).toBe(true);
  });

  test("matchSignatureKey rebuilds a matcher from a stored key", () => {
    expect(matchSignatureKey("bash|command|cmd|pm test", "pnpm test", "bash")).toBe(true);
    expect(matchSignatureKey("bash|command|cmd|pm test", "git status", "bash")).toBe(false);
    expect(matchSignatureKey("edit|write|path|glob|**/.env*", "apps/.env", null)).toBe(true);
    expect(matchSignatureKey("bash|command|cmd|pm test|!", "ls", "bash")).toBe(true);
    expect(compileSignatureKey("not a key")).toBeNull();
    expect(matchSignatureKey("not a key", "ls", "bash")).toBe(false);
  });

  test("globMatchesPath treats magic-free globs as directories", () => {
    expect(globMatchesPath("src/**", "src/db/store.ts")).toBe(true);
    expect(globMatchesPath("src", "src/db/store.ts")).toBe(true);
    expect(globMatchesPath("src/db/store.ts", "src/db/store.ts")).toBe(true);
    expect(globMatchesPath("docs/**", "src/db/store.ts")).toBe(false);
  });
});
