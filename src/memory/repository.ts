import type { Database as SqlJsDatabase } from "sql.js";

import {
  type EvidenceSourceKind,
  MEMORY_DEFAULTS,
  type LifecycleTrigger,
  type MemoryStatus,
  type MemoryType,
} from "../db/schema/types";
import {
  createDeterministicId,
  createMemoryContentHash,
  createMemoryId,
  parseLifecycleTriggers,
  serializeLifecycleTriggers,
} from "./utils";

type SqlParameter = string | number | null;
type SqlParameters = Record<string, SqlParameter>;

const MEMORY_SELECT_COLUMNS = [
  "id",
  "content_hash",
  "type",
  "summary",
  "details",
  "scope_glob",
  "lifecycle_triggers",
  "confidence",
  "importance",
  "status",
  "supersedes_memory_id",
  "created_at",
  "updated_at",
  "last_verified_at",
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
  type: MemoryType;
  summary: string;
  details: string;
  scopeGlob: string;
  lifecycleTriggers: LifecycleTrigger[];
  confidence: number;
  importance: number;
  status: MemoryStatus;
  supersedesMemoryId: string | null;
  createdAt: string;
  updatedAt: string;
  lastVerifiedAt: string | null;
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
  lifecycleTriggers: readonly LifecycleTrigger[];
  confidence?: number;
  importance?: number;
  status?: MemoryStatus;
  supersedesMemoryId?: string | null;
  createdAt?: string;
  updatedAt?: string;
  lastVerifiedAt?: string | null;
}

export interface UpdateMemoryInput {
  type?: MemoryType;
  summary?: string;
  details?: string;
  scopeGlob?: string;
  lifecycleTriggers?: readonly LifecycleTrigger[];
  confidence?: number;
  importance?: number;
  status?: MemoryStatus;
  supersedesMemoryId?: string | null;
  updatedAt?: string;
  lastVerifiedAt?: string | null;
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

export class MemoryRepository {
  readonly db: SqlJsDatabase;

  constructor(db: SqlJsDatabase) {
    this.db = db;
    this.db.run("PRAGMA foreign_keys = ON;");
  }

  createOrGet(input: CreateMemoryInput): CreateMemoryResult {
    const contentHash = createMemoryContentHash({
      summary: input.summary,
      details: input.details,
    });
    const existing = this.getByContentHash(contentHash);

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
    const contentHash = createMemoryContentHash({
      summary: input.summary,
      details: input.details,
    });
    const existing = this.getByContentHash(contentHash);

    if (existing !== null) {
      throw new DuplicateMemoryContentError(contentHash, existing.id);
    }

    const now = new Date().toISOString();
    const createdAt = input.createdAt ?? now;
    const updatedAt = input.updatedAt ?? createdAt;
    const id = input.id ?? createMemoryId(contentHash);

    this.db.run(
      `
        INSERT INTO memories (
          id,
          content_hash,
          type,
          summary,
          details,
          scope_glob,
          lifecycle_triggers,
          confidence,
          importance,
          status,
          supersedes_memory_id,
          created_at,
          updated_at,
          last_verified_at
        )
        VALUES (
          $id,
          $contentHash,
          $type,
          $summary,
          $details,
          $scopeGlob,
          $lifecycleTriggers,
          $confidence,
          $importance,
          $status,
          $supersedesMemoryId,
          $createdAt,
          $updatedAt,
          $lastVerifiedAt
        )
      `,
      {
        $id: id,
        $contentHash: contentHash,
        $type: input.type,
        $summary: input.summary,
        $details: input.details,
        $scopeGlob: input.scopeGlob,
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
      const reviewedAt = input.updatedAt ?? new Date().toISOString();
      const memory = this.updateRequired(input.memoryId, {
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
    const contentHash = createMemoryContentHash({ summary, details });
    const duplicate = this.getByContentHash(contentHash);

    if (duplicate !== null && duplicate.id !== id) {
      throw new DuplicateMemoryContentError(contentHash, duplicate.id);
    }

    this.db.run(
      `
        UPDATE memories
        SET
          content_hash = $contentHash,
          type = $type,
          summary = $summary,
          details = $details,
          scope_glob = $scopeGlob,
          lifecycle_triggers = $lifecycleTriggers,
          confidence = $confidence,
          importance = $importance,
          status = $status,
          supersedes_memory_id = $supersedesMemoryId,
          updated_at = $updatedAt,
          last_verified_at = $lastVerifiedAt
        WHERE id = $id
      `,
      {
        $id: id,
        $contentHash: contentHash,
        $type: input.type ?? existing.type,
        $summary: summary,
        $details: details,
        $scopeGlob: input.scopeGlob ?? existing.scopeGlob,
        $lifecycleTriggers: serializeLifecycleTriggers(
          input.lifecycleTriggers ?? existing.lifecycleTriggers
        ),
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
        $updatedAt: input.updatedAt ?? new Date().toISOString(),
        $lastVerifiedAt:
          input.lastVerifiedAt !== undefined
            ? input.lastVerifiedAt
            : existing.lastVerifiedAt,
      }
    );

    return this.getById(id);
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
    return {
      id: expectString(row[0], "id"),
      contentHash: expectString(row[1], "content_hash"),
      type: expectMemoryType(row[2]),
      summary: expectString(row[3], "summary"),
      details: expectString(row[4], "details"),
      scopeGlob: expectString(row[5], "scope_glob"),
      lifecycleTriggers: parseLifecycleTriggers(
        expectString(row[6], "lifecycle_triggers")
      ),
      confidence: expectNumber(row[7], "confidence"),
      importance: expectNumber(row[8], "importance"),
      status: expectMemoryStatus(row[9]),
      supersedesMemoryId: expectNullableString(row[10], "supersedes_memory_id"),
      createdAt: expectString(row[11], "created_at"),
      updatedAt: expectString(row[12], "updated_at"),
      lastVerifiedAt: expectNullableString(row[13], "last_verified_at"),
    };
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
