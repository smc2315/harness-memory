/**
 * Snapshot files: the only state the hooks read (spec §4.8, §6).
 *
 * - `snapshot/active.v1.json`  — active memories (no embeddings), derived policy rules, failure index, counts.
 * - `snapshot/lexical.v1.json` — serialized MiniSearch index over summary/details/aliases + recent session summaries.
 * - `snapshot/dense.v1.bin`    — optional: 4-byte LE header length, UTF-8 JSON header, Float32 LE matrix (ids × dims).
 *
 * All three are written by every DB writer via tmp + rename after the commit (§9.2 step 6).
 */

import type { ActivationClass, LifecycleTrigger, MemoryStatus, MemoryType } from "../db/schema/types";
import type {
  Authority,
  Enforcement,
  KnowledgeKind,
  PatternKind,
  SignatureTarget,
} from "./vocabulary";

export const ACTIVE_SNAPSHOT_SCHEMA = "active.v1";
export const LEXICAL_SNAPSHOT_SCHEMA = "lexical.v1";
export const DENSE_SNAPSHOT_SCHEMA = "dense.v1";

/** Precompiled signature so the hook does no parsing (§4.6). */
export interface CompiledSignature {
  tool: string;
  target: SignatureTarget;
  pattern_kind: PatternKind;
  pattern: string;
  negate: boolean;
  /** Canonical tokens for `cmd` patterns (first = program), null otherwise. */
  tokens: string[] | null;
  /** Regex source for `glob` (minimatch.makeRe) and `regex` patterns, null otherwise. */
  regex_source: string | null;
  signature_key: string;
}

export interface SnapshotMemory {
  id: string;
  type: MemoryType;
  summary: string;
  /** Truncated to 600 chars. */
  details: string;
  scope_glob: string;
  /** Precompiled regex source for scope_glob; null means global (matches everything). */
  scope_regex: string | null;
  activation_class: ActivationClass;
  lifecycle_triggers: LifecycleTrigger[];
  relevant_tools: string[] | null;
  signature: CompiledSignature | null;
  authority: Authority;
  enforcement: Enforcement;
  status: MemoryStatus;
  knowledge_kind: KnowledgeKind | null;
  policy_subtype: "hard" | "soft" | null;
  confidence: number;
  importance: number;
  evidence_score: number;
  evidence_count: number;
  validation_count: number;
  fire_count: number;
  override_count: number;
  ttl_expires_at: string | null;
  /** Host-loaded file this row was imported from (e.g. CLAUDE.md) for native de-duplication, else null. */
  source_file: string | null;
  aliases: string[];
  contested: 0 | 1;
  import_unconfirmed: 0 | 1;
  failure_classes: string[];
  created_at: string;
  updated_at: string;
  last_verified_at: string | null;
}

export interface SnapshotRule {
  id: string;
  rule_code: string;
  memory_id: string | null;
  severity: "info" | "warning";
  trigger_kind: LifecycleTrigger;
  scope_glob: string;
  scope_regex: string | null;
  tool_pattern: string;
  target_kind: SignatureTarget;
  pattern_kind: PatternKind | null;
  arg_pattern: string | null;
  enforcement: Enforcement;
  message: string;
}

export interface SnapshotCounts {
  active: number;
  candidates: number;
  open_proposals: number;
  auto_active: number;
  expiring_7d: number;
  /** Active rows excluded from the snapshot because they violate V11 (listed by `doctor`). */
  unreachable: number;
  queue: number;
}

export interface ActiveSnapshot {
  schema: typeof ACTIVE_SNAPSHOT_SCHEMA;
  built_at: string;
  db_generation: number;
  user_version: number;
  last_dream_at: string | null;
  last_probe: { at: string; result: string } | null;
  /** stat of memory.sqlite at build time; hooks compare it to detect a stale snapshot. */
  source: { mtime_ms: number; size: number };
  memories: SnapshotMemory[];
  rules: SnapshotRule[];
  /** failure_class → memory ids (after_tool lookup). */
  failure_index: Record<string, string[]>;
  counts: SnapshotCounts;
}

export interface RecentSummary {
  session_id: string;
  summary_short: string;
  updated_at: string;
}

export interface LexicalSnapshot {
  schema: typeof LEXICAL_SNAPSHOT_SCHEMA;
  built_at: string;
  db_generation: number;
  /** Fields indexed in the MiniSearch document (`summary`, `details`, `aliases`). */
  fields: string[];
  /**
   * Tokenizer the builder used (`LEXICAL_TOKENIZER_ID` from src/activation/lexical-snapshot.ts). Absent =
   * MiniSearch defaults; the reader must query with the same tokenizer the posting lists were built with.
   */
  tokenizer?: string;
  /** `MiniSearch.toJSON()` output; loaded with `MiniSearch.loadJSON`. */
  index: unknown;
  recent_summaries: RecentSummary[];
}

export interface DenseSnapshotHeader {
  schema: typeof DENSE_SNAPSHOT_SCHEMA;
  built_at: string;
  db_generation: number;
  model: string;
  dims: number;
  dtype: "float32";
  /** Row i of the matrix is the embedding of ids[i]. */
  ids: string[];
}
