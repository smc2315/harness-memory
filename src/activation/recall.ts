/**
 * Recall layer read path (A′): `snapshot/recall.v1.json` → a MiniSearch index over `summary` + `scope_refs`
 * built with the snapshot tokenizer (Hangul-aware) → the top summaries above `before_model.recall.min_score`,
 * excluding the current session. Rendered as plain `additionalContext`
 * (`[harness-memory] RECALL 2026-11-08: <summary>`): never an enforcement, never a fired line.
 *
 * Loaded only by the `prompt` hook (UserPromptSubmit) and `hm recall` — never on PreToolUse. Like the lexical
 * reader, minisearch is imported lazily; this module never opens SQLite.
 */

import { readFileSync } from "node:fs";

import type { Options } from "minisearch";

import type { HarnessPaths } from "../core/paths";
import { RECALL_SNAPSHOT_SCHEMA, type RecallEpisode, type RecallSnapshot } from "../core/snapshot-types";
import { INJECTION_PREFIX, stripControlCharacters } from "./injection";
import { LEXICAL_TOKENIZER_ID, normalizeLexicalScore, snapshotTokenize } from "./lexical-snapshot";

export const RECALL_INDEX_FIELDS = ["summary", "scope_refs"] as const;
export const RECALL_LABEL = "RECALL";
/** Rendered summary cap (the stored summary is already ≤ 400 chars). */
export const RECALL_TEXT_CHARS = 400;
/** Extra hits asked from the index so excluded (same-session) episodes do not starve the selection. */
const RECALL_SEARCH_HEADROOM = 8;

export interface RecallDocument {
  id: string;
  summary: string;
  /** Scope refs joined by a single space. */
  scope_refs: string;
}

/**
 * Terms that carry no recall signal: English function words a prompt is made of, and the vocabulary the derived
 * summary renderer itself emits (`failed`, `tools`, `files`, …). Without this, a 10-word prompt accumulates enough
 * BM25 from "the / with / what" matches to clear `min_score` on an unrelated episode.
 */
export const RECALL_STOP_WORDS: ReadonlySet<string> = new Set([
  "a", "an", "the", "and", "or", "but", "of", "to", "in", "on", "at", "for", "with", "from", "by", "as", "into", "about", "over",
  "is", "are", "was", "were", "be", "been", "being", "am", "do", "does", "did", "done", "have", "has", "had", "can", "could",
  "should", "would", "will", "shall", "may", "might", "must", "not", "no", "yes", "if", "then", "than", "so", "too", "very",
  "it", "its", "this", "that", "these", "those", "there", "here", "we", "us", "our", "i", "me", "my", "you", "your", "he", "she",
  "they", "them", "their", "what", "which", "who", "whom", "how", "why", "when", "where", "again", "last", "time", "please",
  "let", "lets", "just", "also", "still", "now", "up", "out", "all", "any", "some", "more",
  // summary renderer vocabulary
  "failed", "resolved", "unresolved", "tools", "files", "import", "prompt", "empty", "episode",
]);
/** Prefix matching only for terms this long: `do → docs`, `we → weekly` must not count as hits. */
export const RECALL_PREFIX_MIN_CHARS = 4;

/** Drops stop words and single characters at index and query time (the tokenizer itself is the shared snapshot one). */
export function recallProcessTerm(term: string): string | null {
  if (term.length < 2 || RECALL_STOP_WORDS.has(term)) return null;
  return term;
}

/** Equal field boosts keep the raw BM25 score comparable to `idf × tf`, which the min_score default was chosen against. */
export function recallIndexOptions(): Options<RecallDocument> {
  return {
    fields: [...RECALL_INDEX_FIELDS],
    storeFields: [],
    idField: "id",
    tokenize: snapshotTokenize,
    processTerm: recallProcessTerm,
    searchOptions: {
      tokenize: snapshotTokenize,
      processTerm: recallProcessTerm,
      boost: { summary: 1, scope_refs: 1 },
      prefix: (term: string) => term.length >= RECALL_PREFIX_MIN_CHARS,
      fuzzy: false,
      combineWith: "OR",
    },
  };
}

export function toRecallDocument(episode: Pick<RecallEpisode, "id" | "summary" | "scope_refs">): RecallDocument {
  return { id: episode.id, summary: episode.summary, scope_refs: episode.scope_refs.join(" ") };
}

export interface RecallHit {
  episode: RecallEpisode;
  /** Normalized BM25 (`s / (s + 1)`), compared against `before_model.recall.min_score`. */
  score: number;
  raw: number;
}

export interface RecallIndex {
  readonly episodes: readonly RecallEpisode[];
  readonly episodeCount: number;
  readonly dbGeneration: number;
  readonly builtAt: string;
  search(query: string, limit: number): RecallHit[];
}

interface MiniSearchLike<T> {
  addAll(documents: readonly T[]): void;
  search(query: string): Array<{ id: unknown; score: number }>;
  readonly documentCount: number;
}

interface MiniSearchModule {
  default: (new <T>(options: Options<T>) => MiniSearchLike<T>) & { loadJS<T>(js: unknown, options: Options<T>): MiniSearchLike<T> };
}

/** Wraps a MiniSearch instance (built or loaded) as the `RecallIndex` the selectors use. */
function wrapIndex(index: MiniSearchLike<RecallDocument>, byId: Map<string, RecallEpisode>, meta: { dbGeneration: number; builtAt: string }): RecallIndex {
  return {
    episodes: [...byId.values()],
    episodeCount: index.documentCount,
    dbGeneration: meta.dbGeneration,
    builtAt: meta.builtAt,
    search(query: string, limit: number): RecallHit[] {
      if (query.trim().length === 0 || limit <= 0) return [];
      const hits: RecallHit[] = [];
      for (const hit of index.search(query)) {
        const episode = byId.get(String(hit.id));
        if (episode === undefined) continue;
        hits.push({ episode, score: normalizeLexicalScore(hit.score), raw: hit.score });
        if (hits.length >= limit) break;
      }
      return hits;
    },
  };
}

function uniqueById(episodes: readonly RecallEpisode[]): Map<string, RecallEpisode> {
  const byId = new Map<string, RecallEpisode>();
  for (const episode of episodes) if (!byId.has(episode.id)) byId.set(episode.id, episode);
  return byId;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRecallEpisode(value: unknown): value is RecallEpisode {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.session_key === "string" &&
    typeof value.closed_at === "string" &&
    typeof value.summary === "string" &&
    (value.summary_kind === "extracted" || value.summary_kind === "derived") &&
    Array.isArray(value.scope_refs)
  );
}

/** Structural check: enough to trust the fields the readers use; unknown extra keys are ignored. */
export function isRecallSnapshot(value: unknown): value is RecallSnapshot {
  return isRecord(value) && value.schema === RECALL_SNAPSHOT_SCHEMA && typeof value.db_generation === "number" && Array.isArray(value.episodes);
}

/** Builds the search index over the given episodes (lazy `import("minisearch")`): the CLI's database fallback and files without a serialized index. */
export async function buildRecallIndex(episodes: readonly RecallEpisode[], meta: { dbGeneration: number; builtAt: string }): Promise<RecallIndex> {
  const mod = (await import("minisearch")) as unknown as MiniSearchModule;
  const index = new mod.default<RecallDocument>(recallIndexOptions());
  const byId = uniqueById(episodes);
  index.addAll([...byId.values()].map(toRecallDocument));
  return wrapIndex(index, byId, meta);
}

/**
 * Reads `recall.v1.json`; null when the file is missing / corrupt (the hook then injects nothing). The serialized
 * index is loaded when the builder stamped the tokenizer this reader uses; otherwise (or when it is absent or
 * does not load) the index is rebuilt from the episodes.
 */
export async function readRecallSnapshot(paths: Pick<HarnessPaths, "snapshotRecall">): Promise<RecallIndex | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(paths.snapshotRecall, "utf8"));
  } catch {
    return null;
  }
  if (!isRecallSnapshot(parsed)) return null;
  const episodes = parsed.episodes.filter(isRecallEpisode);
  const meta = { dbGeneration: parsed.db_generation, builtAt: typeof parsed.built_at === "string" ? parsed.built_at : "" };
  try {
    if (isRecord(parsed.index) && parsed.tokenizer === LEXICAL_TOKENIZER_ID) {
      const mod = (await import("minisearch")) as unknown as MiniSearchModule;
      const byId = uniqueById(episodes);
      const index = mod.default.loadJS<RecallDocument>(parsed.index, recallIndexOptions());
      if (index.documentCount === byId.size) return wrapIndex(index, byId, meta);
    }
    return await buildRecallIndex(episodes, meta);
  } catch {
    return null;
  }
}

/** `[harness-memory] RECALL 2026-11-08: <summary>` — one line, control characters stripped. */
export function renderRecallText(episode: Pick<RecallEpisode, "closed_at" | "summary">): string {
  const date = episode.closed_at.slice(0, 10);
  const flat = stripControlCharacters(episode.summary).replace(/\s+/g, " ").trim();
  const summary = flat.length <= RECALL_TEXT_CHARS ? flat : `${flat.slice(0, RECALL_TEXT_CHARS - 1)}…`;
  return `${INJECTION_PREFIX} ${RECALL_LABEL} ${date}: ${summary}`;
}

export interface RecallItem {
  /** Episode id. */
  id: string;
  session_key: string;
  closed_at: string;
  summary_kind: RecallEpisode["summary_kind"];
  /** Normalized BM25 score of the hit. */
  score: number;
  text: string;
  bytes: number;
}

export interface SelectRecallParams {
  index: RecallIndex;
  prompt: string;
  /** Episodes of this session are never recalled into it (null = no exclusion, e.g. the CLI). */
  sessionKey: string | null;
  maxItems: number;
  maxBytes: number;
  minScore: number;
}

export interface RecallSelection {
  items: RecallItem[];
  /** Newline-joined item texts, null when nothing was selected. */
  text: string | null;
  bytes: number;
  /** Hits that were above the threshold but did not fit the budget. */
  dropped: number;
}

/** Top matches above `minScore`, excluding the current session, in rank order while they fit `maxItems` / `maxBytes`. */
export function selectRecallItems(params: SelectRecallParams): RecallSelection {
  const empty: RecallSelection = { items: [], text: null, bytes: 0, dropped: 0 };
  if (params.maxItems <= 0 || params.maxBytes <= 0 || params.prompt.trim().length === 0 || params.index.episodeCount === 0) return empty;
  const items: RecallItem[] = [];
  let bytes = 0;
  let dropped = 0;
  for (const hit of params.index.search(params.prompt, params.maxItems + RECALL_SEARCH_HEADROOM)) {
    if (hit.score < params.minScore) continue;
    if (params.sessionKey !== null && hit.episode.session_key === params.sessionKey) continue;
    const text = renderRecallText(hit.episode);
    const size = Buffer.byteLength(text, "utf8");
    const separator = items.length > 0 ? 1 : 0;
    if (items.length >= params.maxItems || bytes + separator + size > params.maxBytes) {
      dropped += 1;
      continue;
    }
    items.push({ id: hit.episode.id, session_key: hit.episode.session_key, closed_at: hit.episode.closed_at, summary_kind: hit.episode.summary_kind, score: hit.score, text, bytes: size });
    bytes += separator + size;
  }
  return { items, text: items.length === 0 ? null : items.map((item) => item.text).join("\n"), bytes, dropped };
}
