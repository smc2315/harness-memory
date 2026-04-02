import type { MemoryRecord, MemoryRepository } from "../memory";
import { scanMemoryContent } from "../security/scanner";

export interface AutoPromotionResult {
  promoted: Array<{ memoryId: string; summary: string }>;
  skipped: Array<{ memoryId: string; summary: string; reason: string }>;
}

export interface AutoPromoterOptions {
  minConfidence?: number;
  minEvidence?: number;
  ttlDays?: number;
  allowedTypes?: string[];
}

const DEFAULT_MIN_CONFIDENCE = 0.85;
const DEFAULT_MIN_EVIDENCE = 3;
const DEFAULT_TTL_DAYS = 14;
const DEFAULT_ALLOWED_TYPES = ["pitfall", "workflow"];
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function createSkipped(memory: MemoryRecord, reason: string): AutoPromotionResult["skipped"][number] {
  return {
    memoryId: memory.id,
    summary: memory.summary,
    reason,
  };
}

export async function runAutoPromotionCycle(
  repository: MemoryRepository,
  options: AutoPromoterOptions = {}
): Promise<AutoPromotionResult> {
  const minConfidence = options.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
  const minEvidence = options.minEvidence ?? DEFAULT_MIN_EVIDENCE;
  const ttlDays = options.ttlDays ?? DEFAULT_TTL_DAYS;
  const allowedTypes = new Set(options.allowedTypes ?? DEFAULT_ALLOWED_TYPES);

  const candidates = repository.list({ status: "candidate" });
  const result: AutoPromotionResult = {
    promoted: [],
    skipped: [],
  };

  for (const candidate of candidates) {
    const scanResult = scanMemoryContent(candidate.summary, candidate.details);
    if (!scanResult.safe) {
      result.skipped.push(createSkipped(candidate, "security scan failed"));
      continue;
    }

    if (candidate.confidence < minConfidence) {
      result.skipped.push(
        createSkipped(
          candidate,
          `confidence below threshold (${candidate.confidence.toFixed(2)} < ${minConfidence.toFixed(2)})`
        )
      );
      continue;
    }

    const evidenceCount = repository.listEvidence(candidate.id).length;
    if (evidenceCount < minEvidence) {
      result.skipped.push(
        createSkipped(
          candidate,
          `insufficient evidence (${String(evidenceCount)} < ${String(minEvidence)})`
        )
      );
      continue;
    }

    if (candidate.type === "policy") {
      result.skipped.push(createSkipped(candidate, "policy memories are never auto-promoted"));
      continue;
    }

    if (!allowedTypes.has(candidate.type)) {
      result.skipped.push(createSkipped(candidate, `type '${candidate.type}' is not auto-promotable`));
      continue;
    }

    repository.update(candidate.id, {
      status: "active",
      promotionSource: "auto",
      ttlExpiresAt: new Date(Date.now() + ttlDays * MS_PER_DAY).toISOString(),
      validationCount: 0,
    });

    result.promoted.push({
      memoryId: candidate.id,
      summary: candidate.summary,
    });
  }

  return result;
}

// ---------------------------------------------------------------------------
// Revalidation + Contradiction (T4)
// ---------------------------------------------------------------------------

const MS_PER_DAY_REVAL = 24 * 60 * 60 * 1000;

/**
 * Revalidate an auto-promoted memory: increment validation count, extend TTL.
 * Called when the LLM extraction produces a `reinforce` action for an auto memory.
 */
export function revalidateMemory(
  repository: MemoryRepository,
  memoryId: string,
  ttlDays: number = DEFAULT_TTL_DAYS,
): boolean {
  const memory = repository.getById(memoryId);

  if (memory === null || memory.status !== "active" || memory.promotionSource !== "auto") {
    return false;
  }

  const newTtl = new Date(Date.now() + ttlDays * MS_PER_DAY_REVAL).toISOString();

  repository.update(memoryId, {
    validationCount: memory.validationCount + 1,
    ttlExpiresAt: newTtl,
    lastVerifiedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  return true;
}

/**
 * Demote a memory to stale due to contradicting evidence.
 * Works on both manual and auto-promoted memories.
 */
export function demoteOnContradiction(
  repository: MemoryRepository,
  memoryId: string,
): boolean {
  const memory = repository.getById(memoryId);

  if (memory === null || memory.status !== "active") {
    return false;
  }

  repository.update(memoryId, {
    status: "stale",
    updatedAt: new Date().toISOString(),
  });

  return true;
}
