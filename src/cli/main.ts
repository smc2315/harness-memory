/**
 * `hm` / `harness-memory` dispatcher (spec §11): `hm <command> [args] [--json] [--db <path>] [--root <dir>]`.
 * Direct dispatch (no framework), exit codes 0 ok / 1 error / 2 usage or not-in-this-build / 75 lock busy.
 * `runCli` never throws: errors become one stderr line (+ hint) and an exit code.
 */

import { createInterface } from "node:readline";

import { loadConfig } from "../core/config";
import { EXIT_CODES } from "../core/errors";
import type { CliSeams, CommandContext } from "./context";
import { flagBoolean, flagString, GLOBAL_OPTIONS, parseArgs, renderOptionsHelp, type OptionSpecs } from "./lib/args";
import { Printer, processStreams, type CliStreams } from "./lib/output";
import { findPackageRoot, readPackageVersion, resolveCliPaths, stableExecPath } from "./lib/paths";
import { describeFailure, EXIT_USAGE } from "./lib/store";
import { COMMAND_GROUP_TITLES, COMMANDS, findCommand, type CommandDefinition, type CommandGroup } from "./registry";

export interface RunCliOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  streams?: CliStreams;
  isTTY?: boolean;
  execPath?: string;
  platform?: NodeJS.Platform;
  clock?: () => string;
  /** Answers confirmation prompts (tests); default asks on a TTY and refuses otherwise. */
  confirm?: (question: string) => Promise<boolean>;
  /** The harness-memory package directory (default: found from this bundle); null when it is unknown. */
  packageRoot?: string | null;
  seams?: CliSeams;
}

export const CLI_NAME = "hm";

function ttyConfirm(): (question: string) => Promise<boolean> {
  return (question) =>
    new Promise((resolve) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      rl.question(`${question} [y/N] `, (answer) => {
        rl.close();
        resolve(/^y(?:es)?$/i.test(answer.trim()));
      });
    });
}

export function renderHelp(version: string): string[] {
  const lines = [
    `harness-memory ${version} — project memory for coding harnesses`,
    "",
    `usage: ${CLI_NAME} <command> [args] [--json] [--db <path>] [--root <dir>]`,
    "",
  ];
  const groups = Object.keys(COMMAND_GROUP_TITLES) as CommandGroup[];
  const width = COMMANDS.reduce((max, command) => Math.max(max, command.name.length), 0);
  for (const group of groups) {
    const members = COMMANDS.filter((command) => command.group === group);
    if (members.length === 0) continue;
    lines.push(`${COMMAND_GROUP_TITLES[group]}:`);
    for (const command of members) {
      const marker = command.run === undefined ? "  (not in this build)" : "";
      lines.push(`  ${command.name.padEnd(width)}  ${command.summary}${marker}`);
    }
    lines.push("");
  }
  lines.push("global options:");
  lines.push(...renderOptionsHelp(GLOBAL_OPTIONS));
  lines.push("", `${CLI_NAME} <command> --help shows the command's options.`);
  return lines;
}

export function renderCommandHelp(command: CommandDefinition): string[] {
  const lines = [`usage: ${CLI_NAME} ${command.name} ${command.usage}`.trimEnd(), "", command.summary];
  if (command.run === undefined) lines.push("", "This command is not part of this build (it arrives with the Phase C CLI work).");
  const options: OptionSpecs = { ...(command.options ?? {}), ...GLOBAL_OPTIONS };
  lines.push("", "options:", ...renderOptionsHelp(options));
  return lines;
}

/** Splits argv into the command word and the rest; leading global flags (`--json`, `--root x`) are kept. */
function splitCommand(argv: readonly string[]): { command: string | null; rest: string[] } {
  const valueOptions = new Set(Object.entries(GLOBAL_OPTIONS).filter(([, spec]) => spec.type !== "boolean").map(([name]) => `--${name}`));
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token.startsWith("-")) {
      if (valueOptions.has(token)) index += 1;
      continue;
    }
    return { command: token, rest: [...argv.slice(0, index), ...argv.slice(index + 1)] };
  }
  return { command: null, rest: [...argv] };
}

export async function runCli(argv: readonly string[], options: RunCliOptions = {}): Promise<number> {
  const streams = options.streams ?? processStreams;
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const packageRoot = options.packageRoot === undefined ? findPackageRoot() : options.packageRoot;
  const version = readPackageVersion(packageRoot);
  const debug = env.HARNESS_MEMORY_DEBUG === "1";

  const { command: commandName, rest } = splitCommand(argv);
  const globalArgs = parseArgs(rest, GLOBAL_OPTIONS);
  const json = flagBoolean(globalArgs, "json");

  if (argv.includes("--version") || argv.includes("-v")) {
    streams.stdout(`${version}\n`);
    return EXIT_CODES.ok;
  }
  if (commandName === null) {
    streams.stdout(`${renderHelp(version).join("\n")}\n`);
    return argv.length === 0 || flagBoolean(globalArgs, "help") ? EXIT_CODES.ok : EXIT_USAGE;
  }

  const command = findCommand(commandName);
  if (command === null) {
    streams.stderr(`error: unknown command '${commandName}'\n`);
    streams.stderr(`run '${CLI_NAME} --help' for the list of commands\n`);
    return EXIT_USAGE;
  }

  const specs: OptionSpecs = { ...(command.options ?? {}), ...GLOBAL_OPTIONS };
  const args = parseArgs(rest, specs);
  if (flagBoolean(args, "help")) {
    streams.stdout(`${renderCommandHelp(command).join("\n")}\n`);
    return EXIT_CODES.ok;
  }
  if (command.run === undefined) {
    streams.stderr(`${CLI_NAME} ${command.name}: not in this build — this command ships with the Phase C CLI work (docs/redesign/implementation-plan.md §5).\n`);
    return EXIT_USAGE;
  }
  if (args.unknown.length > 0 || args.invalid.length > 0) {
    for (const option of args.unknown) streams.stderr(`error: unknown option ${option}\n`);
    for (const option of args.invalid) streams.stderr(`error: invalid value for ${option}\n`);
    streams.stderr(`${renderCommandHelp(command).join("\n")}\n`);
    return EXIT_USAGE;
  }

  const printer = new Printer(streams, json);
  const isTTY = options.isTTY ?? (process.stdin.isTTY === true && process.stdout.isTTY === true);
  let paths;
  try {
    paths = resolveCliPaths({ cwd, root: flagString(args, "root"), db: flagString(args, "db") });
  } catch (error) {
    printer.error(describeFailure(error, debug).message);
    return EXIT_CODES.error;
  }
  const clock = options.clock ?? (() => new Date().toISOString());
  const seams = options.seams ?? {};
  const ctx: CommandContext = {
    name: command.name,
    args,
    cwd,
    env,
    platform: options.platform ?? process.platform,
    execPath: options.execPath ?? stableExecPath(),
    json,
    out: printer,
    stderr: streams.stderr,
    isTTY,
    confirm: options.confirm ?? (isTTY ? ttyConfirm() : async () => false),
    clock,
    nowMs: seams.nowMs ?? (() => Date.now()),
    seams,
    paths,
    config: loadConfig(paths.config),
    packageRoot,
    version,
    debug,
  };

  try {
    return await command.run(ctx);
  } catch (error) {
    const failure = describeFailure(error, debug);
    printer.error(failure.message);
    if (failure.hint !== null) printer.note(`hint: ${failure.hint}`);
    return failure.exitCode;
  }
}
