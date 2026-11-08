/**
 * Snapshot builder (spec §4.8, §9.2 step 6): the only state the hooks read.
 *
 *   snapshot/active.v1.json   active memories (compiled signature + scope regex, no embeddings), derived
 *                             policy rules, failure index, counts, probe / dream metadata
 *   snapshot/lexical.v1.json  MiniSearch index over summary / details / aliases (storeFields: []) + recent summaries
 *   snapshot/dense.v1.bin     rows with an embedding: 4-byte LE header length, UTF-8 JSON header, Float32 LE matrix
 *
 * Active rows that violate V11 (no trigger a hook can deliver) are excluded and counted in
 * `counts.unreachable`; a signature that no longer compiles is dropped before the check.
 * Files are written as `<file>.tmp-<pid>` then renamed (cleanOrphanTmp covers the leftovers).
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename } from "node:path";

import MiniSearch from "minisearch";
import type { Database as SqlJsDatabase } from "sql.js";

import { LEXICAL_TOKENIZER_ID, lexicalSnapshotOptions, type LexicalSnapshotDocument } from "../activation/lexical-snapshot";
import { compileGlobSource, compileSignature } from "../activation/signature";
import type { HarnessConfig } from "../core/config";
import type { HarnessPaths } from "../core/paths";
import {
  ACTIVE_SNAPSHOT_SCHEMA,
  DENSE_SNAPSHOT_SCHEMA,
  LEXICAL_SNAPSHOT_SCHEMA,
  type ActiveSnapshot,
  type CompiledSignature,
  type DenseSnapshotHeader,
  type LexicalSnapshot,
  type RecentSummary,
  type SnapshotCounts,
  type SnapshotMemory,
  type SnapshotRule,
} from "../core/snapshot-types";
import { isGlobalScope, type Enforcement, type PatternKind, type SignatureTarget } from "../core/vocabulary";
import type { LifecycleTrigger } from "./schema/types";
import { MemoryRepository, type MemoryRecord } from "../memory/repository";
import { isReachableTrigger } from "../promotion/authority";
import { META_KEYS, MetaRepository } from "./repositories/meta";
import { ProposalRepository } from "./repositories/proposals";
import { getDbGeneration } from "./meta";
import { selectAll, selectCount, userVersion } from "./sql";

export const SNAPSHOT_DETAILS_CHARS = 600;
export const SNAPSHOT_RECENT_SUMMARIES = 20;
export const LEXICAL_FIELDS = ["summary", "details", "aliases"] as const;

/** `{id, summary, details, aliases (space-joined)}` — the shape the hooks' reader expects (src/activation/lexical-snapshot.ts). */
export type LexicalDocument = LexicalSnapshotDocument;

export interface UnreachableMemory {
  id: string;
  reason: "signature_invalid" | "trigger_unreachable";
  detail: string;
}

export interface SnapshotData {
  active: ActiveSnapshot;
  lexicalDocuments: LexicalDocument[];
  recentSummaries: RecentSummary[];
  dense: { header: DenseSnapshotHeader; vectors: Float32Array[] } | null;
  unreachable: UnreachableMemory[];
  /** Active rows whose stored signature does not compile (still included when another trigger reaches them). */
  signatureDropped: string[];
}

export interface BuildSnapshotOptions {
  now: string;
  config?: HarnessConfig;
  /** db_generation to stamp; defaults to the `meta` value. */
  generation?: number;
  pid?: number;
  /** Model name recorded in the dense header (defaults to config.embeddings.model). */
  embeddingModel?: string;
}

export interface SnapshotBuildResult extends SnapshotData {
  files: { active: string; lexical: string; dense: string | null };
  bytes: { active: number; lexical: number; dense: number };
}

/** `import:<file>#L<n>` → `<file>`; anything else → null. */
export function sourceFileOf(sourceRef: string | null): string | null {
  if (sourceRef === null || !sourceRef.startsWith("import:")) return null;
  const rest = sourceRef.slice("import:".length);
  const file = rest.split("#")[0] ?? "";
  return file.length === 0 ? null : file;
}

export interface MemoryConversion {
  snapshot: SnapshotMemory | null;
  unreachable: UnreachableMemory | null;
  signatureDropped: boolean;
}

/** Converts one active row; `snapshot` is null when V11 excludes it. */
export function toSnapshotMemory(memory: MemoryRecord): MemoryConversion {
  let signature: CompiledSignature | null = null;
  let signatureDropped = false;
  let signatureDetail = "";
  if (memory.triggerSignature !== null) {
    const compiled = compileSignature(memory.triggerSignature);
    if (compiled.ok) {
      signature = compiled.compiled;
    } else {
      signatureDropped = true;
      signatureDetail = `${compiled.code}: ${compiled.detail}`;
    }
  }
  const hasSignature = signature !== null;
  const reachable = isReachableTrigger({
    type: memory.type,
    hasSignature,
    signatureTool: signature?.tool ?? null,
    lifecycleTriggers: memory.lifecycleTriggers,
  });
  if (!reachable) {
    return {
      snapshot: null,
      unreachable: {
        id: memory.id,
        reason: signatureDropped ? "signature_invalid" : "trigger_unreachable",
        detail: signatureDropped ? signatureDetail : `triggers ${memory.lifecycleTriggers.join(",")} cannot be delivered for ${memory.type}`,
      },
      signatureDropped,
    };
  }
  const snapshot: SnapshotMemory = {
    id: memory.id,
    type: memory.type,
    summary: memory.summary,
    details: memory.details.length > SNAPSHOT_DETAILS_CHARS ? memory.details.slice(0, SNAPSHOT_DETAILS_CHARS) : memory.details,
    scope_glob: memory.scopeGlob,
    scope_regex: isGlobalScope(memory.scopeGlob) ? null : compileGlobSource(memory.scopeGlob),
    activation_class: memory.activationClass,
    lifecycle_triggers: [...memory.lifecycleTriggers],
    relevant_tools: memory.relevantTools === null ? null : [...memory.relevantTools],
    signature,
    authority: memory.authority,
    enforcement: memory.enforcement,
    status: memory.status,
    knowledge_kind: memory.knowledgeKind,
    policy_subtype: memory.policySubtype,
    confidence: memory.confidence,
    importance: memory.importance,
    evidence_score: memory.evidenceScore,
    evidence_count: memory.evidenceCount,
    validation_count: memory.validationCount,
    fire_count: memory.fireCount,
    override_count: memory.overrideCount,
    ttl_expires_at: memory.ttlExpiresAt,
    source_file: sourceFileOf(memory.sourceRef),
    aliases: [...memory.aliases],
    contested: memory.contested,
    import_unconfirmed: memory.importUnconfirmed,
    failure_classes: [...memory.failureClasses],
    created_at: memory.createdAt,
    updated_at: memory.updatedAt,
    last_verified_at: memory.lastVerifiedAt,
  };
  return { snapshot, unreachable: null, signatureDropped };
}

function readRules(db: SqlJsDatabase): SnapshotRule[] {
  return selectAll(
    db,
    `SELECT r.id, r.rule_code, r.memory_id, r.severity, r.trigger_kind, r.scope_glob, r.tool_pattern, r.target_kind,
            r.pattern_kind, r.arg_pattern, r.enforcement, r.message
     FROM policy_rules r
     WHERE r.memory_id IS NULL OR EXISTS (SELECT 1 FROM memories m WHERE m.id = r.memory_id AND m.status = 'active')
     ORDER BY r.rule_code ASC`
  ).map((row) => {
    const scopeGlob = String(row.scope_glob);
    return {
      id: String(row.id),
      rule_code: String(row.rule_code),
      memory_id: row.memory_id === null || row.memory_id === undefined ? null : String(row.memory_id),
      severity: row.severity === "warning" ? "warning" : "info",
      trigger_kind: String(row.trigger_kind) as LifecycleTrigger,
      scope_glob: scopeGlob,
      scope_regex: isGlobalScope(scopeGlob) ? null : compileGlobSource(scopeGlob),
      tool_pattern: String(row.tool_pattern ?? "*"),
      target_kind: String(row.target_kind ?? "any") as SignatureTarget,
      pattern_kind: row.pattern_kind === null || row.pattern_kind === undefined ? null : (String(row.pattern_kind) as PatternKind),
      arg_pattern: row.arg_pattern === null || row.arg_pattern === undefined ? null : String(row.arg_pattern),
      enforcement: String(row.enforcement ?? "advise") as Enforcement,
      message: String(row.message),
    };
  });
}

function readRecentSummaries(db: SqlJsDatabase): RecentSummary[] {
  return selectAll(
    db,
    `SELECT session_id, summary_short, updated_at FROM session_summaries ORDER BY updated_at DESC, id ASC LIMIT ${String(SNAPSHOT_RECENT_SUMMARIES)}`
  ).map((row) => ({
    session_id: String(row.session_id),
    summary_short: String(row.summary_short),
    updated_at: String(row.updated_at),
  }));
}

function countQueueFiles(paths: HarnessPaths): number {
  try {
    return readdirSync(paths.queueDir).filter((name) => name.endsWith(".json")).length;
  } catch {
    return 0;
  }
}

function sourceStat(paths: HarnessPaths): { mtime_ms: number; size: number } {
  try {
    const stat = statSync(paths.db);
    return { mtime_ms: stat.mtimeMs, size: stat.size };
  } catch {
    return { mtime_ms: 0, size: 0 };
  }
}

/** Builds every snapshot structure in memory (no file I/O); `buildSnapshot` writes them. */
export function buildSnapshotData(db: SqlJsDatabase, paths: HarnessPaths, options: BuildSnapshotOptions): SnapshotData {
  const repository = new MemoryRepository(db);
  const meta = new MetaRepository(db);
  const proposals = new ProposalRepository(db);
  const activeRows = repository.list({ status: "active" });

  const memories: SnapshotMemory[] = [];
  const unreachable: UnreachableMemory[] = [];
  const signatureDropped: string[] = [];
  const lexicalDocuments: LexicalDocument[] = [];
  const denseVectors: Float32Array[] = [];
  const denseIds: string[] = [];
  const failureIndex: Record<string, string[]> = {};

  for (const row of activeRows) {
    const converted = toSnapshotMemory(row);
    if (converted.signatureDropped) signatureDropped.push(row.id);
    if (converted.snapshot === null) {
      if (converted.unreachable !== null) unreachable.push(converted.unreachable);
      continue;
    }
    memories.push(converted.snapshot);
    lexicalDocuments.push({ id: row.id, summary: row.summary, details: row.details, aliases: row.aliases.join(" ") });
    if (row.embedding !== null && row.embedding.length > 0) {
      if (denseVectors.length === 0 || denseVectors[0]!.length === row.embedding.length) {
        denseVectors.push(row.embedding);
        denseIds.push(row.id);
      }
    }
    for (const failureClass of row.failureClasses) {
      const bucket = failureIndex[failureClass] ?? (failureIndex[failureClass] = []);
      bucket.push(row.id);
    }
  }
  memories.sort((left, right) => left.id.localeCompare(right.id));
  lexicalDocuments.sort((left, right) => left.id.localeCompare(right.id));
  for (const key of Object.keys(failureIndex)) failureIndex[key]!.sort();

  const counts = repository.countByStatus();
  const now = options.now;
  const sevenDays = new Date(Date.parse(now) + 7 * 24 * 60 * 60 * 1000).toISOString();
  const expiringMemories = selectCount(
    db,
    "SELECT COUNT(*) FROM memories WHERE status = 'active' AND authority = 'auto' AND ttl_expires_at IS NOT NULL AND ttl_expires_at <= ?",
    [sevenDays]
  );
  const snapshotCounts: SnapshotCounts = {
    active: memories.length,
    candidates: counts.candidate,
    open_proposals: proposals.countOpen(),
    auto_active: memories.filter((memory) => memory.authority === "auto").length,
    expiring_7d: proposals.countExpiringWithin(now, 7) + expiringMemories,
    unreachable: unreachable.length,
    queue: countQueueFiles(paths),
  };

  const probeAt = meta.get(META_KEYS.lastProbeAt);
  const probeResult = meta.get(META_KEYS.lastProbeResult);
  const generation = options.generation ?? getDbGeneration(db);

  const active: ActiveSnapshot = {
    schema: ACTIVE_SNAPSHOT_SCHEMA,
    built_at: now,
    db_generation: generation,
    user_version: userVersion(db),
    last_dream_at: meta.get(META_KEYS.lastDreamAt),
    last_probe: probeAt !== null && probeResult !== null ? { at: probeAt, result: probeResult } : null,
    source: sourceStat(paths),
    memories,
    rules: readRules(db),
    failure_index: failureIndex,
    counts: snapshotCounts,
  };

  let dense: SnapshotData["dense"] = null;
  if (denseVectors.length > 0) {
    const header: DenseSnapshotHeader = {
      schema: DENSE_SNAPSHOT_SCHEMA,
      built_at: now,
      db_generation: generation,
      model: options.embeddingModel ?? options.config?.embeddings.model ?? "unknown",
      dims: denseVectors[0]!.length,
      dtype: "float32",
      ids: denseIds,
    };
    dense = { header, vectors: denseVectors };
  }

  return { active, lexicalDocuments, recentSummaries: readRecentSummaries(db), dense, unreachable, signatureDropped };
}

/** Same options as the hooks' reader (`lexicalOptionsFor(LEXICAL_TOKENIZER_ID)`): MiniSearch serializes posting lists, not options. */
export function createLexicalIndex(): MiniSearch<LexicalDocument> {
  return new MiniSearch<LexicalDocument>(lexicalSnapshotOptions());
}

export function buildLexicalSnapshot(data: SnapshotData): LexicalSnapshot {
  const index = createLexicalIndex();
  index.addAll(data.lexicalDocuments);
  return {
    schema: LEXICAL_SNAPSHOT_SCHEMA,
    built_at: data.active.built_at,
    db_generation: data.active.db_generation,
    fields: [...LEXICAL_FIELDS],
    tokenizer: LEXICAL_TOKENIZER_ID,
    index: index.toJSON(),
    recent_summaries: data.recentSummaries,
  };
}

/** `[u32 LE header length][header JSON][Float32 LE matrix]` */
export function encodeDenseSnapshot(header: DenseSnapshotHeader, vectors: readonly Float32Array[]): Buffer {
  const headerBytes = Buffer.from(JSON.stringify(header), "utf8");
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32LE(headerBytes.length, 0);
  const matrix = Buffer.alloc(vectors.length * header.dims * 4);
  let offset = 0;
  for (const vector of vectors) {
    for (let i = 0; i < header.dims; i += 1) {
      matrix.writeFloatLE(vector[i] ?? 0, offset);
      offset += 4;
    }
  }
  return Buffer.concat([prefix, headerBytes, matrix]);
}

export function decodeDenseSnapshot(buffer: Buffer): { header: DenseSnapshotHeader; matrix: Float32Array } {
  const headerLength = buffer.readUInt32LE(0);
  const header = JSON.parse(buffer.subarray(4, 4 + headerLength).toString("utf8")) as DenseSnapshotHeader;
  const body = buffer.subarray(4 + headerLength);
  const matrix = new Float32Array(body.byteLength / 4);
  for (let i = 0; i < matrix.length; i += 1) matrix[i] = body.readFloatLE(i * 4);
  return { header, matrix };
}

function writeAtomic(file: string, data: Buffer | string, pid: number): number {
  const tmp = `${file}.tmp-${String(pid)}`;
  writeFileSync(tmp, data);
  try {
    renameSync(tmp, file);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EPERM" || code === "EBUSY" || code === "EACCES" || code === "EEXIST") {
      copyFileSync(tmp, file);
      rmSync(tmp, { force: true });
    } else {
      rmSync(tmp, { force: true });
      throw error;
    }
  }
  return typeof data === "string" ? Buffer.byteLength(data, "utf8") : data.byteLength;
}

/** Builds and writes the three snapshot files; also clears `snapshot/.reindex-requested`. */
export function buildSnapshot(db: SqlJsDatabase, paths: HarnessPaths, options: BuildSnapshotOptions): SnapshotBuildResult {
  const pid = options.pid ?? process.pid;
  const data = buildSnapshotData(db, paths, options);
  mkdirSync(paths.snapshotDir, { recursive: true });

  const activeBytes = writeAtomic(paths.snapshotActive, JSON.stringify(data.active), pid);
  const lexical = buildLexicalSnapshot(data);
  const lexicalBytes = writeAtomic(paths.snapshotLexical, JSON.stringify(lexical), pid);

  let denseBytes = 0;
  let denseFile: string | null = null;
  if (data.dense !== null) {
    denseBytes = writeAtomic(paths.snapshotDense, encodeDenseSnapshot(data.dense.header, data.dense.vectors), pid);
    denseFile = paths.snapshotDense;
  } else if (existsSync(paths.snapshotDense)) {
    rmSync(paths.snapshotDense, { force: true });
  }

  rmSync(paths.reindexRequested, { force: true });

  return {
    ...data,
    files: { active: paths.snapshotActive, lexical: paths.snapshotLexical, dense: denseFile },
    bytes: { active: activeBytes, lexical: lexicalBytes, dense: denseBytes },
  };
}

/** Name of the snapshot file a path refers to (for logs). */
export function snapshotFileName(path: string): string {
  return basename(path);
}
