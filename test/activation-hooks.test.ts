/**
 * Pure read-path functions over snapshot rows: before_tool ranking/quotas/decisions, before_model
 * thresholds and fusion, session_start filters and digest, after_tool hints, the snapshot reader and
 * the shared rendering / tokenizer helpers.
 */

import { readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";

import { afterEach, describe, expect, test } from "vitest";

import { selectAfterToolHints } from "../src/activation/after-tool";
import { activateBeforeModel } from "../src/activation/before-model";
import { decideBeforeTool, type BeforeToolInput } from "../src/activation/before-tool";
import { applyBudget, isHostLoadedFile, itemFromSnapshotMemory, renderItemText, renderReason } from "../src/activation/injection";
import { LEXICAL_TOKENIZER_ID, normalizeLexicalScore, snapshotTokenize, stripHangulParticles } from "../src/activation/lexical-snapshot";
import { snapshotMemoryScore, trustMultiplier } from "../src/activation/scoring";
import { buildDigestMessage, selectSessionStartItems } from "../src/activation/session-start";
import {
  compileSnapshotRegexes,
  isActiveSnapshot,
  readActiveSnapshot,
  readLexicalSnapshot,
  requestReindex,
  scopeMatches,
  type LoadedSnapshot,
} from "../src/activation/snapshot-reader";
import { DEFAULT_CONFIG } from "../src/core/config";
import type { SnapshotMemory } from "../src/core/snapshot-types";
import {
  buildActiveSnapshot,
  buildLexicalSnapshot,
  createHarnessFixture,
  FIXTURE_NOW,
  fixtureMemory,
  fixtureRule,
  type HarnessFixture,
} from "./helpers/snapshot-fixture";

function load(memories: SnapshotMemory[], rules = [] as ReturnType<typeof fixtureRule>[], failureIndex: Record<string, string[]> = {}): LoadedSnapshot {
  const snapshot = buildActiveSnapshot({ memories, rules, failureIndex });
  return { snapshot, compiled: compileSnapshotRegexes(memories), stale: false, byId: new Map(memories.map((memory) => [memory.id, memory])) };
}

const emptyTail = { firedKeys: new Set<string>(), lastScopeRef: null as string | null };

function bashInput(command: string, overrides: Partial<BeforeToolInput> = {}): BeforeToolInput {
  return { canonical: "bash", dialect: "bash", targetKind: "command", target: command, scopeRefs: [], permissionMode: "default", ...overrides };
}

describe("decideBeforeTool", () => {
  test("signature memories fire on a path-less command even with a narrow scope (R2), scope-less pitfalls need a global scope", () => {
    const narrowSignature = fixtureMemory({ id: "narrow-sig", scope_glob: "src/db/**", signature: { tool: "bash", target: "command", pattern_kind: "cmd", pattern: "pm test" }, enforcement: "soft_deny" });
    const narrowPlain = fixtureMemory({ id: "narrow-plain", type: "pitfall", scope_glob: "src/db/**", lifecycle_triggers: ["before_tool"] });
    const globalPlain = fixtureMemory({ id: "global-plain", type: "pitfall", scope_glob: "**/*", lifecycle_triggers: ["before_tool"] });
    const loaded = load([narrowSignature, narrowPlain, globalPlain]);

    const decision = decideBeforeTool({ loaded, tailState: emptyTail, input: bashInput("npm test"), config: DEFAULT_CONFIG, now: FIXTURE_NOW });
    expect(decision.activated.map((item) => item.id)).toEqual(["narrow-sig", "global-plain"]);
    expect(decision.suppressed).toContainEqual(expect.objectContaining({ id: "narrow-plain", kind: "scope_mismatch" }));
    expect(decision.decision).toBe("deny");
    expect(decision.fired?.memory_ids).toEqual(["narrow-sig", "global-plain"]);

    // With scope refs that miss the narrow scope, the signature row is suppressed too (scope and signature are complementary, not conjunctive only when refs are absent).
    const withRefs = decideBeforeTool({ loaded, tailState: emptyTail, input: bashInput("npm test -- src/memory/a.test.ts", { scopeRefs: ["src/memory/a.test.ts"] }), config: DEFAULT_CONFIG, now: FIXTURE_NOW });
    expect(withRefs.suppressed).toContainEqual(expect.objectContaining({ id: "narrow-sig", kind: "scope_mismatch" }));

    // lastScopeRef inside the scope adds the +0.25 bonus but never suppresses.
    const bonus = decideBeforeTool({ loaded, tailState: { firedKeys: new Set(), lastScopeRef: "src/db/store.ts" }, input: bashInput("npm test"), config: DEFAULT_CONFIG, now: FIXTURE_NOW });
    const plain = decideBeforeTool({ loaded, tailState: emptyTail, input: bashInput("npm test"), config: DEFAULT_CONFIG, now: FIXTURE_NOW });
    expect(bonus.activated[0]!.score).toBeCloseTo(plain.activated[0]!.score + 0.25, 6);
  });

  test("ranking: deny > confirm > soft_deny > advise, signature match, human first, then score; quotas and budget apply", () => {
    const base = { signature: { tool: "bash", target: "command", pattern_kind: "cmd", pattern: "pm test" } as const, type: "pitfall" as const };
    const adviseHuman = fixtureMemory({ id: "advise-human", ...base, authority: "human", enforcement: "advise", importance: 0.2 });
    const softAuto = fixtureMemory({ id: "soft-auto", ...base, enforcement: "soft_deny" });
    const softHuman = fixtureMemory({ id: "soft-human", ...base, authority: "human", enforcement: "soft_deny", importance: 0.1 });
    const softAutoHighScore = fixtureMemory({ id: "soft-auto-hi", ...base, enforcement: "soft_deny", importance: 0.99, validation_count: 3 });
    const denyPolicy = fixtureMemory({ id: "deny-policy", ...base, type: "policy", authority: "human", enforcement: "deny" });
    const loaded = load([adviseHuman, softAuto, softHuman, softAutoHighScore, denyPolicy]);

    const decision = decideBeforeTool({ loaded, tailState: emptyTail, input: bashInput("npm test"), config: DEFAULT_CONFIG, now: FIXTURE_NOW });
    // deny first; then the pitfall quota (2) keeps the human soft_deny and the high-score auto one; advise and the low auto fall out.
    expect(decision.activated.map((item) => item.id)).toEqual(["deny-policy", "soft-human", "soft-auto-hi"]);
    expect(decision.suppressed).toContainEqual(expect.objectContaining({ id: "soft-auto", kind: "type_balance_limit" }));
    expect(decision.decision).toBe("deny");
    expect(decision.enforcement).toBe("deny");
    expect(decision.reason).toContain("blocked by a human-set policy");
    expect(decision.additionalContext).toContain("soft-human".length > 0 ? "PITFALL" : "");

    const tight = decideBeforeTool({
      loaded,
      tailState: emptyTail,
      input: bashInput("npm test"),
      config: { before_tool: { ...DEFAULT_CONFIG.before_tool, max_items: 1, max_bytes: 2048 } },
      now: FIXTURE_NOW,
    });
    expect(tight.activated.map((item) => item.id)).toEqual(["deny-policy"]);
    expect(tight.suppressed.filter((entry) => entry.kind === "budget_limit")).toHaveLength(2);

    const tinyBytes = decideBeforeTool({
      loaded,
      tailState: emptyTail,
      input: bashInput("npm test"),
      config: { before_tool: { ...DEFAULT_CONFIG.before_tool, max_items: 3, max_bytes: 10 } },
      now: FIXTURE_NOW,
    });
    expect(tinyBytes.activated).toEqual([]);
    expect(tinyBytes.decision).toBe("none");
    expect(tinyBytes.fired).toBeNull();
  });

  test("deny fires every time; soft_deny and confirm are excluded once fired for the same (memory|tool)", () => {
    const deny = fixtureMemory({ id: "deny-1", type: "policy", authority: "human", enforcement: "deny", signature: { tool: "bash", target: "command", pattern_kind: "cmd", pattern: "rm -rf" } });
    const soft = fixtureMemory({ id: "soft-1", enforcement: "soft_deny", signature: { tool: "bash", target: "command", pattern_kind: "cmd", pattern: "rm -rf" } });
    const confirm = fixtureMemory({ id: "confirm-1", type: "policy", authority: "human", enforcement: "confirm", signature: { tool: "bash", target: "command", pattern_kind: "cmd", pattern: "rm -rf" } });
    const loaded = load([deny, soft, confirm]);
    const fired = { firedKeys: new Set(["deny-1|bash", "soft-1|bash", "confirm-1|bash"]), lastScopeRef: null };
    const decision = decideBeforeTool({ loaded, tailState: fired, input: bashInput("rm -rf dist"), config: DEFAULT_CONFIG, now: FIXTURE_NOW });
    expect(decision.activated.map((item) => item.id)).toEqual(["deny-1"]);
    expect(decision.suppressed.filter((entry) => entry.kind === "already_fired").map((entry) => entry.id).sort()).toEqual(["confirm-1", "soft-1"]);

    // Same memory, different tool → not excluded.
    const otherTool = decideBeforeTool({ loaded, tailState: { firedKeys: new Set(["soft-1|edit"]), lastScopeRef: null }, input: bashInput("rm -rf dist"), config: DEFAULT_CONFIG, now: FIXTURE_NOW });
    expect(otherTool.activated.map((item) => item.id)).toContain("soft-1");
  });

  test("filters: status, ttl, trigger, relevant_tools (mcp prefix), signature target kind and signature-less types", () => {
    const stale = fixtureMemory({ id: "stale", status: "stale", signature: { tool: "bash", target: "command", pattern_kind: "cmd", pattern: "pm test" } });
    const expired = fixtureMemory({ id: "expired", ttl_expires_at: "2026-11-01T00:00:00.000Z", signature: { tool: "bash", target: "command", pattern_kind: "cmd", pattern: "pm test" } });
    const wrongTrigger = fixtureMemory({ id: "wrong-trigger", lifecycle_triggers: ["before_model"], signature: { tool: "bash", target: "command", pattern_kind: "cmd", pattern: "pm test" } });
    const toolMismatch = fixtureMemory({ id: "tool-mismatch", relevant_tools: ["edit", "write"], scope_glob: "**/*" });
    const mcpOnly = fixtureMemory({ id: "mcp-only", relevant_tools: ["mcp"], scope_glob: "**/*" });
    const pathSig = fixtureMemory({ id: "path-sig", signature: { tool: "*", target: "path", pattern_kind: "glob", pattern: "**/*.env" } });
    const decision = fixtureMemory({ id: "decision-no-sig", type: "decision", scope_glob: "**/*" });
    const loaded = load([stale, expired, wrongTrigger, toolMismatch, mcpOnly, pathSig, decision]);

    const bash = decideBeforeTool({ loaded, tailState: emptyTail, input: bashInput("npm test"), config: DEFAULT_CONFIG, now: FIXTURE_NOW });
    const kinds = Object.fromEntries(bash.suppressed.map((entry) => [entry.id, entry.kind]));
    expect(kinds).toMatchObject({
      stale: "status_inactive",
      expired: "ttl_expired",
      "wrong-trigger": "trigger_mismatch",
      "tool-mismatch": "tool_mismatch",
      "mcp-only": "tool_mismatch",
      "path-sig": "signature_mismatch",
      "decision-no-sig": "signature_required",
    });
    expect(bash.activated).toEqual([]);

    const mcp = decideBeforeTool({
      loaded,
      tailState: emptyTail,
      input: { canonical: "mcp:github/create_issue", dialect: null, targetKind: "any", target: '{"title":"x"}', scopeRefs: [], permissionMode: null },
      config: DEFAULT_CONFIG,
      now: FIXTURE_NOW,
    });
    expect(mcp.activated.map((item) => item.id)).toEqual(["mcp-only"]);
  });

  test("policy rules join through the shared matcher and show up as rule items / rule codes", () => {
    const memory = fixtureMemory({ id: "pol-mem", type: "policy", authority: "human", enforcement: "confirm", scope_glob: "**/*", signature: { tool: "write|edit", target: "path", pattern_kind: "glob", pattern: "**/.env*" } });
    const derived = fixtureRule({ rule_code: "POL-pol-mem-before_tool", memory_id: "pol-mem", tool_pattern: "write|edit", target_kind: "path", pattern_kind: "glob", arg_pattern: "**/.env*", enforcement: "confirm", message: memory.summary });
    const manual = fixtureRule({ rule_code: "MANUAL_DB", scope_glob: "src/db/**", tool_pattern: "edit", enforcement: "advise", message: "Database edits need a migration file" });
    const loaded = load([memory], [derived, manual]);

    const env = decideBeforeTool({
      loaded,
      tailState: emptyTail,
      input: { canonical: "write", dialect: null, targetKind: "path", target: ".env", scopeRefs: [".env"], permissionMode: "default" },
      config: DEFAULT_CONFIG,
      now: FIXTURE_NOW,
    });
    expect(env.activated.map((item) => item.id)).toEqual(["pol-mem"]);
    expect(env.rules.map((rule) => rule.ruleCode)).toEqual(["POL-pol-mem-before_tool"]);
    expect(env.fired).toMatchObject({ memory_ids: ["pol-mem"], rule_codes: ["POL-pol-mem-before_tool"], decision: "ask" });

    const db = decideBeforeTool({
      loaded,
      tailState: emptyTail,
      input: { canonical: "edit", dialect: null, targetKind: "path", target: "src/db/store.ts", scopeRefs: ["src/db/store.ts"], permissionMode: "default" },
      config: DEFAULT_CONFIG,
      now: FIXTURE_NOW,
    });
    expect(db.activated.map((item) => item.id)).toEqual(["rule:MANUAL_DB"]);
    expect(db.decision).toBe("none");
    expect(db.additionalContext).toContain("Database edits need a migration file");
    expect(db.fired).toMatchObject({ memory_ids: [], rule_codes: ["MANUAL_DB"], delivery: "with_result" });
  });

  test("permission modes: dontAsk downgrades confirm, plan/default/acceptEdits keep ask", () => {
    const confirm = fixtureMemory({ id: "c", type: "policy", authority: "human", enforcement: "confirm", signature: { tool: "bash", target: "command", pattern_kind: "cmd", pattern: "git push --force" } });
    const loaded = load([confirm]);
    for (const [mode, expected] of [
      ["dontAsk", "deny"],
      ["bypassPermissions", "deny"],
      ["plan", "ask"],
      ["acceptEdits", "ask"],
      [null, "ask"],
    ] as const) {
      const decision = decideBeforeTool({ loaded, tailState: emptyTail, input: bashInput("git push --force", { permissionMode: mode }), config: DEFAULT_CONFIG, now: FIXTURE_NOW });
      expect(decision.decision, String(mode)).toBe(expected);
      expect(decision.downgraded).toBe(expected === "deny");
    }
  });
});

describe("activateBeforeModel", () => {
  const baseline = fixtureMemory({ id: "baseline", type: "policy", activation_class: "baseline", lifecycle_triggers: ["before_model", "session_start"], summary: "Always run eslint before committing", authority: "human" });
  const scoped = fixtureMemory({ id: "scoped", type: "workflow", scope_glob: "src/db/**", lifecycle_triggers: ["before_model"], summary: "Free sql.js statements in finally blocks", authority: "human" });
  const globalRow = fixtureMemory({ id: "global", type: "workflow", lifecycle_triggers: ["before_model"], summary: "Use pnpm instead of npm for every script", aliases: ["패키지 매니저"] });
  const hostLoaded = fixtureMemory({ id: "host", type: "workflow", lifecycle_triggers: ["before_model"], source_file: "CLAUDE.md", summary: "Use pnpm for scripts (CLAUDE.md copy)" });
  let fixture: HarnessFixture | null = null;

  afterEach(() => {
    fixture?.cleanup();
    fixture = null;
  });

  test("baseline always, lexical hits above min_score, host-loaded skipped, scope intersection required", async () => {
    fixture = createHarnessFixture({ memories: [baseline, scoped, globalRow, hostLoaded] });
    const loaded = readActiveSnapshot(fixture.paths, { spawnWorker: null })!;
    const lexical = await readLexicalSnapshot(fixture.paths);
    expect(lexical?.documentCount).toBe(4);

    const result = await activateBeforeModel({ loaded, lexical, prompt: "should I use pnpm or npm for scripts?", lastScopeRef: null, host: "claude-code", config: DEFAULT_CONFIG, now: FIXTURE_NOW });
    expect(result.items.map((item) => item.id)).toEqual(["baseline", "global"]);
    expect(result.suppressed).toContainEqual(expect.objectContaining({ id: "host", kind: "host_loaded" }));
    expect(result.suppressed).toContainEqual(expect.objectContaining({ id: "scoped", kind: "scope_mismatch" }));
    expect(result.text).toContain("[harness-memory] POLICY (human)");

    const korean = await activateBeforeModel({ loaded, lexical, prompt: "패키지 매니저는 뭘 써야 해?", lastScopeRef: null, host: "claude-code", config: DEFAULT_CONFIG, now: FIXTURE_NOW });
    expect(korean.items.map((item) => item.id)).toContain("global");

    const viaLastScope = await activateBeforeModel({ loaded, lexical, prompt: "finally blocks for statements?", lastScopeRef: "src/db/store.ts", host: "claude-code", config: DEFAULT_CONFIG, now: FIXTURE_NOW });
    expect(viaLastScope.items.map((item) => item.id)).toContain("scoped");

    const strict = await activateBeforeModel({ loaded, lexical, prompt: "unrelated question about pancakes", lastScopeRef: null, host: "claude-code", config: { before_model: { ...DEFAULT_CONFIG.before_model, min_score: 0.99 } }, now: FIXTURE_NOW });
    expect(strict.items.map((item) => item.id)).toEqual(["baseline"]);
    expect(strict.suppressed.filter((entry) => entry.kind === "retrieval_miss").length).toBeGreaterThanOrEqual(1);
  });

  test("a dense hit ≥ 0.80 rescues a lexical miss and fuses with RRF; below the threshold it does not", async () => {
    fixture = createHarnessFixture({ memories: [baseline, globalRow] });
    const loaded = readActiveSnapshot(fixture.paths, { spawnWorker: null })!;
    const lexical = await readLexicalSnapshot(fixture.paths);
    const dense = { topk: async () => ({ ids: ["global"], scores: [0.86] }) };
    const hit = await activateBeforeModel({ loaded, lexical, dense, prompt: "which tool installs packages here", lastScopeRef: null, host: "claude-code", config: DEFAULT_CONFIG, now: FIXTURE_NOW });
    expect(hit.denseUsed).toBe(true);
    expect(hit.items.map((item) => item.id)).toEqual(["baseline", "global"]);
    expect(hit.items[1]!.source).toBe("dense");

    const weak = { topk: async () => ({ ids: ["global"], scores: [0.5] }) };
    const miss = await activateBeforeModel({ loaded, lexical, dense: weak, prompt: "which tool installs packages here", lastScopeRef: null, host: "claude-code", config: DEFAULT_CONFIG, now: FIXTURE_NOW });
    expect(miss.items.map((item) => item.id)).toEqual(["baseline"]);

    const failing = { topk: async () => null };
    const noHelper = await activateBeforeModel({ loaded, lexical, dense: failing, prompt: "pnpm or npm", lastScopeRef: null, host: "claude-code", config: DEFAULT_CONFIG, now: FIXTURE_NOW });
    expect(noHelper.denseUsed).toBe(false);
    expect(noHelper.items.map((item) => item.id)).toContain("global");
    expect(noHelper.items.find((item) => item.id === "global")!.source).toBe("lexical");
  });

  test("budget: max_items and max_bytes cut the list in rank order", async () => {
    const many = Array.from({ length: 8 }, (_, index) => fixtureMemory({ id: `b-${String(index)}`, activation_class: "baseline", lifecycle_triggers: ["before_model"], importance: 0.1 * (index + 1) }));
    const loaded = load(many);
    const result = await activateBeforeModel({ loaded, lexical: null, prompt: "anything", lastScopeRef: null, host: "claude-code", config: { before_model: { ...DEFAULT_CONFIG.before_model, max_items: 3 } }, now: FIXTURE_NOW });
    expect(result.items).toHaveLength(3);
    expect(result.items.map((item) => item.id)).toEqual(["b-7", "b-6", "b-5"]);
    expect(result.suppressed.filter((entry) => entry.kind === "budget_limit")).toHaveLength(5);
  });
});

describe("session start and after tool", () => {
  test("selectSessionStartItems keeps baseline/decision/constraint/workflow rows that opt into session_start", () => {
    const rows = [
      fixtureMemory({ id: "baseline", type: "policy", activation_class: "baseline", lifecycle_triggers: ["session_start"] }),
      fixtureMemory({ id: "decision", type: "decision", lifecycle_triggers: ["session_start"] }),
      fixtureMemory({ id: "constraint", type: "architecture_constraint", lifecycle_triggers: ["session_start"], importance: 0.9 }),
      fixtureMemory({ id: "workflow", type: "workflow", lifecycle_triggers: ["session_start"] }),
      fixtureMemory({ id: "pitfall", type: "pitfall", lifecycle_triggers: ["session_start"] }),
      fixtureMemory({ id: "no-trigger", type: "decision", lifecycle_triggers: ["before_model"] }),
      fixtureMemory({ id: "agents", type: "workflow", lifecycle_triggers: ["session_start"], source_file: "docs/AGENTS.md" }),
      fixtureMemory({ id: "claude", type: "workflow", lifecycle_triggers: ["session_start"], source_file: ".claude/CLAUDE.md" }),
    ];
    const result = selectSessionStartItems({ loaded: load(rows), host: "claude-code", config: DEFAULT_CONFIG, now: FIXTURE_NOW });
    // baseline first, then score (constraint has the highest importance), then the id tie-break.
    expect(result.items.map((item) => item.id)).toEqual(["baseline", "constraint", "agents", "decision", "workflow"]);
    const kinds = Object.fromEntries(result.suppressed.map((entry) => [entry.id, entry.kind]));
    expect(kinds).toMatchObject({ pitfall: "type_excluded", "no-trigger": "trigger_mismatch", claude: "host_loaded" });

    const codex = selectSessionStartItems({ loaded: load(rows), host: "codex", config: DEFAULT_CONFIG, now: FIXTURE_NOW });
    expect(codex.items.map((item) => item.id)).toContain("claude");
    expect(codex.items.map((item) => item.id)).not.toContain("agents");
  });

  test("buildDigestMessage is throttled per day and silent when nothing is pending", () => {
    expect(buildDigestMessage({ open_proposals: 0, expiring_7d: 0 }, undefined, FIXTURE_NOW)).toBeNull();
    expect(buildDigestMessage({ open_proposals: 1, expiring_7d: 0 }, undefined, FIXTURE_NOW)).toBe("harness-memory: 1 proposal open — run `hm review`");
    expect(buildDigestMessage({ open_proposals: 2, expiring_7d: 2 }, "2026-11-07", FIXTURE_NOW)).toContain("2 proposals open, 2 expiring");
    expect(buildDigestMessage({ open_proposals: 2, expiring_7d: 2 }, "2026-11-08", FIXTURE_NOW)).toBeNull();
  });

  test("selectAfterToolHints follows failure_index, respects relevant_tools and the 2 / 1 KB budget", () => {
    const rows = [
      fixtureMemory({ id: "h1", lifecycle_triggers: ["after_tool"], failure_classes: ["enoent"], importance: 0.9 }),
      fixtureMemory({ id: "h2", lifecycle_triggers: ["after_tool"], failure_classes: ["enoent"], importance: 0.5 }),
      fixtureMemory({ id: "h3", lifecycle_triggers: ["after_tool"], failure_classes: ["enoent"], importance: 0.7 }),
      fixtureMemory({ id: "edit-only", lifecycle_triggers: ["after_tool"], failure_classes: ["enoent"], relevant_tools: ["edit"], importance: 0.99 }),
      fixtureMemory({ id: "inactive", status: "stale", failure_classes: ["enoent"] }),
    ];
    const loaded = load(rows, [], { enoent: ["edit-only", "h1", "h2", "h3", "inactive", "missing-id"] });
    const result = selectAfterToolHints({ loaded, failureClass: "enoent", canonical: "bash", config: DEFAULT_CONFIG, now: FIXTURE_NOW });
    expect(result.items.map((item) => item.id)).toEqual(["h1", "h3"]);
    expect(result.skipped.sort()).toEqual(["edit-only", "h2", "inactive", "missing-id"]);
    expect(selectAfterToolHints({ loaded, failureClass: "timeout", canonical: "bash", config: DEFAULT_CONFIG, now: FIXTURE_NOW }).items).toEqual([]);
  });
});

describe("snapshot reader", () => {
  let fixture: HarnessFixture | null = null;

  afterEach(() => {
    fixture?.cleanup();
    fixture = null;
  });

  test("validates the schema, precompiles regexes and detects staleness", () => {
    const memory = fixtureMemory({ id: "m", scope_glob: "src/**/*.ts", signature: { tool: "edit", target: "path", pattern_kind: "glob", pattern: "**/*.sqlite" } });
    fixture = createHarnessFixture({ memories: [memory] });
    const loaded = readActiveSnapshot(fixture.paths, { spawnWorker: null });
    expect(loaded).not.toBeNull();
    expect(loaded!.stale).toBe(false);
    // regexes are compiled lazily: nothing before the first scope check, cached afterwards
    expect(loaded!.compiled.scopeRegex.size).toBe(0);
    expect(scopeMatches(loaded!, memory, "src/db/store.ts")).toBe(true);
    expect(loaded!.compiled.scopeRegex.get("m")).toBeInstanceOf(RegExp);
    expect(loaded!.compiled.scopeRegex.size).toBe(1);
    const eager = compileSnapshotRegexes(loaded!.snapshot.memories);
    expect(eager.scopeRegex.get("m")).toBeInstanceOf(RegExp);
    expect(eager.signatureRegex.get("m")).toBeInstanceOf(RegExp);
    expect(scopeMatches(loaded!, memory, "docs/readme.md")).toBe(false);
    expect(scopeMatches(loaded!, memory, "src\\db\\store.ts")).toBe(true);

    fixture.touchDb();
    const spawns: string[] = [];
    const stale = readActiveSnapshot(fixture.paths, { spawnWorker: (command) => (spawns.push(command), 1) });
    expect(stale!.stale).toBe(true);
    expect(spawns).toEqual(["reindex"]);

    expect(isActiveSnapshot({ schema: "active.v1" })).toBe(false);
    expect(isActiveSnapshot(JSON.parse(readFileSync(fixture.paths.snapshotActive, "utf8")))).toBe(true);
  });

  test("requestReindex is throttled by the touch file and skipped without a database", () => {
    fixture = createHarnessFixture({ memories: [] });
    const spawns: string[] = [];
    const spawnWorker = (command: string): number => (spawns.push(command), 1);
    expect(requestReindex(fixture.paths, { spawnWorker, nowMs: Date.parse(FIXTURE_NOW) })).toBe(true);
    expect(requestReindex(fixture.paths, { spawnWorker, nowMs: Date.parse(FIXTURE_NOW) + 30_000 })).toBe(false);
    const old = new Date(Date.parse(FIXTURE_NOW) - 120_000);
    utimesSync(fixture.paths.reindexRequested, old, old);
    expect(requestReindex(fixture.paths, { spawnWorker, nowMs: Date.parse(FIXTURE_NOW) })).toBe(true);
    expect(spawns).toEqual(["reindex", "reindex"]);
    expect(statSync(fixture.paths.reindexRequested).mtimeMs).toBeGreaterThan(old.getTime());

    const noDb = createHarnessFixture({ withDb: false, withActive: false });
    try {
      expect(requestReindex(noDb.paths, { spawnWorker })).toBe(false);
      expect(readActiveSnapshot(noDb.paths, { spawnWorker })).toBeNull();
      expect(spawns).toHaveLength(2);
    } finally {
      noDb.cleanup();
    }
  });

  test("readLexicalSnapshot returns null for a missing or malformed file", async () => {
    fixture = createHarnessFixture({ memories: [], withLexical: false });
    expect(await readLexicalSnapshot(fixture.paths)).toBeNull();
    writeFileSync(fixture.paths.snapshotLexical, JSON.stringify({ schema: "lexical.v1", index: "nope", recent_summaries: [] }), "utf8");
    expect(await readLexicalSnapshot(fixture.paths)).toBeNull();
  });

  test("an index built with MiniSearch defaults (no tokenizer stamp) is queried with default tokenization", async () => {
    const memory = fixtureMemory({ id: "camel", summary: "Call getUserName before rendering", details: "", aliases: ["테스트를"] });
    fixture = createHarnessFixture({ memories: [memory], withLexical: false });
    writeFileSync(fixture.paths.snapshotLexical, JSON.stringify(buildLexicalSnapshot([memory], [], { defaultTokenizer: true })), "utf8");
    const searcher = await readLexicalSnapshot(fixture.paths);
    expect(searcher?.tokenizer).toBeUndefined();
    expect(searcher!.search("getUserName", 5).map((hit) => hit.id)).toEqual(["camel"]);
    expect(searcher!.search("테스트를", 5).map((hit) => hit.id)).toEqual(["camel"]);

    writeFileSync(fixture.paths.snapshotLexical, JSON.stringify(buildLexicalSnapshot([memory])), "utf8");
    const stamped = await readLexicalSnapshot(fixture.paths);
    expect(stamped?.tokenizer).toBe(LEXICAL_TOKENIZER_ID);
    expect(stamped!.search("user name", 5).map((hit) => hit.id)).toEqual(["camel"]);
    expect(stamped!.search("테스트", 5).map((hit) => hit.id)).toEqual(["camel"]);
  });
});

describe("injection helpers, scoring and tokenizer", () => {
  test("renderItemText / renderReason / applyBudget", () => {
    const memory = fixtureMemory({ id: "x", type: "architecture_constraint", authority: "auto", summary: "Keep adapters thin", details: "Boundaries stay in src/adapters.", contested: 1 });
    const item = itemFromSnapshotMemory(memory, { score: 1, source: "scope" });
    expect(item.text).toBe("[harness-memory] CONSTRAINT (auto, provisional): Keep adapters thin — Boundaries stay in src/adapters.");
    expect(item.contested).toBe(false);
    const contestedHuman = itemFromSnapshotMemory({ ...memory, authority: "human", enforcement: "advise" }, { score: 1, source: "scope" });
    expect(contestedHuman.text).toContain("(human, contested)");
    expect(renderReason(item, "soft_deny").endsWith("call the tool again to proceed.")).toBe(true);
    expect(renderReason({ ...item, text: "x".repeat(900) }, "confirm").length).toBeLessThanOrEqual(600);
    expect(renderItemText({ type: "policy", authority: "human", unconfirmed: true, summary: "S", details: "", contested: false })).toBe("[harness-memory] POLICY (human, unconfirmed import): S");

    const budget = applyBudget([item, item, item], 2, 10_000);
    expect(budget.included).toHaveLength(2);
    expect(budget.dropped).toHaveLength(1);
    expect(applyBudget([item], 5, item.bytes - 1).included).toEqual([]);
    expect(applyBudget([item, item], 5, item.bytes * 2).included).toHaveLength(1);
  });

  test("isHostLoadedFile per host; scoring trust ladder", () => {
    expect(isHostLoadedFile("claude-code", "CLAUDE.md")).toBe(true);
    expect(isHostLoadedFile("claude-code", "sub/dir/claude.local.md")).toBe(true);
    expect(isHostLoadedFile("claude-code", "AGENTS.md")).toBe(false);
    expect(isHostLoadedFile("codex", "AGENTS.md")).toBe(true);
    expect(isHostLoadedFile("import", "CLAUDE.md")).toBe(false);
    expect(isHostLoadedFile("claude-code", null)).toBe(false);

    const now = Date.parse(FIXTURE_NOW);
    const human = fixtureMemory({ authority: "human", importance: 1, confidence: 1, updated_at: FIXTURE_NOW });
    expect(snapshotMemoryScore(human, now)).toBeCloseTo(1, 6);
    expect(trustMultiplier("auto", 0)).toBe(0.65);
    expect(trustMultiplier("auto", 1)).toBe(0.8);
    expect(trustMultiplier("auto", 5)).toBe(0.95);
    const old = fixtureMemory({ authority: "auto", validation_count: 1, importance: 1, confidence: 1, updated_at: "2020-01-01T00:00:00.000Z" });
    expect(snapshotMemoryScore(old, now)).toBeCloseTo(0.75 * 0.8, 6);
  });

  test("snapshot tokenizer strips Korean particles and keeps code identifiers", () => {
    expect(stripHangulParticles("테스트를")).toBe("테스트");
    expect(stripHangulParticles("스크립트에서는")).toBe("스크립트");
    expect(stripHangulParticles("회의")).toBe("회의");
    expect(stripHangulParticles("어린이를")).toBe("어린");
    expect(snapshotTokenize("getUserName 테스트를 run_tests")).toEqual(["get", "user", "name", "테스트", "테스트를", "run", "tests"]);
    expect(normalizeLexicalScore(0)).toBe(0);
    expect(normalizeLexicalScore(1)).toBeCloseTo(0.5, 6);
  });
});
