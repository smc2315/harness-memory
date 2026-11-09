/**
 * MiniSearch options shared by the snapshot builder (`src/db/snapshot.ts`, worker) and the hooks
 * that load `snapshot/lexical.v1.json` (`prompt`, `session-start`). The two sides MUST use the same
 * tokenizer and field list: MiniSearch serializes the posting lists, not the options.
 *
 * No runtime import of `minisearch` here (hooks load it lazily); only its types are referenced.
 */

import type { Options } from "minisearch";

import type { SnapshotMemory } from "../core/snapshot-types";

export const LEXICAL_SNAPSHOT_FIELDS = ["summary", "details", "aliases"] as const;

/** Stamp written into `lexical.v1.json#tokenizer` by builders that index with `lexicalSnapshotOptions()`. */
export const LEXICAL_TOKENIZER_ID = "code-aware-hangul.v1";

export interface LexicalSnapshotDocument {
  id: string;
  summary: string;
  details: string;
  /** Extractor-provided aliases joined by a single space. */
  aliases: string;
}

/**
 * Splits text on whitespace/punctuation, then further splits camelCase, snake_case and kebab-case
 * tokens into individual lower-cased words (`getUserName` → `get user name`).
 */
export function codeAwareTokenize(text: string): string[] {
  return text
    .split(/[\s\p{P}]+/u)
    .flatMap((word) => {
      const expanded = word
        .replace(/([a-z])([A-Z])/g, "$1 $2")
        .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");

      return expanded.split(/[_\-\s]+/);
    })
    .filter((token) => token.length > 0)
    .map((token) => token.toLowerCase());
}

const HANGUL_TOKEN = /^[ㄱ-ㆎ가-힣]+$/;
/** Longest particles first so `에서` wins over `에`. */
const HANGUL_PARTICLES = [
  "입니다",
  "합니다",
  "에서는",
  "으로는",
  "에서",
  "으로",
  "에게",
  "부터",
  "까지",
  "처럼",
  "보다",
  "하고",
  "해서",
  "하면",
  "이다",
  "은",
  "는",
  "이",
  "가",
  "을",
  "를",
  "의",
  "에",
  "로",
  "와",
  "과",
  "도",
  "만",
];
const HANGUL_MIN_STEM = 2;
const HANGUL_MAX_STRIPS = 2;

/** Strips up to two trailing Korean particles while the stem keeps at least two syllables (`테스트를` → `테스트`). */
export function stripHangulParticles(token: string): string {
  if (!HANGUL_TOKEN.test(token)) return token;
  let stem = token;
  for (let round = 0; round < HANGUL_MAX_STRIPS; round += 1) {
    const particle = HANGUL_PARTICLES.find(
      (candidate) => stem.length - candidate.length >= HANGUL_MIN_STEM && stem.endsWith(candidate)
    );
    if (particle === undefined) break;
    stem = stem.slice(0, stem.length - particle.length);
  }
  return stem;
}

/**
 * Snapshot tokenizer: code-aware splitting plus Korean particle stripping. Hangul tokens emit the
 * stem and (when different) the original form so `어린이` and `어린이를` land on the same terms.
 */
export function snapshotTokenize(text: string): string[] {
  const tokens: string[] = [];
  for (const token of codeAwareTokenize(text)) {
    const stem = stripHangulParticles(token);
    tokens.push(stem);
    if (stem !== token) tokens.push(token);
  }
  return tokens;
}

/** MiniSearch constructor options for `lexical.v1.json` (builder and reader use exactly these). */
export function lexicalSnapshotOptions(): Options<LexicalSnapshotDocument> {
  return {
    fields: [...LEXICAL_SNAPSHOT_FIELDS],
    storeFields: [],
    idField: "id",
    tokenize: snapshotTokenize,
    searchOptions: {
      tokenize: snapshotTokenize,
      boost: { summary: 2.5, aliases: 2, details: 1 },
      prefix: true,
      fuzzy: false,
      combineWith: "OR",
    },
  };
}

/**
 * Options for an index built with MiniSearch's default tokenizer (no `tokenizer` stamp in the file):
 * the query side must tokenize the same way or identifiers / Korean particles stop matching.
 */
export function lexicalDefaultOptions(): Options<LexicalSnapshotDocument> {
  return {
    fields: [...LEXICAL_SNAPSHOT_FIELDS],
    storeFields: [],
    idField: "id",
    searchOptions: {
      boost: { summary: 2.5, aliases: 2, details: 1 },
      prefix: true,
      fuzzy: false,
      combineWith: "OR",
    },
  };
}

/** Picks the reader options matching the builder's stamp. */
export function lexicalOptionsFor(tokenizer: string | undefined): Options<LexicalSnapshotDocument> {
  return tokenizer === LEXICAL_TOKENIZER_ID ? lexicalSnapshotOptions() : lexicalDefaultOptions();
}

export function toLexicalDocument(memory: Pick<SnapshotMemory, "id" | "summary" | "details" | "aliases">): LexicalSnapshotDocument {
  return {
    id: memory.id,
    summary: memory.summary,
    details: memory.details,
    aliases: memory.aliases.join(" "),
  };
}

/** Raw BM25 → (0, 1): `s / (s + 1)`; `before_model.min_score` is compared against this value. */
export function normalizeLexicalScore(raw: number): number {
  return raw <= 0 ? 0 : raw / (raw + 1);
}
