import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: [
      "node_modules/**",
      ".bun/**",
      ".opencode/**",
      ".local/**",
      "test/embedding/**",
      "test/benchmark-tier2/**",
      "test/tmp-debug.test.ts",
      // spawned-hook latency measurement: runs alone via vitest.latency.config.ts (npm run test:latency)
      "test/eval-latency.test.ts",
    ],
  },
});
