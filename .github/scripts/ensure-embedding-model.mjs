/**
 * CI helper for the `embedding` job (.github/workflows/ci.yml): make sure `Xenova/multilingual-e5-small` sits
 * in BOTH directories the Tier-2 suites read from, downloading it at most once.
 *
 *   1. @xenova/transformers' own default cache, `env.cacheDir` (node_modules/@xenova/transformers/.cache):
 *      test/embedding/real-model.test.ts builds `new EmbeddingService()` without a cacheDir, and
 *      EmbeddingService sets env.cacheDir only when one is passed (src/activation/embeddings.ts).
 *   2. modelsDir() = (HARNESS_MEMORY_HOME ?? ~/.harness-memory)/models (src/core/paths.ts): the runtime helper
 *      (src/embed/helper.ts, `config.embeddings.cache_dir ?? modelsDir()`) and
 *      test/embedding/helper-real-model.test.ts, whose beforeAll throws when the model is missing there and
 *      deliberately never downloads.
 *
 * Both directories use transformers' FileCache layout `<cacheDir>/Xenova/multilingual-e5-small/{config.json,
 * tokenizer.json, tokenizer_config.json, onnx/model_quantized.onnx}`, so the second one is a copy of the first.
 * Idempotent: when both are complete it exits without loading the model or touching the network, so the
 * workflow runs it on cache hits as well and a partial cache cannot pin the job red.
 */
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const MODEL = "Xenova/multilingual-e5-small";
const MODEL_SEGMENTS = MODEL.split("/");
/** The files `pipeline("feature-extraction", MODEL, { quantized: true })` (the default) loads; the .onnx is 118 MB. */
const REQUIRED_FILES = ["config.json", "tokenizer.json", "tokenizer_config.json", join("onnx", "model_quantized.onnx")];

function modelDirIn(cacheDir) {
  return join(cacheDir, ...MODEL_SEGMENTS);
}

function complete(cacheDir) {
  const dir = modelDirIn(cacheDir);
  return REQUIRED_FILES.every((file) => existsSync(join(dir, file)));
}

function missing(cacheDir) {
  const dir = modelDirIn(cacheDir);
  return REQUIRED_FILES.filter((file) => !existsSync(join(dir, file)));
}

const started = Date.now();
const transformers = await import("@xenova/transformers");
const transformersCache = resolve(transformers.env.cacheDir);
const runtimeModels = join(process.env.HARNESS_MEMORY_HOME ?? join(homedir(), ".harness-memory"), "models");

if (complete(transformersCache)) {
  console.log(`${MODEL} already complete in ${transformersCache}`);
} else {
  console.log(`${MODEL} missing ${missing(transformersCache).join(", ")} in ${transformersCache}: downloading`);
  transformers.env.allowLocalModels = true;
  transformers.env.allowRemoteModels = true;
  await transformers.pipeline("feature-extraction", MODEL, { quantized: true });
  if (!complete(transformersCache)) {
    throw new Error(`pipeline() finished but ${transformersCache} still lacks ${missing(transformersCache).join(", ")}`);
  }
  console.log(`downloaded into ${transformersCache}`);
}

if (complete(runtimeModels)) {
  console.log(`${MODEL} already complete in ${runtimeModels}`);
} else {
  console.log(`${MODEL} missing ${missing(runtimeModels).join(", ")} in ${runtimeModels}: copying from ${transformersCache}`);
  mkdirSync(modelDirIn(runtimeModels), { recursive: true });
  cpSync(modelDirIn(transformersCache), modelDirIn(runtimeModels), { recursive: true, force: true });
  if (!complete(runtimeModels)) {
    throw new Error(`copy finished but ${runtimeModels} still lacks ${missing(runtimeModels).join(", ")}`);
  }
  console.log(`copied into ${runtimeModels}`);
}

console.log(`model ready in both caches (${String(Date.now() - started)} ms)`);
