import { defineConfig } from "vitest/config";

/**
 * Tier 2 benchmark configuration.
 *
 * Uses REAL multilingual-e5-small embeddings. Tests are slower (~10-20s)
 * and require model download on first run (~60MB).
 *
 * Run: npx vitest run --config vitest.tier2.config.ts
 */
export default defineConfig({
  test: {
    include: ["test/benchmark-tier2/**/*.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
