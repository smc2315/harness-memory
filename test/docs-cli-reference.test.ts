/**
 * Documentation guard (Phase C3): the READMEs, CHANGELOG, upgrade notes and package metadata must agree
 * with the CLI dispatcher. Every registered command is documented in both READMEs, every `--flag` the
 * READMEs attach to an `hm` command exists in the registry (options or usage string) or is a global
 * option, every implemented command's options are mentioned, the hook events of §8.2 are listed, and the
 * v0.5 pages carry their banner.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import { GLOBAL_OPTIONS } from "../src/cli/lib/args";
import { HOOK_REGISTRATIONS } from "../src/cli/lib/settings";
import { COMMANDS } from "../src/cli/registry";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function read(relative: string): string {
  return readFileSync(join(repoRoot, relative), "utf8");
}

const readmeEn = read("README.md");
const readmeKo = read("README.ko.md");
const changelog = read("CHANGELOG.md");
const upgrade = read("docs/redesign/upgrade-from-0.5.md");
const pkg = JSON.parse(read("package.json")) as { version: string; description: string; keywords: string[] };

const FLAG_PATTERN = /--[a-z][a-z0-9-]*/g;

/**
 * Option keys declared by the command modules on disk (`<name>Options: OptionSpecs = { key: { type: … } }`).
 * Read as text, not imported, so a module that is not wired into the registry yet (Phase C work in
 * flight) still counts as the dispatcher's source of truth for its flags.
 */
function commandModuleFlags(): Set<string> {
  const flags = new Set<string>();
  const dir = join(repoRoot, "src", "cli", "commands");
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".ts")) continue;
    const source = readFileSync(join(dir, file), "utf8");
    for (const match of source.matchAll(/^\s+(?:"([a-z][a-z0-9-]*)"|([a-z][a-z0-9-]*)):\s*\{\s*type:\s*"(?:boolean|string|number)"/gm)) {
      flags.add(`--${match[1] ?? match[2]!}`);
    }
  }
  return flags;
}

/** Flags the dispatcher knows: global options, every command's options, every flag named in a usage string, every module option. */
function knownFlags(): Set<string> {
  const flags = new Set<string>(["--help", "--version", ...commandModuleFlags()]);
  for (const name of Object.keys(GLOBAL_OPTIONS)) flags.add(`--${name}`);
  for (const command of COMMANDS) {
    for (const name of Object.keys(command.options ?? {})) flags.add(`--${name}`);
    for (const match of command.usage.matchAll(FLAG_PATTERN)) flags.add(match[0]);
  }
  return flags;
}

/**
 * `--flag` tokens that document an `hm` invocation: every flag on a line mentioning `hm <command>`
 * (READMEs), or only the flags inside backticked `hm …` spans (`spansOnly`, for pages that also quote
 * the retired v0.5 commands next to their replacements).
 */
function hmFlagsIn(text: string, options: { spansOnly?: boolean } = {}): Array<{ line: string; flag: string }> {
  const found: Array<{ line: string; flag: string }> = [];
  for (const line of text.split(/\r?\n/)) {
    if (!/\bhm\s+[a-z]/.test(line)) continue;
    const haystacks = options.spansOnly === true ? [...line.matchAll(/`hm [^`]*`/g)].map((match) => match[0]) : [line];
    for (const haystack of haystacks) {
      for (const match of haystack.matchAll(FLAG_PATTERN)) found.push({ line: line.trim().slice(0, 120), flag: match[0] });
    }
  }
  return found;
}

function cliSection(text: string): string {
  const start = text.indexOf("<!-- cli-reference:start -->");
  const end = text.indexOf("<!-- cli-reference:end -->");
  expect(start, "cli-reference:start marker").toBeGreaterThan(-1);
  expect(end, "cli-reference:end marker").toBeGreaterThan(start);
  return text.slice(start, end);
}

describe("README CLI reference matches src/cli/registry.ts", () => {
  test("every registered command appears in both READMEs' CLI reference", () => {
    const en = cliSection(readmeEn);
    const ko = cliSection(readmeKo);
    for (const command of COMMANDS) {
      expect(en, `README.md documents hm ${command.name}`).toContain(`\`hm ${command.name}`);
      expect(ko, `README.ko.md documents hm ${command.name}`).toContain(`\`hm ${command.name}`);
    }
  });

  test("the READMEs document no flag the dispatcher does not know", () => {
    const known = knownFlags();
    for (const [file, text, spansOnly] of [
      ["README.md", readmeEn, false],
      ["README.ko.md", readmeKo, false],
      ["docs/redesign/upgrade-from-0.5.md", upgrade, true],
    ] as const) {
      for (const { line, flag } of hmFlagsIn(text, { spansOnly })) {
        expect(known.has(flag), `${file}: unknown flag ${flag} on line "${line}"`).toBe(true);
      }
    }
  });

  test("every option of an implemented command is documented in both READMEs", () => {
    for (const command of COMMANDS) {
      if (command.run === undefined) continue;
      for (const name of Object.keys(command.options ?? {})) {
        expect(readmeEn, `README.md mentions --${name} of ${command.name}`).toContain(`--${name}`);
        expect(readmeKo, `README.ko.md mentions --${name} of ${command.name}`).toContain(`--${name}`);
      }
    }
  });

  test("the CLI reference lists the same commands in the same order in both languages", () => {
    const names = (text: string): string[] =>
      [...cliSection(text).matchAll(/\|\s*`hm ([a-z:-]+)/g)].map((match) => match[1]!);
    const en = names(readmeEn);
    const ko = names(readmeKo);
    expect(en).toEqual(COMMANDS.map((command) => command.name));
    expect(ko).toEqual(en);
  });

  test("global options and exit codes are documented", () => {
    for (const text of [readmeEn, readmeKo]) {
      for (const name of Object.keys(GLOBAL_OPTIONS)) expect(text).toContain(`--${name}`);
      expect(text).toContain("75");
      expect(text).toContain("`hm --version`");
    }
  });
});

describe("README install section matches the hook registrations (§8.2)", () => {
  test("every registered Claude Code event and matcher is listed", () => {
    for (const text of [readmeEn, readmeKo]) {
      for (const registration of HOOK_REGISTRATIONS) {
        expect(text, `event ${registration.claudeEvent}`).toContain(`\`${registration.claudeEvent}\``);
        expect(text, `argv ${registration.event}`).toContain(`\`${registration.event}\``);
      }
      // Matchers are rendered with escaped pipes inside markdown tables.
      expect(text).toContain("Bash\\|PowerShell\\|Edit\\|MultiEdit\\|Write\\|NotebookEdit\\|WebFetch\\|mcp__.*");
      expect(text).toContain("manual\\|auto");
    }
  });
});

describe("release metadata", () => {
  test("CHANGELOG has an entry for the package version", () => {
    expect(changelog).toContain(`## ${pkg.version}`);
  });

  test("package.json description and keywords describe the Claude Code host", () => {
    expect(pkg.description).toMatch(/Claude Code/);
    expect(pkg.keywords).toContain("claude-code");
    expect(pkg.keywords).toContain("hooks");
    expect(pkg.keywords).toContain("project-memory");
  });

  test("upgrade notes cover migrations 017–022 and the target schema version", () => {
    for (const file of ["017_memories_authority.sql", "018_episodes_runs.sql", "019_proposals_provenance.sql", "020_policy_rules_v2.sql", "021_legacy_archive.sql", "022_episode_summaries.sql"]) {
      expect(upgrade, file).toContain(file);
      expect(existsSync(join(repoRoot, "src", "db", "migrations", file)), `${file} exists`).toBe(true);
    }
    expect(upgrade).toContain("user_version");
    expect(upgrade).toContain("bak-v<N>");
    expect(upgrade).toContain("db:rollback");
    expect(readmeEn).toContain("docs/redesign/upgrade-from-0.5.md");
    expect(readmeKo).toContain("docs/redesign/upgrade-from-0.5.md");
  });

  test("the v0.5 pages carry the historical banner pointing at the v0.6 spec", () => {
    for (const page of [
      "docs/spec/dream-cycle.md",
      "docs/spec/opencode-adapter.md",
      "docs/spec/promotion-rubric.md",
      "docs/spec/lifecycle-triggers.md",
      "docs/spec/memory-taxonomy.md",
      "docs/product/final-positioning.md",
      "docs/product/roadmap.md",
      "docs/product/TODO.md",
    ]) {
      const text = read(page);
      expect(text.startsWith("<!-- v0.5-historical-banner -->"), `${page} starts with the banner marker`).toBe(true);
      expect(text, `${page} links the spec`).toContain("docs/redesign/spec-v0.6.md");
    }
  });
});
