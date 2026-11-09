/**
 * MemoryRepository — camelCase records over the `memories` table (migration 017 shape).
 *
 * Rules enforced here (spec §4.1, §4.7, §5.7 steps 3–5, §7.1, G3):
 * - `create()` REQUIRES `authority` and `sourceKind`; there is no default for either.
 * - Duplicate detection only looks at live rows (`candidate|active|stale`): a live twin by
 *   `identity_key` or `semantic_key` throws `DuplicateMemoryContentError` so the caller reinforces
 *   instead. When only terminal twins exist, `reviveTerminal: true` creates a new live row with a
 *   deterministic revived id; without the flag the terminal twin is reported as a duplicate.
 * - `update()` never writes `status` or `authority`: status changes go through
 *   `transitionMemory` (src/promotion/transitions.ts), authority through `setAuthority`.
 * - Every timestamp is injectable (`clock` option, `updatedAt` inputs); nothing here reads the
 *   wall clock unless the caller omits a time.
 */

import type { Database as SqlJsDatabase, SqlValue } from "sql.js";

import {
  type ActivationClass,
  type EvidenceSourceKind,
  MEMORY_DEFAULTS,
  type LifecycleTrigger,
  type MemoryStatus,
  type MemoryType,
  type PolicySubtype,
  type PromotionSource,
} from "../db/schema/types";
import { semanticKey as computeSemanticKey } from "../core/ids";
import {
  AUTHORITIES,
  ENFORCEMENTS,
  KNOWLEDGE_KINDS,
  LIVE_STATUSES,
  SOURCE_KINDS,
  type Authority,
  type Enforcement,
  type KnowledgeKind,
  type SourceKind,
  type TriggerSignature,
} from "../core/vocabulary";
import {
  createDeterministicId,
  createMemoryContentHash,
  createMemoryIdentityKey,
  createMemoryId,
  createRevivedMemoryId,
  fallbackSignatureKey,
  parseLifecycleTriggers,
  parseRelevantTools,
  parseStringArray,
  parseTriggerSignature,
  serializeLifecycleTriggers,
  serializeRelevantTools,
  serializeStringArray,
  serializeTriggerSignature,
} from "./utils";

type SqlParameters = Record<string, SqlValue>;
type SqlRow = Record<string, SqlValue>;

const MEMORY_SELECT_COLUMNS = [
  "id",
  "content_hash",
  "identity_key",
  "type",
  "summary",
  "details",
  "scope_glob",
  "lifecycle_triggers",
  "confidence",
  "importance",
  "status",
  "supersedes_memory_id",
  "promotion_source",
  "ttl_expires_at",
  "validation_count",
  "policy_subtype",
  "created_at",
  "updated_at",
  "last_verified_at",
  "activation_class",
  "embedding",
  "embedding_summary",
  "relevant_tools_json",
  "semantic_key",
  "trigger_signature_json",
  "signature_key",
  "knowledge_kind",
  "failure_classes_json",
  "status_reason",
  "superseded_by_memory_id",
  "source_ref",
  "revalidate_after",
  "last_fired_at",
  "open_proposal_id",
  "authority",
  "enforcement",
  "source_kind",
  "evidence_score",
  "evidence_count",
  "distinct_session_count",
  "fire_count",
  "override_count",
  "contested",
  "needs_scope",
  "import_unconfirmed",
  "aliases_json",
].join(", ");

const EVIDENCE_SELECT_COLUMNS = [
  "id",
  "memory_id",
  "source_kind",
  "source_ref",
  "excerpt",
  "created_at",
].join(", ");

/** `'candidate', 'active', 'stale'` — the statuses the partial unique indexes cover. */
export const LIVE_STATUS_SQL_LIST = LIVE_STATUSES.map((status) => `'${status}'`).join(", ");

const MEMORY_TYPES = new Set<MemoryType>([
  "policy",
  "workflow",
  "pitfall",
  "architecture_constraint",
  "decision",
]);

const MEMORY_STATUSES = new Set<MemoryStatus>([
  "candidate",
  "active",
  "stale",
  "superseded",
  "rejected",
]);

const ACTIVATION_CLASSES = new Set<ActivationClass>([
  "baseline",
  "startup",
  "scoped",
  "event",
]);

const EVIDENCE_SOURCE_KINDS = new Set<EvidenceSourceKind>([
  "session",
  "task",
  "file",
  "manual_note",
]);

export interface MemoryRecord {
  id: string;
  contentHash: string;
  identityKey: string | null;
  type: MemoryType;
  summary: string;
  details: string;
  scopeGlob: string;
  activationClass: ActivationClass;
  lifecycleTriggers: LifecycleTrigger[];
  confidence: number;
  importance: number;
  status: MemoryStatus;
  supersedesMemoryId: string | null;
  promotionSource: PromotionSource;
  ttlExpiresAt: string | null;
  validationCount: number;
  policySubtype: PolicySubtype;
  createdAt: string;
  updatedAt: string;
  lastVerifiedAt: string | null;
  embedding: Float32Array | null;
  embeddingSummary: Float32Array | null;
  relevantTools: string[] | null;
  // v0.6 (migration 017) ---------------------------------------------------------------------
  semanticKey: string | null;
  triggerSignature: TriggerSignature | null;
  /** Serialized canonical signature; '' when the memory has no signature. */
  signatureKey: string;
  knowledgeKind: KnowledgeKind | null;
  failureClasses: string[];
  statusReason: string | null;
  supersededByMemoryId: string | null;
  sourceRef: string | null;
  revalidateAfter: string | null;
  lastFiredAt: string | null;
  openProposalId: string | null;
  authority: Authority;
  enforcement: Enforcement;
  sourceKind: SourceKind;
  evidenceScore: number;
  evidenceCount: number;
  distinctSessionCount: number;
  fireCount: number;
  overrideCount: number;
  contested: 0 | 1;
  needsScope: 0 | 1;
  importUnconfirmed: 0 | 1;
  aliases: string[];
}

export interface EvidenceRecord {
  id: string;
  memoryId: string;
  sourceKind: EvidenceSourceKind;
  sourceRef: string;
  excerpt: string;
  createdAt: string;
}

export interface CreateMemoryInput {
  id?: string;
  type: MemoryType;
  summary: string;
  details: string;
  scopeGlob: string;
  activationClass?: ActivationClass;
  lifecycleTriggers: readonly LifecycleTrigger[];
  confidence?: number;
  importance?: number;
  status?: MemoryStatus;
  supersedesMemoryId?: string | null;
  createdAt?: string;
  updatedAt?: string;
  lastVerifiedAt?: string | null;
  embedding?: Float32Array | null;
  embeddingSummary?: Float32Array | null;
  relevantTools?: readonly string[] | null;
  promotionSource?: PromotionSource;
  policySubtype?: PolicySubtype;
  validationCount?: number;
  // v0.6 ----------------------------------------------------------------------------------
  /** REQUIRED (spec G3): who may change this row's status. Extraction / MEMORY.md / migration rows are `auto`. */
  authority: Authority;
  /** REQUIRED: manual | import | extraction | legacy. */
  sourceKind: SourceKind;
  knowledgeKind?: KnowledgeKind | null;
  /** Defaults to 'advise'. */
  enforcement?: Enforcement;
  triggerSignature?: TriggerSignature | null;
  /**
   * Canonical signature key from activation/signature.ts. When omitted, a structural fallback
   * (`tool|target|kind|pattern`) is derived from `triggerSignature`; '' when there is no signature.
   */
  signatureKey?: string;
  /**
   * `undefined` → computed as sha256(type|scope_glob|signature_key|normalize(summary));
   * `null` → stored as NULL (opt out of live uniqueness, e.g. a merge-proposal loser);
   * string → stored as given.
   */
  semanticKey?: string | null;
  aliases?: readonly string[];
  failureClasses?: readonly string[];
  sourceRef?: string | null;
  statusReason?: string | null;
  ttlExpiresAt?: string | null;
  revalidateAfter?: string | null;
  importUnconfirmed?: 0 | 1;
  needsScope?: 0 | 1;
  /**
   * When every row with the same identity is terminal (rejected/superseded), create a new live
   * row with id `memory:<identity_key>:<n>` instead of throwing (spec §5.7 step 4, R5).
   */
  reviveTerminal?: boolean;
}

export interface UpdateMemoryInput {
  type?: MemoryType;
  summary?: string;
  details?: string;
  scopeGlob?: string;
  activationClass?: ActivationClass;
  lifecycleTriggers?: readonly LifecycleTrigger[];
  confidence?: number;
  importance?: number;
  supersedesMemoryId?: string | null;
  promotionSource?: PromotionSource;
  policySubtype?: PolicySubtype;
  ttlExpiresAt?: string | null;
  validationCount?: number;
  updatedAt?: string;
  lastVerifiedAt?: string | null;
  embeddingSummary?: Float32Array | null;
  relevantTools?: readonly string[] | null;
  knowledgeKind?: KnowledgeKind | null;
  sourceRef?: string | null;
  aliases?: readonly string[];
  failureClasses?: readonly string[];
  /** Not accepted: status changes go through `transitionMemory` (passing it throws). */
  status?: never;
  /** Not accepted: authority changes go through `setAuthority` (passing it throws). */
  authority?: never;
}

export interface UpdateDerivedInput {
  evidenceScore: number;
  evidenceCount: number;
  distinctSessionCount: number;
  confidence?: number;
  updatedAt?: string;
}

export interface RecordFireInput {
  /** Time of the (latest) fire; `last_fired_at` becomes max(existing, at). */
  at: string;
  /** Fires to add (default 1). */
  count?: number;
  /** Overrides to add (default 0). */
  overrideDelta?: number;
}

export interface SetScopeInput {
  scopeGlob: string;
  lifecycleTriggers?: readonly LifecycleTrigger[];
  activationClass?: ActivationClass;
  /** `undefined` keeps the current signature; `null` removes it (signature_key becomes ''). */
  triggerSignature?: TriggerSignature | null;
  /** Canonical key for `triggerSignature`; derived structurally when omitted. */
  signatureKey?: string;
  /** `undefined` → recomputed from the new scope/signature/summary; `null` → NULL; string → as given. */
  semanticKey?: string | null;
  updatedAt?: string;
}

export interface SetFlagsInput {
  contested?: 0 | 1;
  needsScope?: 0 | 1;
  importUnconfirmed?: 0 | 1;
  openProposalId?: string | null;
  updatedAt?: string;
}

export interface SetTtlInput {
  ttlExpiresAt: string | null;
  revalidateAfter: string | null;
  validationCount?: number;
  lastVerifiedAt?: string | null;
  updatedAt?: string;
}

export interface LookupOptions {
  /** Default true: only `candidate|active|stale` rows. False: any status, live rows first, newest first. */
  live?: boolean;
}

export interface CreateEvidenceInput {
  id?: string;
  memoryId: string;
  sourceKind: EvidenceSourceKind;
  sourceRef: string;
  excerpt: string;
  createdAt?: string;
}

export interface ListMemoriesInput {
  status?: MemoryStatus | readonly MemoryStatus[];
  type?: MemoryType | readonly MemoryType[];
  activationClass?: ActivationClass | readonly ActivationClass[];
  authority?: Authority | readonly Authority[];
  sourceKind?: SourceKind | readonly SourceKind[];
  knowledgeKind?: KnowledgeKind | readonly KnowledgeKind[];
  /** Exact scope_glob match. */
  scopeGlob?: string;
  /** Rows whose ttl_expires_at is set and <= this ISO time. */
  ttlExpiredBefore?: string;
  /** Rows whose revalidate_after is set and <= this ISO time. */
  revalidateDueBefore?: string;
  /** Rows created strictly before this ISO time. */
  createdBefore?: string;
  needsScope?: 0 | 1;
  contested?: 0 | 1;
  importUnconfirmed?: 0 | 1;
  limit?: number;
  offset?: number;
}

export interface CreateMemoryResult {
  memory: MemoryRecord;
  isNew: boolean;
}

export interface MemoryLineage {
  root: MemoryRecord;
  focus: MemoryRecord;
  ancestors: MemoryRecord[];
  descendants: MemoryRecord[];
}

export type MemoryHistoryRelation = "ancestor" | "focus" | "descendant";

export interface MemoryHistoryEntry {
  relation: MemoryHistoryRelation;
  memory: MemoryRecord;
  evidence: EvidenceRecord[];
}

export interface MemoryConflictRecord {
  key: string;
  root: MemoryRecord;
  memories: MemoryRecord[];
}

export type DuplicateMatchKind = "identity_key" | "semantic_key" | "content_hash" | "terminal_twin";

export class DuplicateMemoryContentError extends Error {
  /** The key that matched (identity key, semantic key or content hash depending on `matchedBy`). */
  readonly key: string;
  readonly existingMemoryId: string;
  readonly matchedBy: DuplicateMatchKind;

  constructor(key: string, existingMemoryId: string, matchedBy: DuplicateMatchKind = "identity_key") {
    super(
      matchedBy === "terminal_twin"
        ? `Memory ${existingMemoryId} already holds this fact in a terminal status; pass reviveTerminal to create a new live row (key ${key})`
        : `Memory content already exists by ${matchedBy} ${key} (memory ${existingMemoryId})`
    );
    this.name = "DuplicateMemoryContentError";
    this.key = key;
    this.existingMemoryId = existingMemoryId;
    this.matchedBy = matchedBy;
  }

  /** @deprecated use `key`. */
  get contentHash(): string {
    return this.key;
  }
}

export class MemoryNotFoundError extends Error {
  readonly memoryId: string;

  constructor(memoryId: string) {
    super(`Memory ${memoryId} was not found`);
    this.name = "MemoryNotFoundError";
    this.memoryId = memoryId;
  }
}

export class InvalidMemoryTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidMemoryTransitionError";
  }
}

export interface MemoryRepositoryOptions {
  /** ISO timestamp source used when an input omits its time. Defaults to the wall clock. */
  clock?: () => string;
}

function isMemoryType(value: string): value is MemoryType {
  return MEMORY_TYPES.has(value as MemoryType);
}

function isMemoryStatus(value: string): value is MemoryStatus {
  return MEMORY_STATUSES.has(value as MemoryStatus);
}

function isActivationClass(value: string): value is ActivationClass {
  return ACTIVATION_CLASSES.has(value as ActivationClass);
}

function expectString(value: unknown, column: string): string {
  if (typeof value !== "string") {
    throw new Error(`Expected ${column} to be a string`);
  }

  return value;
}

function expectNullableString(value: unknown, column: string): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  return expectString(value, column);
}

function expectNumber(value: unknown, column: string): number {
  if (typeof value !== "number") {
    throw new Error(`Expected ${column} to be a number`);
  }

  return value;
}

function expectFlag(value: unknown, column: string): 0 | 1 {
  const number = expectNumber(value, column);

  if (number !== 0 && number !== 1) {
    throw new Error(`Expected ${column} to be 0 or 1`);
  }

  return number;
}

function expectEnum<T extends string>(value: unknown, column: string, allowed: readonly T[]): T {
  const text = expectString(value, column);

  if (!(allowed as readonly string[]).includes(text)) {
    throw new Error(`Invalid ${column}: ${text}`);
  }

  return text as T;
}

function expectNullableEnum<T extends string>(
  value: unknown,
  column: string,
  allowed: readonly T[]
): T | null {
  if (value === null || value === undefined) {
    return null;
  }

  return expectEnum(value, column, allowed);
}

function expectMemoryType(value: unknown): MemoryType {
  const type = expectString(value, "type");

  if (!isMemoryType(type)) {
    throw new Error(`Invalid memory type: ${type}`);
  }

  return type;
}

function expectMemoryStatus(value: unknown): MemoryStatus {
  const status = expectString(value, "status");

  if (!isMemoryStatus(status)) {
    throw new Error(`Invalid memory status: ${status}`);
  }

  return status;
}

function expectActivationClass(value: unknown): ActivationClass {
  const activationClass = expectString(value, "activation_class");

  if (!isActivationClass(activationClass)) {
    throw new Error(`Invalid activation class: ${activationClass}`);
  }

  return activationClass;
}

function expectEvidenceSourceKind(value: unknown): EvidenceSourceKind {
  const sourceKind = expectString(value, "source_kind");

  if (!EVIDENCE_SOURCE_KINDS.has(sourceKind as EvidenceSourceKind)) {
    throw new Error(`Invalid evidence source kind: ${sourceKind}`);
  }

  return sourceKind as EvidenceSourceKind;
}

function normalizeScore(value: number, field: "confidence" | "importance"): number {
  if (typeof value !== "number" || Number.isNaN(value) || value < 0 || value > 1) {
    throw new Error(`${field} must be between 0 and 1`);
  }

  return value;
}

function normalizeCount(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative integer`);
  }

  return value;
}

function normalizeLimit(value: number | undefined, field: "limit" | "offset"): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  return normalizeCount(value, field);
}

function requireEnumInput<T extends string>(
  value: unknown,
  field: string,
  allowed: readonly T[]
): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw new Error(
      `${field} is required and must be one of ${allowed.join(", ")} (got ${String(value)})`
    );
  }

  return value as T;
}

function optionalEnumInput<T extends string>(
  value: unknown,
  field: string,
  allowed: readonly T[],
  fallback: T
): T {
  if (value === undefined) {
    return fallback;
  }

  return requireEnumInput(value, field, allowed);
}

function optionalNullableEnumInput<T extends string>(
  value: unknown,
  field: string,
  allowed: readonly T[]
): T | null {
  if (value === undefined || value === null) {
    return null;
  }

  return requireEnumInput(value, field, allowed);
}

function normalizeFlag(value: 0 | 1 | undefined, fallback: 0 | 1): 0 | 1 {
  if (value === undefined) {
    return fallback;
  }

  if (value !== 0 && value !== 1) {
    throw new Error("flags must be 0 or 1");
  }

  return value;
}

function blobOf(vector: Float32Array | null | undefined): Uint8Array | null {
  if (vector === null || vector === undefined) {
    return null;
  }

  return new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength);
}

function vectorOf(value: SqlValue | undefined): Float32Array | null {
  if (!(value instanceof Uint8Array)) {
    return null;
  }

  return new Float32Array(value.buffer, value.byteOffset, value.byteLength / 4);
}

function maxIso(left: string | null, right: string): string {
  if (left === null) {
    return right;
  }

  return Date.parse(right) > Date.parse(left) ? right : left;
}

function compareMemoryByCreatedAt(left: MemoryRecord, right: MemoryRecord): number {
  const createdAtDelta = Date.parse(left.createdAt) - Date.parse(right.createdAt);
  if (createdAtDelta !== 0) {
    return createdAtDelta;
  }

  return left.id.localeCompare(right.id);
}

function compareEvidenceByCreatedAt(left: EvidenceRecord, right: EvidenceRecord): number {
  const createdAtDelta = Date.parse(left.createdAt) - Date.parse(right.createdAt);
  if (createdAtDelta !== 0) {
    return createdAtDelta;
  }

  return left.id.localeCompare(right.id);
}

function toArray<T>(value: T | readonly T[] | undefined): T[] {
  if (value === undefined) {
    return [];
  }

  return Array.isArray(value) ? [...(value as readonly T[])] : [value as T];
}

export class MemoryRepository {
  readonly db: SqlJsDatabase;
  private readonly clock: () => string;

  constructor(db: SqlJsDatabase, options: MemoryRepositoryOptions = {}) {
    this.db = db;
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.db.run("PRAGMA foreign_keys = ON;");
  }

  // ---------------------------------------------------------------------------------------
  // Create
  // ---------------------------------------------------------------------------------------

  /** Returns the live twin (by identity key, then semantic key) when one exists, otherwise creates. */
  createOrGet(input: CreateMemoryInput): CreateMemoryResult {
    const identityKey = createMemoryIdentityKey({
      type: input.type,
      summary: input.summary,
      details: input.details,
      scopeGlob: input.scopeGlob,
      lifecycleTriggers: input.lifecycleTriggers,
    });
    const byIdentity = this.getByIdentityKey(identityKey);

    if (byIdentity !== null) {
      return { memory: byIdentity, isNew: false };
    }

    const semanticKey = this.resolveSemanticKeyInput(input);
    if (semanticKey !== null) {
      const bySemantic = this.getBySemanticKey(semanticKey);

      if (bySemantic !== null) {
        return { memory: bySemantic, isNew: false };
      }
    }

    return { memory: this.create(input), isNew: true };
  }

  create(input: CreateMemoryInput): MemoryRecord {
    const authority = requireEnumInput(input.authority, "authority", AUTHORITIES);
    const sourceKind = requireEnumInput(input.sourceKind, "sourceKind", SOURCE_KINDS);
    const enforcement = optionalEnumInput(input.enforcement, "enforcement", ENFORCEMENTS, "advise");
    const knowledgeKind = optionalNullableEnumInput(input.knowledgeKind, "knowledgeKind", KNOWLEDGE_KINDS);
    const status = input.status ?? MEMORY_DEFAULTS.STATUS;

    if (!isMemoryStatus(status)) {
      throw new Error(`Invalid memory status: ${String(status)}`);
    }

    const identityKey = createMemoryIdentityKey({
      type: input.type,
      summary: input.summary,
      details: input.details,
      scopeGlob: input.scopeGlob,
      lifecycleTriggers: input.lifecycleTriggers,
    });
    const contentHash = createMemoryContentHash({
      summary: input.summary,
      details: input.details,
    });
    const triggerSignature = input.triggerSignature ?? null;
    const signatureKey = input.signatureKey ?? fallbackSignatureKey(triggerSignature);
    const semanticKey = this.resolveSemanticKeyInput(input, signatureKey);

    this.assertNoLiveTwin(identityKey, semanticKey, null);

    let id = input.id;
    if (id === undefined) {
      const existingRows = this.countRowsWithIdentityKey(identityKey);

      if (existingRows === 0) {
        id = createMemoryId(identityKey);
      } else if (input.reviveTerminal === true) {
        id = createRevivedMemoryId(identityKey, existingRows);
      } else {
        const twin = this.getByIdentityKey(identityKey, { live: false });
        throw new DuplicateMemoryContentError(identityKey, twin?.id ?? "unknown", "terminal_twin");
      }
    }

    const now = this.clock();
    const createdAt = input.createdAt ?? now;
    const updatedAt = input.updatedAt ?? createdAt;

    this.db.run(
      `
        INSERT INTO memories (
          id, content_hash, identity_key, type, summary, details, scope_glob, activation_class,
          lifecycle_triggers, confidence, importance, status, supersedes_memory_id, promotion_source,
          ttl_expires_at, validation_count, policy_subtype, created_at, updated_at, last_verified_at,
          embedding, embedding_summary, relevant_tools_json,
          semantic_key, trigger_signature_json, signature_key, knowledge_kind, failure_classes_json,
          status_reason, source_ref, revalidate_after, authority, enforcement, source_kind,
          needs_scope, import_unconfirmed, aliases_json
        )
        VALUES (
          $id, $contentHash, $identityKey, $type, $summary, $details, $scopeGlob, $activationClass,
          $lifecycleTriggers, $confidence, $importance, $status, $supersedesMemoryId, $promotionSource,
          $ttlExpiresAt, $validationCount, $policySubtype, $createdAt, $updatedAt, $lastVerifiedAt,
          $embedding, $embeddingSummary, $relevantToolsJson,
          $semanticKey, $triggerSignatureJson, $signatureKey, $knowledgeKind, $failureClassesJson,
          $statusReason, $sourceRef, $revalidateAfter, $authority, $enforcement, $sourceKind,
          $needsScope, $importUnconfirmed, $aliasesJson
        )
      `,
      {
        $id: id,
        $contentHash: contentHash,
        $identityKey: identityKey,
        $type: input.type,
        $summary: input.summary,
        $details: input.details,
        $scopeGlob: input.scopeGlob,
        $activationClass: input.activationClass ?? MEMORY_DEFAULTS.ACTIVATION_CLASS,
        $lifecycleTriggers: serializeLifecycleTriggers(input.lifecycleTriggers),
        $confidence: normalizeScore(input.confidence ?? MEMORY_DEFAULTS.CONFIDENCE, "confidence"),
        $importance: normalizeScore(input.importance ?? MEMORY_DEFAULTS.IMPORTANCE, "importance"),
        $status: status,
        $supersedesMemoryId: input.supersedesMemoryId ?? null,
        $promotionSource: input.promotionSource ?? "manual",
        $ttlExpiresAt: input.ttlExpiresAt ?? null,
        $validationCount: normalizeCount(input.validationCount ?? 0, "validationCount"),
        $policySubtype: input.policySubtype ?? null,
        $createdAt: createdAt,
        $updatedAt: updatedAt,
        $lastVerifiedAt: input.lastVerifiedAt ?? null,
        $embedding: blobOf(input.embedding),
        $embeddingSummary: blobOf(input.embeddingSummary),
        $relevantToolsJson: serializeRelevantTools(input.relevantTools ?? null),
        $semanticKey: semanticKey,
        $triggerSignatureJson: serializeTriggerSignature(triggerSignature),
        $signatureKey: signatureKey,
        $knowledgeKind: knowledgeKind,
        $failureClassesJson:
          input.failureClasses === undefined ? null : serializeStringArray(input.failureClasses),
        $statusReason: input.statusReason ?? null,
        $sourceRef: input.sourceRef ?? null,
        $revalidateAfter: input.revalidateAfter ?? null,
        $authority: authority,
        $enforcement: enforcement,
        $sourceKind: sourceKind,
        $needsScope: normalizeFlag(input.needsScope, 0),
        $importUnconfirmed: normalizeFlag(input.importUnconfirmed, 0),
        $aliasesJson: serializeStringArray(input.aliases),
      }
    );

    return this.requireMemory(id);
  }

  // ---------------------------------------------------------------------------------------
  // Lookups
  // ---------------------------------------------------------------------------------------

  getById(id: string): MemoryRecord | null {
    return this.selectOne(`SELECT ${MEMORY_SELECT_COLUMNS} FROM memories WHERE id = $id`, { $id: id });
  }

  getByContentHash(contentHash: string, options: LookupOptions = {}): MemoryRecord | null {
    return this.lookupByKey("content_hash", contentHash, options);
  }

  getByIdentityKey(identityKey: string, options: LookupOptions = {}): MemoryRecord | null {
    return this.lookupByKey("identity_key", identityKey, options);
  }

  getBySemanticKey(semanticKey: string, options: LookupOptions = {}): MemoryRecord | null {
    return this.lookupByKey("semantic_key", semanticKey, options);
  }

  list(input: ListMemoriesInput = {}): MemoryRecord[] {
    const params: SqlParameters = {};
    const where: string[] = [];

    const addIn = (column: string, values: readonly string[], prefix: string): void => {
      if (values.length === 0) {
        return;
      }

      const placeholders = values.map((_, index) => `$${prefix}${index}`);
      where.push(`${column} IN (${placeholders.join(", ")})`);
      values.forEach((value, index) => {
        params[`$${prefix}${index}`] = value;
      });
    };

    addIn("status", toArray(input.status), "status");
    addIn("type", toArray(input.type), "type");
    addIn("activation_class", toArray(input.activationClass), "activationClass");
    addIn("authority", toArray(input.authority), "authority");
    addIn("source_kind", toArray(input.sourceKind), "sourceKind");
    addIn("knowledge_kind", toArray(input.knowledgeKind), "knowledgeKind");

    if (input.scopeGlob !== undefined) {
      where.push("scope_glob = $scopeGlob");
      params.$scopeGlob = input.scopeGlob;
    }

    if (input.ttlExpiredBefore !== undefined) {
      where.push("ttl_expires_at IS NOT NULL AND ttl_expires_at <= $ttlExpiredBefore");
      params.$ttlExpiredBefore = input.ttlExpiredBefore;
    }

    if (input.revalidateDueBefore !== undefined) {
      where.push("revalidate_after IS NOT NULL AND revalidate_after <= $revalidateDueBefore");
      params.$revalidateDueBefore = input.revalidateDueBefore;
    }

    if (input.createdBefore !== undefined) {
      where.push("created_at < $createdBefore");
      params.$createdBefore = input.createdBefore;
    }

    if (input.needsScope !== undefined) {
      where.push("needs_scope = $needsScope");
      params.$needsScope = input.needsScope;
    }

    if (input.contested !== undefined) {
      where.push("contested = $contested");
      params.$contested = input.contested;
    }

    if (input.importUnconfirmed !== undefined) {
      where.push("import_unconfirmed = $importUnconfirmed");
      params.$importUnconfirmed = input.importUnconfirmed;
    }

    const limit = normalizeLimit(input.limit, "limit");
    const offset = normalizeLimit(input.offset, "offset");

    if (limit !== undefined) {
      params.$limit = limit;
    } else if (offset !== undefined) {
      params.$limit = -1;
    }

    if (offset !== undefined) {
      params.$offset = offset;
    }

    const clauses = [
      `SELECT ${MEMORY_SELECT_COLUMNS} FROM memories`,
      where.length > 0 ? `WHERE ${where.join(" AND ")}` : "",
      "ORDER BY created_at DESC, id ASC",
      params.$limit !== undefined ? "LIMIT $limit" : "",
      offset !== undefined ? "OFFSET $offset" : "",
    ].filter((clause) => clause.length > 0);

    return this.selectMany(clauses.join(" "), params);
  }

  listWithEmbeddings(): MemoryRecord[] {
    return this.selectMany(
      `SELECT ${MEMORY_SELECT_COLUMNS} FROM memories WHERE embedding IS NOT NULL ORDER BY created_at DESC, id ASC`,
      {}
    );
  }

  countByStatus(): Record<MemoryStatus, number> {
    const counts: Record<MemoryStatus, number> = {
      candidate: 0,
      active: 0,
      stale: 0,
      superseded: 0,
      rejected: 0,
    };
    const statement = this.db.prepare("SELECT status, COUNT(*) AS n FROM memories GROUP BY status");

    try {
      while (statement.step()) {
        const row = statement.getAsObject();
        const status = expectMemoryStatus(row.status);
        counts[status] = expectNumber(row.n, "n");
      }
    } finally {
      statement.free();
    }

    return counts;
  }

  // ---------------------------------------------------------------------------------------
  // Evidence (manual notes; the v0.6 write path uses memory_provenance instead)
  // ---------------------------------------------------------------------------------------

  createEvidence(input: CreateEvidenceInput): EvidenceRecord {
    this.requireMemory(input.memoryId);

    const createdAt = input.createdAt ?? this.clock();
    const id =
      input.id ??
      createDeterministicId(
        ["evidence", input.memoryId, input.sourceKind, input.sourceRef, input.excerpt, createdAt].join(":")
      );

    this.db.run(
      `
        INSERT INTO evidence (id, memory_id, source_kind, source_ref, excerpt, created_at)
        VALUES ($id, $memoryId, $sourceKind, $sourceRef, $excerpt, $createdAt)
      `,
      {
        $id: id,
        $memoryId: input.memoryId,
        $sourceKind: input.sourceKind,
        $sourceRef: input.sourceRef,
        $excerpt: input.excerpt,
        $createdAt: createdAt,
      }
    );

    const created = this.selectOneEvidence(
      `SELECT ${EVIDENCE_SELECT_COLUMNS} FROM evidence WHERE id = $id`,
      { $id: id }
    );

    if (created === null) {
      throw new Error(`Failed to load created evidence ${id}`);
    }

    return created;
  }

  listEvidence(memoryId: string): EvidenceRecord[] {
    this.requireMemory(memoryId);

    return this.selectManyEvidence(
      `
        SELECT ${EVIDENCE_SELECT_COLUMNS}
        FROM evidence
        WHERE memory_id = $memoryId
        ORDER BY created_at ASC, id ASC
      `,
      { $memoryId: memoryId }
    );
  }

  // ---------------------------------------------------------------------------------------
  // Lineage
  // ---------------------------------------------------------------------------------------

  getLineage(memoryId: string): MemoryLineage {
    const focus = this.requireMemory(memoryId);
    const ancestors: MemoryRecord[] = [];
    const ancestorIds = new Set<string>([focus.id]);
    let currentSupersedesId = focus.supersedesMemoryId;

    while (currentSupersedesId !== null && !ancestorIds.has(currentSupersedesId)) {
      const ancestor = this.requireMemory(currentSupersedesId);
      ancestors.push(ancestor);
      ancestorIds.add(ancestor.id);
      currentSupersedesId = ancestor.supersedesMemoryId;
    }

    ancestors.reverse();

    return {
      root: ancestors[0] ?? focus,
      focus,
      ancestors,
      descendants: this.collectDescendants(focus.id, new Set<string>([focus.id])),
    };
  }

  getHistory(memoryId: string): MemoryHistoryEntry[] {
    const lineage = this.getLineage(memoryId);
    const orderedMemories = [...lineage.ancestors, lineage.focus, ...lineage.descendants];
    const evidenceByMemoryId = this.listEvidenceByMemoryIds(orderedMemories.map((memory) => memory.id));
    const ancestorIds = new Set(lineage.ancestors.map((memory) => memory.id));
    const descendantIds = new Set(lineage.descendants.map((memory) => memory.id));

    return orderedMemories.map((memory) => {
      let relation: MemoryHistoryRelation = "focus";

      if (ancestorIds.has(memory.id)) {
        relation = "ancestor";
      } else if (descendantIds.has(memory.id)) {
        relation = "descendant";
      }

      return {
        relation,
        memory,
        evidence: evidenceByMemoryId.get(memory.id) ?? [],
      };
    });
  }

  listLineageConflicts(memoryIds: readonly string[]): MemoryConflictRecord[] {
    const candidateMemories = Array.from(new Set(memoryIds)).map((memoryId) => this.requireMemory(memoryId));
    const groups = new Map<string, MemoryConflictRecord>();

    for (const memory of candidateMemories) {
      const lifecycleKey = serializeLifecycleTriggers(memory.lifecycleTriggers);
      const conflictKey = [memory.type, memory.scopeGlob, lifecycleKey].join("|");
      const existing = groups.get(conflictKey);

      if (existing === undefined) {
        groups.set(conflictKey, { key: conflictKey, root: memory, memories: [memory] });
        continue;
      }

      existing.memories.push(memory);
      if (compareMemoryByCreatedAt(memory, existing.root) < 0) {
        existing.root = memory;
      }
    }

    return Array.from(groups.values())
      .map((group) => ({ ...group, memories: [...group.memories].sort(compareMemoryByCreatedAt) }))
      .filter((group) => group.memories.length > 1);
  }

  // ---------------------------------------------------------------------------------------
  // Update (content fields only; status/authority are rejected)
  // ---------------------------------------------------------------------------------------

  update(id: string, input: UpdateMemoryInput): MemoryRecord | null {
    if ((input as { status?: unknown }).status !== undefined) {
      throw new InvalidMemoryTransitionError("status changes go through transitionMemory");
    }

    if ((input as { authority?: unknown }).authority !== undefined) {
      throw new InvalidMemoryTransitionError("authority changes go through setAuthority");
    }

    const existing = this.getById(id);

    if (existing === null) {
      return null;
    }

    const summary = input.summary ?? existing.summary;
    const details = input.details ?? existing.details;
    const type = input.type ?? existing.type;
    const scopeGlob = input.scopeGlob ?? existing.scopeGlob;
    const lifecycleTriggers = input.lifecycleTriggers ?? existing.lifecycleTriggers;
    const knowledgeKind =
      input.knowledgeKind === undefined
        ? existing.knowledgeKind
        : optionalNullableEnumInput(input.knowledgeKind, "knowledgeKind", KNOWLEDGE_KINDS);
    const contentHash = createMemoryContentHash({ summary, details });
    const identityKey = createMemoryIdentityKey({ type, summary, details, scopeGlob, lifecycleTriggers });
    const semanticKey =
      existing.semanticKey === null
        ? null
        : computeSemanticKey(type, scopeGlob, existing.signatureKey, summary);

    this.assertNoLiveTwin(identityKey, semanticKey, id);

    const embeddingSummaryBlob =
      input.embeddingSummary === undefined ? blobOf(existing.embeddingSummary) : blobOf(input.embeddingSummary);

    this.db.run(
      `
        UPDATE memories
        SET
          content_hash = $contentHash,
          identity_key = $identityKey,
          semantic_key = $semanticKey,
          type = $type,
          summary = $summary,
          details = $details,
          scope_glob = $scopeGlob,
          activation_class = $activationClass,
          lifecycle_triggers = $lifecycleTriggers,
          confidence = $confidence,
          importance = $importance,
          supersedes_memory_id = $supersedesMemoryId,
          promotion_source = $promotionSource,
          policy_subtype = $policySubtype,
          ttl_expires_at = $ttlExpiresAt,
          validation_count = $validationCount,
          embedding_summary = $embeddingSummary,
          relevant_tools_json = $relevantToolsJson,
          knowledge_kind = $knowledgeKind,
          source_ref = $sourceRef,
          aliases_json = $aliasesJson,
          failure_classes_json = $failureClassesJson,
          updated_at = $updatedAt,
          last_verified_at = $lastVerifiedAt
        WHERE id = $id
      `,
      {
        $id: id,
        $contentHash: contentHash,
        $identityKey: identityKey,
        $semanticKey: semanticKey,
        $type: type,
        $summary: summary,
        $details: details,
        $scopeGlob: scopeGlob,
        $activationClass: input.activationClass ?? existing.activationClass,
        $lifecycleTriggers: serializeLifecycleTriggers(lifecycleTriggers),
        $confidence: normalizeScore(input.confidence ?? existing.confidence, "confidence"),
        $importance: normalizeScore(input.importance ?? existing.importance, "importance"),
        $supersedesMemoryId:
          input.supersedesMemoryId !== undefined ? input.supersedesMemoryId : existing.supersedesMemoryId,
        $promotionSource: input.promotionSource ?? existing.promotionSource,
        $policySubtype: input.policySubtype !== undefined ? input.policySubtype : existing.policySubtype,
        $ttlExpiresAt: input.ttlExpiresAt !== undefined ? input.ttlExpiresAt : existing.ttlExpiresAt,
        $validationCount: normalizeCount(input.validationCount ?? existing.validationCount, "validationCount"),
        $embeddingSummary: embeddingSummaryBlob,
        $relevantToolsJson: serializeRelevantTools(
          input.relevantTools !== undefined ? input.relevantTools : existing.relevantTools
        ),
        $knowledgeKind: knowledgeKind,
        $sourceRef: input.sourceRef !== undefined ? input.sourceRef : existing.sourceRef,
        $aliasesJson: serializeStringArray(input.aliases ?? existing.aliases),
        $failureClassesJson:
          input.failureClasses !== undefined
            ? serializeStringArray(input.failureClasses)
            : existing.failureClasses.length === 0
              ? null
              : serializeStringArray(existing.failureClasses),
        $updatedAt: input.updatedAt ?? this.clock(),
        $lastVerifiedAt: input.lastVerifiedAt !== undefined ? input.lastVerifiedAt : existing.lastVerifiedAt,
      }
    );

    return this.getById(id);
  }

  updateEmbedding(id: string, embedding: Float32Array): void {
    this.db.run("UPDATE memories SET embedding = ? WHERE id = ?", [blobOf(embedding), id]);
  }

  updateEmbeddingSummary(id: string, embedding: Float32Array): void {
    this.db.run("UPDATE memories SET embedding_summary = ? WHERE id = ?", [blobOf(embedding), id]);
  }

  // ---------------------------------------------------------------------------------------
  // Focused mutators (v0.6)
  // ---------------------------------------------------------------------------------------

  /** Derived counters from memory_provenance (spec §5.7 step 4). `confidence` is written only when given. */
  updateDerived(id: string, input: UpdateDerivedInput): MemoryRecord {
    const existing = this.requireMemory(id);
    const confidence =
      input.confidence === undefined ? existing.confidence : normalizeScore(input.confidence, "confidence");

    this.db.run(
      `
        UPDATE memories
        SET evidence_score = $evidenceScore,
            evidence_count = $evidenceCount,
            distinct_session_count = $distinctSessionCount,
            confidence = $confidence,
            updated_at = $updatedAt
        WHERE id = $id
      `,
      {
        $id: id,
        $evidenceScore: input.evidenceScore,
        $evidenceCount: normalizeCount(input.evidenceCount, "evidenceCount"),
        $distinctSessionCount: normalizeCount(input.distinctSessionCount, "distinctSessionCount"),
        $confidence: confidence,
        $updatedAt: input.updatedAt ?? existing.updatedAt,
      }
    );

    return this.requireMemory(id);
  }

  /** Roll-up of `fired` ledger lines (spec §9.3 B): fire_count += count, override_count += overrideDelta, last_fired_at = max. */
  recordFire(id: string, input: RecordFireInput): MemoryRecord {
    const existing = this.requireMemory(id);
    const count = normalizeCount(input.count ?? 1, "count");
    const overrideDelta = normalizeCount(input.overrideDelta ?? 0, "overrideDelta");

    this.db.run(
      `
        UPDATE memories
        SET fire_count = fire_count + $count,
            override_count = override_count + $overrideDelta,
            last_fired_at = $lastFiredAt
        WHERE id = $id
      `,
      {
        $id: id,
        $count: count,
        $overrideDelta: overrideDelta,
        $lastFiredAt: maxIso(existing.lastFiredAt, input.at),
      }
    );

    return this.requireMemory(id);
  }

  setEnforcement(id: string, enforcement: Enforcement, updatedAt?: string): MemoryRecord {
    this.requireMemory(id);
    const value = requireEnumInput(enforcement, "enforcement", ENFORCEMENTS);

    this.db.run("UPDATE memories SET enforcement = $enforcement, updated_at = $updatedAt WHERE id = $id", {
      $id: id,
      $enforcement: value,
      $updatedAt: updatedAt ?? this.clock(),
    });

    return this.requireMemory(id);
  }

  /** Scope / trigger / signature change; recomputes identity_key and (by default) semantic_key. */
  setScope(id: string, input: SetScopeInput): MemoryRecord {
    const existing = this.requireMemory(id);
    const lifecycleTriggers = input.lifecycleTriggers ?? existing.lifecycleTriggers;
    const triggerSignature =
      input.triggerSignature === undefined ? existing.triggerSignature : input.triggerSignature;
    const signatureKey =
      input.signatureKey ??
      (input.triggerSignature === undefined ? existing.signatureKey : fallbackSignatureKey(triggerSignature));
    const identityKey = createMemoryIdentityKey({
      type: existing.type,
      summary: existing.summary,
      details: existing.details,
      scopeGlob: input.scopeGlob,
      lifecycleTriggers,
    });
    const semanticKey =
      input.semanticKey === undefined
        ? computeSemanticKey(existing.type, input.scopeGlob, signatureKey, existing.summary)
        : input.semanticKey;

    this.assertNoLiveTwin(identityKey, semanticKey, id);

    this.db.run(
      `
        UPDATE memories
        SET scope_glob = $scopeGlob,
            lifecycle_triggers = $lifecycleTriggers,
            activation_class = $activationClass,
            identity_key = $identityKey,
            trigger_signature_json = $triggerSignatureJson,
            signature_key = $signatureKey,
            semantic_key = $semanticKey,
            updated_at = $updatedAt
        WHERE id = $id
      `,
      {
        $id: id,
        $scopeGlob: input.scopeGlob,
        $lifecycleTriggers: serializeLifecycleTriggers(lifecycleTriggers),
        $activationClass: input.activationClass ?? existing.activationClass,
        $identityKey: identityKey,
        $triggerSignatureJson: serializeTriggerSignature(triggerSignature),
        $signatureKey: signatureKey,
        $semanticKey: semanticKey,
        $updatedAt: input.updatedAt ?? this.clock(),
      }
    );

    return this.requireMemory(id);
  }

  /**
   * The only writer of `authority` (spec §7.1). Human rows carry no TTL, so setting `human`
   * clears ttl_expires_at / revalidate_after and marks promotion_source 'manual'.
   */
  setAuthority(id: string, authority: Authority, updatedAt?: string): MemoryRecord {
    this.requireMemory(id);
    const value = requireEnumInput(authority, "authority", AUTHORITIES);

    if (value === "human") {
      this.db.run(
        `
          UPDATE memories
          SET authority = 'human',
              promotion_source = 'manual',
              ttl_expires_at = NULL,
              revalidate_after = NULL,
              updated_at = $updatedAt
          WHERE id = $id
        `,
        { $id: id, $updatedAt: updatedAt ?? this.clock() }
      );
    } else {
      this.db.run("UPDATE memories SET authority = 'auto', updated_at = $updatedAt WHERE id = $id", {
        $id: id,
        $updatedAt: updatedAt ?? this.clock(),
      });
    }

    return this.requireMemory(id);
  }

  setFlags(id: string, input: SetFlagsInput): MemoryRecord {
    const existing = this.requireMemory(id);

    this.db.run(
      `
        UPDATE memories
        SET contested = $contested,
            needs_scope = $needsScope,
            import_unconfirmed = $importUnconfirmed,
            open_proposal_id = $openProposalId,
            updated_at = $updatedAt
        WHERE id = $id
      `,
      {
        $id: id,
        $contested: normalizeFlag(input.contested, existing.contested),
        $needsScope: normalizeFlag(input.needsScope, existing.needsScope),
        $importUnconfirmed: normalizeFlag(input.importUnconfirmed, existing.importUnconfirmed),
        $openProposalId: input.openProposalId !== undefined ? input.openProposalId : existing.openProposalId,
        $updatedAt: input.updatedAt ?? existing.updatedAt,
      }
    );

    return this.requireMemory(id);
  }

  setTtl(id: string, input: SetTtlInput): MemoryRecord {
    const existing = this.requireMemory(id);

    this.db.run(
      `
        UPDATE memories
        SET ttl_expires_at = $ttlExpiresAt,
            revalidate_after = $revalidateAfter,
            validation_count = $validationCount,
            last_verified_at = $lastVerifiedAt,
            updated_at = $updatedAt
        WHERE id = $id
      `,
      {
        $id: id,
        $ttlExpiresAt: input.ttlExpiresAt,
        $revalidateAfter: input.revalidateAfter,
        $validationCount: normalizeCount(input.validationCount ?? existing.validationCount, "validationCount"),
        $lastVerifiedAt: input.lastVerifiedAt !== undefined ? input.lastVerifiedAt : existing.lastVerifiedAt,
        $updatedAt: input.updatedAt ?? existing.updatedAt,
      }
    );

    return this.requireMemory(id);
  }

  setAliases(id: string, aliases: readonly string[], updatedAt?: string): MemoryRecord {
    this.requireMemory(id);

    this.db.run("UPDATE memories SET aliases_json = $aliasesJson, updated_at = $updatedAt WHERE id = $id", {
      $id: id,
      $aliasesJson: serializeStringArray(aliases),
      $updatedAt: updatedAt ?? this.clock(),
    });

    return this.requireMemory(id);
  }

  // ---------------------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------------------

  private resolveSemanticKeyInput(input: CreateMemoryInput, signatureKey?: string): string | null {
    if (input.semanticKey !== undefined) {
      return input.semanticKey;
    }

    const key = signatureKey ?? input.signatureKey ?? fallbackSignatureKey(input.triggerSignature ?? null);

    return computeSemanticKey(input.type, input.scopeGlob, key, input.summary);
  }

  private assertNoLiveTwin(identityKey: string, semanticKey: string | null, selfId: string | null): void {
    const byIdentity = this.getByIdentityKey(identityKey);

    if (byIdentity !== null && byIdentity.id !== selfId) {
      throw new DuplicateMemoryContentError(identityKey, byIdentity.id, "identity_key");
    }

    if (semanticKey !== null) {
      const bySemantic = this.getBySemanticKey(semanticKey);

      if (bySemantic !== null && bySemantic.id !== selfId) {
        throw new DuplicateMemoryContentError(semanticKey, bySemantic.id, "semantic_key");
      }
    }
  }

  private countRowsWithIdentityKey(identityKey: string): number {
    const statement = this.db.prepare("SELECT COUNT(*) AS n FROM memories WHERE identity_key = $identityKey");

    try {
      statement.bind({ $identityKey: identityKey });
      statement.step();
      return expectNumber(statement.getAsObject().n, "n");
    } finally {
      statement.free();
    }
  }

  private lookupByKey(
    column: "identity_key" | "semantic_key" | "content_hash",
    value: string,
    options: LookupOptions
  ): MemoryRecord | null {
    const live = options.live ?? true;
    const where = live ? `${column} = $value AND status IN (${LIVE_STATUS_SQL_LIST})` : `${column} = $value`;

    return this.selectOne(
      `
        SELECT ${MEMORY_SELECT_COLUMNS}
        FROM memories
        WHERE ${where}
        ORDER BY CASE WHEN status IN (${LIVE_STATUS_SQL_LIST}) THEN 0 ELSE 1 END, created_at DESC, id ASC
        LIMIT 1
      `,
      { $value: value }
    );
  }

  private requireMemory(id: string): MemoryRecord {
    const memory = this.getById(id);

    if (memory === null) {
      throw new MemoryNotFoundError(id);
    }

    return memory;
  }

  private collectDescendants(memoryId: string, visited: Set<string>): MemoryRecord[] {
    const descendants: MemoryRecord[] = [];
    const directDescendants = this.selectMany(
      `
        SELECT ${MEMORY_SELECT_COLUMNS}
        FROM memories
        WHERE supersedes_memory_id = $memoryId
        ORDER BY created_at ASC, id ASC
      `,
      { $memoryId: memoryId }
    );

    for (const descendant of directDescendants) {
      if (visited.has(descendant.id)) {
        continue;
      }

      visited.add(descendant.id);
      descendants.push(descendant);
      descendants.push(...this.collectDescendants(descendant.id, visited));
    }

    return descendants;
  }

  private listEvidenceByMemoryIds(memoryIds: readonly string[]): Map<string, EvidenceRecord[]> {
    const uniqueMemoryIds = Array.from(new Set(memoryIds));
    const evidenceByMemoryId = new Map<string, EvidenceRecord[]>();

    if (uniqueMemoryIds.length === 0) {
      return evidenceByMemoryId;
    }

    const params: SqlParameters = {};
    const placeholders = uniqueMemoryIds.map((memoryId, index) => {
      const parameterName = `$memoryId${index}`;
      params[parameterName] = memoryId;
      return parameterName;
    });
    const evidenceRecords = this.selectManyEvidence(
      `
        SELECT ${EVIDENCE_SELECT_COLUMNS}
        FROM evidence
        WHERE memory_id IN (${placeholders.join(", ")})
        ORDER BY created_at ASC, id ASC
      `,
      params
    );

    for (const evidence of evidenceRecords) {
      const existing = evidenceByMemoryId.get(evidence.memoryId) ?? [];
      existing.push(evidence);
      evidenceByMemoryId.set(evidence.memoryId, existing);
    }

    for (const evidenceList of evidenceByMemoryId.values()) {
      evidenceList.sort(compareEvidenceByCreatedAt);
    }

    return evidenceByMemoryId;
  }

  private selectOne(sql: string, params: SqlParameters): MemoryRecord | null {
    const statement = this.db.prepare(sql);

    try {
      statement.bind(params);

      if (!statement.step()) {
        return null;
      }

      return mapMemoryRow(statement.getAsObject());
    } finally {
      statement.free();
    }
  }

  private selectMany(sql: string, params: SqlParameters): MemoryRecord[] {
    const statement = this.db.prepare(sql);

    try {
      statement.bind(params);

      const rows: MemoryRecord[] = [];

      while (statement.step()) {
        rows.push(mapMemoryRow(statement.getAsObject()));
      }

      return rows;
    } finally {
      statement.free();
    }
  }

  private selectOneEvidence(sql: string, params: SqlParameters): EvidenceRecord | null {
    const statement = this.db.prepare(sql);

    try {
      statement.bind(params);

      if (!statement.step()) {
        return null;
      }

      return mapEvidenceRow(statement.getAsObject());
    } finally {
      statement.free();
    }
  }

  private selectManyEvidence(sql: string, params: SqlParameters): EvidenceRecord[] {
    const statement = this.db.prepare(sql);

    try {
      statement.bind(params);

      const rows: EvidenceRecord[] = [];

      while (statement.step()) {
        rows.push(mapEvidenceRow(statement.getAsObject()));
      }

      return rows;
    } finally {
      statement.free();
    }
  }
}

/** Maps a `memories` row (any projection containing MEMORY_SELECT_COLUMNS) onto a MemoryRecord. */
export function mapMemoryRow(row: SqlRow): MemoryRecord {
  return {
    id: expectString(row.id, "id"),
    contentHash: expectString(row.content_hash, "content_hash"),
    identityKey: expectNullableString(row.identity_key, "identity_key"),
    type: expectMemoryType(row.type),
    summary: expectString(row.summary, "summary"),
    details: expectString(row.details, "details"),
    scopeGlob: expectString(row.scope_glob, "scope_glob"),
    lifecycleTriggers: parseLifecycleTriggers(expectString(row.lifecycle_triggers, "lifecycle_triggers")),
    confidence: expectNumber(row.confidence, "confidence"),
    importance: expectNumber(row.importance, "importance"),
    status: expectMemoryStatus(row.status),
    supersedesMemoryId: expectNullableString(row.supersedes_memory_id, "supersedes_memory_id"),
    promotionSource: expectEnum(row.promotion_source, "promotion_source", ["manual", "auto"] as const),
    ttlExpiresAt: expectNullableString(row.ttl_expires_at, "ttl_expires_at"),
    validationCount: expectNumber(row.validation_count, "validation_count"),
    policySubtype: expectNullableEnum(row.policy_subtype, "policy_subtype", ["hard", "soft"] as const),
    createdAt: expectString(row.created_at, "created_at"),
    updatedAt: expectString(row.updated_at, "updated_at"),
    lastVerifiedAt: expectNullableString(row.last_verified_at, "last_verified_at"),
    activationClass: expectActivationClass(row.activation_class),
    embedding: vectorOf(row.embedding),
    embeddingSummary: vectorOf(row.embedding_summary),
    relevantTools: parseRelevantTools(expectNullableString(row.relevant_tools_json, "relevant_tools_json")),
    semanticKey: expectNullableString(row.semantic_key, "semantic_key"),
    triggerSignature: parseTriggerSignature(
      expectNullableString(row.trigger_signature_json, "trigger_signature_json")
    ),
    signatureKey: expectString(row.signature_key, "signature_key"),
    knowledgeKind: expectNullableEnum(row.knowledge_kind, "knowledge_kind", KNOWLEDGE_KINDS),
    failureClasses: parseStringArray(
      expectNullableString(row.failure_classes_json, "failure_classes_json"),
      "failure_classes_json"
    ),
    statusReason: expectNullableString(row.status_reason, "status_reason"),
    supersededByMemoryId: expectNullableString(row.superseded_by_memory_id, "superseded_by_memory_id"),
    sourceRef: expectNullableString(row.source_ref, "source_ref"),
    revalidateAfter: expectNullableString(row.revalidate_after, "revalidate_after"),
    lastFiredAt: expectNullableString(row.last_fired_at, "last_fired_at"),
    openProposalId: expectNullableString(row.open_proposal_id, "open_proposal_id"),
    authority: expectEnum(row.authority, "authority", AUTHORITIES),
    enforcement: expectEnum(row.enforcement, "enforcement", ENFORCEMENTS),
    sourceKind: expectEnum(row.source_kind, "source_kind", SOURCE_KINDS),
    evidenceScore: expectNumber(row.evidence_score, "evidence_score"),
    evidenceCount: expectNumber(row.evidence_count, "evidence_count"),
    distinctSessionCount: expectNumber(row.distinct_session_count, "distinct_session_count"),
    fireCount: expectNumber(row.fire_count, "fire_count"),
    overrideCount: expectNumber(row.override_count, "override_count"),
    contested: expectFlag(row.contested, "contested"),
    needsScope: expectFlag(row.needs_scope, "needs_scope"),
    importUnconfirmed: expectFlag(row.import_unconfirmed, "import_unconfirmed"),
    aliases: parseStringArray(expectString(row.aliases_json, "aliases_json"), "aliases_json"),
  };
}

function mapEvidenceRow(row: SqlRow): EvidenceRecord {
  return {
    id: expectString(row.id, "id"),
    memoryId: expectString(row.memory_id, "memory_id"),
    sourceKind: expectEvidenceSourceKind(row.source_kind),
    sourceRef: expectString(row.source_ref, "source_ref"),
    excerpt: expectString(row.excerpt, "excerpt"),
    createdAt: expectString(row.created_at, "created_at"),
  };
}

/** Column list used by every memory SELECT; exported so other repositories can project identically. */
export { MEMORY_SELECT_COLUMNS };
