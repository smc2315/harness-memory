import { performance } from "node:perf_hooks";

import { describe, expect, test } from "vitest";

import {
  CANONICAL_CACHE_SIZE,
  REGEX_BUDGET_MS,
  REGEX_BUDGET_RATIO,
  REGEX_BUDGET_ROUNDS,
  REGEX_HOPELESS_MS,
  REGEX_HOPELESS_RATIO,
  REGEX_STAGE_BYTES,
  canonicalCommandFor,
  canonicalizeCommand,
  checkRegexSafety,
  checkSpecificity,
  commandPatternHasPath,
  compileSignature,
  compileSignatureKey,
  fastestSweepMs,
  globMatchesPath,
  matchSignature,
  matchSignatureKey,
  parseSignatureKey,
  primaryProgramToken,
  referenceSweepMs,
  regexBudgetMs,
  regexFloorMs,
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
  test("cmd patterns: one manager shares one key, the family word `pm` covers every manager", () => {
    const npmKeys = ["npm test", "npm run test", "npm run-script test", "npm t", "sudo npm test"].map((pattern) => compiled(cmd(pattern)).signature_key);
    expect(new Set(npmKeys)).toEqual(new Set(["bash|command|cmd|npm test"]));
    expect(compiled(cmd("pnpm test")).signature_key).toBe("bash|command|cmd|pnpm test");
    expect(compiled(cmd("yarn test")).signature_key).toBe("bash|command|cmd|yarn test");
    expect(compiled(cmd("pm test")).signature_key).toBe("bash|command|cmd|pm test");
    expect(compiled(cmd("npm test")).tokens).toEqual(["pm", "test"]);
    expect(compiled(cmd("npm test")).program).toBe("npm");
    expect(compiled(cmd("pm test")).program).toBeUndefined();
    expect(compiled(cmd("git push --force")).program).toBeUndefined();
    expect(compiled(cmd("pnpm dlx vitest run")).signature_key).toBe("bash|command|cmd|pnpm dlx vitest run");
    expect(compiled(cmd("pnpm dlx vitest run")).tokens).toEqual(["bin", "vitest", "run"]);
    expect(compiled(cmd("npx vitest run")).program).toBe("npx");
    expect(compiled(cmd("bin vitest run")).program).toBeUndefined();
    // the canonical pattern round-trips through compileSignature
    expect(compiled(cmd(compiled(cmd("pnpm dlx vitest run")).pattern)).signature_key).toBe("bash|command|cmd|pnpm dlx vitest run");
  });

  test("negate is part of the key and round-trips through parseSignatureKey", () => {
    const sig = compiled(cmd("npm test", { negate: true }));
    expect(sig.signature_key).toBe("bash|command|cmd|npm test|!");
    expect(signatureKey(sig)).toBe(sig.signature_key);
    expect(parseSignatureKey(sig.signature_key)).toEqual({ tool: "bash", target: "command", pattern_kind: "cmd", pattern: "npm test", negate: true });
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

  // The last three are quadratic on V5's seed sample with a small constant (`.*` backtracks to the end from every
  // literal prefix; 0.7–1.6 ms per 4 KB sweep on a 2024 desktop): they pass through the 2 ms floor on a fast machine
  // and through REGEX_BUDGET_RATIO × the linear reference on a slow one — the regression for the machine-relative
  // budget (the first CI run rejected the curl pattern on runners 2–3.5× slower than the author's machine).
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
    "cat .*\\.env",
    "curl .*\\|.*sh",
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

  test("a safe pattern stays within the 2 ms floor on the 4 KB samples", () => {
    expect(checkRegexSafety("^npm\\s+(run\\s+)?test\\b")).toMatchObject({ ok: true });
  });

  test("a pattern that backtracks at every position passes the static check but trips the budget on any machine", () => {
    // ≥ 1 860× the linear reference natively and ≥ 1 150× interpreted at 4 KB, against a 500× ceiling. On a quadratic
    // pattern the ratio roughly halves with each smaller stage of the ladder (this pair: ~240–360× at 512 B, ~490–580×
    // at 1 KB on 2024 x64 desktops), so it is normally refused at 1–2 KB and `.*\.env.*`, with its larger constant,
    // already at 512 B; the stage depends on the machine and is not asserted (calibration in
    // docs/redesign/phase-f-notes.md, CI follow-up).
    expect(regexLooksUnsafe("[a-z]+\\s+[0-9]+")).toBe(false);
    expect(checkRegexSafety("[a-z]+\\s+[0-9]+")).toMatchObject({
      ok: false,
      code: "regex_unsafe",
      detail: expect.stringMatching(/exceeded the budget on a \d+ B sample: .* linear scan/),
    });
    expect(checkRegexSafety(".*\\.env.*")).toMatchObject({ ok: false, code: "regex_unsafe" });
  });

  test("patterns of a higher degree are refused early in the ladder, within a bounded time", () => {
    // Three `.*` before a literal the seed sample cannot contain: quartic on that sample, 1.6 s for five 4 KB sweeps
    // natively — a smaller stage refuses it first (from the second stage on, each stage bounds the next by 2^degree).
    let started = performance.now();
    expect(checkRegexSafety("docker .* run .* -v .* /var/run/docker\\.sock")).toMatchObject({
      ok: false,
      code: "regex_unsafe",
      detail: expect.stringMatching(/exceeded the budget on a (128|256|512|1024|2048) B sample/),
    });
    expect(performance.now() - started).toBeLessThan(5_000);
    // Dense literals make a degree-6 pattern cost 1.8 ms per sweep at 128 B and 2.6 s at 512 B natively: the 128 B
    // stage refuses it, and a first sweep beyond REGEX_HOPELESS_RATIO × the budget would end a stage after one sweep.
    started = performance.now();
    expect(checkRegexSafety("a.*b.*c.*d.*e.*f\\.g")).toMatchObject({
      ok: false,
      code: "regex_unsafe",
      detail: expect.stringMatching(/exceeded the budget on a (128|256|512) B sample/),
    });
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(REGEX_HOPELESS_RATIO).toBeGreaterThanOrEqual(10);
    expect(REGEX_HOPELESS_MS).toBeGreaterThanOrEqual(100);
  });

  test("fastestSweepMs keeps the fastest round, stops once a round is within stopAtMs, and divides by passes", () => {
    const clock = (ticks: number[]) => {
      let reads = 0;
      return () => ticks[Math.min(reads++, ticks.length - 1)]!;
    };
    // rounds of 10, 10, 10, 10 and 0.5 ms: four stalled rounds do not count, the fast one does
    expect(fastestSweepMs(/a/, ["abc"], { rounds: 5, stopAtMs: 2, now: clock([0, 10, 10, 20, 20, 30, 30, 40, 40, 40.5]) })).toBe(0.5);
    // early exit: the second round (1 ms) is within stopAtMs, so the clock is read four times and later rounds never run
    let reads = 0;
    const ticks = [0, 10, 10, 11, 11, 99, 99, 99, 99, 99];
    const now = () => ticks[Math.min(reads++, ticks.length - 1)]!;
    expect(fastestSweepMs(/a/, ["abc"], { rounds: 5, stopAtMs: 2, now })).toBe(1);
    expect(reads).toBe(4);
    // every round above stopAtMs: all rounds run and the fastest is returned
    expect(fastestSweepMs(/a/, ["abc"], { rounds: 5, stopAtMs: 2, now: clock([0, 10, 10, 15, 15, 21, 21, 30, 30, 33]) })).toBe(3);
    // passes divide the measured time; the default round count is REGEX_BUDGET_ROUNDS
    expect(fastestSweepMs(/a/, ["abc"], { rounds: 1, passes: 4, now: clock([0, 8]) })).toBe(2);
    expect(REGEX_BUDGET_ROUNDS).toBeGreaterThanOrEqual(3);
  });

  test("the budget is the 2 ms floor on a fast machine and REGEX_BUDGET_RATIO × the linear reference on a slow one", () => {
    expect(regexBudgetMs(0.001)).toBe(REGEX_BUDGET_MS);
    expect(regexBudgetMs(0.01)).toBeCloseTo(REGEX_BUDGET_RATIO * 0.01, 10);
    expect(regexBudgetMs(REGEX_BUDGET_MS / REGEX_BUDGET_RATIO)).toBe(REGEX_BUDGET_MS);
    // the smaller stages of the ladder scale the floor with the sample size
    expect(REGEX_STAGE_BYTES[REGEX_STAGE_BYTES.length - 1]).toBe(4096);
    expect([...REGEX_STAGE_BYTES].sort((left, right) => left - right)).toEqual([...REGEX_STAGE_BYTES]);
    expect(REGEX_STAGE_BYTES[0]).toBe(128);
    expect(regexFloorMs(4096)).toBe(REGEX_BUDGET_MS);
    expect(regexFloorMs(512)).toBe(REGEX_BUDGET_MS / 8);
    expect(regexFloorMs(128)).toBe(REGEX_BUDGET_MS / 32);
    expect(regexBudgetMs(0.0001, regexFloorMs(512))).toBe(REGEX_BUDGET_MS / 8);
    expect(regexBudgetMs(0.001, regexFloorMs(512))).toBeCloseTo(0.5, 10);
    // a linear scan of five 4 KB samples is far below the floor on every machine this runs on (≈ 0.01 ms native,
    // ≈ 0.1 ms with V8's interpreter); a reference anywhere near the floor would mean the budget is meaningless there
    const reference = referenceSweepMs(4096);
    expect(reference).toBeGreaterThan(0);
    expect(reference).toBeLessThan(REGEX_BUDGET_MS / 2);
  });
});

describe("literal package manager in cmd patterns (verification round)", () => {
  test("`npm test` fires on npm forms only; `pm test` on every manager", () => {
    const npm = compiled(cmd("npm test"));
    const cases: Array<[string, "bash" | "powershell", boolean]> = [
      ["npm test", "bash", true],
      ["npm run test", "bash", true],
      ["FOO=1 sudo npm test", "bash", true],
      ["cd pkg && npm test", "bash", true],
      ["pnpm test", "bash", false],
      ["yarn test", "bash", false],
      ["bun test", "bash", false],
      ["& npm.cmd test", "powershell", true],
      ["& pnpm test", "powershell", false],
    ];
    for (const [command, dialect, expected] of cases) expect(matchSignature(npm, command, dialect), command).toBe(expected);
    const family = compiled(cmd("pm test"));
    for (const command of ["npm test", "pnpm test", "yarn test", "bun run test"]) expect(matchSignature(family, command, "bash"), command).toBe(true);
    expect(matchSignature(family, "npm run build", "bash")).toBe(false);
  });

  test("bin runners: `npx vitest` pins npx, `pnpm dlx vitest` pins pnpm dlx, `bin vitest` covers all", () => {
    expect(matchSignature(compiled(cmd("npx vitest run")), "npx vitest run --reporter dot", "bash")).toBe(true);
    expect(matchSignature(compiled(cmd("npx vitest run")), "pnpm dlx vitest run", "bash")).toBe(false);
    expect(matchSignature(compiled(cmd("pnpm dlx vitest run")), "pnpm dlx vitest run", "bash")).toBe(true);
    expect(matchSignature(compiled(cmd("pnpm dlx vitest run")), "bunx vitest run", "bash")).toBe(false);
    const any = compiled(cmd("bin vitest run"));
    for (const command of ["npx vitest run", "pnpm dlx vitest run", "bunx vitest run", "yarn dlx vitest run"]) expect(matchSignature(any, command, "bash"), command).toBe(true);
  });

  test("canonicalizeCommand exposes the literal program beside the folded tokens", () => {
    const result = canonicalizeCommand("cd pkg && pnpm dlx vitest run; yarn test", "bash");
    expect(result.segments).toEqual([["cd", "pkg"], ["bin", "vitest", "run"], ["pm", "test"]]);
    expect(result.literals).toEqual(["cd", "pnpm dlx", "yarn"]);
    expect(result.programTokens).toEqual(["cd", "bin vitest", "pm test"]);
  });
});

describe("matchSignature", () => {
  const pmTest = compiled(cmd("pm test"));
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

describe("canonicalCommandFor (memoized canonical form)", () => {
  const pmTest = compiled(cmd("npm test"));

  test("one shared canonical form per (command, dialect); null and undefined dialects share the `unknown` entry", () => {
    const target = "cd pkg && npm test -- --watch";
    const first = canonicalCommandFor(target, "bash");
    expect(first).toEqual(canonicalizeCommand(target, "bash"));
    expect(canonicalCommandFor(target, "bash")).toBe(first);
    expect(canonicalCommandFor(target, "powershell")).not.toBe(first);
    expect(canonicalCommandFor(target, null)).toBe(canonicalCommandFor(target, undefined));
  });

  test("matchSignature goes through the cache (LRU refresh), so N cmd signatures tokenize one target once", () => {
    const target = "cd pkg && npm test -- --watch src/a.test.ts";
    const first = canonicalCommandFor(target, "bash");
    // Make `target` the oldest entry of a full cache, let matchSignature touch it, then insert enough newer
    // entries to evict everything that was not refreshed in between.
    const fillers = Array.from({ length: CANONICAL_CACHE_SIZE - 1 }, (_, index) => canonicalCommandFor(`echo filler-${String(index)}`, "bash"));
    expect(matchSignature(pmTest, target, "bash")).toBe(true);
    for (let index = 0; index < CANONICAL_CACHE_SIZE - 1; index += 1) canonicalCommandFor(`echo newer-${String(index)}`, "bash");
    expect(canonicalCommandFor(target, "bash")).toBe(first);
    expect(canonicalCommandFor("echo filler-0", "bash")).not.toBe(fillers[0]);
  });
});
