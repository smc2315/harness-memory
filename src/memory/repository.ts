import type { Database as SqlJsDatabase } from "sql.js";

import {
  type ActivationClass,
  type EvidenceSourceKind,
  MEMORY_DEFAULTS,
  type LifecycleTrigger,
  type MemoryStatus,
  type MemoryType,
} from "../db/schema/types";
import {
  createDeterministicId,
  createMemoryContentHash,
  createMemoryIdentityKey,
  createMemoryId,
  parseLifecycleTriggers,
  parseRelevantTools,
  serializeLifecycleTriggers,
  serializeRelevantTools,
} from "./utils";

type SqlParameter = string | number | Uint8Array | null;
type SqlParameters = Record<string, SqlParameter>;

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
].join(", ");

const EVIDENCE_SELECT_COLUMNS = [
  "id",
  "memory_id",
  "source_kind",
  "source_ref",
  "excerpt",
  "created_at",
].join(", ");

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
  promotionSource: "manual" | "auto";
  ttlExpiresAt: string | null;
  validationCount: number;
  policySubtype: "hard" | "soft" | null;
  createdAt: string;
  updatedAt: string;
  lastVerifiedAt: string | null;
  embedding: Float32Array | null;
  embeddingSummary: Float32Array | null;
  relevantTools: string[] | null;
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
  relevantTools?: string[] | null;
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
  status?: MemoryStatus;
  supersedesMemoryId?: string | null;
  promotionSource?: "manual" | "auto";
  ttlExpiresAt?: string | null;
  validationCount?: number;
  updatedAt?: string;
  lastVerifiedAt?: string | null;
  embeddingSummary?: Float32Array | null;
  relevantTools?: string[] | null;
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
  limit?: number;
  offset?: number;
}

export interface CreateMemoryResult {
  memory: MemoryRecord;
  isNew: boolean;
}

export interface MergeMemoriesInput {
  sourceMemoryId: string;
  targetMemoryId: string;
  targetUpdate?: UpdateMemoryInput;
  updatedAt?: string;
}

export interface MergeMemoriesResult {
  source: MemoryRecord;
  target: MemoryRecord;
}

export interface ReplaceMemoryInput {
  previousMemoryId: string;
  replacementMemoryId: string;
  replacementUpdate?: UpdateMemoryInput;
  updatedAt?: string;
}

export interface ReplaceMemoryResult {
  previous: MemoryRecord;
  replacement: MemoryRecord;
}

export interface RejectMemoryInput {
  memoryId: string;
  reason?: string;
  sourceRef?: string;
  updatedAt?: string;
  lastVerifiedAt?: string | null;
}

export interface RejectMemoryResult {
  memory: MemoryRecord;
  evidence: EvidenceRecord | null;
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

export class DuplicateMemoryContentError extends Error {
  readonly contentHash: string;
  readonly existingMemoryId: string;

  constructor(contentHash: string, existingMemoryId: string) {
    super(
      `Memory content already exists for hash ${contentHash} (memory ${existingMemoryId})`
    );
    this.name = "DuplicateMemoryContentError";
    this.contentHash = contentHash;
    this.existingMemoryId = existingMemoryId;
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
  if (value === null) {
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
  if (value < 0 || value > 1) {
    throw new Error(`${field} must be between 0 and 1`);
  }

  return value;
}

function normalizeLimit(value: number | undefined, field: "limit" | "offset"): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative integer`);
  }

  return value;
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

function isMemoryStatusArray(
  value: ListMemoriesInput["status"]
): value is readonly MemoryStatus[] {
  return Array.isArray(value);
}

function isMemoryTypeArray(
  value: ListMemoriesInput["type"]
): value is readonly MemoryType[] {
  return Array.isArray(value);
}

function isActivationClassArray(
  value: ListMemoriesInput["activationClass"]
): value is readonly ActivationClass[] {
  return Array.isArray(value);
}

function toStatusArray(value: ListMemoriesInput["status"]): MemoryStatus[] {
  if (value === undefined) {
    return [];
  }

  return isMemoryStatusArray(value) ? [...value] : [value];
}

function toTypeArray(value: ListMemoriesInput["type"]): MemoryType[] {
  if (value === undefined) {
    return [];
  }

  return isMemoryTypeArray(value) ? [...value] : [value];
}

function toActivationClassArray(
  value: ListMemoriesInput["activationClass"]
): ActivationClass[] {
  if (value === undefined) {
    return [];
  }

  return isActivationClassArray(value) ? [...value] : [value];
}

export class MemoryRepository {
  readonly db: SqlJsDatabase;

  constructor(db: SqlJsDatabase) {
    this.db = db;
    this.db.run("PRAGMA foreign_keys = ON;");
  }

  createOrGet(input: CreateMemoryInput): CreateMemoryResult {
    const existing = this.findExactDuplicate({
      type: input.type,
      summary: input.summary,
      details: input.details,
      scopeGlob: input.scopeGlob,
      lifecycleTriggers: input.lifecycleTriggers,
    });

    if (existing !== null) {
      return {
        memory: existing,
        isNew: false,
      };
    }

    return {
      memory: this.create(input),
      isNew: true,
    };
  }

  create(input: CreateMemoryInput): MemoryRecord {
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
    const existing = this.findExactDuplicate({
      type: input.type,
      summary: input.summary,
      details: input.details,
      scopeGlob: input.scopeGlob,
      lifecycleTriggers: input.lifecycleTriggers,
    });

    if (existing !== null) {
      throw new DuplicateMemoryContentError(identityKey, existing.id);
    }

    const now = new Date().toISOString();
    const createdAt = input.createdAt ?? now;
    const updatedAt = input.updatedAt ?? createdAt;
    const id = input.id ?? createMemoryId(identityKey);
    const embeddingBlob =
      input.embedding === undefined || input.embedding === null
        ? null
        : new Uint8Array(
            input.embedding.buffer,
            input.embedding.byteOffset,
            input.embedding.byteLength
          );
    const embeddingSummaryBlob =
      input.embeddingSummary === undefined || input.embeddingSummary === null
        ? null
        : new Uint8Array(
            input.embeddingSummary.buffer,
            input.embeddingSummary.byteOffset,
            input.embeddingSummary.byteLength
          );

    this.db.run(
      `
        INSERT INTO memories (
          id,
          content_hash,
          identity_key,
          type,
          summary,
          details,
          scope_glob,
          activation_class,
          lifecycle_triggers,
          confidence,
          importance,
          status,
          supersedes_memory_id,
          created_at,
          updated_at,
          last_verified_at,
          embedding,
          embedding_summary,
          relevant_tools_json
        )
        VALUES (
          $id,
          $contentHash,
          $identityKey,
          $type,
          $summary,
          $details,
          $scopeGlob,
          $activationClass,
          $lifecycleTriggers,
          $confidence,
          $importance,
          $status,
          $supersedesMemoryId,
          $createdAt,
          $updatedAt,
          $lastVerifiedAt,
          $embedding,
          $embeddingSummary,
          $relevantToolsJson
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
        $activationClass:
          input.activationClass ?? MEMORY_DEFAULTS.ACTIVATION_CLASS,
        $lifecycleTriggers: serializeLifecycleTriggers(input.lifecycleTriggers),
        $confidence: normalizeScore(
          input.confidence ?? MEMORY_DEFAULTS.CONFIDENCE,
          "confidence"
        ),
        $importance: normalizeScore(
          input.importance ?? MEMORY_DEFAULTS.IMPORTANCE,
          "importance"
        ),
        $status: input.status ?? MEMORY_DEFAULTS.STATUS,
        $supersedesMemoryId: input.supersedesMemoryId ?? null,
        $createdAt: createdAt,
        $updatedAt: updatedAt,
        $lastVerifiedAt: input.lastVerifiedAt ?? null,
        $embedding: embeddingBlob,
        $embeddingSummary: embeddingSummaryBlob,
        $relevantToolsJson: serializeRelevantTools(input.relevantTools ?? null),
      }
    );

    const created = this.getById(id);

    if (created === null) {
      throw new Error(`Failed to load created memory ${id}`);
    }

    return created;
  }

  getById(id: string): MemoryRecord | null {
    return this.selectOne(
      `SELECT ${MEMORY_SELECT_COLUMNS} FROM memories WHERE id = $id`,
      { $id: id }
    );
  }

  getByContentHash(contentHash: string): MemoryRecord | null {
    return this.selectOne(
      `SELECT ${MEMORY_SELECT_COLUMNS} FROM memories WHERE content_hash = $contentHash`,
      { $contentHash: contentHash }
    );
  }

  getByIdentityKey(identityKey: string): MemoryRecord | null {
    return this.selectOne(
      `SELECT ${MEMORY_SELECT_COLUMNS} FROM memories WHERE identity_key = $identityKey`,
      { $identityKey: identityKey }
    );
  }

  list(input: ListMemoriesInput = {}): MemoryRecord[] {
    const params: SqlParameters = {};
    const where: string[] = [];

    const statuses = toStatusArray(input.status);
    if (statuses.length > 0) {
      const placeholders = statuses.map((_, index) => `$status${index}`);
      where.push(`status IN (${placeholders.join(", ")})`);
      statuses.forEach((status, index) => {
        params[`$status${index}`] = status;
      });
    }

    const types = toTypeArray(input.type);
    if (types.length > 0) {
      const placeholders = types.map((_, index) => `$type${index}`);
      where.push(`type IN (${placeholders.join(", ")})`);
      types.forEach((type, index) => {
        params[`$type${index}`] = type;
      });
    }

    const activationClasses = toActivationClassArray(input.activationClass);
    if (activationClasses.length > 0) {
      const placeholders = activationClasses.map(
        (_, index) => `$activationClass${index}`
      );
      where.push(`activation_class IN (${placeholders.join(", ")})`);
      activationClasses.forEach((activationClass, index) => {
        params[`$activationClass${index}`] = activationClass;
      });
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
      limit !== undefined ? "LIMIT $limit" : "",
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

  createEvidence(input: CreateEvidenceInput): EvidenceRecord {
    this.requireMemory(input.memoryId);

    const createdAt = input.createdAt ?? new Date().toISOString();
    const id =
      input.id ??
      createDeterministicId(
        [
          "evidence",
          input.memoryId,
          input.sourceKind,
          input.sourceRef,
          input.excerpt,
          createdAt,
        ].join(":"),
      );

    this.db.run(
      `
        INSERT INTO evidence (
          id,
          memory_id,
          source_kind,
          source_ref,
          excerpt,
          created_at
        )
        VALUES (
          $id,
          $memoryId,
          $sourceKind,
          $sourceRef,
          $excerpt,
          $createdAt
        )
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

  mergeMemories(input: MergeMemoriesInput): MergeMemoriesResult {
    if (input.sourceMemoryId === input.targetMemoryId) {
      throw new InvalidMemoryTransitionError(
        "Cannot merge a memory into itself"
      );
    }

    return this.withTransaction(() => {
      const target = this.requireMemory(input.targetMemoryId);
      const mergedAt = input.updatedAt ?? new Date().toISOString();
      const updatedTarget = this.updateRequired(target.id, {
        ...input.targetUpdate,
        status: target.status,
        supersedesMemoryId: target.supersedesMemoryId,
        updatedAt: input.targetUpdate?.updatedAt ?? mergedAt,
      });
      const updatedSource = this.updateRequired(input.sourceMemoryId, {
        status: "superseded",
        supersedesMemoryId: target.id,
        updatedAt: mergedAt,
      });

      return {
        source: updatedSource,
        target: updatedTarget,
      };
    });
  }

  supersedeMemory(input: ReplaceMemoryInput): ReplaceMemoryResult {
    return this.replaceMemory("superseded", input);
  }

  markMemoryStale(input: ReplaceMemoryInput): ReplaceMemoryResult {
    return this.replaceMemory("stale", input);
  }

  rejectMemory(input: RejectMemoryInput): RejectMemoryResult {
    return this.withTransaction(() => {
      const existing = this.requireMemory(input.memoryId);
      if (existing.status !== "candidate") {
        throw new InvalidMemoryTransitionError(
          `Only candidate memories can be rejected (got ${existing.status})`
        );
      }

      const reviewedAt = input.updatedAt ?? new Date().toISOString();
      const memory = this.updateRequired(input.memoryId, {
        status: "rejected",
        updatedAt: reviewedAt,
        lastVerifiedAt:
          input.lastVerifiedAt === undefined ? reviewedAt : input.lastVerifiedAt,
      });
      const evidence =
        input.reason === undefined
          ? null
          : this.createEvidence({
              memoryId: memory.id,
              sourceKind: "manual_note",
              sourceRef: input.sourceRef ?? "memory:reject",
              excerpt: input.reason,
              createdAt: reviewedAt,
            });

      return {
        memory,
        evidence,
      };
    });
  }

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
    const orderedMemories = [
      ...lineage.ancestors,
      lineage.focus,
      ...lineage.descendants,
    ];
    const evidenceByMemoryId = this.listEvidenceByMemoryIds(
      orderedMemories.map((memory) => memory.id)
    );
    const ancestorIds = new Set(lineage.ancestors.map((memory) => memory.id));
    const descendantIds = new Set(
      lineage.descendants.map((memory) => memory.id)
    );

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
    const candidateMemories = Array.from(new Set(memoryIds)).map((memoryId) =>
      this.requireMemory(memoryId)
    );
    const groups = new Map<string, MemoryConflictRecord>();

    for (const memory of candidateMemories) {
      const lifecycleKey = serializeLifecycleTriggers(memory.lifecycleTriggers);
      const conflictKey = [memory.type, memory.scopeGlob, lifecycleKey].join("|");
      const existing = groups.get(conflictKey);

      if (existing === undefined) {
        groups.set(conflictKey, {
          key: conflictKey,
          root: memory,
          memories: [memory],
        });
        continue;
      }

      existing.memories.push(memory);
      if (compareMemoryByCreatedAt(memory, existing.root) < 0) {
        existing.root = memory;
      }
    }

    return Array.from(groups.values())
      .map((group) => ({
        ...group,
        memories: [...group.memories].sort(compareMemoryByCreatedAt),
      }))
      .filter((group) => group.memories.length > 1);
  }

  update(id: string, input: UpdateMemoryInput): MemoryRecord | null {
    const existing = this.getById(id);

    if (existing === null) {
      return null;
    }

    const summary = input.summary ?? existing.summary;
    const details = input.details ?? existing.details;
    const type = input.type ?? existing.type;
    const scopeGlob = input.scopeGlob ?? existing.scopeGlob;
    const lifecycleTriggers = input.lifecycleTriggers ?? existing.lifecycleTriggers;
    const contentHash = createMemoryContentHash({ summary, details });
    const identityKey = createMemoryIdentityKey({
      type,
      summary,
      details,
      scopeGlob,
      lifecycleTriggers,
    });
    const duplicate = this.findExactDuplicate({
      type,
      summary,
      details,
      scopeGlob,
      lifecycleTriggers,
    });
    const embeddingSummaryBlob =
      input.embeddingSummary === undefined
        ? existing.embeddingSummary === null
          ? null
          : new Uint8Array(
              existing.embeddingSummary.buffer,
              existing.embeddingSummary.byteOffset,
              existing.embeddingSummary.byteLength
            )
        : input.embeddingSummary === null
          ? null
          : new Uint8Array(
              input.embeddingSummary.buffer,
              input.embeddingSummary.byteOffset,
              input.embeddingSummary.byteLength
            );

    if (duplicate !== null && duplicate.id !== id) {
      throw new DuplicateMemoryContentError(identityKey, duplicate.id);
    }

    this.db.run(
      `
        UPDATE memories
        SET
          content_hash = $contentHash,
          identity_key = $identityKey,
          type = $type,
          summary = $summary,
          details = $details,
          scope_glob = $scopeGlob,
          activation_class = $activationClass,
          lifecycle_triggers = $lifecycleTriggers,
          confidence = $confidence,
          importance = $importance,
          status = $status,
          supersedes_memory_id = $supersedesMemoryId,
          promotion_source = $promotionSource,
          ttl_expires_at = $ttlExpiresAt,
          validation_count = $validationCount,
          embedding_summary = $embeddingSummary,
          relevant_tools_json = $relevantToolsJson,
          updated_at = $updatedAt,
          last_verified_at = $lastVerifiedAt
        WHERE id = $id
      `,
      {
        $id: id,
        $contentHash: contentHash,
        $identityKey: identityKey,
        $type: type,
        $summary: summary,
        $details: details,
        $scopeGlob: scopeGlob,
        $activationClass: input.activationClass ?? existing.activationClass,
        $lifecycleTriggers: serializeLifecycleTriggers(lifecycleTriggers),
        $confidence: normalizeScore(
          input.confidence ?? existing.confidence,
          "confidence"
        ),
        $importance: normalizeScore(
          input.importance ?? existing.importance,
          "importance"
        ),
        $status: input.status ?? existing.status,
        $supersedesMemoryId:
          input.supersedesMemoryId !== undefined
            ? input.supersedesMemoryId
            : existing.supersedesMemoryId,
        $promotionSource: input.promotionSource ?? existing.promotionSource,
        $ttlExpiresAt:
          input.ttlExpiresAt !== undefined
            ? input.ttlExpiresAt
            : existing.ttlExpiresAt,
        $validationCount: input.validationCount ?? existing.validationCount,
        $embeddingSummary: embeddingSummaryBlob,
        $relevantToolsJson: serializeRelevantTools(
          input.relevantTools !== undefined
            ? input.relevantTools
            : existing.relevantTools ?? null
        ),
        $updatedAt: input.updatedAt ?? new Date().toISOString(),
        $lastVerifiedAt:
          input.lastVerifiedAt !== undefined
            ? input.lastVerifiedAt
            : existing.lastVerifiedAt,
      }
    );

    return this.getById(id);
  }

  updateEmbedding(id: string, embedding: Float32Array): void {
    const blob = new Uint8Array(
      embedding.buffer,
      embedding.byteOffset,
      embedding.byteLength
    );
    this.db.run("UPDATE memories SET embedding = ? WHERE id = ?", [blob, id]);
  }

  updateEmbeddingSummary(id: string, embedding: Float32Array): void {
    const blob = new Uint8Array(
      embedding.buffer,
      embedding.byteOffset,
      embedding.byteLength
    );
    this.db.run("UPDATE memories SET embedding_summary = ? WHERE id = ?", [blob, id]);
  }

  private replaceMemory(
    previousStatus: Extract<MemoryStatus, "stale" | "superseded">,
    input: ReplaceMemoryInput
  ): ReplaceMemoryResult {
    if (input.previousMemoryId === input.replacementMemoryId) {
      throw new InvalidMemoryTransitionError(
        "Cannot replace a memory with itself"
      );
    }

    return this.withTransaction(() => {
      const replacement = this.requireMemory(input.replacementMemoryId);
      const updatedAt = input.updatedAt ?? new Date().toISOString();
      const updatedPrevious = this.updateRequired(input.previousMemoryId, {
        status: previousStatus,
        updatedAt,
      });
      const updatedReplacement = this.updateRequired(replacement.id, {
        ...input.replacementUpdate,
        status: "active",
        supersedesMemoryId: input.previousMemoryId,
        updatedAt: input.replacementUpdate?.updatedAt ?? updatedAt,
      });

      return {
        previous: updatedPrevious,
        replacement: updatedReplacement,
      };
    });
  }

  private requireMemory(id: string): MemoryRecord {
    const memory = this.getById(id);

    if (memory === null) {
      throw new MemoryNotFoundError(id);
    }

    return memory;
  }

  private updateRequired(id: string, input: UpdateMemoryInput): MemoryRecord {
    const memory = this.update(id, input);

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

  private listEvidenceByMemoryIds(
    memoryIds: readonly string[]
  ): Map<string, EvidenceRecord[]> {
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

  private withTransaction<T>(callback: () => T): T {
    this.db.run("BEGIN TRANSACTION");

    try {
      const result = callback();
      this.db.run("COMMIT");
      return result;
    } catch (error) {
      this.db.run("ROLLBACK");
      throw error;
    }
  }

  private selectOne(sql: string, params: SqlParameters): MemoryRecord | null {
    const statement = this.db.prepare(sql);

    try {
      statement.bind(params);

      if (!statement.step()) {
        return null;
      }

      return this.mapMemoryRow(statement.get() as unknown[]);
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
        rows.push(this.mapMemoryRow(statement.get() as unknown[]));
      }

      return rows;
    } finally {
      statement.free();
    }
  }

  private selectOneEvidence(
    sql: string,
    params: SqlParameters
  ): EvidenceRecord | null {
    const statement = this.db.prepare(sql);

    try {
      statement.bind(params);

      if (!statement.step()) {
        return null;
      }

      return this.mapEvidenceRow(statement.get() as unknown[]);
    } finally {
      statement.free();
    }
  }

  private selectManyEvidence(
    sql: string,
    params: SqlParameters
  ): EvidenceRecord[] {
    const statement = this.db.prepare(sql);

    try {
      statement.bind(params);

      const rows: EvidenceRecord[] = [];

      while (statement.step()) {
        rows.push(this.mapEvidenceRow(statement.get() as unknown[]));
      }

      return rows;
    } finally {
      statement.free();
    }
  }

  private mapMemoryRow(row: unknown[]): MemoryRecord {
    const rawEmbedding = row[20];
    const embedding =
      rawEmbedding instanceof Uint8Array
        ? new Float32Array(
            rawEmbedding.buffer,
            rawEmbedding.byteOffset,
            rawEmbedding.byteLength / 4
          )
        : null;
    const rawEmbeddingSummary = row[21];
    const embeddingSummary =
      rawEmbeddingSummary instanceof Uint8Array
        ? new Float32Array(
            rawEmbeddingSummary.buffer,
            rawEmbeddingSummary.byteOffset,
            rawEmbeddingSummary.byteLength / 4
          )
        : null;

    return {
      id: expectString(row[0], "id"),
      contentHash: expectString(row[1], "content_hash"),
      identityKey: expectNullableString(row[2], "identity_key"),
      type: expectMemoryType(row[3]),
      summary: expectString(row[4], "summary"),
      details: expectString(row[5], "details"),
      scopeGlob: expectString(row[6], "scope_glob"),
      lifecycleTriggers: parseLifecycleTriggers(
        expectString(row[7], "lifecycle_triggers")
      ),
      confidence: expectNumber(row[8], "confidence"),
      importance: expectNumber(row[9], "importance"),
      status: expectMemoryStatus(row[10]),
      supersedesMemoryId: expectNullableString(row[11], "supersedes_memory_id"),
      promotionSource: (expectString(row[12], "promotion_source") as "manual" | "auto"),
      ttlExpiresAt: expectNullableString(row[13], "ttl_expires_at"),
      validationCount: expectNumber(row[14], "validation_count"),
      policySubtype: expectNullableString(row[15], "policy_subtype") as "hard" | "soft" | null,
      createdAt: expectString(row[16], "created_at"),
      updatedAt: expectString(row[17], "updated_at"),
      lastVerifiedAt: expectNullableString(row[18], "last_verified_at"),
      activationClass: expectActivationClass(row[19]),
      embedding,
      embeddingSummary,
      relevantTools: parseRelevantTools(
        expectNullableString(row[22], "relevant_tools_json")
      ),
    };
  }

  private findExactDuplicate(input: {
    type: MemoryType;
    summary: string;
    details: string;
    scopeGlob: string;
    lifecycleTriggers: readonly LifecycleTrigger[];
  }): MemoryRecord | null {
    return this.selectOne(
      `SELECT ${MEMORY_SELECT_COLUMNS}
       FROM memories
       WHERE type = $type
         AND summary = $summary
         AND details = $details
         AND scope_glob = $scopeGlob
         AND lifecycle_triggers = $lifecycleTriggers`,
      {
        $type: input.type,
        $summary: input.summary,
        $details: input.details,
        $scopeGlob: input.scopeGlob,
        $lifecycleTriggers: serializeLifecycleTriggers(input.lifecycleTriggers),
      }
    );
  }

  private mapEvidenceRow(row: unknown[]): EvidenceRecord {
    return {
      id: expectString(row[0], "id"),
      memoryId: expectString(row[1], "memory_id"),
      sourceKind: expectEvidenceSourceKind(row[2]),
      sourceRef: expectString(row[3], "source_ref"),
      excerpt: expectString(row[4], "excerpt"),
      createdAt: expectString(row[5], "created_at"),
    };
  }
}
