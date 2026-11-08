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
import { evalLatencyOptions, runEvalLatency } from "./commands/eval-latency";
import { evalReplayOptions, runEvalReplay } from "./commands/eval-replay";
import { dreamOptions, extractOptions, runDream, runExtract } from "./commands/extract";
import { importOptions, runImport } from "./commands/import";
import { installOptions, runInstall } from "./commands/install";
import { memoryAddOptions, runMemoryAdd } from "./commands/memory-add";
import { memoryExportOptions, memoryExportSkillOptions, runMemoryExport, runMemoryExportSkill } from "./commands/memory-export";
import { memoryHistoryOptions, memoryTraceOptions, runMemoryHistory, runMemoryTrace } from "./commands/memory-history";
import { memoryListOptions, runMemoryList } from "./commands/memory-list";
import { memoryShowOptions, runMemoryShow } from "./commands/memory-show";
import { memoryStatsOptions, runMemoryStats } from "./commands/memory-stats";
import {
  memoryDemoteOptions,
  memoryEnforceOptions,
  memoryPromoteOptions,
  memoryRejectOptions,
  memoryRestoreOptions,
  runMemoryDemote,
  runMemoryEnforce,
  runMemoryPromote,
  runMemoryReject,
  runMemoryRestore,
} from "./commands/memory-transitions";
import { memoryWhyOptions, runMemoryWhy } from "./commands/memory-why";
import { proposalsAcceptOptions, proposalsListOptions, proposalsRejectOptions, runProposalsAccept, runProposalsList, runProposalsReject } from "./commands/proposals";
import { queueOptions, runQueue } from "./commands/queue";
import { reviewOptions, runReview } from "./commands/review";
import { runSnapshotRebuild, snapshotRebuildOptions } from "./commands/snapshot-rebuild";
import { runStatus, statusOptions } from "./commands/status";
import { runTrace, traceOptions } from "./commands/trace";
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
  {
    name: "install",
    group: "install",
    summary: "Register the hooks, migrate the database, build the snapshot",
    usage: "--host claude [--user] [--with-embeddings] [--hook-form auto|exec|shell] [--hook-script <path>] [--skip-probe] [--skip-self-test]",
    options: installOptions,
    run: runInstall,
  },
  { name: "uninstall", group: "install", summary: "Remove the registered hooks (manifest entries); --purge also deletes .harness-memory/", usage: "[--purge] [--user]", options: uninstallOptions, run: runUninstall },
  { name: "doctor", group: "install", summary: "Cross-check install, hooks log, queue, locks, database and snapshot", usage: "[--fix] [--host-debug <path>] [--self-test] [--hook-script <path>]", options: doctorOptions, run: runDoctor },
  { name: "db:migrate", group: "install", summary: "Apply pending schema migrations (backup first) and rebuild the snapshot", usage: "", options: dbMigrateOptions, run: runDbMigrate },
  { name: "db:rollback", group: "install", summary: "Restore memory.sqlite.bak-v<N> after confirmation", usage: "[--to <version>] [--yes]", options: dbRollbackOptions, run: runDbRollback },
  { name: "snapshot:rebuild", group: "install", summary: "Rebuild snapshot/*.v1.* from the database", usage: "", options: snapshotRebuildOptions, run: runSnapshotRebuild },
  // status
  { name: "status", group: "status", summary: "One-line health summary", usage: "", options: statusOptions, run: runStatus },
  // review
  { name: "review", group: "review", summary: "Interactive review of proposals, candidates and unconfirmed imports", usage: "[--json] [--list] [--accept-all-kind <kind>] [--keys a,r,s]", options: reviewOptions, run: runReview },
  { name: "proposals:list", group: "review", summary: "List open proposals", usage: "[--kind <kind>] [--all]", options: proposalsListOptions, run: runProposalsList },
  { name: "proposals:accept", group: "review", summary: "Accept a proposal", usage: "<id> | --kind <kind> --all [--note <text>]", options: proposalsAcceptOptions, run: runProposalsAccept },
  { name: "proposals:reject", group: "review", summary: "Reject a proposal", usage: "<id> [--note <text>]", options: proposalsRejectOptions, run: runProposalsReject },
  // memory
  {
    name: "memory:list",
    group: "memory",
    summary: "List memories",
    usage: "[--status <s>] [--type <t>] [--authority <a>] [--source <k>] [--scope <glob>] [--unconfirmed] [--contested] [--limit <n>]",
    options: memoryListOptions,
    run: runMemoryList,
  },
  { name: "memory:show", group: "memory", summary: "Show one memory", usage: "<id>", options: memoryShowOptions, run: runMemoryShow },
  {
    name: "memory:add",
    group: "memory",
    summary: "Add a human memory (candidate; --active promotes it)",
    usage:
      "--type <t> --summary <text> [--scope <glob>] [--details <text>] [--triggers <a,b>] [--signature <spec>] [--tools <a,b>] [--enforce <level>] [--aliases <a,b>] [--policy-subtype <s>] [--confidence <n>] [--importance <n>] [--active]",
    options: memoryAddOptions,
    run: runMemoryAdd,
  },
  { name: "memory:promote", group: "memory", summary: "Promote a candidate or stale memory to active (human)", usage: "<id>", options: memoryPromoteOptions, run: runMemoryPromote },
  { name: "memory:demote", group: "memory", summary: "Demote an active memory to stale (human)", usage: "<id>", options: memoryDemoteOptions, run: runMemoryDemote },
  { name: "memory:reject", group: "memory", summary: "Reject a candidate memory", usage: "<id> [--note <text>]", options: memoryRejectOptions, run: runMemoryReject },
  { name: "memory:restore", group: "memory", summary: "Restore a superseded or stale memory to active", usage: "<id>", options: memoryRestoreOptions, run: runMemoryRestore },
  { name: "memory:enforce", group: "memory", summary: "Set the enforcement level of a memory (makes it human)", usage: "<id> <advise|confirm|soft_deny|deny>", options: memoryEnforceOptions, run: runMemoryEnforce },
  { name: "memory:history", group: "memory", summary: "Transitions, provenance and legacy dream history of a memory", usage: "<id>", options: memoryHistoryOptions, run: runMemoryHistory },
  { name: "memory:export", group: "memory", summary: "Deterministic SQL dump of the database", usage: "[--out <file>]", options: memoryExportOptions, run: runMemoryExport },
  { name: "memory:export-skill", group: "memory", summary: "Export mature memories as SKILL.md files", usage: "[--out <dir>] [--min-confidence <n>] [--min-importance <n>]", options: memoryExportSkillOptions, run: runMemoryExportSkill },
  { name: "memory:stats", group: "memory", summary: "Counts, review load and recent auto activations", usage: "[--since <iso>]", options: memoryStatsOptions, run: runMemoryStats },
  {
    name: "memory:why",
    group: "memory",
    summary: "Explain what would fire for a tool call",
    usage: "--tool <name> --target <text> [--input <json>] [--session <key>] [--permission-mode <m>]",
    options: memoryWhyOptions,
    run: runMemoryWhy,
  },
  { name: "memory:trace", group: "memory", summary: "Episodes and runs behind a memory", usage: "<id>", options: memoryTraceOptions, run: runMemoryTrace },
  // pipeline
  { name: "queue", group: "pipeline", summary: "Inspect or edit the extraction queue", usage: "[list|show <id>|retry <id>|drop <id>]", options: queueOptions, run: runQueue },
  { name: "extract", group: "pipeline", summary: "Run the extraction worker now", usage: "[--now] [--provider <name>] [--dry-run]", options: extractOptions, run: runExtract },
  { name: "dream", group: "pipeline", summary: "Run consolidation now", usage: "[--provider <name>]", options: dreamOptions, run: runDream },
  { name: "trace", group: "pipeline", summary: "Ledger timeline of a session", usage: "<session_key> [--limit <n>] [--host <h>]", options: traceOptions, run: runTrace },
  // import
  { name: "import", group: "import", summary: "Import bullets from a file as human memories", usage: "[--from <file>] [--yes] [--sync] [--provider <name>] [--dry-run]", options: importOptions, run: runImport },
  // eval
  {
    name: "eval:latency",
    group: "eval",
    summary: "Hook latency against a 300-memory fixture",
    usage: "[--local] [--runs <n>] [--threshold <ms>] [--memories <n>] [--large] [--hook-script <path>]",
    options: evalLatencyOptions,
    run: runEvalLatency,
  },
  { name: "eval:replay", group: "eval", summary: "Replay the recorded extraction fixtures", usage: "[--scenario <ids>] [--fixtures <dir>] [--keep] [--verbose]", options: evalReplayOptions, run: runEvalReplay },
  { name: "eval:live", group: "eval", summary: "Live extraction evaluation (later release)", usage: "" },
];

export function findCommand(name: string): CommandDefinition | null {
  return COMMANDS.find((command) => command.name === name) ?? null;
}

export function implementedCommands(): CommandDefinition[] {
  return COMMANDS.filter((command) => command.run !== undefined);
}
