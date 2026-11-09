/**
 * Lexical search sidecar for the activation engine.
 *
 * Uses MiniSearch (BM25) to index memory summary + details text.
 * Provides fast keyword-based retrieval as an alternative to glob matching.
 */

import MiniSearch from "minisearch";

import { codeAwareTokenize } from "./lexical-snapshot";

export interface LexicalDocument {
  id: string;
  summary: string;
  details: string;
}

export interface LexicalSearchResult {
  id: string;
  score: number;
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

  search(query: string, limit?: number, candidateIds?: ReadonlySet<string>): LexicalSearchResult[] {
    if (query.trim().length === 0) {
      return [];
    }

    let results = this.index.search(query);
    if (candidateIds !== undefined) {
      results = results.filter((result) => candidateIds.has(String(result.id)));
    }

    const capped = limit !== undefined ? results.slice(0, limit) : results;

    return capped.map((result) => ({
      id: String(result.id),
      score: result.score,
    }));
  }
}
