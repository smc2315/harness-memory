import { minimatch } from "minimatch";

function normalizeGlobPath(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+/g, "/");
}

export function createScopeMatcher(
  scopeGlob: string
): (scopeRef: string) => boolean {
  const normalizedGlob = normalizeGlobPath(scopeGlob);
  return (scopeRef: string) =>
    minimatch(normalizeGlobPath(scopeRef), normalizedGlob, { dot: true });
}

export function matchesScope(scopeGlob: string, scopeRef: string): boolean {
  return createScopeMatcher(scopeGlob)(scopeRef);
}

export function normalizeScopeRef(scopeRef: string): string {
  return normalizeGlobPath(scopeRef);
}
