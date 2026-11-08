import { defineConfig } from "tsup";

// Phase A6 entry map: the v0.5 per-command CLI bundles and the OpenCode plugin are gone.
// TODO(B2/B3): add the runtime bundles once their sources exist — they do not yet:
//   hook: "src/hook-launch.ts", "hook-bundle": "src/hook.ts", worker: "src/worker.ts", "embed-helper": "src/embed-helper.ts"
export default defineConfig({
  entry: {
    index: "src/index.ts",
    "core/index": "src/core/index.ts",
    "activation/index": "src/activation/index.ts",
    "adapters/index": "src/adapters/index.ts",
    "audit/index": "src/audit/index.ts",
    "db/index": "src/db/index.ts",
    "dream/index": "src/dream/index.ts",
    "eval/index": "src/eval/index.ts",
    "memory/index": "src/memory/index.ts",
    "policy/index": "src/policy/index.ts",
    "bin/harness-memory": "src/bin/harness-memory.ts",
  },
  format: ["esm"],
  target: "node20",
  platform: "node",
  bundle: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  dts: true,
  shims: false,
  outDir: "dist",
  external: ["sql.js", "@xenova/transformers"],
});
