/**
 * `hm import [--from <file>|auto-memory] [--auto-memory] [--include-project] [--memory-dir <dir>] [--yes] [--sync]
 * [--provider <name>] [--dry-run]` (spec §11, §5.6 import mode, §7.1; phase F A′ §4 adds Claude Code's auto memory
 * and the login-optional path).
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
 *
 * Login-optional (A′ §4 "imported rules enforce without the login"): a bullet the extractor could not type in this
 * run — no extraction CLI, `not_logged_in`, a failed probe — is imported **verbatim** instead of waiting in the
 * queue: a `policy` row with the bullet text as its summary (redacted, scanned, ≤ 160 chars; the rest in details),
 * global scope, trigger `before_model`, enforcement advise, `import_unconfirmed = 1`, the same `source_ref`, import
 * provenance to the bullet's episode (so `--sync` sees it) and the episode parked as `skipped` with reason
 * `import_verbatim`. It goes through the same confirmation table / `--yes` proposals as an extracted row. When
 * `hm import` later runs with a provider configured, the parked episodes are requeued first; a bullet the extractor
 * then types has its verbatim row superseded by the typed row (actor `import`, reason `import:retyped`), a bullet
 * still waiting is parked again — the detached worker never sees a verbatim episode, so no duplicate rows arise.
 *
 * Auto memory (`--from auto-memory`, `--auto-memory`, `--memory-dir <dir>`, or `--from <memory directory>` for a
 * directory that holds a MEMORY.md or typed notes): the project's `~/.claude/projects/<slug>/memory/*.md` notes —
 * type `feedback`, plus `project` with --include-project — are read by src/cli/lib/auto-memory.ts; each note's
 * body becomes bullets (its rule bullets, else its `**How to apply:**` paragraph, else its first paragraph, else
 * its description; see that module) and every bullet goes through the very same pipeline with `sourcePath =
 * auto-memory:<topic file>`, so `ledger_ref` / `source_ref` read `import:auto-memory:<topic file>#L<n>`: the
 * `auto-memory:` marker tells these human rows apart from CLAUDE.md imports while `source_kind` stays `import`.
 * `--sync` then works against the whole directory (`import:auto-memory:<dir>/`): a live row whose bullet is in no
 * current note — edited away or its file deleted — is staled; rows of a file that is present but was not parsed
 * (over the size cap, unreadable) are left alone. MEMORY.md is never imported through this source: Claude Code
 * loads it itself every session. Topic files are not host-loaded, so their rows are injected at session_start /
 * before_model and enforce at before_tool like any other import; a plain `--from <…>/memory/MEMORY.md` import is
 * skipped at session_start / before_model only once `isHostLoadedFile` (src/activation/injection.ts, requested)
 * recognises that path. Nothing under `~/.claude/` is ever written.
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { Database as SqlJsDatabase } from "sql.js";

import type { HarnessConfig } from "../../core/config";
import type { EpisodeDescriptor } from "../../core/episode-types";
import { EXIT_CODES } from "../../core/errors";
import { EXTRACTION_LIMITS, type FactOutcome } from "../../core/extraction-types";
import { extractionRunId } from "../../core/ids";
import { redactCredentials } from "../../core/signals";
import { EpisodeRepository } from "../../db/repositories/episodes";
import { ProvenanceRepository, recomputeDerived } from "../../db/repositories/provenance";
import { ExtractionRunRepository } from "../../db/repositories/runs";
import { TYPE_IMPORTANCE } from "../../dream/reconcile";
import type { WorkerResult } from "../../dream/worker";
import { DuplicateMemoryContentError, MemoryRepository, type CreateMemoryInput, type MemoryRecord } from "../../memory/repository";
import { enforcementDefault } from "../../promotion/authority";
import { transitionMemory } from "../../promotion/transitions";
import { scanMemoryContent } from "../../security/scanner";
import type { CommandContext } from "../context";
import { flagBoolean, flagString, type OptionSpecs } from "../lib/args";
import {
  AUTO_MEMORY_DEFAULT_TYPES,
  AUTO_MEMORY_SOURCE,
  autoMemorySyncPrefix,
  canonicalDirectory,
  clipText,
  isDirectory,
  locateAutoMemory,
  looksLikeAutoMemoryDirectory,
  noteContextRef,
  planAutoMemoryImport,
  type AutoMemoryBulletMode,
  type AutoMemoryLocated,
} from "../lib/auto-memory";
import { CliInputError, guard, usageError } from "../lib/cli-error";
import { readDb, requireDatabase, writeDb } from "../lib/db-access";
import { buildImportDescriptor, importSourcePath, importSourceRefPrefix, parseImportBullets, type ImportBullet } from "../lib/import-file";
import { shortId } from "../lib/lookup";
import { confirmImportRow, proposeImportUpgrades } from "../lib/memory-actions";
import { clip, memoryToJson, type MemoryJson } from "../lib/memory-render";
import { pluralize, renderTable } from "../lib/output";
import { renderWorkerResult, resolveCliProvider, runCliWorker } from "../lib/worker-run";
import { defaultTriggers } from "./memory-add";

export const importOptions: OptionSpecs = {
  from: { type: "string", description: "File to import (default: CLAUDE.md in the project root); `auto-memory` or a memory directory imports Claude Code's auto memory notes", placeholder: "<file>|auto-memory" },
  "auto-memory": { type: "boolean", description: "Import this project's Claude Code auto memory notes (~/.claude/projects/<slug>/memory/*.md, type feedback)" },
  "include-project": { type: "boolean", description: "With auto-memory: also import notes of type project" },
  "memory-dir": { type: "string", description: "With auto-memory: read this memory directory instead of the one derived from the project path", placeholder: "<dir>" },
  yes: { type: "boolean", description: "Skip the confirmation table: rows stay import_unconfirmed=1 with enforcement advise (review later)", alias: "y" },
  sync: { type: "boolean", description: "Stale the live rows of this file (or memory directory) whose bullets disappeared" },
  provider: { type: "string", description: "Extraction provider for this run (claude | codex | replay)", placeholder: "<name>" },
  "dry-run": { type: "boolean", description: "List the bullets that would be imported; nothing is written" },
};

export const IMPORT_DEFAULT_FILES = ["CLAUDE.md", "AGENTS.md"] as const;
/** Episodes leased per worker loop (worker LEASE_BATCH). */
const LEASE_BATCH = 3;
/** `episodes.skip_reason` of a bullet imported verbatim (the extractor was unavailable); the worker never leases it. */
export const IMPORT_VERBATIM_SKIP_REASON = "import_verbatim";
/** Confidence of a verbatim row (the same a hand-added `hm memory:add` row gets). */
export const IMPORT_VERBATIM_CONFIDENCE = 0.9;

export type ImportSourceKind = "file" | typeof AUTO_MEMORY_SOURCE;

export interface ImportRowReport {
  line: number;
  text: string;
  /** auto-memory: the topic file this bullet came from (absolute path); null for a file import. */
  file: string | null;
  episode_id: string;
  episode_status: string | null;
  run_status: string | null;
  outcomes: FactOutcome[];
  memories: MemoryJson[];
  /** True when `memories` are verbatim rows (the bullet text itself, imported without the extractor). */
  verbatim: boolean;
}

/** One topic file of an auto-memory import, selected or skipped (with the reason). */
export interface ImportFileReport {
  path: string;
  name: string;
  type: string | null;
  selected: boolean;
  reason: string | null;
  bullets: number;
  skipped_lines: number;
  mode: AutoMemoryBulletMode | null;
  truncated: number;
}

export interface ImportReport {
  /** The import file, or the memory directory for auto-memory. */
  file: string;
  source_kind: ImportSourceKind;
  /** `CLAUDE.md`-style path for a file; `auto-memory:<dir>` for auto memory. */
  source_path: string;
  /** How the memory directory was found (auto-memory only). */
  located: AutoMemoryLocated | null;
  /** Topic files considered (auto-memory only). */
  files: ImportFileReport[] | null;
  bullets: number;
  skipped_lines: number;
  provider: string;
  dry_run: boolean;
  worker: { busy: boolean; processed: number; waiting: { count: number; reason: string } | null; errors: string[] } | null;
  rows: ImportRowReport[];
  created: string[];
  reinforced: string[];
  /** Rows created verbatim in this run (the extractor was unavailable). */
  verbatim: string[];
  /** Verbatim rows of earlier runs superseded in this run by the rows the extractor typed. */
  retyped: string[];
  confirmed: string[];
  unconfirmed: string[];
  upgrade_proposals: string[];
  superseded: string[];
  synced_stale: string[];
  confirmation: "confirmed" | "declined" | "unconfirmed" | "not_asked";
}

interface ImportSource {
  kind: ImportSourceKind;
  file: string;
  sourcePath: string;
  located: AutoMemoryLocated | null;
  files: ImportFileReport[] | null;
  bullets: ImportBullet[];
  /** Per bullet: the topic file it came from (auto-memory) or null. */
  rowFiles: Array<string | null>;
  descriptors: EpisodeDescriptor[];
  skippedLines: number;
  /** `source_ref` prefix of every row this source owns (`--sync`). */
  syncPrefix: string;
  /** Bullet hashes that keep a row alive under `--sync`. */
  syncHashes: ReadonlySet<string>;
  /** `source_ref` prefixes (`import:<sourcePath>#L`) whose rows `--sync` must not stale: files present but unparsed. */
  syncProtectedPrefixes: string[];
}

function resolveImportFile(ctx: CommandContext, explicit: string | null): string {
  if (explicit !== null) {
    const file = resolve(ctx.cwd, explicit);
    if (!existsSync(file)) throw new CliInputError(`import file not found: ${file}`);
    return file;
  }
  for (const name of IMPORT_DEFAULT_FILES) {
    const candidate = join(ctx.paths.root, name);
    if (existsSync(candidate)) return candidate;
  }
  throw usageError("no file to import", `pass --from <file> (or --from auto-memory for Claude Code's auto memory notes); none of ${IMPORT_DEFAULT_FILES.join(", ")} exists in ${ctx.paths.root}`);
}

function fileSource(ctx: CommandContext, file: string, now: string): ImportSource {
  const sourcePath = importSourcePath(ctx.paths.root, file);
  const parsed = parseImportBullets(readFileSync(file, "utf8"));
  return {
    kind: "file",
    file,
    sourcePath,
    located: null,
    files: null,
    bullets: parsed.bullets,
    rowFiles: parsed.bullets.map(() => null),
    descriptors: parsed.bullets.map((bullet) => buildImportDescriptor({ sourcePath, bullet, now, root: ctx.paths.root })),
    skippedLines: parsed.skippedLines,
    syncPrefix: importSourceRefPrefix(sourcePath),
    syncHashes: new Set(parsed.bullets.map((bullet) => bullet.hash)),
    syncProtectedPrefixes: [],
  };
}

/** `--memory-dir` / `--from <directory>` (canonicalised), else the directory derived from the project root (with the scan fallback). */
function resolveAutoMemoryDir(ctx: CommandContext, explicitDir: string | null): { dir: string; how: AutoMemoryLocated } {
  if (explicitDir !== null) {
    const dir = resolve(ctx.cwd, explicitDir);
    if (!isDirectory(dir)) throw new CliInputError(`auto-memory directory not found: ${dir}`);
    return { dir: canonicalDirectory(dir), how: "explicit" };
  }
  const lookup = locateAutoMemory(ctx.paths.root, { env: ctx.env, platform: ctx.platform });
  if (lookup.location === null) {
    const hint =
      lookup.candidates.length === 0
        ? `Claude Code keeps auto memory under ${join(lookup.projectsDir, "<project>", "memory")}; none has notes yet (the directory derived from this project is ${lookup.derived}). Pass --memory-dir <dir> to import another directory.`
        : `no memory directory matches this project (derived: ${lookup.derived}); directories with notes: ${lookup.candidates.join(", ")}. Pass --memory-dir <dir> to pick one.`;
    throw new CliInputError(`no auto memory found for ${ctx.paths.root}`, { hint });
  }
  return { dir: lookup.location.dir, how: lookup.location.how };
}

function autoMemorySource(ctx: CommandContext, explicitDir: string | null, now: string): ImportSource {
  const { dir, how } = resolveAutoMemoryDir(ctx, explicitDir);
  const types = flagBoolean(ctx.args, "include-project") ? [...AUTO_MEMORY_DEFAULT_TYPES, "project"] : AUTO_MEMORY_DEFAULT_TYPES;
  const plan = planAutoMemoryImport(dir, types);
  const bullets: ImportBullet[] = [];
  const rowFiles: Array<string | null> = [];
  const descriptors: EpisodeDescriptor[] = [];
  const files: ImportFileReport[] = [];
  let skippedLines = 0;
  for (const entry of plan.notes) {
    const contextRef = noteContextRef(entry.note);
    for (const bullet of entry.bullets) {
      bullets.push(bullet);
      rowFiles.push(entry.note.file);
      descriptors.push(buildImportDescriptor({ sourcePath: entry.note.sourcePath, bullet, now, root: ctx.paths.root, contextRef }));
    }
    skippedLines += entry.skippedLines;
    files.push({ path: entry.note.file, name: entry.note.name, type: entry.note.type, selected: true, reason: null, bullets: entry.bullets.length, skipped_lines: entry.skippedLines, mode: entry.mode, truncated: entry.truncated });
  }
  for (const skipped of plan.selection.skipped) {
    files.push({ path: skipped.note.file, name: skipped.note.name, type: skipped.note.type, selected: false, reason: skipped.reason, bullets: 0, skipped_lines: 0, mode: null, truncated: 0 });
  }
  for (const skipped of plan.listing.skipped) {
    files.push({ path: skipped.file, name: basename(skipped.file, ".md"), type: null, selected: false, reason: skipped.reason, bullets: 0, skipped_lines: 0, mode: null, truncated: 0 });
  }
  files.sort((left, right) => left.path.localeCompare(right.path));
  return {
    kind: AUTO_MEMORY_SOURCE,
    file: plan.dir,
    sourcePath: autoMemorySyncPrefix(plan.dir).slice("import:".length, -1),
    located: how,
    files,
    bullets,
    rowFiles,
    descriptors,
    skippedLines,
    syncPrefix: autoMemorySyncPrefix(plan.dir),
    syncHashes: plan.syncHashes,
    syncProtectedPrefixes: plan.protectedSourcePaths.map(importSourceRefPrefix),
  };
}

/**
 * Which source the flags name. Directory mode is entered by `--from auto-memory`, `--auto-memory` or `--memory-dir`;
 * `--from <directory>` is accepted only when the directory holds auto-memory notes (a MEMORY.md or a typed note), so
 * a mistyped path or `--from docs` is a usage error instead of a silent mode switch (review M-4).
 */
function resolveSource(ctx: CommandContext, now: string): ImportSource {
  const explicit = flagString(ctx.args, "from") ?? ctx.args.positionals[0] ?? null;
  const memoryDir = flagString(ctx.args, "memory-dir");
  const autoMemoryFlag = flagBoolean(ctx.args, "auto-memory");
  const explicitPath = explicit === null || explicit === AUTO_MEMORY_SOURCE ? null : resolve(ctx.cwd, explicit);
  if (explicitPath !== null && isDirectory(explicitPath)) {
    if (memoryDir !== null) {
      if (canonicalDirectory(resolve(ctx.cwd, memoryDir)) !== canonicalDirectory(explicitPath)) {
        throw usageError("--from <directory> and --memory-dir name different directories", "pass only one of them");
      }
    } else if (!looksLikeAutoMemoryDirectory(explicitPath)) {
      throw usageError(
        `--from ${explicit ?? ""} is a directory without auto-memory notes (no MEMORY.md, no .md note with a frontmatter type)`,
        "pass --from <file> for a Markdown file, or --memory-dir <dir> to read this directory as Claude Code auto memory anyway"
      );
    }
    return autoMemorySource(ctx, explicitPath, now);
  }
  const wantsAutoMemory = autoMemoryFlag || memoryDir !== null || explicit === AUTO_MEMORY_SOURCE;
  if (!wantsAutoMemory) return fileSource(ctx, resolveImportFile(ctx, explicit), now);
  if (explicitPath !== null) {
    throw usageError(`--from ${explicit ?? ""} names a file, but --auto-memory / --memory-dir asks for Claude Code's auto memory`, "drop one of them: `hm import --from <file>` or `hm import --from auto-memory [--memory-dir <dir>]`");
  }
  return autoMemorySource(ctx, memoryDir, now);
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
const LIVE_ROW_STATUSES = new Set(["candidate", "active", "stale"]);

/** Live rows a bullet's episode backs through verbatim import provenance (no extraction run). */
export function verbatimRowsOf(db: SqlJsDatabase, episodeId: string): MemoryRecord[] {
  const repository = new MemoryRepository(db);
  const rows: MemoryRecord[] = [];
  for (const record of new ProvenanceRepository(db).listForEpisode(episodeId)) {
    if (record.relation !== "import" || record.extractionRunId !== null) continue;
    const memory = repository.getById(record.memoryId);
    if (memory !== null && LIVE_ROW_STATUSES.has(memory.status) && !rows.some((row) => row.id === memory.id)) rows.push(memory);
  }
  return rows;
}

export function collectImportRows(
  db: SqlJsDatabase,
  descriptors: readonly EpisodeDescriptor[],
  bullets: readonly ImportBullet[],
  rowFiles: ReadonlyArray<string | null> = []
): { rows: ImportRowReport[]; created: MemoryRecord[]; reinforced: MemoryRecord[] } {
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
    let verbatim = false;
    if (memories.length === 0) {
      for (const memory of verbatimRowsOf(db, descriptor.id)) {
        verbatim = true;
        memories.push(memoryToJson(memory));
        if (memory.sourceRef === descriptor.ledger_ref) created.set(memory.id, memory);
        else reinforced.set(memory.id, memory);
      }
    }
    return { line: bullet.line, text: bullet.text, file: rowFiles[index] ?? null, episode_id: descriptor.id, episode_status: entry.episodeStatus, run_status: entry.runStatus, outcomes: entry.outcomes, memories, verbatim };
  });
  return { rows, created: [...created.values()], reinforced: [...reinforced.values()] };
}

// ---------------------------------------------------------------------------------------------
// Verbatim rows (login-optional path)
// ---------------------------------------------------------------------------------------------

export interface VerbatimImportResult {
  created: string[];
  /** Live rows that already held the bullet's text (same identity); they gained import provenance instead. */
  reinforced: string[];
  /** Bullets left queued for the extractor: too short for a summary, or rejected by the content scanner. */
  skipped: Array<{ episode_id: string; reason: "too_short" | "unsafe_content" }>;
}

/** The row a bullet becomes without the extractor: `policy`, global, before_model, advise, unconfirmed, human / import. */
export function verbatimImportInput(descriptor: EpisodeDescriptor, bulletText: string, options: { now: string; config: HarnessConfig }): CreateMemoryInput | { reason: "too_short" | "unsafe_content" } {
  const text = redactCredentials(bulletText).replace(/\s+/g, " ").trim();
  const summary = clipText(text, EXTRACTION_LIMITS.summary_max);
  if (summary.length < EXTRACTION_LIMITS.summary_min) return { reason: "too_short" };
  const details = summary === text ? "" : clipText(text, EXTRACTION_LIMITS.details_max);
  if (!scanMemoryContent(summary, details).safe) return { reason: "unsafe_content" };
  const scopeGlob = "**/*";
  return {
    type: "policy",
    summary,
    details,
    scopeGlob,
    activationClass: "baseline",
    lifecycleTriggers: defaultTriggers("policy", false, scopeGlob),
    confidence: IMPORT_VERBATIM_CONFIDENCE,
    importance: TYPE_IMPORTANCE.policy,
    status: "active",
    relevantTools: null,
    promotionSource: "manual",
    policySubtype: null,
    authority: "human",
    sourceKind: "import",
    knowledgeKind: "import",
    enforcement: enforcementDefault({ type: "policy", authority: "human", policySubtype: null, hasSignature: false, specificityOk: false, knowledgeKind: "import", importUnconfirmed: 1, config: options.config, summary }),
    triggerSignature: null,
    aliases: [],
    sourceRef: descriptor.ledger_ref,
    importUnconfirmed: 1,
    createdAt: options.now,
    updatedAt: options.now,
    lastVerifiedAt: options.now,
    reviveTerminal: true,
  };
}

/**
 * Imports verbatim every bullet whose episode is still `queued` after the worker ran (the extractor was unavailable
 * for it): one `policy` row per bullet (see `verbatimImportInput`), import provenance from the episode, the episode
 * parked as `skipped(import_verbatim)`. Episodes the extractor handled (`extracted`), parked earlier or leased by
 * another worker are left alone, so the step is idempotent.
 */
export function createVerbatimImportRows(
  db: SqlJsDatabase,
  descriptors: readonly EpisodeDescriptor[],
  bullets: readonly ImportBullet[],
  options: { now: string; config: HarnessConfig }
): VerbatimImportResult {
  const episodes = new EpisodeRepository(db);
  const repository = new MemoryRepository(db, { clock: () => options.now });
  const provenance = new ProvenanceRepository(db);
  const result: VerbatimImportResult = { created: [], reinforced: [], skipped: [] };
  descriptors.forEach((descriptor, index) => {
    episodes.insertIfAbsent(descriptor, options.now);
    const episode = episodes.getById(descriptor.id);
    if (episode === null || episode.status !== "queued") return;
    const input = verbatimImportInput(descriptor, bullets[index]!.text, options);
    if ("reason" in input) {
      result.skipped.push({ episode_id: descriptor.id, reason: input.reason });
      return;
    }
    let memoryId: string;
    try {
      memoryId = repository.create(input).id;
      result.created.push(memoryId);
    } catch (error) {
      if (!(error instanceof DuplicateMemoryContentError) || error.matchedBy === "terminal_twin") throw error;
      const twin = repository.getById(error.existingMemoryId);
      if (twin === null) throw error;
      memoryId = twin.id;
      result.reinforced.push(memoryId);
    }
    provenance.insert({
      memoryId,
      episodeId: descriptor.id,
      eventSeq: 0,
      relation: "import",
      confidence: IMPORT_VERBATIM_CONFIDENCE,
      excerpt: input.summary,
      extractionRunId: null,
      createdAt: options.now,
    });
    recomputeDerived(db, memoryId);
    episodes.markSkipped(descriptor.id, IMPORT_VERBATIM_SKIP_REASON);
  });
  return result;
}

/** Parked verbatim episodes of this import → `queued` again so the extractor can type them; returns their ids. */
export function requeueVerbatimEpisodes(db: SqlJsDatabase, descriptors: readonly EpisodeDescriptor[], now: string): string[] {
  const episodes = new EpisodeRepository(db);
  const requeued: string[] = [];
  for (const descriptor of descriptors) {
    const episode = episodes.getById(descriptor.id);
    if (episode === null || episode.status !== "skipped" || episode.skipReason !== IMPORT_VERBATIM_SKIP_REASON) continue;
    episodes.requeue(descriptor.id, { nextAttemptAt: now, resetAttempts: true, lastError: null });
    requeued.push(descriptor.id);
  }
  return requeued;
}

export interface RetypeResult {
  /** Verbatim rows superseded by a typed row: `[verbatim id, replacement id]`. */
  retyped: Array<[string, string]>;
  /** Requeued episodes the extractor still could not type; parked again as `skipped(import_verbatim)`. */
  parked: string[];
}

/**
 * After the worker ran over requeued verbatim episodes: a bullet the extractor typed (an applied outcome with a
 * memory) has its active verbatim rows superseded by the first typed row (actor `import`, reason `import:retyped`);
 * a bullet still `queued` (the provider was unavailable after all) is parked again so the detached worker does not
 * type it later without this supersede step.
 */
export function retypeVerbatimRows(db: SqlJsDatabase, descriptors: readonly EpisodeDescriptor[], requeued: ReadonlySet<string>, rows: readonly ImportRowReport[], now: string): RetypeResult {
  const episodes = new EpisodeRepository(db);
  const result: RetypeResult = { retyped: [], parked: [] };
  descriptors.forEach((descriptor, index) => {
    if (!requeued.has(descriptor.id)) return;
    const row = rows[index];
    const typed = (row?.outcomes ?? []).filter((outcome) => outcome.memory_id !== undefined && APPLIED_OUTCOMES.has(outcome.outcome)).map((outcome) => outcome.memory_id!);
    const verbatim = verbatimRowsOf(db, descriptor.id);
    if (typed.length > 0) {
      const replacement = typed.find((id) => !verbatim.some((memory) => memory.id === id));
      if (replacement === undefined) return;
      for (const memory of verbatim) {
        if (memory.status !== "active") continue;
        transitionMemory(db, { memoryId: memory.id, to: "superseded", actor: "import", reason: "import:retyped", now, replacementId: replacement, statusReason: "import" });
        result.retyped.push([memory.id, replacement]);
      }
      return;
    }
    const episode = episodes.getById(descriptor.id);
    if (episode !== null && episode.status === "queued") {
      episodes.markSkipped(descriptor.id, IMPORT_VERBATIM_SKIP_REASON);
      result.parked.push(descriptor.id);
    }
  });
  return result;
}

// ---------------------------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------------------------

/** `L12` for a file import, `<topic>.md:L12` for an auto-memory bullet. */
export function importRowLabel(row: Pick<ImportRowReport, "line" | "file">): string {
  return row.file === null ? `L${String(row.line)}` : `${basename(row.file)}:L${String(row.line)}`;
}

export function renderImportTable(rows: readonly ImportRowReport[]): string[] {
  const table: string[][] = [];
  for (const row of rows) {
    const label = importRowLabel(row);
    const applied = row.outcomes.filter((outcome) => outcome.memory_id !== undefined && APPLIED_OUTCOMES.has(outcome.outcome));
    const rejected = row.outcomes.filter((outcome) => outcome.outcome === "rejected" || outcome.outcome === "skipped");
    if (row.verbatim && applied.length === 0) {
      for (const memory of row.memories) {
        table.push([label, "verbatim", shortId(memory.id), `${memory.type} ${memory.enforcement}${memory.importUnconfirmed === 1 ? " (unconfirmed)" : ""}`, clip(memory.scopeGlob, 20), clip(memory.summary, 70)]);
      }
      continue;
    }
    if (applied.length === 0 && rejected.length === 0) {
      table.push([label, row.run_status ?? row.episode_status ?? "pending", "-", "-", "-", clip(row.text, 70)]);
      continue;
    }
    for (const outcome of applied) {
      const memory = row.memories.find((entry) => entry.id === outcome.memory_id);
      table.push([
        label,
        outcome.outcome === "reinforced" ? "reinforced" : "imported",
        shortId(outcome.memory_id),
        memory === undefined ? "-" : `${memory.type} ${memory.enforcement}${memory.importUnconfirmed === 1 ? " (unconfirmed)" : ""}`,
        memory === undefined ? "-" : clip(memory.scopeGlob, 20),
        memory === undefined ? clip(row.text, 70) : clip(memory.summary, 70),
      ]);
    }
    for (const outcome of rejected) {
      table.push([label, `${outcome.outcome}(${outcome.rejection ?? outcome.detail ?? "-"})`, "-", "-", "-", clip(row.text, 70)]);
    }
  }
  return renderTable(table, ["LINE", "RESULT", "MEMORY", "TYPE / ENF", "SCOPE", "SUMMARY"]);
}

function renderImportHeader(report: ImportReport): string[] {
  const skipped = report.skipped_lines > 0 ? ` (${String(report.skipped_lines)} non-bullet lines skipped)` : "";
  if (report.source_kind !== AUTO_MEMORY_SOURCE) return [`import ${report.source_path}: ${pluralize(report.bullets, "bullet")}${skipped}`];
  const files = report.files ?? [];
  const selected = files.filter((file) => file.selected);
  const how = report.located === null || report.located === "derived" || report.located === "explicit" ? "" : ` (directory found by ${report.located.replace("_", " ")})`;
  const lines = [`import auto-memory ${report.file}: ${pluralize(selected.length, "note")} → ${pluralize(report.bullets, "bullet")}${skipped}${how}`];
  for (const file of selected) {
    const truncated = file.truncated > 0 ? `, ${String(file.truncated)} dropped over the per-file cap` : "";
    lines.push(`  ${basename(file.path)} (${file.type ?? "untyped"}, ${(file.mode ?? "-").replace(/_/g, " ")}: ${pluralize(file.bullets, "bullet")}${truncated})`);
  }
  const others = files.filter((file) => !file.selected);
  if (others.length > 0) lines.push(`  skipped ${others.map((file) => `${basename(file.path)} (${file.reason ?? "-"})`).join(", ")}`);
  return lines;
}

export function renderImportReport(report: ImportReport, options: { includeTable?: boolean } = {}): string[] {
  const lines = renderImportHeader(report);
  if (report.dry_run) {
    lines.push(...renderTable(report.rows.map((row) => [importRowLabel(row), shortId(row.episode_id), clip(row.text, 90)]), ["LINE", "EPISODE", "BULLET"]));
    lines.push("dry run: nothing written");
    return lines;
  }
  if (report.worker !== null && report.worker.busy) {
    lines.push("another worker holds worker.lock; the bullets are queued and will be imported as unconfirmed rows — run `hm review` afterwards");
    return lines;
  }
  if (report.rows.length > 0 && options.includeTable !== false) lines.push(...renderImportTable(report.rows));
  if (report.verbatim.length > 0) {
    const reason = report.worker?.waiting?.reason ?? "no_provider";
    lines.push(
      `extraction CLI unavailable (${reason}): imported ${pluralize(report.verbatim.length, "bullet")} verbatim — policy rows with the bullet text, enforcement advise, no signature; run \`hm import\` again after \`claude auth login\` and the extractor types them (the typed rows replace these)`
    );
  }
  // Bullets still queued after the verbatim step (too short for a summary, or rejected by the content scanner).
  const stillQueued = report.rows.filter((row) => row.episode_status === "queued").length;
  if (report.worker?.waiting && stillQueued > 0) {
    lines.push(`waiting: ${pluralize(stillQueued, "episode")} (${report.worker.waiting.reason}) — rows appear once the provider is available`);
  }
  if (report.retyped.length > 0) lines.push(`retyped: ${pluralize(report.retyped.length, "verbatim row")} superseded by the rows the extractor typed`);
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

// ---------------------------------------------------------------------------------------------
// --sync
// ---------------------------------------------------------------------------------------------

export interface SyncOptions {
  /** `source_ref` prefixes whose rows are never staled (files still present but not parsed this run). */
  protectedPrefixes?: readonly string[];
}

/**
 * Live import rows whose `source_ref` starts with `prefix` and that no current bullet backs (no import provenance
 * from an episode whose turn key is in `currentHashes`) → stale(import_sync). The prefix is one file
 * (`import:<file>#L`) or one auto-memory directory (`import:auto-memory:<dir>/`); rows under a protected prefix
 * (a note over the size cap, an unreadable file) are kept — their file is still there.
 */
export function syncRemovedBulletsByPrefix(db: SqlJsDatabase, prefix: string, currentHashes: ReadonlySet<string>, now: string, options: SyncOptions = {}): string[] {
  const repository = new MemoryRepository(db, { clock: () => now });
  const episodes = new EpisodeRepository(db);
  const provenance = new ProvenanceRepository(db);
  const protectedPrefixes = options.protectedPrefixes ?? [];
  const staled: string[] = [];
  for (const memory of repository.list({ status: "active", sourceKind: "import" })) {
    if (memory.sourceRef === null || !memory.sourceRef.startsWith(prefix)) continue;
    const ref = memory.sourceRef;
    if (protectedPrefixes.some((guarded) => ref.startsWith(guarded))) continue;
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

/** Live import rows of this file whose bullets are gone (no import provenance from a current bullet) → stale(import_sync). */
export function syncRemovedBullets(db: SqlJsDatabase, sourcePath: string, currentHashes: ReadonlySet<string>, now: string): string[] {
  return syncRemovedBulletsByPrefix(db, importSourceRefPrefix(sourcePath), currentHashes, now);
}

// ---------------------------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------------------------

export async function runImport(ctx: CommandContext): Promise<number> {
  return guard(ctx, async () => {
    const now = ctx.clock();
    const source = resolveSource(ctx, now);
    const yes = flagBoolean(ctx.args, "yes");
    const sync = flagBoolean(ctx.args, "sync");
    const dryRun = flagBoolean(ctx.args, "dry-run");
    const { sourcePath, descriptors, bullets } = source;
    const resolved = dryRun ? null : resolveCliProvider(ctx, flagString(ctx.args, "provider"));

    const report: ImportReport = {
      file: source.file,
      source_kind: source.kind,
      source_path: sourcePath,
      located: source.located,
      files: source.files,
      bullets: bullets.length,
      skipped_lines: source.skippedLines,
      provider: resolved?.name ?? "none",
      dry_run: dryRun,
      worker: null,
      rows: descriptors.map((descriptor, index) => ({
        line: bullets[index]!.line,
        text: bullets[index]!.text,
        file: source.rowFiles[index] ?? null,
        episode_id: descriptor.id,
        episode_status: null,
        run_status: null,
        outcomes: [],
        memories: [],
        verbatim: false,
      })),
      created: [],
      reinforced: [],
      verbatim: [],
      retyped: [],
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
    let requeued = new Set<string>();
    if (descriptors.length > 0) {
      // Verbatim rows of earlier runs: with a provider configured, give the extractor another go at their bullets.
      if (resolved?.provider) {
        const { value } = await writeDb(
          ctx,
          { purpose: "import:retype", kind: "import:retype", subject: sourcePath },
          (db, write) => requeueVerbatimEpisodes(db, descriptors, write.now),
          (ids) => ids.length === 0
        );
        requeued = new Set(value);
      }
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

      // Login-optional path: bullets the extractor could not type become verbatim rows; requeued verbatim rows
      // the extractor did type are superseded by the typed rows (or parked again when it still could not).
      const afterWorker = await readDb(ctx, (db) => collectImportRows(db, descriptors, bullets, source.rowFiles));
      const { value } = await writeDb(
        ctx,
        { purpose: "import:verbatim", kind: "import:verbatim", subject: sourcePath },
        (db, write) => {
          const retype = retypeVerbatimRows(db, descriptors, requeued, afterWorker.rows, write.now);
          const verbatim = createVerbatimImportRows(db, descriptors, bullets, { now: write.now, config: ctx.config });
          return { retype, verbatim };
        },
        (value) => value.retype.retyped.length === 0 && value.retype.parked.length === 0 && value.verbatim.created.length === 0 && value.verbatim.reinforced.length === 0
      );
      report.verbatim = value.verbatim.created;
      report.retyped = value.retype.retyped.map(([verbatimId]) => verbatimId);
    }

    const collected = await readDb(ctx, (db) => collectImportRows(db, descriptors, bullets, source.rowFiles));
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
        for (const line of renderImportHeader(report)) ctx.out.line(line);
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
      const { value } = await writeDb(
        ctx,
        { purpose: "import:sync", kind: "import:sync", subject: sourcePath },
        (db, write) => syncRemovedBulletsByPrefix(db, source.syncPrefix, source.syncHashes, write.now, { protectedPrefixes: source.syncProtectedPrefixes }),
        (ids) => ids.length === 0
      );
      report.synced_stale = value;
    }

    // In the interactive path the header and the table were already printed before the confirmation prompt.
    ctx.out.result(report, (value) => (tablePrinted ? renderImportReport(value, { includeTable: false }).slice(renderImportHeader(value).length) : renderImportReport(value)));
    return EXIT_CODES.ok;
  });
}
