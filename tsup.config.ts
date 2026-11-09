import { defineConfig } from "tsup";

/**
 * Two bundles sets (plan §4 B3):
 *  - library entries with .d.ts (package.json `exports`), and
 *  - runtime entries without .d.ts: the hook launcher `dist/hook.js` (loads `./hook-bundle.js` through a
 *    variable specifier, so it stays a separate file), the hook bundle, the detached worker, the embedding
 *    helper and the `hm` binary. The hooks spawn `node dist/worker.js <root> <command>` and
 *    `node dist/embed-helper.js <root>` as siblings of the hook bundle, so every runtime entry sits at the
 *    dist root.
 * sql.js and @xenova/transformers stay external (loaded lazily at runtime); minisearch/minimatch are
 * bundled where statically imported and left to the lazy `import()`/createRequire paths in the hook.
 */
const shared = {
  format: ["esm"] as const,
  target: "node20" as const,
  platform: "node" as const,
  bundle: true,
  splitting: false,
  sourcemap: true,
  shims: false,
  outDir: "dist",
  external: ["sql.js", "@xenova/transformers"],
};

export default defineConfig([
  {
    ...shared,
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
    },
    clean: true,
    dts: true,
  },
  {
    ...shared,
    entry: {
      hook: "src/hook-launch.ts",
      "hook-bundle": "src/hook.ts",
      worker: "src/worker.ts",
      "embed-helper": "src/embed-helper.ts",
      "bin/harness-memory": "src/bin/harness-memory.ts",
    },
    clean: false,
    dts: false,
  },
]);
