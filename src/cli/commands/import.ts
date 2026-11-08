/**
 * `hm import [--from <file>] [--yes] [--sync] [--provider <name>] [--dry-run]` (spec §11, §5.6 import mode, §7.1).
 *
 * bullets → import episodes (host `import`, close_reason `import`, ledger_ref `import:<path>#L<n>`, tools [],
 * prompt_text = bullet) → queue → the Phase B extraction pipeline in import mode (`action = create` only; the
 * validator requires signature patterns to be quoted in the bullet) → rows `active`, `authority='human'`,
 * `source_kind='import'`, `source_ref='import:<file>#L<n>'`, `import_unconfirmed=1`, enforcement advise →
 * the result table. On a TTY the table is confirmed (import_unconfirmed cleared, enforcement recomputed,
 * near-identical older rows superseded by actor `import`); `--yes` keeps the rows unconfirmed (enforcement ≤
 * advise, they appear in `hm review`) and only opens `supersede` proposals for near-identical rows. `--sync`
 * stales the live rows of this file whose bullets disappeared (transitionMemory, actor `import`). Re-runs are
 * idempotent: the episode id is derived from the bullet hash, the run id from the episode id.
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Database as SqlJsDatabase } from "sql.js";

import type { HarnessConfig } from "../../core/config";
import type { EpisodeDescriptor } from "../../core/episode-types";
import { EXIT_CODES } from "../../core/errors";
import type { FactOutcome } from "../../core/extraction-types";
import { extractionRunId } from "../../core/ids";
import { EpisodeRepository } from "../../db/repositories/episodes";
import { ProvenanceRepository } from "../../db/repositories/provenance";
import { ExtractionRunRepository } from "../../db/repositories/runs";
import type { WorkerResult } from "../../dream/worker";
import { MemoryRepository, type MemoryRecord } from "../../memory/repository";
import { transitionMemory } from "../../promotion/transitions";
import type { CommandContext } from "../context";
import { flagBoolean, flagString, type OptionSpecs } from "../lib/args";
import { CliInputError, guard, usageError } from "../lib/cli-error";
import { readDb, requireDatabase, writeDb } from "../lib/db-access";
import { buildImportDescriptor, importSourcePath, importSourceRefPrefix, parseImportBullets, type ImportBullet } from "../lib/import-file";
import { shortId } from "../lib/lookup";
import { confirmImportRow, proposeImportUpgrades } from "../lib/memory-actions";
import { clip, memoryToJson, type MemoryJson } from "../lib/memory-render";
import { pluralize, renderTable } from "../lib/output";
import { renderWorkerResult, resolveCliProvider, runCliWorker } from "../lib/worker-run";

export const importOptions: OptionSpecs = {
  from: { type: "string", description: "File to import (default: CLAUDE.md in the project root)", placeholder: "<file>" },
  yes: { type: "boolean", description: "Skip the confirmation table: rows stay import_unconfirmed=1 with enforcement advise (review later)", alias: "y" },
  sync: { type: "boolean", description: "Stale the live rows of this file whose bullets disappeared" },
  provider: { type: "string", description: "Extraction provider for this run (claude | codex | replay)", placeholder: "<name>" },
  "dry-run": { type: "boolean", description: "List the bullets that would be imported; nothing is written" },
};

export const IMPORT_DEFAULT_FILES = ["CLAUDE.md", "AGENTS.md"] as const;
/** Episodes leased per worker loop (worker LEASE_BATCH). */
const LEASE_BATCH = 3;

export interface ImportRowReport {
  line: number;
  text: string;
  episode_id: string;
  episode_status: string | null;
  run_status: string | null;
  outcomes: FactOutcome[];
  memories: MemoryJson[];
}

export interface ImportReport {
  file: string;
  source_path: string;
  bullets: number;
  skipped_lines: number;
  provider: string;
  dry_run: boolean;
  worker: { busy: boolean; processed: number; waiting: { count: number; reason: string } | null; errors: string[] } | null;
  rows: ImportRowReport[];
  created: string[];
  reinforced: string[];
  confirmed: string[];
  unconfirmed: string[];
  upgrade_proposals: string[];
  superseded: string[];
  synced_stale: string[];
  confirmation: "confirmed" | "declined" | "unconfirmed" | "not_asked";
}

function resolveImportFile(ctx: CommandContext): string {
  const explicit = flagString(ctx.args, "from") ?? ctx.args.positionals[0] ?? null;
  if (explicit !== null) {
    const file = resolve(ctx.cwd, explicit);
    if (!existsSync(file)) throw new CliInputError(`import file not found: ${file}`);
    return file;
  }
  for (const name of IMPORT_DEFAULT_FILES) {
    const candidate = join(ctx.paths.root, name);
    if (existsSync(candidate)) return candidate;
  }
  throw usageError("no file to import", `pass --from <file>; none of ${IMPORT_DEFAULT_FILES.join(", ")} exists in ${ctx.paths.root}`);
}

/** The extraction cap exists to bound automatic extraction; an explicit import is a deliberate run. */
export function importRunConfig(config: HarnessConfig): HarnessConfig {
  return { ...config, extraction: { ...config.extraction, max_runs_per_day: Number.MAX_SAFE_INTEGER } };
}

function outcomesByEpisode(db: SqlJsDatabase, descriptors: readonly EpisodeDescriptor[]): Map<string, { episodeStatus: string | null; runStatus: string | null; outcomes: FactOutcome[] }> {
  const episodes = new EpisodeRepository(db);
  const runs = new ExtractionRunRepository(db);
  const result = new Map<string, { episodeStatus: string | null; runStatus: string | null; outcomes: FactOutcome[] }>();
  for (const descriptor of descriptors) {
    const episode = episodes.getById(descriptor.id);
    const run = runs.getById(extractionRunId(descriptor.id)) ?? runs.listForEpisode(descriptor.id)[0] ?? null;
    result.set(descriptor.id, { episodeStatus: episode?.status ?? null, runStatus: run?.status ?? null, outcomes: run?.outcomes ?? [] });
  }
  return result;
}

const APPLIED_OUTCOMES = new Set(["created", "activated", "reinforced"]);

export function collectImportRows(db: SqlJsDatabase, descriptors: readonly EpisodeDescriptor[], bullets: readonly ImportBullet[]): { rows: ImportRowReport[]; created: MemoryRecord[]; reinforced: MemoryRecord[] } {
  const repository = new MemoryRepository(db);
  const byEpisode = outcomesByEpisode(db, descriptors);
  const created = new Map<string, MemoryRecord>();
  const reinforced = new Map<string, MemoryRecord>();
  const rows: ImportRowReport[] = descriptors.map((descriptor, index) => {
    const bullet = bullets[index]!;
    const entry = byEpisode.get(descriptor.id)!;
    const memories: MemoryJson[] = [];
    for (const outcome of entry.outcomes) {
      if (outcome.memory_id === undefined || !APPLIED_OUTCOMES.has(outcome.outcome)) continue;
      const memory = repository.getById(outcome.memory_id);
      if (memory === null) continue;
      memories.push(memoryToJson(memory));
      if (outcome.outcome === "reinforced") reinforced.set(memory.id, memory);
      else created.set(memory.id, memory);
    }
    return { line: bullet.line, text: bullet.text, episode_id: descriptor.id, episode_status: entry.episodeStatus, run_status: entry.runStatus, outcomes: entry.outcomes, memories };
  });
  return { rows, created: [...created.values()], reinforced: [...reinforced.values()] };
}

export function renderImportTable(rows: readonly ImportRowReport[]): string[] {
  const table: string[][] = [];
  for (const row of rows) {
    const applied = row.outcomes.filter((outcome) => outcome.memory_id !== undefined && APPLIED_OUTCOMES.has(outcome.outcome));
    const rejected = row.outcomes.filter((outcome) => outcome.outcome === "rejected" || outcome.outcome === "skipped");
    if (applied.length === 0 && rejected.length === 0) {
      table.push([`L${String(row.line)}`, row.run_status ?? row.episode_status ?? "pending", "-", "-", "-", clip(row.text, 70)]);
      continue;
    }
    for (const outcome of applied) {
      const memory = row.memories.find((entry) => entry.id === outcome.memory_id);
      table.push([
        `L${String(row.line)}`,
        outcome.outcome === "reinforced" ? "reinforced" : "imported",
        shortId(outcome.memory_id),
        memory === undefined ? "-" : `${memory.type} ${memory.enforcement}${memory.importUnconfirmed === 1 ? " (unconfirmed)" : ""}`,
        memory === undefined ? "-" : clip(memory.scopeGlob, 20),
        memory === undefined ? clip(row.text, 70) : clip(memory.summary, 70),
      ]);
    }
    for (const outcome of rejected) {
      table.push([`L${String(row.line)}`, `${outcome.outcome}(${outcome.rejection ?? outcome.detail ?? "-"})`, "-", "-", "-", clip(row.text, 70)]);
    }
  }
  return renderTable(table, ["LINE", "RESULT", "MEMORY", "TYPE / ENF", "SCOPE", "SUMMARY"]);
}

export function renderImportReport(report: ImportReport, options: { includeTable?: boolean } = {}): string[] {
  const lines = [`import ${report.source_path}: ${pluralize(report.bullets, "bullet")}${report.skipped_lines > 0 ? ` (${String(report.skipped_lines)} non-bullet lines skipped)` : ""}`];
  if (report.dry_run) {
    lines.push(...renderTable(report.rows.map((row) => [`L${String(row.line)}`, shortId(row.episode_id), clip(row.text, 90)]), ["LINE", "EPISODE", "BULLET"]));
    lines.push("dry run: nothing written");
    return lines;
  }
  if (report.worker !== null && report.worker.busy) {
    lines.push("another worker holds worker.lock; the bullets are queued and will be imported as unconfirmed rows — run `hm review` afterwards");
    return lines;
  }
  if (report.rows.length > 0 && options.includeTable !== false) lines.push(...renderImportTable(report.rows));
  if (report.worker?.waiting) lines.push(`waiting: ${pluralize(report.worker.waiting.count, "episode")} (${report.worker.waiting.reason}) — rows appear once the provider is available`);
  for (const error of report.worker?.errors ?? []) lines.push(`error: ${error}`);
  switch (report.confirmation) {
    case "confirmed":
      lines.push(`confirmed ${pluralize(report.confirmed.length, "memory", "memories")}${report.superseded.length > 0 ? `; superseded ${report.superseded.map(shortId).join(", ")}` : ""}`);
      break;
    case "declined":
      lines.push(`left ${pluralize(report.unconfirmed.length, "row")} unconfirmed (enforcement advise); decide per row with \`hm review\``);
      break;
    case "unconfirmed":
      lines.push(`imported ${pluralize(report.unconfirmed.length, "row")} unconfirmed (import_unconfirmed=1, enforcement advise); confirm with \`hm review\`${report.upgrade_proposals.length > 0 ? `; opened ${pluralize(report.upgrade_proposals.length, "supersede proposal")} for near-identical rows` : ""}`);
      break;
    case "not_asked":
      break;
  }
  if (report.synced_stale.length > 0) lines.push(`sync: staled ${pluralize(report.synced_stale.length, "row")} whose bullets disappeared: ${report.synced_stale.map(shortId).join(", ")}`);
  return lines;
}

/** Live import rows of this file whose bullets are gone (no import provenance from a current bullet) → stale(import_sync). */
export function syncRemovedBullets(db: SqlJsDatabase, sourcePath: string, currentHashes: ReadonlySet<string>, now: string): string[] {
  const repository = new MemoryRepository(db, { clock: () => now });
  const episodes = new EpisodeRepository(db);
  const provenance = new ProvenanceRepository(db);
  const prefix = importSourceRefPrefix(sourcePath);
  const staled: string[] = [];
  for (const memory of repository.list({ status: "active", sourceKind: "import" })) {
    if (memory.sourceRef === null || !memory.sourceRef.startsWith(prefix)) continue;
    const backed = provenance
      .listForMemory(memory.id)
      .filter((row) => row.relation === "import")
      .some((row) => {
        const episode = episodes.getById(row.episodeId);
        return episode !== null && currentHashes.has(episode.turnKey);
      });
    if (backed) continue;
    transitionMemory(db, { memoryId: memory.id, to: "stale", actor: "import", reason: "import:removed", now, statusReason: "import_sync" });
    staled.push(memory.id);
  }
  return staled;
}

export async function runImport(ctx: CommandContext): Promise<number> {
  return guard(ctx, async () => {
    const file = resolveImportFile(ctx);
    const yes = flagBoolean(ctx.args, "yes");
    const sync = flagBoolean(ctx.args, "sync");
    const dryRun = flagBoolean(ctx.args, "dry-run");
    const sourcePath = importSourcePath(ctx.paths.root, file);
    const parsed = parseImportBullets(readFileSync(file, "utf8"));
    const now = ctx.clock();
    const descriptors = parsed.bullets.map((bullet) => buildImportDescriptor({ sourcePath, bullet, now, root: ctx.paths.root }));
    const resolved = dryRun ? null : resolveCliProvider(ctx, flagString(ctx.args, "provider"));

    const report: ImportReport = {
      file,
      source_path: sourcePath,
      bullets: parsed.bullets.length,
      skipped_lines: parsed.skippedLines,
      provider: resolved?.name ?? "none",
      dry_run: dryRun,
      worker: null,
      rows: descriptors.map((descriptor, index) => ({ line: parsed.bullets[index]!.line, text: parsed.bullets[index]!.text, episode_id: descriptor.id, episode_status: null, run_status: null, outcomes: [], memories: [] })),
      created: [],
      reinforced: [],
      confirmed: [],
      unconfirmed: [],
      upgrade_proposals: [],
      superseded: [],
      synced_stale: [],
      confirmation: "not_asked",
    };

    if (dryRun) {
      ctx.out.result(report, renderImportReport);
      return EXIT_CODES.ok;
    }
    if (!yes && !ctx.isTTY) {
      throw usageError("import needs a terminal to confirm the result table", "pass --yes to import unconfirmed rows (import_unconfirmed=1, enforcement advise; confirm later with `hm review`)");
    }
    requireDatabase(ctx);

    let worker: WorkerResult | null = null;
    if (descriptors.length > 0) {
      const descriptorFile = join(ctx.paths.dir, `import-${String(process.pid)}-${Date.now().toString(36)}.json`);
      writeFileSync(descriptorFile, JSON.stringify(descriptors), "utf8");
      try {
        worker = await runCliWorker(ctx, {
          command: "import",
          args: [descriptorFile],
          provider: resolved?.provider ?? null,
          config: importRunConfig(ctx.config),
          maxLoops: Math.ceil(descriptors.length / LEASE_BATCH) + 2,
        });
      } finally {
        rmSync(descriptorFile, { force: true });
      }
      report.worker = { busy: worker.busy, processed: worker.processed.length, waiting: worker.waiting, errors: worker.errors };
      if (ctx.debug) for (const line of renderWorkerResult(worker, report.provider)) ctx.out.note(line);
      if (worker.busy) {
        ctx.out.result(report, renderImportReport);
        return EXIT_CODES.ok;
      }
    }

    const collected = await readDb(ctx, (db) => collectImportRows(db, descriptors, parsed.bullets));
    report.rows = collected.rows;
    report.created = collected.created.map((memory) => memory.id);
    report.reinforced = collected.reinforced.map((memory) => memory.id);
    const pending = collected.created.filter((memory) => memory.importUnconfirmed === 1);
    let tablePrinted = false;

    if (pending.length > 0) {
      if (yes) {
        report.unconfirmed = pending.map((memory) => memory.id);
        report.confirmation = "unconfirmed";
        const { value } = await writeDb(
          ctx,
          { purpose: "import:propose", kind: "import:propose", subject: sourcePath },
          (db, write) => pending.flatMap((memory) => proposeImportUpgrades(db, memory, { config: ctx.config, now: write.now })),
          (ids) => ids.length === 0
        );
        report.upgrade_proposals = value;
      } else {
        for (const line of renderImportTable(report.rows)) ctx.out.line(line);
        tablePrinted = true;
        const accepted = await ctx.confirm(`Confirm ${pluralize(pending.length, "imported memory", "imported memories")} (clears import_unconfirmed, recomputes enforcement)?`);
        if (accepted) {
          const { value } = await writeDb(ctx, { purpose: "import:confirm", kind: "import:confirm", subject: sourcePath }, (db, write) => {
            const repository = new MemoryRepository(db, { clock: () => write.now });
            const confirmed: string[] = [];
            const superseded: string[] = [];
            for (const memory of pending) {
              const current = repository.getById(memory.id);
              if (current === null) continue;
              const result = confirmImportRow(db, current, { config: ctx.config, now: write.now });
              confirmed.push(result.memory.id);
              superseded.push(...result.superseded);
            }
            return { confirmed, superseded };
          });
          report.confirmed = value.confirmed;
          report.superseded = value.superseded;
          report.confirmation = "confirmed";
        } else {
          report.unconfirmed = pending.map((memory) => memory.id);
          report.confirmation = "declined";
        }
      }
    }

    if (sync) {
      const hashes = new Set(parsed.bullets.map((bullet) => bullet.hash));
      const { value } = await writeDb(
        ctx,
        { purpose: "import:sync", kind: "import:sync", subject: sourcePath },
        (db, write) => syncRemovedBullets(db, sourcePath, hashes, write.now),
        (ids) => ids.length === 0
      );
      report.synced_stale = value;
    }

    // In the interactive path the table was already printed before the confirmation prompt.
    ctx.out.result(report, (value) => renderImportReport(value, { includeTable: !tablePrinted }));
    return EXIT_CODES.ok;
  });
}
