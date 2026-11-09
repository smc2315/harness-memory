/**
 * Registry self-consistency: the `usage` synopsis printed by `hm <command> --help` names every option the
 * command module declares (and nothing the dispatcher would reject), so the first line of the help text is
 * not a lagging summary of the options list under it.
 */

import { describe, expect, test } from "vitest";

import { GLOBAL_OPTIONS } from "../src/cli/lib/args";
import { renderCommandHelp } from "../src/cli/main";
import { COMMANDS, findCommand } from "../src/cli/registry";

const FLAG_PATTERN = /--[a-z][a-z0-9-]*/g;

describe("registry usage strings", () => {
  test("every declared option appears in the command's usage synopsis", () => {
    for (const command of COMMANDS) {
      const usageFlags = new Set([...command.usage.matchAll(FLAG_PATTERN)].map((match) => match[0]));
      for (const name of Object.keys(command.options ?? {})) {
        expect(usageFlags.has(`--${name}`), `hm ${command.name}: usage "${command.usage}" lacks --${name}`).toBe(true);
      }
    }
  });

  test("every flag in a usage synopsis is an option the dispatcher accepts", () => {
    for (const command of COMMANDS) {
      const known = new Set([...Object.keys(command.options ?? {}), ...Object.keys(GLOBAL_OPTIONS)].map((name) => `--${name}`));
      for (const match of command.usage.matchAll(FLAG_PATTERN)) {
        expect(known.has(match[0]), `hm ${command.name}: usage names ${match[0]}, which parseArgs would reject`).toBe(true);
      }
    }
  });

  test("hm eval:replay --help and hm install --help show the flags on the usage line", () => {
    const replay = renderCommandHelp(findCommand("eval:replay")!);
    expect(replay[0]).toBe("usage: hm eval:replay [--scenario <ids>] [--fixtures <dir>] [--keep] [--verbose]");
    const install = renderCommandHelp(findCommand("install")!);
    expect(install[0]).toContain("--hook-form auto|exec|shell");
    expect(install[0]).toContain("--skip-self-test");
  });
});
