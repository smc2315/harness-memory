/**
 * Snapshot-side PolicyEngine (the hook path): a derived rule matches through its policy memory's
 * precompiled signature, so a PreToolUse process never recompiles `arg_pattern` — no minimatch load for
 * glob rules, no regex-safety sampling for regex rules (spec §4.6 / §6.2 step 6, plan §2). Manual rules
 * (memory_id NULL) still compile lazily. Nothing in this file compiles a glob before the assertions run,
 * so `require.cache` is a faithful witness for "minimatch was never loaded" (vitest isolates test files).
 */

import { createRequire } from "node:module";

import { describe, expect, test } from "vitest";

import { decideBeforeTool } from "../src/activation/before-tool";
import { emptyCompiledRegexes, type LoadedSnapshot } from "../src/activation/snapshot-reader";
import { DEFAULT_CONFIG } from "../src/core/config";
import type { CompiledSignature, SnapshotMemory } from "../src/core/snapshot-types";
import { PolicyEngine } from "../src/policy/engine";
import { buildActiveSnapshot, FIXTURE_NOW, fixtureMemory, fixtureRule } from "./helpers/snapshot-fixture";

const nodeRequire = createRequire(import.meta.url);

function minimatchModules(): string[] {
  return Object.keys(nodeRequire.cache).filter((file) => /[\\/]node_modules[\\/]minimatch[\\/]/.test(file));
}

/** The compiled form `active.v1.json` carries, written by hand: compiling it here would itself load minimatch. */
function precompiled(partial: Pick<CompiledSignature, "tool" | "target" | "pattern_kind" | "pattern"> & Partial<CompiledSignature>): CompiledSignature {
  return {
    negate: false,
    tokens: null,
    regex_source: null,
    signature_key: `${partial.tool}|${partial.target}|${partial.pattern_kind}|${partial.pattern}`,
    ...partial,
  };
}

function policyMemory(id: string, signature: CompiledSignature, enforcement: SnapshotMemory["enforcement"] = "confirm"): SnapshotMemory {
  const memory = fixtureMemory({ id, type: "policy", authority: "human", enforcement, summary: `Policy ${id}` });
  memory.signature = signature;
  return memory;
}

function load(memories: SnapshotMemory[], rules: ReturnType<typeof fixtureRule>[]): LoadedSnapshot {
  return {
    snapshot: buildActiveSnapshot({ memories, rules }),
    compiled: emptyCompiledRegexes(),
    stale: false,
    byId: new Map(memories.map((memory) => [memory.id, memory])),
  };
}

/** What minimatch produces for `**\/.env*` (dot: true), written by hand to keep this file free of glob compilation. */
const ENV_GLOB_REGEX = "^(?:.*/)?\\.env[^/]*$";

describe("PolicyEngine.fromSnapshotRules with the snapshot's memories", () => {
  test("a derived glob rule matches through its memory's precompiled signature: minimatch is never loaded", () => {
    expect(minimatchModules()).toEqual([]);
    const memory = policyMemory("pol-env", precompiled({ tool: "write|edit", target: "path", pattern_kind: "glob", pattern: "**/.env*", regex_source: ENV_GLOB_REGEX }));
    const rule = fixtureRule({
      id: "rule-env",
      rule_code: "POL-pol-env-before_tool",
      memory_id: "pol-env",
      tool_pattern: "write|edit",
      target_kind: "path",
      pattern_kind: "glob",
      arg_pattern: "**/.env*",
      enforcement: "confirm",
      message: memory.summary,
    });
    const engine = PolicyEngine.fromSnapshotRules([rule], new Map([[memory.id, memory]]));

    const hit = engine.evaluate({ lifecycleTrigger: "before_tool", scopeRef: "apps/web/.env.local", toolName: "write", toolTarget: "apps/web/.env.local" });
    expect(hit.warnings.map((warning) => warning.ruleCode)).toEqual(["POL-pol-env-before_tool"]);
    const miss = engine.evaluate({ lifecycleTrigger: "before_tool", scopeRef: "src/env.ts", toolName: "write", toolTarget: "src/env.ts" });
    expect(miss.warnings).toEqual([]);
    expect(minimatchModules()).toEqual([]);
  });

  test("the memory's compiled tokens are authoritative: a quoted cmd argument is not re-tokenized in the hook", () => {
    // `echo "a b"` compiles to the tokens [echo, "a b"]; recompiling the canonical pattern `echo a b` gives [echo, a, b].
    const memory = policyMemory("pol-echo", precompiled({ tool: "bash", target: "command", pattern_kind: "cmd", pattern: "echo a b", tokens: ["echo", "a b"] }), "soft_deny");
    const rule = fixtureRule({
      id: "rule-echo",
      rule_code: "POL-pol-echo-before_tool",
      memory_id: "pol-echo",
      tool_pattern: "bash",
      target_kind: "command",
      pattern_kind: "cmd",
      arg_pattern: "echo a b",
      enforcement: "soft_deny",
    });
    const request = { lifecycleTrigger: "before_tool" as const, scopeRef: "", toolName: "bash", toolTarget: 'echo "a b"', shellDialect: "bash" as const };
    expect(PolicyEngine.fromSnapshotRules([rule], new Map([[memory.id, memory]])).evaluate(request).warnings).toHaveLength(1);
    // Without the memories the engine has to recompile the pattern and the quoted argument no longer matches.
    expect(PolicyEngine.fromSnapshotRules([rule]).evaluate(request).warnings).toHaveLength(0);
  });

  test("a derived rule whose memory signature does not match its arg_pattern falls back to compiling", () => {
    const memory = policyMemory("pol-test", precompiled({ tool: "bash", target: "command", pattern_kind: "cmd", pattern: "pm test", tokens: ["pm", "test"] }));
    const rule = fixtureRule({
      id: "rule-build",
      rule_code: "POL-pol-test-before_tool",
      memory_id: "pol-test",
      tool_pattern: "bash",
      target_kind: "command",
      pattern_kind: "cmd",
      arg_pattern: "pm build",
      enforcement: "confirm",
    });
    const engine = PolicyEngine.fromSnapshotRules([rule], new Map([[memory.id, memory]]));
    expect(engine.evaluate({ lifecycleTrigger: "before_tool", scopeRef: "", toolName: "bash", toolTarget: "npm run build" }).warnings).toHaveLength(1);
    expect(engine.evaluate({ lifecycleTrigger: "before_tool", scopeRef: "", toolName: "bash", toolTarget: "npm test" }).warnings).toHaveLength(0);
  });

  test("decideBeforeTool resolves derived rules through loaded.byId (glob and regex kinds, still no minimatch)", () => {
    expect(minimatchModules()).toEqual([]);
    const envPolicy = policyMemory("pol-env", precompiled({ tool: "write|edit", target: "path", pattern_kind: "glob", pattern: "**/.env*", regex_source: ENV_GLOB_REGEX }));
    const forcePolicy = policyMemory("pol-force", precompiled({ tool: "bash", target: "command", pattern_kind: "regex", pattern: "git push.*--force", regex_source: "git push.*--force" }), "soft_deny");
    const rules = [
      fixtureRule({ id: "rule-env", rule_code: "POL-pol-env-before_tool", memory_id: "pol-env", tool_pattern: "write|edit", target_kind: "path", pattern_kind: "glob", arg_pattern: "**/.env*", enforcement: "confirm" }),
      fixtureRule({ id: "rule-force", rule_code: "POL-pol-force-before_tool", memory_id: "pol-force", tool_pattern: "bash", target_kind: "command", pattern_kind: "regex", arg_pattern: "git push.*--force", enforcement: "soft_deny" }),
    ];
    const loaded = load([envPolicy, forcePolicy], rules);
    const tailState = { firedKeys: new Set<string>(), lastScopeRef: null };

    const env = decideBeforeTool({
      loaded,
      tailState,
      input: { canonical: "write", dialect: null, targetKind: "path", target: ".env", scopeRefs: [".env"], permissionMode: "default" },
      config: DEFAULT_CONFIG,
      now: FIXTURE_NOW,
    });
    expect(env.activated.map((item) => item.id)).toEqual(["pol-env"]);
    expect(env.rules.map((rule) => rule.ruleCode)).toEqual(["POL-pol-env-before_tool"]);
    expect(env.decision).toBe("ask");

    const force = decideBeforeTool({
      loaded,
      tailState,
      input: { canonical: "bash", dialect: "bash", targetKind: "command", target: "git push --force origin main", scopeRefs: [], permissionMode: "default" },
      config: DEFAULT_CONFIG,
      now: FIXTURE_NOW,
    });
    expect(force.activated.map((item) => item.id)).toEqual(["pol-force"]);
    expect(force.rules.map((rule) => rule.ruleCode)).toEqual(["POL-pol-force-before_tool"]);
    expect(force.decision).toBe("deny");
    expect(minimatchModules()).toEqual([]);
  });

  // Last on purpose: compiling a glob loads minimatch, which the assertions above must not see.
  test("a manual rule (no memory) with a glob arg_pattern still compiles it lazily", () => {
    const manual = fixtureRule({
      id: "rule-manual",
      rule_code: "MANUAL_SQL",
      tool_pattern: "edit",
      target_kind: "path",
      pattern_kind: "glob",
      arg_pattern: "src/db/migrations/*.sql",
      enforcement: "advise",
    });
    const engine = PolicyEngine.fromSnapshotRules([manual], new Map());
    const hit = engine.evaluate({ lifecycleTrigger: "before_tool", scopeRef: "", toolName: "edit", toolTarget: "src/db/migrations/022_next.sql" });
    expect(hit.warnings.map((warning) => warning.ruleCode)).toEqual(["MANUAL_SQL"]);
    expect(engine.evaluate({ lifecycleTrigger: "before_tool", scopeRef: "", toolName: "edit", toolTarget: "src/db/store.ts" }).warnings).toEqual([]);
  });
});
