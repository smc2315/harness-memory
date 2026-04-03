import { EmbeddingService } from "../../../src/activation/embeddings";

export interface Tier2EmbeddingRuntime {
  service: EmbeddingService;
  warmupMs: number;
}

let cachedRuntime: Tier2EmbeddingRuntime | null = null;

export async function createTier2EmbeddingRuntime(): Promise<Tier2EmbeddingRuntime> {
  if (cachedRuntime !== null && cachedRuntime.service.isReady) {
    return cachedRuntime;
  }

  const service = new EmbeddingService();
  const start = Date.now();
  await service.warmup();
  const warmupMs = Date.now() - start;

  cachedRuntime = {
    service,
    warmupMs,
  };

  return cachedRuntime;
}

export function resetTier2EmbeddingRuntime(): void {
  cachedRuntime = null;
}
