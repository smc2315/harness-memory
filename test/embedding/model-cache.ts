/**
 * Shared by the Tier-2 files (`npm run test:embedding`): the directory the runtime helper reads the quantized
 * `Xenova/multilingual-e5-small` from — `embeddings.cache_dir`, default `~/.harness-memory/models`
 * (`HARNESS_MEMORY_HOME` moves it; `modelsDir` in src/core/paths) — and the fail-fast check that keeps vitest
 * from ever downloading the 130 MB model or racing a download against EmbeddingService's 30 s warmup timer.
 * Both Tier-2 files therefore share one model copy with `hm dream` / the helper, and CI needs to cache one path.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import { DEFAULT_CONFIG } from "../../src/core/config";
import { modelsDir } from "../../src/core/paths";

export interface CachedModelOptions {
  /** Defaults to `DEFAULT_CONFIG.embeddings.model`. */
  model?: string;
  /** `embeddings.cache_dir`; null / undefined = `modelsDir()`. */
  cacheDir?: string | null;
}

/** The cache directory both Tier-2 files load the model from: the one `createTransformersEmbedder` / `createCliEmbed` use. */
export function tier2CacheDir(cacheDir?: string | null): string {
  return cacheDir ?? DEFAULT_CONFIG.embeddings.cache_dir ?? modelsDir();
}

/** What @xenova/transformers reads for a quantized feature-extraction pipeline; the ONNX file is the 118 MB one. */
const REQUIRED_FILES = ["config.json", "tokenizer.json", "tokenizer_config.json", join("onnx", "model_quantized.onnx")];

/** Returns the model directory, or throws (instead of downloading) when the quantized model is not cached there. */
export function requireCachedModel(options: CachedModelOptions = {}): string {
  const model = options.model ?? DEFAULT_CONFIG.embeddings.model;
  const modelDir = join(tier2CacheDir(options.cacheDir), ...model.split("/"));
  const missing = REQUIRED_FILES.filter((file) => !existsSync(join(modelDir, file)));
  if (missing.length > 0) {
    throw new Error(
      `Tier-2 embedding tests: the model ${model} is not cached at ${modelDir} (missing ${missing.join(", ")}). ` +
        `The cache is embeddings.cache_dir, default ~/.harness-memory/models (HARNESS_MEMORY_HOME moves it). ` +
        `Enable embeddings in a project and run \`hm dream\` once with network access to download it, then re-run; ` +
        `the Tier-2 tests never download inside vitest.`
    );
  }
  return modelDir;
}
