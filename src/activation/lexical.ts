/**
 * Lexical search sidecar for the activation engine.
 *
 * Uses MiniSearch (BM25) to index memory summary + details text.
 * Provides fast keyword-based retrieval as an alternative to glob matching.
 */

import MiniSearch from "minisearch";

export interface LexicalDocument {
  id: string;
  summary: string;
  details: string;
}

export interface LexicalSearchResult {
  id: string;
  score: number;
}

/**
 * Splits text on whitespace/punctuation, then further splits camelCase,
 * snake_case, and kebab-case tokens into individual words.
 *
 * Examples:
 *   "getUserName" -> ["get", "user", "name"]
 *   "user_name" -> ["user", "name"]
 *   "my-component" -> ["my", "component"]
 */
function codeAwareTokenize(text: string): string[] {
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

export class LexicalIndex {
  private index: MiniSearch<LexicalDocument>;

  constructor() {
    this.index = new MiniSearch<LexicalDocument>({
      fields: ["summary", "details"],
      storeFields: ["summary"],
      tokenize: codeAwareTokenize,
      searchOptions: {
        tokenize: codeAwareTokenize,
        boost: { summary: 2.5, details: 1 },
        prefix: true,
        fuzzy: false,
      },
    });
  }

  get size(): number {
    return this.index.documentCount;
  }

  rebuild(documents: readonly LexicalDocument[]): void {
    this.index.removeAll();
    this.index.addAll(documents as LexicalDocument[]);
  }

  add(document: LexicalDocument): void {
    this.index.add(document);
  }

  remove(document: LexicalDocument): void {
    this.index.remove(document);
  }

  search(query: string, limit?: number): LexicalSearchResult[] {
    if (query.trim().length === 0) {
      return [];
    }

    const results = this.index.search(query);
    const capped = limit !== undefined ? results.slice(0, limit) : results;

    return capped.map((result) => ({
      id: String(result.id),
      score: result.score,
    }));
  }
}
