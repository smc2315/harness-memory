/**
 * `before_model` activation for the `prompt` hook (spec §6.1): baseline rows always; non-baseline
 * rows need a scope intersection with the path tokens of the prompt (or the last tool's scope ref)
 * AND a lexical BM25 hit over the snapshot index (summary / details / aliases) above
 * `before_model.min_score` — or a dense hit ≥ 0.80 when the embedding helper answered in time. Lexical
 * and dense lists are fused with RRF (`fusion.ts`). Rows imported from a host-loaded file (CLAUDE.md,
 * AGENTS.md) are skipped. Budget 5 items / 3 KB from config.
 *
 * Recall (A′): after the memory items, at most `before_model.recall.max_items` past-episode summaries from
 * `recall.v1.json` that score ≥ `before_model.recall.min_score`, excluding the current session, within
 * `before_model.recall.max_bytes` and only inside what the memory items left of `before_model.max_bytes`.
 * Plain context — no enforcement, no fired line.
 */

import type { HarnessConfig } from "../core/config";
import type { SnapshotMemory } from "../core/snapshot-types";
import type { Host } from "../core/vocabulary";
import { RRF_K, rrfFusion, type FusionCandidate } from "./fusion";
import { applyBudget, isHostLoadedFile, isTtlExpired, itemFromSnapshotMemory, type InjectedItem, type InjectionSource } from "./injection";
import { normalizeLexicalScore } from "./lexical-snapshot";
import { selectRecallItems, type RecallIndex, type RecallItem } from "./recall";
import { compareSnapshotMemories, snapshotMemoryScore } from "./scoring";
import { scopeMatches, type LexicalSearcher, type LoadedSnapshot } from "./snapshot-reader";
import { extractScopeRefs } from "./tool-vocabulary";

export interface DenseHits {
  ids: string[];
  scores: number[];
}

/** Minimal client surface: the embedding helper over the named pipe, or a stub in tests. */
export interface DenseClient {
  topk(text: string, k: number): Promise<DenseHits | null>;
}

export type BeforeModelSuppressionKind =
  | "status_inactive"
  | "ttl_expired"
  | "trigger_mismatch"
  | "host_loaded"
  | "scope_mismatch"
  | "retrieval_miss"
  | "budget_limit";

export interface BeforeModelSuppression {
  id: string;
  kind: BeforeModelSuppressionKind;
  reason: string;
}

export interface BeforeModelParams {
  loaded: LoadedSnapshot;
  lexical: LexicalSearcher | null;
  dense?: DenseClient | null;
  prompt: string;
  lastScopeRef: string | null;
  host: Host;
  config: Pick<HarnessConfig, "before_model">;
  now: string;
  /** Recall index over `recall.v1.json`; null / absent = no recall items (file missing, `recall.enabled` false). */
  recall?: RecallIndex | null;
  /** Current session key: its own episodes are never recalled into it. */
  sessionKey?: string | null;
}

export interface BeforeModelResult {
  items: InjectedItem[];
  suppressed: BeforeModelSuppression[];
  /** Memory items followed by the recall items, newline-joined; null when nothing is injected. */
  text: string | null;
  lexicalUsed: boolean;
  denseUsed: boolean;
  /** Past-episode summaries appended after the memory items (plain context, never enforced). */
  recall: RecallItem[];
}

export const DENSE_HIT_THRESHOLD = 0.8;
/** How many candidates each retrieval leg is asked for before fusion. */
const RETRIEVAL_WIDTH = 20;

/** Retrieval score in [0, 1] for the fused source, mirroring `normalizeStartupRetrievalScore`. */
function retrievalScore(candidate: FusionCandidate, lexicalById: Map<string, number>, denseById: Map<string, number>): number {
  if (candidate.source === "hybrid") return Math.min(1, candidate.score * (RRF_K + 1));
  if (candidate.source === "vector") return denseById.get(candidate.id) ?? 0;
  return lexicalById.get(candidate.id) ?? 0;
}

function sourceOf(candidate: FusionCandidate): InjectionSource {
  if (candidate.source === "hybrid") return "hybrid";
  return candidate.source === "vector" ? "dense" : "lexical";
}

export async function activateBeforeModel(params: BeforeModelParams): Promise<BeforeModelResult> {
  const { loaded, lexical, prompt, host, config } = params;
  const nowMs = Date.parse(params.now);
  const suppressed: BeforeModelSuppression[] = [];
  const baseline: SnapshotMemory[] = [];
  const scoped: SnapshotMemory[] = [];

  const pathTokens = extractScopeRefs(prompt);
  if (params.lastScopeRef !== null && params.lastScopeRef.length > 0) pathTokens.push(params.lastScopeRef);

  for (const memory of loaded.snapshot.memories) {
    if (memory.status !== "active") {
      suppressed.push({ id: memory.id, kind: "status_inactive", reason: `status ${memory.status}` });
      continue;
    }
    if (isTtlExpired(memory.ttl_expires_at, nowMs)) {
      suppressed.push({ id: memory.id, kind: "ttl_expired", reason: `ttl expired at ${memory.ttl_expires_at ?? ""}` });
      continue;
    }
    if (!memory.lifecycle_triggers.includes("before_model")) {
      suppressed.push({ id: memory.id, kind: "trigger_mismatch", reason: "not a before_model memory" });
      continue;
    }
    if (isHostLoadedFile(host, memory.source_file)) {
      suppressed.push({ id: memory.id, kind: "host_loaded", reason: `${memory.source_file ?? ""} is loaded by the host` });
      continue;
    }
    if (memory.activation_class === "baseline") {
      baseline.push(memory);
      continue;
    }
    const intersects = memory.scope_regex === null || pathTokens.some((ref) => scopeMatches(loaded, memory, ref));
    if (!intersects) {
      suppressed.push({ id: memory.id, kind: "scope_mismatch", reason: `scope ${memory.scope_glob} does not intersect the prompt paths` });
      continue;
    }
    scoped.push(memory);
  }

  const scoreOf = new Map<string, number>();
  for (const memory of [...baseline, ...scoped]) scoreOf.set(memory.id, snapshotMemoryScore(memory, nowMs));

  const items: InjectedItem[] = baseline
    .sort((left, right) => compareSnapshotMemories(left, right, scoreOf.get(left.id) ?? 0, scoreOf.get(right.id) ?? 0))
    .map((memory) => itemFromSnapshotMemory(memory, { score: scoreOf.get(memory.id) ?? 0, source: "baseline" }));

  let lexicalUsed = false;
  let denseUsed = false;
  if (scoped.length > 0 && prompt.trim().length > 0) {
    const scopedIds = new Set(scoped.map((memory) => memory.id));
    const lexicalById = new Map<string, number>();
    const lexicalList: FusionCandidate[] = [];
    if (lexical !== null) {
      lexicalUsed = true;
      for (const hit of lexical.search(prompt, Math.max(RETRIEVAL_WIDTH, scoped.length))) {
        if (!scopedIds.has(hit.id)) continue;
        const normalized = normalizeLexicalScore(hit.score);
        if (normalized < config.before_model.min_score) continue;
        lexicalById.set(hit.id, normalized);
        lexicalList.push({ id: hit.id, score: normalized, source: "lexical" });
      }
    }

    const denseById = new Map<string, number>();
    const denseList: FusionCandidate[] = [];
    const dense = params.dense ?? null;
    if (dense !== null) {
      let hits: DenseHits | null = null;
      try {
        hits = await dense.topk(prompt, Math.min(RETRIEVAL_WIDTH, Math.max(1, scoped.length)));
      } catch {
        hits = null;
      }
      if (hits !== null) {
        denseUsed = true;
        hits.ids.forEach((id, index) => {
          const score = hits.scores[index] ?? 0;
          if (!scopedIds.has(id) || score < DENSE_HIT_THRESHOLD) return;
          denseById.set(id, score);
          denseList.push({ id, score, source: "vector" });
        });
      }
    }

    const lists = [lexicalList, denseList].filter((list) => list.length > 0);
    const fused = lists.length === 0 ? [] : rrfFusion(lists, config.before_model.max_items * 2);
    const hitIds = new Set<string>();
    for (const candidate of fused) {
      const memory = loaded.byId.get(candidate.id);
      if (memory === undefined) continue;
      hitIds.add(candidate.id);
      const retrieval = retrievalScore(candidate, lexicalById, denseById);
      const score = (scoreOf.get(memory.id) ?? 0) * 0.4 + retrieval * 0.6;
      items.push(itemFromSnapshotMemory(memory, { score, source: sourceOf(candidate) }));
    }
    for (const memory of scoped) {
      if (!hitIds.has(memory.id)) {
        suppressed.push({ id: memory.id, kind: "retrieval_miss", reason: `no lexical hit ≥ ${config.before_model.min_score} and no dense hit ≥ ${DENSE_HIT_THRESHOLD}` });
      }
    }
  } else {
    for (const memory of scoped) suppressed.push({ id: memory.id, kind: "retrieval_miss", reason: "empty prompt" });
  }

  const budget = applyBudget(items, config.before_model.max_items, config.before_model.max_bytes);
  for (const item of budget.dropped) {
    suppressed.push({ id: item.id, kind: "budget_limit", reason: `budget ${config.before_model.max_items} items / ${config.before_model.max_bytes} bytes` });
  }

  // Recall items come last and only inside what the memory items left of the before_model byte budget.
  let text = budget.text;
  let recall: RecallItem[] = [];
  const recallIndex = params.recall ?? null;
  if (recallIndex !== null && recallIndex.episodeCount > 0 && prompt.trim().length > 0) {
    const recallConfig = config.before_model.recall;
    const separator = budget.included.length > 0 ? 1 : 0;
    const remainingBytes = config.before_model.max_bytes - budget.bytes - separator;
    const selection = selectRecallItems({
      index: recallIndex,
      prompt,
      sessionKey: params.sessionKey ?? null,
      maxItems: recallConfig.max_items,
      maxBytes: Math.min(recallConfig.max_bytes, remainingBytes),
      minScore: recallConfig.min_score,
    });
    if (selection.text !== null) {
      recall = selection.items;
      text = text === null ? selection.text : `${text}\n${selection.text}`;
    }
  }

  return { items: budget.included, suppressed, text, lexicalUsed, denseUsed, recall };
}
