/**
 * Embedding service for vector-based memory retrieval.
 *
 * Uses @xenova/transformers with multilingual-e5-small (384d) for local
 * embedding generation. Supports Korean + English text.
 */

import type { FeatureExtractionPipelineType } from "@xenova/transformers";

const DEFAULT_MODEL = "Xenova/multilingual-e5-small";
export const EMBEDDING_DIMENSIONS = 384;
const MAX_CACHE_SIZE = 200;
const WARMUP_TIMEOUT_MS = 30_000;

export interface EmbeddingServiceOptions {
  modelName?: string;
  cacheDir?: string;
}

export class EmbeddingService {
  private static defaultInstance: EmbeddingService | null = null;

  static getInstance(options?: EmbeddingServiceOptions): EmbeddingService {
    if (EmbeddingService.defaultInstance === null) {
      EmbeddingService.defaultInstance = new EmbeddingService(options);
    }

    return EmbeddingService.defaultInstance;
  }

  private pipeline: FeatureExtractionPipelineType | null = null;
  private initPromise: Promise<void> | null = null;
  private cache = new Map<string, Float32Array>();
  private modelName: string;
  private cacheDir: string | undefined;
  public isReady = false;

  constructor(options?: EmbeddingServiceOptions) {
    this.modelName = options?.modelName ?? DEFAULT_MODEL;
    this.cacheDir = options?.cacheDir;
  }

  /** Warm up the model (download if needed, load into memory). */
  async warmup(): Promise<void> {
    if (this.isReady) {
      return;
    }

    if (this.initPromise !== null) {
      return this.initPromise;
    }

    this.initPromise = Promise.race([
      this.loadModel(),
      new Promise<void>((_, reject) => {
        setTimeout(() => {
          reject(new Error(`Embedding warmup timed out after ${WARMUP_TIMEOUT_MS}ms`));
        }, WARMUP_TIMEOUT_MS);
      }),
    ]);

    return this.initPromise;
  }

  private async loadModel(): Promise<void> {
    try {
      // Dynamic import to avoid bundling issues
      const { pipeline, env } = await import("@xenova/transformers");

      env.allowLocalModels = true;
      env.allowRemoteModels = true;
      if (this.cacheDir !== undefined) {
        env.cacheDir = this.cacheDir;
      }

      this.pipeline = await pipeline("feature-extraction", this.modelName, {
        progress_callback: undefined,
      });

      this.isReady = true;
    } catch (error) {
      this.initPromise = null;
      throw error;
    }
  }

  /**
   * Generate embedding for a raw text string. Returns 384-dim Float32Array.
   *
   * For e5-family models, prefer {@link embedQuery} or {@link embedPassage}
   * which add the required task prefix for better discrimination.
   */
  async embed(text: string): Promise<Float32Array> {
    const cached = this.cache.get(text);
    if (cached !== undefined) {
      return cached;
    }

    if (!this.isReady) {
      await this.warmup();
    }

    if (this.pipeline === null) {
      throw new Error("Embedding pipeline not initialized");
    }

    const output = (await this.pipeline(text, {
      pooling: "mean",
      normalize: true,
    })) as { data: ArrayLike<number> };

    const embedding = new Float32Array(output.data);

    if (embedding.length !== EMBEDDING_DIMENSIONS) {
      throw new Error(
        `Unexpected embedding dimension ${embedding.length}; expected ${EMBEDDING_DIMENSIONS}`
      );
    }

    if (this.cache.size >= MAX_CACHE_SIZE) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) {
        this.cache.delete(firstKey);
      }
    }
    this.cache.set(text, embedding);

    return embedding;
  }

  /**
   * Embed a search query with the "query: " prefix required by e5 models.
   *
   * Use this when embedding user queries / search text for retrieval.
   */
  async embedQuery(text: string): Promise<Float32Array> {
    return this.embed(`query: ${text}`);
  }

  /**
   * Embed a document passage with the "passage: " prefix required by e5 models.
   *
   * Use this when embedding memory content for indexing / storage.
   */
  async embedPassage(text: string): Promise<Float32Array> {
    return this.embed(`passage: ${text}`);
  }

  /** Embed multiple texts as passages. */
  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    const results: Float32Array[] = [];
    for (const text of texts) {
      results.push(await this.embedPassage(text));
    }

    return results;
  }
}

/** Cosine similarity between two normalized vectors. */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    return 0;
  }

  let dot = 0;
  for (let index = 0; index < a.length; index += 1) {
    dot += a[index] * b[index];
  }

  // Vectors are already normalized by the pipeline, so dot product = cosine
  return dot;
}

/** Find top-K most similar vectors. */
export function findTopK(
  query: Float32Array,
  candidates: { id: string; embedding: Float32Array }[],
  k: number
): { id: string; score: number }[] {
  const scored = candidates.map((candidate) => ({
    id: candidate.id,
    score: cosineSimilarity(query, candidate.embedding),
  }));

  scored.sort((left, right) => right.score - left.score);
  return scored.slice(0, k);
}
