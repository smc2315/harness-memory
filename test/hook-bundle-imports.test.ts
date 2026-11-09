/**
 * Static import-graph guard for the hook bundle (plan §2 convention): starting from src/hook.ts and
 * src/embed-helper.ts, no statically imported module may pull sql.js, minimatch or @xenova/transformers,
 * and minisearch may only be reached through a dynamic `import()`. Also pins the launcher to ≤ 20 lines.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { describe, expect, test } from "vitest";

const SRC = resolve(__dirname, "..", "src");
const FORBIDDEN_STATIC = ["sql.js", "minimatch", "@xenova/transformers", "minisearch"];

/** `import x from "y"`, `import { a } from "y"`, `export { a } from "y"`, `export * from "y"` — but not `import type` / `import(`. */
const STATIC_IMPORT = /^(?:import|export)\s+(?!type\b)[^;'"]*?\s+from\s+["']([^"']+)["']/gm;
const SIDE_EFFECT_IMPORT = /^import\s+["']([^"']+)["']/gm;

function resolveLocal(from: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const base = resolve(dirname(from), specifier);
  for (const candidate of [`${base}.ts`, resolve(base, "index.ts")]) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`cannot resolve ${specifier} from ${from}`);
}

function walk(entry: string): { files: Set<string>; packages: Map<string, string[]> } {
  const files = new Set<string>();
  const packages = new Map<string, string[]>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (files.has(file)) continue;
    files.add(file);
    const source = readFileSync(file, "utf8");
    const specifiers: string[] = [];
    for (const match of source.matchAll(STATIC_IMPORT)) specifiers.push(match[1]!);
    for (const match of source.matchAll(SIDE_EFFECT_IMPORT)) specifiers.push(match[1]!);
    for (const specifier of specifiers) {
      const local = resolveLocal(file, specifier);
      if (local !== null) {
        queue.push(local);
      } else if (!specifier.startsWith("node:")) {
        const users = packages.get(specifier) ?? [];
        users.push(file.slice(SRC.length + 1).replace(/\\/g, "/"));
        packages.set(specifier, users);
      }
    }
  }
  return { files, packages };
}

describe("hook bundle import graph", () => {
  test("src/hook.ts never statically imports sql.js, minimatch, transformers or minisearch", () => {
    const { files, packages } = walk(resolve(SRC, "hook.ts"));
    expect(files.size).toBeGreaterThan(20);
    for (const name of FORBIDDEN_STATIC) {
      expect(packages.get(name) ?? [], `${name} reached through ${JSON.stringify(packages.get(name))}`).toEqual([]);
    }
    // The barrels that drag minimatch (activation/index via scope.ts) must stay out of the hook graph.
    const names = [...files].map((file) => file.slice(SRC.length + 1).replace(/\\/g, "/"));
    expect(names).not.toContain("activation/index.ts");
    expect(names).not.toContain("activation/scope.ts");
    expect(names).not.toContain("activation/engine.ts");
    expect(names).toContain("activation/signature.ts");
    expect(names).toContain("adapters/hook-core.ts");
  });

  test("the embedding helper entry reaches transformers only through a dynamic import", () => {
    const { packages } = walk(resolve(SRC, "embed-helper.ts"));
    for (const name of FORBIDDEN_STATIC) expect(packages.get(name) ?? []).toEqual([]);
    const helper = readFileSync(resolve(SRC, "embed", "helper.ts"), "utf8");
    expect(helper).toMatch(/await import\("@xenova\/transformers"\)/);
  });

  test("the launcher is at most 20 lines and enables the compile cache before loading the bundle", () => {
    const launcher = readFileSync(resolve(SRC, "hook-launch.ts"), "utf8");
    const lines = launcher.trimEnd().split(/\r?\n/);
    expect(lines.length).toBeLessThanOrEqual(20);
    expect(launcher).toContain("enableCompileCache?.()");
    expect(launcher.indexOf("enableCompileCache")).toBeLessThan(launcher.indexOf("hook-bundle.js"));
  });
});
