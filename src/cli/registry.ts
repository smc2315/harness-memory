/**
 * The 33 commands of spec §11, grouped as the spec lists them. Commands this build does not ship
 * (Phase C) stay registered so `hm <name>` explains itself and exits 2 instead of "unknown command".
 * Phase C adds an implementation by filling `run` in `COMMAND_RUNNERS` (one module per command under
 * `src/cli/commands/`).
 */

import type { OptionSpecs } from "./lib/args";
import type { CommandRunner } from "./context";
import { dbMigrateOptions, runDbMigrate } from "./commands/db-migrate";
import { dbRollbackOptions, runDbRollback } from "./commands/db-rollback";
import { doctorOptions, runDoctor } from "./commands/doctor";
import { installOptions, runInstall } from "./commands/install";
import { runSnapshotRebuild, snapshotRebuildOptions } from "./commands/snapshot-rebuild";
import { runStatus, statusOptions } from "./commands/status";
import { runUninstall, uninstallOptions } from "./commands/uninstall";

export type CommandGroup = "install" | "status" | "review" | "memory" | "pipeline" | "import" | "eval";

export interface CommandDefinition {
  name: string;
  group: CommandGroup;
  summary: string;
  /** Arguments after the command word, for `--help`. */
  usage: string;
  options?: OptionSpecs;
  run?: CommandRunner;
}

export const COMMAND_GROUP_TITLES: Readonly<Record<CommandGroup, string>> = {
  install: "Install",
  status: "Status",
  review: "Review",
  memory: "Memory",
  pipeline: "Pipeline",
  import: "Import",
  eval: "Evaluation",
};

export const COMMANDS: readonly CommandDefinition[] = [
  // install
  { name: "install", group: "install", summary: "Register the hooks, migrate the database, build the snapshot", usage: "--host claude [--user] [--with-embeddings]", options: installOptions, run: runInstall },
  { name: "uninstall", group: "install", summary: "Remove the registered hooks (manifest entries); --purge also deletes .harness-memory/", usage: "[--purge]", options: uninstallOptions, run: runUninstall },
  { name: "doctor", group: "install", summary: "Cross-check install, hooks log, queue, locks, database and snapshot", usage: "[--fix] [--host-debug <path>]", options: doctorOptions, run: runDoctor },
  { name: "db:migrate", group: "install", summary: "Apply pending schema migrations (backup first) and rebuild the snapshot", usage: "", options: dbMigrateOptions, run: runDbMigrate },
  { name: "db:rollback", group: "install", summary: "Restore memory.sqlite.bak-v<N> after confirmation", usage: "[--to <version>] [--yes]", options: dbRollbackOptions, run: runDbRollback },
  { name: "snapshot:rebuild", group: "install", summary: "Rebuild snapshot/*.v1.* from the database", usage: "", options: snapshotRebuildOptions, run: runSnapshotRebuild },
  // status
  { name: "status", group: "status", summary: "One-line health summary", usage: "", options: statusOptions, run: runStatus },
  // review
  { name: "review", group: "review", summary: "Interactive review of proposals, candidates and unconfirmed imports", usage: "[--json] [--accept-all-kind <kind>]" },
  { name: "proposals:list", group: "review", summary: "List open proposals", usage: "[--kind <kind>]" },
  { name: "proposals:accept", group: "review", summary: "Accept a proposal", usage: "<id> | --kind <kind> --all" },
  { name: "proposals:reject", group: "review", summary: "Reject a proposal", usage: "<id>" },
  // memory
  { name: "memory:list", group: "memory", summary: "List memories", usage: "[--status <s>] [--type <t>]" },
  { name: "memory:show", group: "memory", summary: "Show one memory", usage: "<id>" },
  { name: "memory:add", group: "memory", summary: "Add a human memory", usage: "--type <t> --summary <text> [--scope <glob>]" },
  { name: "memory:promote", group: "memory", summary: "Promote a candidate to active (human)", usage: "<id>" },
  { name: "memory:demote", group: "memory", summary: "Demote an active memory to candidate", usage: "<id>" },
  { name: "memory:reject", group: "memory", summary: "Reject a memory", usage: "<id> [--note <text>]" },
  { name: "memory:restore", group: "memory", summary: "Restore a rejected/stale memory", usage: "<id>" },
  { name: "memory:enforce", group: "memory", summary: "Set the enforcement level of a memory", usage: "<id> <advise|confirm|soft_deny|deny>" },
  { name: "memory:history", group: "memory", summary: "Transitions, provenance and legacy dream history of a memory", usage: "<id>" },
  { name: "memory:export", group: "memory", summary: "Deterministic SQL dump of the database", usage: "[--out <file>]" },
  { name: "memory:export-skill", group: "memory", summary: "Export mature memories as SKILL.md files", usage: "[--out <dir>]" },
  { name: "memory:stats", group: "memory", summary: "Counts, review load and recent auto activations", usage: "[--since <iso>]" },
  { name: "memory:why", group: "memory", summary: "Explain what would fire for a tool call", usage: "--tool <name> --target <text>" },
  { name: "memory:trace", group: "memory", summary: "Episodes and runs behind a memory", usage: "<id>" },
  // pipeline
  { name: "queue", group: "pipeline", summary: "Inspect or edit the extraction queue", usage: "[list|show <id>|retry <id>|drop <id>]" },
  { name: "extract", group: "pipeline", summary: "Run the extraction worker now", usage: "[--now] [--provider <name>] [--dry-run]" },
  { name: "dream", group: "pipeline", summary: "Run consolidation now", usage: "" },
  { name: "trace", group: "pipeline", summary: "Ledger timeline of a session", usage: "<session_key>" },
  // import
  { name: "import", group: "import", summary: "Import bullets from a file as human memories", usage: "[--from <file>] [--yes] [--sync]" },
  // eval
  { name: "eval:latency", group: "eval", summary: "Hook latency against a 300-memory fixture", usage: "[--local]" },
  { name: "eval:replay", group: "eval", summary: "Replay the recorded extraction fixtures", usage: "" },
  { name: "eval:live", group: "eval", summary: "Live extraction evaluation (later release)", usage: "" },
];

export function findCommand(name: string): CommandDefinition | null {
  return COMMANDS.find((command) => command.name === name) ?? null;
}

export function implementedCommands(): CommandDefinition[] {
  return COMMANDS.filter((command) => command.run !== undefined);
}
