/**
 * consolidate / runDream (spec §5.8, §13.2 (k)): TTL paths for correction vs convention rows, candidate
 * expiry at 45 d, fire-based TTL extension, override downgrade, merge and fix_signature proposals,
 * embedding backfill, the idle-turn sweep and the file GC.
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { Database as SqlJsDatabase } from "sql.js";

import { DEFAULT_CONFIG } from "../src/core/config";
import type { SessionState } from "../src/core/ledger-types";
import { ledgerFile, resolvePaths, stateDirectories, stateFile, type HarnessPaths } from "../src/core/paths";
import { META_KEYS, MetaRepository } from "../src/db/repositories/meta";
import { ProposalRepository } from "../src/db/repositories/proposals";
import { TransitionRepository } from "../src/db/repositories/transitions";
import { selectAll } from "../src/db/sql";
import { garbageCollectFiles, runDream, sweepIdleTurns } from "../src/dream/consolidate";
import { appendLedgerLine, parseLedger } from "../src/dream/ledger";
import { MemoryRepository } from "../src/memory/repository";
import { createTestDb } from "./helpers/create-test-db";
import { assistantLine, promptLine, toolFailLine } from "./helpers/ledger-fixture";
import { T0, autoMemory, humanMemory, isoPlus } from "./helpers/memory-fixtures";

let db: SqlJsDatabase;
let memories: MemoryRepository;
let root: string;
let paths: HarnessPaths;

beforeEach(async () => {
  db = await createTestDb({ now: T0 });
  memories = new MemoryRepository(db, { clock: () => T0 });
  root = mkdtempSync(join(tmpdir(), "hm-dream-"));
  paths = resolvePaths(root);
  for (const dir of stateDirectories(paths)) mkdirSync(dir, { recursive: true });
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

async function dream(now: string, extra: Partial<Parameters<typeof runDream>[1]> = {}) {
  db.run("BEGIN");
  try {
    const op = await runDream(db, { paths, config: DEFAULT_CONFIG, now, skipFiles: true, ...extra });
    db.run("COMMIT");
    return op;
  } catch (error) {
    db.run("ROLLBACK");
    throw error;
  }
}

describe("(k) TTL and candidate expiry", () => {
  test("a correction row reaching its TTL gets a revalidate proposal; the proposal's expiry stales it", async () => {
    const row = memories.create(autoMemory({ status: "active", knowledgeKind: "correction", ttlExpiresAt: isoPlus(T0, { days: 30 }), lifecycleTriggers: ["before_tool"], summary: "Correction row" }));
    const before = await dream(isoPlus(T0, { days: 29 }));
    expect(before.noop).toBe(true);
    expect(before.wrote).toBe(true);
    expect(memories.getById(row.id)?.status).toBe("active");

    const atTtl = await dream(isoPlus(T0, { days: 31 }));
    expect(atTtl.noop).toBe(false);
    expect(atTtl.id).toBe(`dream:${isoPlus(T0, { days: 31 })}`);
    expect(atTtl.report.revalidateProposals).toHaveLength(1);
    expect(memories.getById(row.id)?.status).toBe("active");
    const proposal = new ProposalRepository(db).getById(atTtl.report.revalidateProposals[0]!)!;
    expect(proposal).toMatchObject({ kind: "revalidate", targetMemoryId: row.id, createdBy: "consolidator", status: "open" });
    expect(proposal.expiresAt).toBe(isoPlus(T0, { days: 61 }));

    const again = await dream(isoPlus(T0, { days: 40 }));
    expect(again.report.revalidateProposals).toEqual([]);
    expect(memories.getById(row.id)?.status).toBe("active");

    const afterProposalExpiry = await dream(isoPlus(T0, { days: 62 }));
    expect(afterProposalExpiry.report.expiredProposals).toEqual([proposal.id]);
    expect(afterProposalExpiry.report.staledByExpiry).toEqual([row.id]);
    const stale = memories.getById(row.id)!;
    expect(stale.status).toBe("stale");
    expect(stale.statusReason).toBe("ttl_expired");
    expect(new TransitionRepository(db).listForMemory(row.id)).toEqual([expect.objectContaining({ toStatus: "stale", actor: "expiry", proposalId: proposal.id })]);
    expect(new MetaRepository(db).get(META_KEYS.lastDreamAt)).toBe(isoPlus(T0, { days: 62 }));
  });

  test("a convention row goes stale(ttl_expired) directly at 7 d", async () => {
    const row = memories.create(autoMemory({ status: "active", knowledgeKind: "convention", ttlExpiresAt: isoPlus(T0, { days: 7 }), summary: "Convention row" }));
    const result = await dream(isoPlus(T0, { days: 8 }));
    expect(result.report.staled).toEqual([row.id]);
    expect(memories.getById(row.id)).toMatchObject({ status: "stale", statusReason: "ttl_expired" });
    expect(new ProposalRepository(db).countOpen()).toBe(0);
  });

  test("auto candidates are rejected(expiry) after 45 d; human rows are untouched", async () => {
    const candidate = memories.create(autoMemory({ summary: "Old candidate", createdAt: T0, updatedAt: T0 }));
    const fresh = memories.create(autoMemory({ summary: "Fresh candidate", createdAt: isoPlus(T0, { days: 20 }), updatedAt: isoPlus(T0, { days: 20 }) }));
    const human = memories.create(humanMemory({ status: "candidate", summary: "Human candidate" }));
    const result = await dream(isoPlus(T0, { days: 46 }));
    expect(result.report.rejectedCandidates).toEqual([candidate.id]);
    expect(memories.getById(candidate.id)).toMatchObject({ status: "rejected", statusReason: "expiry" });
    expect(memories.getById(fresh.id)?.status).toBe("candidate");
    expect(memories.getById(human.id)?.status).toBe("candidate");
    expect(new TransitionRepository(db).listForMemory(candidate.id)[0]).toMatchObject({ actor: "expiry", toStatus: "rejected" });
  });
});

describe("fire roll-up effects", () => {
  test("a recent fire extends the TTL before the TTL check and the extension persists", async () => {
    const row = memories.create(autoMemory({ status: "active", knowledgeKind: "convention", ttlExpiresAt: isoPlus(T0, { days: 5 }), summary: "Fired row" }));
    memories.recordFire(row.id, { at: isoPlus(T0, { days: 4, hours: 20 }) });
    const result = await dream(isoPlus(T0, { days: 5, hours: 1 }));
    expect(result.report.ttlExtended).toEqual([row.id]);
    expect(result.report.staled).toEqual([]);
    const after = memories.getById(row.id)!;
    expect(after.status).toBe("active");
    expect(after.ttlExpiresAt).toBe(isoPlus(T0, { days: 18, hours: 20 }));
  });

  test("override downgrade: ≥ 3 overrides with evidence < 3 → advise plus an audit entry; human rows untouched", async () => {
    const auto = memories.create(autoMemory({ status: "active", enforcement: "soft_deny", summary: "Noisy auto row" }));
    memories.recordFire(auto.id, { at: T0, count: 3, overrideDelta: 3 });
    const human = memories.create(humanMemory({ enforcement: "confirm", summary: "Noisy human row" }));
    memories.recordFire(human.id, { at: T0, count: 3, overrideDelta: 3 });
    const result = await dream(isoPlus(T0, { hours: 1 }));
    expect(result.report.downgraded).toEqual([auto.id]);
    expect(memories.getById(auto.id)?.enforcement).toBe("advise");
    expect(memories.getById(human.id)?.enforcement).toBe("confirm");
    const audit = selectAll(db, "SELECT event_type FROM audit_log");
    expect(audit.map((row) => row.event_type)).toEqual(["enforcement_downgrade"]);
  });
});

describe("proposals opened by the consolidator", () => {
  test("near-duplicate auto rows get one merge proposal (older row is the target)", async () => {
    // 10 tokens each, 9 shared → Jaccard 9/11 ≈ 0.82 (distinct semantic keys, above the 0.8 merge threshold).
    const older = memories.create(autoMemory({ status: "active", summary: "Run the suite with pnpm test instead of npm test here", createdAt: T0, updatedAt: T0 }));
    const newer = memories.create(autoMemory({ status: "active", summary: "Run the suite with pnpm test instead of npm test today", details: "other details", createdAt: isoPlus(T0, { hours: 1 }), updatedAt: isoPlus(T0, { hours: 1 }) }));
    memories.create(autoMemory({ status: "active", summary: "Completely different claim about linting with eslint" }));
    const result = await dream(isoPlus(T0, { days: 1 }));
    expect(result.report.mergeProposals).toHaveLength(1);
    const proposal = new ProposalRepository(db).getById(result.report.mergeProposals[0]!)!;
    expect(proposal).toMatchObject({ kind: "merge", targetMemoryId: older.id, candidateMemoryId: newer.id, createdBy: "consolidator" });
    const second = await dream(isoPlus(T0, { days: 2 }));
    expect(second.report.mergeProposals).toEqual([]);
  });

  test("an active row whose signature does not compile gets a fix_signature proposal", async () => {
    const row = memories.create(humanMemory({ type: "pitfall", lifecycleTriggers: ["before_tool", "before_model"], triggerSignature: { tool: "bash", target: "command", pattern_kind: "regex", pattern: "(a+)+$" } }));
    const result = await dream(isoPlus(T0, { hours: 1 }));
    expect(result.report.fixSignatureProposals).toHaveLength(1);
    expect(new ProposalRepository(db).listOpen({ kind: "fix_signature", targetId: row.id })).toHaveLength(1);
  });
});

describe("embedding backfill", () => {
  test("rows without embeddings are embedded through the injected function", async () => {
    const a = memories.create(autoMemory({ status: "active", summary: "Needs an embedding A" }));
    const b = memories.create(humanMemory({ summary: "Needs an embedding B" }));
    const calls: string[][] = [];
    const embed = async (texts: string[]) => {
      calls.push(texts);
      return texts.map((_text, index) => new Float32Array([index + 1, 0, 0]));
    };
    const result = await dream(isoPlus(T0, { hours: 1 }), { embed });
    expect(result.report.embedded).toBe(2);
    expect(result.noop).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0]![0]).toContain("Needs an embedding");
    expect(memories.getById(a.id)?.embedding).not.toBeNull();
    expect(memories.getById(b.id)?.embedding).not.toBeNull();
    const again = await dream(isoPlus(T0, { hours: 2 }), { embed });
    expect(again.report.embedded).toBe(0);
  });
});

describe("idle sweep and GC (file system)", () => {
  function writeState(state: SessionState): string {
    const file = stateFile(paths, state.host, state.session_key);
    writeFileSync(file, JSON.stringify(state));
    return file;
  }

  test("an open turn whose ledger has been idle for an hour is closed as idle and queued", () => {
    const now = isoPlus(T0, { hours: 3 });
    const ledger = ledgerFile(paths, "claude-code", "k1");
    appendLedgerLine(ledger, promptLine("fix the build", { seq: 100, turn_key: "p1" }));
    const start = readFileSync(ledger).byteLength;
    appendLedgerLine(ledger, promptLine("now the tests please", { seq: 200, turn_key: "p2" }));
    appendLedgerLine(ledger, toolFailLine("npm test", "Exit code 1\nfails", { seq: 201, turn_key: "p2", program_token: "pm test", exit_code: 1, failure_class: "exit_1" }));
    appendLedgerLine(ledger, assistantLine("Investigating.", { seq: 202, turn_key: "p2" }));
    const old = new Date(Date.parse(now) - 2 * 60 * 60 * 1000);
    utimesSync(ledger, old, old);
    const file = writeState({ schema: "state.v1", host: "claude-code", session_id: "sess-1", session_key: "k1", turn_key: "p2", turn_start_offset: start, segment: 0, last_episode_id: "ep-prev", correction_for: "ep-prev", updated_at: T0 });

    const result = sweepIdleTurns(paths, now);
    expect(result.errors).toEqual([]);
    expect(result.closed).toHaveLength(1);
    const descriptor = result.closed[0]!;
    expect(descriptor.close_reason).toBe("idle");
    expect(descriptor.correction_for).toBe("ep-prev");
    expect(descriptor.event_count).toBe(3);
    expect(descriptor.flags.failure).toBe(1);
    // correction_for from the state file marks the turn as a correction (2) on top of the bare failure (1).
    expect(descriptor.flags.correction).toBe(1);
    expect(descriptor.evidence_weight).toBe(3);
    expect(descriptor.ledger_ref).toBe(`ledger/claude-code-k1.jsonl#${String(start)}-${String(descriptor.ledger_ref.split("-").pop())}`);
    expect(readdirSync(paths.queueDir)).toEqual([`${descriptor.id}.json`]);

    const state = JSON.parse(readFileSync(file, "utf8")) as SessionState;
    expect(state.turn_key).toBeNull();
    expect(state.segment).toBe(0);
    expect(state.last_episode_id).toBe(descriptor.id);
    // The prompt hook renders a corrected episode's tool lines from this range (SessionState.last_episode_range).
    expect(state.last_episode_range).toEqual({ start, end: Number(descriptor.ledger_ref.split("-").pop()) });
    expect(state.correction_for).toBeUndefined();
    const lines = parseLedger(readFileSync(ledger)).lines;
    const marker = lines[lines.length - 1]!;
    expect(marker.kind).toBe("marker");
    expect(marker.kind === "marker" && marker.marker).toBe("idle_close");
    expect(state.turn_start_offset).toBe(readFileSync(ledger).byteLength);

    expect(sweepIdleTurns(paths, isoPlus(now, { hours: 1 })).closed).toEqual([]);
  });

  test("a recently active ledger is left alone", () => {
    const ledger = ledgerFile(paths, "claude-code", "k2");
    appendLedgerLine(ledger, promptLine("hello", { seq: 1, turn_key: "p1" }));
    writeState({ schema: "state.v1", host: "claude-code", session_id: "s", session_key: "k2", turn_key: "p1", turn_start_offset: 0, segment: 0, updated_at: T0 });
    const result = sweepIdleTurns(paths, new Date().toISOString());
    expect(result.closed).toEqual([]);
    expect(readdirSync(paths.queueDir)).toEqual([]);
  });

  test("GC removes old ledgers (not referenced by an open turn), raw cache, tmp orphans and audit rows", async () => {
    const now = isoPlus(T0, { days: 30 });
    const nowMs = Date.parse(now);
    const oldDate = new Date(nowMs - 20 * 24 * 60 * 60 * 1000);
    const openLedger = ledgerFile(paths, "claude-code", "open");
    const closedLedger = ledgerFile(paths, "claude-code", "closed");
    const freshLedger = ledgerFile(paths, "claude-code", "fresh");
    for (const file of [openLedger, closedLedger, freshLedger]) writeFileSync(file, "{}\n");
    const fresh = new Date(nowMs - 60_000);
    utimesSync(openLedger, oldDate, oldDate);
    utimesSync(closedLedger, oldDate, oldDate);
    utimesSync(freshLedger, fresh, fresh);
    writeFileSync(stateFile(paths, "claude-code", "open"), JSON.stringify({ schema: "state.v1", host: "claude-code", session_id: "s", session_key: "open", turn_key: "p1", turn_start_offset: 0, segment: 0, updated_at: T0 } satisfies SessionState));
    const orphanState = stateFile(paths, "claude-code", "gone");
    writeFileSync(orphanState, JSON.stringify({ schema: "state.v1", host: "claude-code", session_id: "s", session_key: "gone", turn_key: null, turn_start_offset: 0, segment: 0, updated_at: T0 } satisfies SessionState));
    utimesSync(orphanState, oldDate, oldDate);
    const oldRaw = join(paths.rawDir, "run-old.json");
    const freshRaw = join(paths.rawDir, "run-fresh.json");
    writeFileSync(oldRaw, "{}");
    writeFileSync(freshRaw, "{}");
    utimesSync(oldRaw, new Date(nowMs - 2 * 24 * 60 * 60 * 1000), new Date(nowMs - 2 * 24 * 60 * 60 * 1000));
    utimesSync(freshRaw, fresh, fresh);
    const tmp = join(paths.snapshotDir, "active.v1.json.tmp-999");
    writeFileSync(tmp, "x");
    utimesSync(tmp, oldDate, oldDate);

    const gc = garbageCollectFiles(paths, DEFAULT_CONFIG, now);
    expect(gc).toEqual({ ledgers: 1, states: 1, raw: 1, tmp: 1 });
    expect(existsSync(openLedger)).toBe(true);
    expect(existsSync(closedLedger)).toBe(false);
    expect(existsSync(freshLedger)).toBe(true);
    expect(existsSync(orphanState)).toBe(false);
    expect(existsSync(oldRaw)).toBe(false);
    expect(existsSync(freshRaw)).toBe(true);
    expect(existsSync(tmp)).toBe(false);

    db.run("INSERT INTO audit_log (id, event_type, summary, details_json, created_at) VALUES ('a-old', 'activation', 'old', '{}', ?)", [isoPlus(T0, { days: -40 })]);
    db.run("INSERT INTO audit_log (id, event_type, summary, details_json, created_at) VALUES ('a-new', 'activation', 'new', '{}', ?)", [now]);
    const result = await dream(now, { skipFiles: false });
    expect(result.report.gc.audit).toBe(1);
    expect(selectAll(db, "SELECT id FROM audit_log").map((row) => row.id)).toEqual(["a-new"]);
  });
});
