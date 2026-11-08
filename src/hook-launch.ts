// `dist/hook.js <event>` — the ≤ 20-line launcher registered in Claude Code's settings (spec §3.1).
// It enables Node's compile cache when available (m0-facts #5) and then loads the real bundle, so the
// bundle's own compilation benefits from the cache. Always exits 0 and never writes to stdout itself.
import * as nodeModule from "node:module";

(nodeModule as { enableCompileCache?: () => unknown }).enableCompileCache?.();
// A failure after main() returned (a detached child's asynchronous `error`, a stray rejection) stays silent too.
process.on("uncaughtException", () => { process.exitCode = 0; });
process.on("unhandledRejection", () => { process.exitCode = 0; });

const bundleSpecifier = "./hook-bundle.js";
try {
  const bundle = (await import(bundleSpecifier)) as { main(argv: readonly string[]): Promise<unknown> };
  await bundle.main(process.argv.slice(2));
} catch {
  // A broken install must not surface as a hook error: the host sees exit 0 and no output.
}
process.exitCode = 0;
