import { defineConfig } from "vitest/config";

/**
 * The spawned-hook latency test measures wall-clock time of 50 real `node dist/hook.js pre-tool` processes.
 * Under `npm test` it would share the machine with the other suites (20-process ops tests, worker runs) and
 * report load, not the hook, so it runs on its own: `npm run test:latency` (needs `npm run build`).
 * The hard spec gate (p95 ≤ 90 ms) is `hm eval:latency`.
 */
export default defineConfig({
  test: {
    include: ["test/eval-latency.test.ts"],
    fileParallelism: false,
  },
});
