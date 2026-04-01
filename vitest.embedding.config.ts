import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/embedding/**/*.test.ts"],
    exclude: ["node_modules/**"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
