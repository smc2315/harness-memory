import { describe, expect, test } from "vitest";

import { GLOBAL_OPTIONS, parseArgs, renderOptionsHelp, type OptionSpecs } from "../src/cli/lib/args";
import { formatRelative, renderTable } from "../src/cli/lib/output";

const specs: OptionSpecs = {
  ...GLOBAL_OPTIONS,
  yes: { type: "boolean", description: "confirm", alias: "y" },
  to: { type: "number", description: "version" },
  host: { type: "string", description: "host" },
};

describe("cli argument parsing", () => {
  test("accepts --key value, --key=value, -alias and --no-key", () => {
    const parsed = parseArgs(["--host", "claude", "--to=9", "-y", "--no-json", "file.txt"], specs);
    expect(parsed.flags).toEqual({ host: "claude", to: 9, yes: true, json: false });
    expect(parsed.positionals).toEqual(["file.txt"]);
    expect(parsed.unknown).toEqual([]);
    expect(parsed.invalid).toEqual([]);
  });

  test("reports unknown and invalid options instead of swallowing them", () => {
    const parsed = parseArgs(["--bogus", "--to", "abc", "--host"], specs);
    expect(parsed.unknown).toEqual(["--bogus"]);
    expect(parsed.invalid).toEqual(["--to abc", "--host"]);
  });

  test("-- ends option parsing and a value option does not eat the next option", () => {
    const parsed = parseArgs(["--host", "--json", "--", "--not-an-option"], specs);
    expect(parsed.invalid).toEqual(["--host"]);
    expect(parsed.flags.json).toBe(true);
    expect(parsed.positionals).toEqual(["--not-an-option"]);
  });

  test("renders aligned help lines", () => {
    const lines = renderOptionsHelp({ json: GLOBAL_OPTIONS.json!, db: GLOBAL_OPTIONS.db! });
    expect(lines[0]).toMatch(/^ {2}--json {2,}Print machine-readable JSON/);
    expect(lines[1]).toContain("--db <path>");
  });
});

describe("cli output helpers", () => {
  test("formatRelative renders past, future and null stamps", () => {
    const now = Date.parse("2026-11-08T12:00:00.000Z");
    expect(formatRelative("2026-11-08T10:00:00.000Z", now)).toBe("2h ago");
    expect(formatRelative("2026-11-08T12:00:03.000Z", now)).toBe("just now");
    expect(formatRelative("2026-11-11T12:00:00.000Z", now)).toBe("in 3d");
    expect(formatRelative(null, now)).toBe("never");
    expect(formatRelative("garbage", now)).toBe("?");
  });

  test("renderTable aligns columns and separates the header", () => {
    const lines = renderTable(
      [
        ["a", "longer cell"],
        ["bb", "x"],
      ],
      ["ID", "VALUE"]
    );
    expect(lines).toEqual(["ID  VALUE", "--  -----------", "a   longer cell", "bb  x"]);
  });
});
