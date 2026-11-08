/**
 * Snapshot builder (spec §4.8): output shape per src/core/snapshot-types, V11 exclusion, lexical index
 * round-trip through MiniSearch.loadJSON (Korean alias), dense file encoding, counts and the reindex marker.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import MiniSearch from "minisearch";
import type { Database as SqlJsDatabase } from "sql.js";

import { LEXICAL_TOKENIZER_ID, lexicalOptionsFor, type LexicalSnapshotDocument } from "../src/activation/lexical-snapshot";
import { DEFAULT_CONFIG } from "../src/core/config";
import { resolvePaths, stateDirectories, type HarnessPaths } from "../src/core/paths";
import type { ActiveSnapshot, LexicalSnapshot } from "../src/core/snapshot-types";
import { ProposalRepository } from "../src/db/repositories/proposals";
import { buildSnapshot, buildSnapshotData, decodeDenseSnapshot, encodeDenseSnapshot, sourceFileOf, toSnapshotMemory } from "../src/db/snapshot";
import { MemoryRepository } from "../src/memory/repository";
import { derivePolicyRules } from "../src/policy/derive";
import { createTestDb } from "./helpers/create-test-db";
import { T0, autoMemory, humanMemory } from "./helpers/memory-fixtures";

let db: SqlJsDatabase;
let memories: MemoryRepository;
let root: string;
let paths: HarnessPaths;

beforeEach(async () => {
  db = await createTestDb({ now: T0 });
  memories = new MemoryRepository(db, { clock: () => T0 });
  root = mkdtempSync(join(tmpdir(), "hm-snapshot-"));
  paths = resolvePaths(root);
  for (const dir of stateDirectories(paths)) mkdirSync(dir, { recursive: true });
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

function seed() {
  const policy = memories.create(
    humanMemory({
      type: "policy",
      summary: "Never commit .env files",
      details: "Secrets live in the vault.",
      scopeGlob: "**/*",
      lifecycleTriggers: ["before_tool", "before_model"],
      policySubtype: "hard",
      enforcement: "confirm",
      triggerSignature: { tool: "write|edit", target: "path", pattern_kind: "glob", pattern: "**/.env*" },
      sourceRef: "import:CLAUDE.md#L12",
    })
  );
  const pitfall = memories.create(
    autoMemory({
      status: "active",
      summary: "Run the suite with pnpm test; npm test has no script here.",
      details: "x".repeat(700),
      scopeGlob: "**/*",
      lifecycleTriggers: ["before_tool"],
      triggerSignature: { tool: "bash", target: "command", pattern_kind: "cmd", pattern: "npm test" },
      signatureKey: "bash|command|cmd|pm test",
      aliases: ["pnpm test", "테스트 실행"],
      failureClasses: ["exit_1"],
      embedding: new Float32Array([0.1, 0.2, 0.3, 0.4]),
      enforcement: "soft_deny",
      knowledgeKind: "failure_resolution",
    })
  );
  const unreachable = memories.create(
    autoMemory({ type: "workflow", status: "active", summary: "Unreachable workflow before_tool only", scopeGlob: "src/**", lifecycleTriggers: ["before_tool"], knowledgeKind: "convention" })
  );
  const readOnly = memories.create(
    autoMemory({
      status: "active",
      summary: "Signature on a tool the hooks never see",
      scopeGlob: "docs/**",
      lifecycleTriggers: ["before_tool"],
      triggerSignature: { tool: "read", target: "path", pattern_kind: "glob", pattern: "docs/**/*.md" },
      knowledgeKind: "convention",
    })
  );
  const candidate = memories.create(autoMemory({ summary: "Still a candidate" }));
  return { policy, pitfall, unreachable, readOnly, candidate };
}

describe("buildSnapshot", () => {
  test("writes active / lexical / dense files with the documented shape and excludes unreachable rows", () => {
    const rows = seed();
    derivePolicyRules(db, { now: T0 });
    new ProposalRepository(db).create({ kind: "stale", targetMemoryId: rows.pitfall.id, rationale: "r", confidence: 0.5, createdBy: "extractor", now: T0 });
    writeFileSync(join(paths.queueDir, "a.json"), "{}");
    writeFileSync(join(paths.queueDir, "b.json"), "{}");
    writeFileSync(paths.reindexRequested, "");

    const result = buildSnapshot(db, paths, { now: T0, config: DEFAULT_CONFIG, generation: 7, pid: 4242 });

    expect(existsSync(paths.snapshotActive)).toBe(true);
    expect(existsSync(paths.snapshotLexical)).toBe(true);
    expect(existsSync(paths.snapshotDense)).toBe(true);
    expect(existsSync(paths.reindexRequested)).toBe(false);
    expect(existsSync(`${paths.snapshotActive}.tmp-4242`)).toBe(false);

    const active = JSON.parse(readFileSync(paths.snapshotActive, "utf8")) as ActiveSnapshot;
    expect(active.schema).toBe("active.v1");
    expect(active.built_at).toBe(T0);
    expect(active.db_generation).toBe(7);
    expect(active.user_version).toBe(21);
    expect(active.last_dream_at).toBeNull();
    expect(active.last_probe).toBeNull();
    expect(typeof active.source.mtime_ms).toBe("number");
    expect(active.memories.map((memory) => memory.id).sort()).toEqual([rows.policy.id, rows.pitfall.id].sort());
    expect(result.unreachable.map((entry) => entry.id).sort()).toEqual([rows.unreachable.id, rows.readOnly.id].sort());
    expect(result.unreachable.every((entry) => entry.reason === "trigger_unreachable")).toBe(true);

    const pitfall = active.memories.find((memory) => memory.id === rows.pitfall.id)!;
    expect(pitfall.details).toHaveLength(600);
    expect(pitfall.scope_regex).toBeNull();
    expect(pitfall.signature).toMatchObject({ tool: "bash", target: "command", pattern_kind: "cmd", pattern: "pm test", tokens: ["pm", "test"], signature_key: "bash|command|cmd|pm test" });
    expect(pitfall.authority).toBe("auto");
    expect(pitfall.enforcement).toBe("soft_deny");
    expect(pitfall.aliases).toEqual(["pnpm test", "테스트 실행"]);
    expect(pitfall.failure_classes).toEqual(["exit_1"]);
    expect(pitfall.source_file).toBeNull();
    expect(Object.keys(pitfall).sort()).toEqual(
      [
        "id", "type", "summary", "details", "scope_glob", "scope_regex", "activation_class", "lifecycle_triggers", "relevant_tools", "signature",
        "authority", "enforcement", "status", "knowledge_kind", "policy_subtype", "confidence", "importance", "evidence_score", "evidence_count",
        "validation_count", "fire_count", "override_count", "ttl_expires_at", "source_file", "aliases", "contested", "import_unconfirmed",
        "failure_classes", "created_at", "updated_at", "last_verified_at",
      ].sort()
    );

    const policy = active.memories.find((memory) => memory.id === rows.policy.id)!;
    expect(policy.source_file).toBe("CLAUDE.md");
    expect(policy.policy_subtype).toBe("hard");
    expect(policy.signature?.regex_source).toBeTypeOf("string");
    expect(policy.signature?.pattern_kind).toBe("glob");

    expect(active.rules).toHaveLength(2);
    expect(active.rules[0]).toMatchObject({ memory_id: rows.policy.id, tool_pattern: "write|edit", target_kind: "path", pattern_kind: "glob", arg_pattern: "**/.env*", enforcement: "confirm", scope_regex: null });
    expect(active.failure_index).toEqual({ exit_1: [rows.pitfall.id] });
    expect(active.counts).toEqual({ active: 2, candidates: 1, open_proposals: 1, auto_active: 1, expiring_7d: 0, unreachable: 2, queue: 2 });

    const lexical = JSON.parse(readFileSync(paths.snapshotLexical, "utf8")) as LexicalSnapshot;
    expect(lexical.schema).toBe("lexical.v1");
    expect(lexical.fields).toEqual(["summary", "details", "aliases"]);
    expect(lexical.recent_summaries).toEqual([]);
    expect(lexical.tokenizer).toBe(LEXICAL_TOKENIZER_ID);
    const index = MiniSearch.loadJSON<LexicalSnapshotDocument>(JSON.stringify(lexical.index), lexicalOptionsFor(lexical.tokenizer));
    expect(index.documentCount).toBe(2);
    expect(index.search("테스트").map((hit) => String(hit.id))).toEqual([rows.pitfall.id]);
    expect(index.search("테스트를 돌려").map((hit) => String(hit.id))).toEqual([rows.pitfall.id]);
    expect(index.search("env").map((hit) => String(hit.id))).toEqual([rows.policy.id]);
    expect(index.search("pnpm", { prefix: true }).map((hit) => String(hit.id))).toEqual([rows.pitfall.id]);

    const dense = decodeDenseSnapshot(readFileSync(paths.snapshotDense));
    expect(dense.header).toMatchObject({ schema: "dense.v1", db_generation: 7, model: DEFAULT_CONFIG.embeddings.model, dims: 4, dtype: "float32", ids: [rows.pitfall.id] });
    expect(Array.from(dense.matrix).map((value) => Number(value.toFixed(3)))).toEqual([0.1, 0.2, 0.3, 0.4]);
    expect(result.bytes.active).toBeGreaterThan(1000);
  });

  test("a stale dense file is removed when no row has an embedding; recent summaries are listed", () => {
    memories.create(humanMemory({ summary: "Plain policy" }));
    db.run(
      `INSERT INTO session_summaries (id, session_id, summary_short, summary_medium, source_event_ids, tool_names, type_distribution, event_count, created_at, updated_at)
       VALUES ('ss1', 'session-1', 'short one', 'medium', '[]', '[]', '{}', 1, ?, ?)`,
      [T0, T0]
    );
    writeFileSync(paths.snapshotDense, "stale");
    const result = buildSnapshot(db, paths, { now: T0, config: DEFAULT_CONFIG });
    expect(result.dense).toBeNull();
    expect(existsSync(paths.snapshotDense)).toBe(false);
    const lexical = JSON.parse(readFileSync(paths.snapshotLexical, "utf8")) as LexicalSnapshot;
    expect(lexical.recent_summaries).toEqual([{ session_id: "session-1", summary_short: "short one", updated_at: T0 }]);
    expect(result.active.counts.queue).toBe(0);
  });

  test("toSnapshotMemory drops a signature that no longer compiles and keeps the row when another trigger reaches it", () => {
    const row = memories.create(
      humanMemory({
        type: "pitfall",
        summary: "Bad regex signature but before_model keeps it",
        lifecycleTriggers: ["before_tool", "before_model"],
        triggerSignature: { tool: "bash", target: "command", pattern_kind: "regex", pattern: "(a+)+$" },
      })
    );
    const converted = toSnapshotMemory(row);
    expect(converted.signatureDropped).toBe(true);
    expect(converted.snapshot?.signature).toBeNull();
    expect(converted.unreachable).toBeNull();

    const data = buildSnapshotData(db, paths, { now: T0 });
    expect(data.signatureDropped).toEqual([row.id]);
    expect(data.active.counts.unreachable).toBe(0);
  });

  test("dense encoding round-trips and sourceFileOf parses import refs", () => {
    const header = { schema: "dense.v1" as const, built_at: T0, db_generation: 1, model: "m", dims: 2, dtype: "float32" as const, ids: ["a", "b"] };
    const buffer = encodeDenseSnapshot(header, [new Float32Array([1, 2]), new Float32Array([3, 4])]);
    expect(buffer.readUInt32LE(0)).toBe(Buffer.byteLength(JSON.stringify(header), "utf8"));
    const decoded = decodeDenseSnapshot(buffer);
    expect(decoded.header).toEqual(header);
    expect(Array.from(decoded.matrix)).toEqual([1, 2, 3, 4]);
    expect(sourceFileOf("import:CLAUDE.md#L3")).toBe("CLAUDE.md");
    expect(sourceFileOf("import:docs/AGENTS.md")).toBe("docs/AGENTS.md");
    expect(sourceFileOf("episode:abc")).toBeNull();
    expect(sourceFileOf(null)).toBeNull();
  });
});
