/**
 * 0.6.0-rc.2 reconcile (docs/redesign/full-autonomy-0.6.0-rc.2.md §2–§4): the step 3 neighbour rules — pure
 * helpers, findNeighbourMatch over a seeded repository, the write path — and the rc.2 birth columns of the create
 * path (signature_precision / side_effect / horizon → enforcementDefault's silent-write rule, the task TTL).
 * No provider process, injected clocks.
 */

import { beforeEach, describe, expect, test } from "vitest";
import type { Database as SqlJsDatabase } from "sql.js";

import { DEFAULT_CONFIG, type HarnessConfig } from "../src/core/config";
import type { EpisodeDescriptor } from "../src/core/episode-types";
import type { ExtractionOutput } from "../src/core/extraction-types";
import { extractionRunId, sha256Hex } from "../src/core/ids";
import type { LedgerLine } from "../src/core/ledger-types";
import { LIVE_STATUSES, type MemoryType } from "../src/core/vocabulary";
import { getDbGeneration, hasWriteOp, insertWriteOp, setDbGeneration } from "../src/db/meta";
import { EpisodeRepository } from "../src/db/repositories/episodes";
import { TransitionRepository } from "../src/db/repositories/transitions";
import { buildExtractionPrompt } from "../src/dream/extract/prompt";
import { validateExtraction, type ValidatedFact } from "../src/dream/extract/validate";
import {
  ERROR_CODE_STOPLIST,
  NEIGHBOUR_JACCARD,
  NEIGHBOUR_MIN_SHARED_ALIASES,
  errorCodeTokens,
  findNeighbour,
  findNeighbourMatch,
  jaccard,
  neighbourRules,
  reconcileRun,
  sharedAliasCount,
  signatureKeysTwin,
  summaryTokens,
  type NormalizedFact,
  type ReconcileWriteOp,
} from "../src/dream/reconcile";
import { MemoryRepository } from "../src/memory/repository";
import { SILENT_WRITE_MIN_EVIDENCE, TASK_TTL_DAYS } from "../src/promotion/authority";
import { derivePolicyRules } from "../src/policy/derive";
import { createTestDb } from "./helpers/create-test-db";
import { assistantLine, loadLedgerFixture, promptLine, toolFailLine, toolOkLine } from "./helpers/ledger-fixture";
import { autoMemory, humanMemory, isoPlus } from "./helpers/memory-fixtures";
import { REPLAY_NOW, applyRun, descriptorFromLines, factFixture, outputFixture } from "./helpers/replay-run";

const s01 = loadLedgerFixture("s01-correction-only.jsonl").lines.filter((line) => line.turn_key === "p1");

let db: SqlJsDatabase;
let memories: MemoryRepository;

beforeEach(async () => {
  db = await createTestDb({ now: REPLAY_NOW });
  memories = new MemoryRepository(db, { clock: () => REPLAY_NOW });
});

const NPM_TEST_KEY = "bash|command|cmd|npm test";
const NPM_TEST_SIGNATURE = { tool: "bash" as const, target: "command" as const, pattern_kind: "cmd" as const, pattern: "npm test" };

/** A hand-built NormalizedFact: only what the neighbour rules read (summary, details, aliases, type, scope, key). */
function normalizedFixture(input: { summary: string; details?: string; aliases?: string[]; type?: MemoryType; scopeGlob?: string; signatureKey?: string }): NormalizedFact {
  const type = input.type ?? "pitfall";
  const scopeGlob = input.scopeGlob ?? "**/*";
  const signatureKey = input.signatureKey ?? "";
  const fact: ValidatedFact = {
    ...factFixture({ type, summary: input.summary, details: input.details ?? "", aliases: input.aliases ?? [], scope_glob: scopeGlob, trigger_signature: null, lifecycle_triggers: ["before_model"] }),
    ordinal: 0,
    compiledSignature: null,
    semanticKey: `key:${input.summary}`,
    normalizedScope: scopeGlob,
    relabels: [],
    signature_precision: signatureKey.length > 0 ? "mistake_exact" : null,
    side_effect: "read",
    horizon: "durable",
  };
  return {
    fact,
    type,
    scopeGlob,
    activationClass: "scoped",
    lifecycleTriggers: ["before_model"],
    relevantTools: null,
    signatureKey,
    semanticKey: fact.semanticKey,
    knowledgeKind: "correction",
    failureClasses: [],
    relabels: [],
  };
}

/** A bare failure turn (evidence_weight 1): prompt + `npm test` failing + assistant. */
function bareFailureLines(turnKey: string, seqBase: number): LedgerLine[] {
  return [
    promptLine("run the tests", { seq: seqBase, turn_key: turnKey }),
    toolFailLine("npm test", "Exit code 1\nnpm ERR! Missing script: \"test\"", { seq: seqBase + 1, turn_key: turnKey, program_token: "pm test", exit_code: 1, failure_class: "exit_1" }),
    assistantLine("npm test failed; the scripts are defined for pnpm.", { seq: seqBase + 2, turn_key: turnKey }),
  ];
}

/** A push to the protected branch that fails, then the branch push that resolves it (evidence_weight 2, flags.resolution). */
function protectedPushLines(turnKey: string, seqBase: number): LedgerLine[] {
  return [
    promptLine("push the fix", { seq: seqBase, turn_key: turnKey }),
    toolFailLine("git push origin main", "remote: error: GH006: Protected branch update failed for refs/heads/main", {
      seq: seqBase + 1,
      turn_key: turnKey,
      program_token: "git",
      exit_code: 1,
      failure_class: "exit_1",
    }),
    toolOkLine("git push origin fix/login", { seq: seqBase + 2, turn_key: turnKey, program_token: "git", output_head: "ok", resolution_of: "bash|exit_1|git" }),
    assistantLine("Pushed the branch; main is protected, so the change goes through a pull request.", { seq: seqBase + 3, turn_key: turnKey }),
  ];
}

interface ApplyObjectOptions {
  descriptor: EpisodeDescriptor;
  lines: readonly LedgerLine[];
  output: ExtractionOutput;
  now?: string;
  config?: HarnessConfig;
}

/**
 * `applyRun`'s twin for recorded outputs that carry the rc.2 fields: the OBJECT is validated (validateExtraction), not
 * re-parsed through src/dream/extract/schema.ts, whose hand-written V1 still drops `trigger_signature.side_effect` and
 * `horizon` (area B's report) — the raw path would store read / durable whatever the output said.
 */
function applyObjectRun(options: ApplyObjectOptions): ReconcileWriteOp {
  const now = options.now ?? REPLAY_NOW;
  const config = options.config ?? DEFAULT_CONFIG;
  new EpisodeRepository(db).insertIfAbsent(options.descriptor, now);
  const built = buildExtractionPrompt({ descriptor: options.descriptor, lines: options.lines, contextLines: null, existingMemories: [] });
  const repository = new MemoryRepository(db, { clock: () => now });
  const validated = validateExtraction({
    output: options.output,
    descriptor: options.descriptor,
    seqMap: built.seqMap,
    existingMemoryIds: new Set(repository.list({ status: LIVE_STATUSES }).map((memory) => memory.id)),
    nowIso: now,
  });
  expect(validated.suspect).toBe(false);
  db.run("BEGIN");
  try {
    const op = reconcileRun(db, {
      descriptor: options.descriptor,
      runId: extractionRunId(options.descriptor.id),
      validated: { ...validated, output: options.output },
      ctx: {
        now,
        config,
        run: { provider: "replay", model: "replay", promptSha256: sha256Hex(built.prompt), inputChars: built.prompt.length, startedAt: now, rawOutputRef: null },
        seqMap: built.seqMap,
        correctionForEpisode: null,
        paths: null,
        alreadyApplied: (id) => hasWriteOp(db, id),
      },
    });
    if (!op.noop) {
      derivePolicyRules(db, { now });
      const generation = getDbGeneration(db) + 1;
      setDbGeneration(db, generation);
      if (op.id !== null) insertWriteOp(db, op.id, op.kind, generation, now);
    }
    db.run("COMMIT");
    return op;
  } catch (error) {
    db.run("ROLLBACK");
    throw error;
  }
}

describe("errorCodeTokens (design §4)", () => {
  test("recognizes the error-code shapes and compares them verbatim", () => {
    expect([...errorCodeTokens("The connector answers G006 when the tenant header is missing; C001 on a bad token.")]).toEqual(["G006", "C001"]);
    expect([...errorCodeTokens("MySQL: ERROR 1054 (42S22): Unknown column")]).toEqual(["ERROR 1054"]);
    expect([...errorCodeTokens("Driver fails with JDBC-11021 after the pool is exhausted; Oracle says ORA-00942.")]).toEqual(["JDBC-11021", "ORA-00942"]);
    expect([...errorCodeTokens("rustc: error[E0308]: mismatched types; Postgres P0001 raised by the trigger")]).toEqual(["E0308", "P0001"]);
  });

  test("years, lower-case tokens and the technical-name stoplist are not error codes", () => {
    expect(errorCodeTokens("Planned for FY2026 and tracked as CVE-2026-1234; ERROR 2026 is a date, 2026 alone too.").size).toBe(0);
    expect(errorCodeTokens("line e1234 and ref p003 are cited in lower case").size).toBe(0);
    expect(errorCodeTokens("Hash the payload with SHA256 and sign with RSA2048; timestamps are ISO8601; X509 certificates.").size).toBe(0);
    for (const name of ERROR_CODE_STOPLIST) expect(errorCodeTokens(`uses ${name} here`).size).toBe(0);
    expect(errorCodeTokens("").size).toBe(0);
  });
});

describe("signatureKeysTwin (design §2 / §4)", () => {
  test("equal keys, substring keys of one tool; nothing across tools, empty keys or sibling patterns", () => {
    expect(signatureKeysTwin(NPM_TEST_KEY, NPM_TEST_KEY)).toBe("signature_key");
    expect(signatureKeysTwin(NPM_TEST_KEY, "bash|command|cmd|npm test --coverage")).toBe("signature_substring");
    expect(signatureKeysTwin("bash|command|cmd|npm test --coverage", NPM_TEST_KEY)).toBe("signature_substring");
    // `sh|command|cmd|npm test` is a substring of the bash key but names another tool.
    expect(signatureKeysTwin("sh|command|cmd|npm test", NPM_TEST_KEY)).toBeNull();
    // Whole keys are compared: `npm test` is not a twin of `pnpm test` although the pattern text is a substring.
    expect(signatureKeysTwin(NPM_TEST_KEY, "bash|command|cmd|pnpm test")).toBeNull();
    expect(signatureKeysTwin("", NPM_TEST_KEY)).toBeNull();
    expect(signatureKeysTwin(NPM_TEST_KEY, "")).toBeNull();
    expect(signatureKeysTwin("", "")).toBeNull();
    expect(signatureKeysTwin(NPM_TEST_KEY, "edit|path|glob|**/.env")).toBeNull();
  });
});

describe("sharedAliasCount (design §4)", () => {
  test("trims and case-folds; blanks never count", () => {
    expect(NEIGHBOUR_MIN_SHARED_ALIASES).toBe(2);
    expect(sharedAliasCount(["PNPM Test ", "테스트 실행", "lint"], ["pnpm test", " 테스트 실행", "build"])).toBe(2);
    expect(sharedAliasCount(["pnpm test"], ["pnpm test", "pnpm test"])).toBe(1);
    expect(sharedAliasCount(["  ", ""], ["", "  "])).toBe(0);
    expect(sharedAliasCount([], ["x"])).toBe(0);
  });
});

describe("findNeighbourMatch over a seeded repository (§5.7 step 3, design §4)", () => {
  const SUMMARY = "Run the test suite with pnpm test instead of npm test in this repository.";

  test("Jaccard ≥ 0.6 on the summary is still a rule on its own", () => {
    const seed = memories.create(autoMemory({ summary: SUMMARY, aliases: [] }));
    const match = findNeighbourMatch(memories, normalizedFixture({ summary: "Run the test suite with pnpm test instead of npm test in this repository" }));
    expect(match?.memory.id).toBe(seed.id);
    expect(match?.rules).toEqual(["jaccard"]);
    expect(match?.score).toBe(1);
    expect(findNeighbour(memories, normalizedFixture({ summary: "Entirely different wording about deploy credentials." }))).toBeNull();
  });

  test("an equal signature key makes a twin of a reworded claim", () => {
    const seed = memories.create(autoMemory({ summary: SUMMARY, aliases: [], triggerSignature: NPM_TEST_SIGNATURE, signatureKey: NPM_TEST_KEY }));
    const normalized = normalizedFixture({ summary: "Prefer pnpm here; npm has no scripts.", signatureKey: NPM_TEST_KEY });
    expect(jaccard(summaryTokens(normalized.fact.summary), summaryTokens(SUMMARY))).toBeLessThan(NEIGHBOUR_JACCARD);
    const match = findNeighbourMatch(memories, normalized);
    expect(match?.memory.id).toBe(seed.id);
    expect(match?.rules).toEqual(["signature_key"]);
    expect(neighbourRules(normalized, seed)).toEqual(["signature_key"]);
  });

  test("a substring key of the same tool is a twin; another tool's or a sibling pattern is not", () => {
    const seed = memories.create(autoMemory({ summary: SUMMARY, aliases: [], triggerSignature: NPM_TEST_SIGNATURE, signatureKey: NPM_TEST_KEY }));
    expect(findNeighbourMatch(memories, normalizedFixture({ summary: "Coverage runs are pnpm-only in this repository.", signatureKey: "bash|command|cmd|npm test --coverage" }))).toMatchObject({ memory: { id: seed.id }, rules: ["signature_substring"] });
    expect(findNeighbour(memories, normalizedFixture({ summary: "Coverage runs are pnpm-only in this repository.", signatureKey: "sh|command|cmd|npm test" }))).toBeNull();
    expect(findNeighbour(memories, normalizedFixture({ summary: "Coverage runs are pnpm-only in this repository.", signatureKey: "bash|command|cmd|pnpm test" }))).toBeNull();
  });

  test("two shared aliases (case-folded, trimmed) make a twin; one does not", () => {
    const seed = memories.create(autoMemory({ summary: SUMMARY, aliases: ["PNPM Test", " 테스트 실행 "] }));
    const twin = normalizedFixture({ summary: "The package scripts of this repository are registered for pnpm only.", aliases: ["pnpm test", "테스트 실행"] });
    expect(findNeighbourMatch(memories, twin)).toMatchObject({ memory: { id: seed.id }, rules: ["aliases"] });
    expect(findNeighbour(memories, normalizedFixture({ summary: "The package scripts of this repository are registered for pnpm only.", aliases: ["pnpm test", "lint"] }))).toBeNull();
  });

  test("a shared error-code token over summary + details makes a twin; a shared year or SHA256 does not", () => {
    const seed = memories.create(autoMemory({ summary: "The connector rejects a call when the tenant header is missing.", details: "The API answers G006; seen on the orders endpoint in FY2026.", aliases: [] }));
    const twin = normalizedFixture({ summary: "Send the tenant header on every connector call; the API answers G006 without it." });
    expect(findNeighbourMatch(memories, twin)).toMatchObject({ memory: { id: seed.id }, rules: ["error_code"] });
    expect(findNeighbour(memories, normalizedFixture({ summary: "Budget planning for FY2026 happens in the finance sheet." }))).toBeNull();
    expect(findNeighbour(memories, normalizedFixture({ summary: "Hash uploads with SHA256 before the connector call." }))).toBeNull();
  });

  test("§5.7: a signature-bearing fact is never absorbed by a signature-less row, whatever matched", () => {
    const seed = memories.create(autoMemory({ summary: SUMMARY, aliases: ["pnpm test", "테스트 실행"], details: "G006 appears in the log." }));
    const normalized = normalizedFixture({ summary: SUMMARY, aliases: ["pnpm test", "테스트 실행"], details: "G006 appears in the log.", signatureKey: NPM_TEST_KEY });
    expect(findNeighbour(memories, normalized)).toBeNull();
    expect(neighbourRules(normalized, seed)).toEqual([]);
    // The other way round is fine: a signature-less restatement joins the signature-bearing row.
    const signed = memories.create(autoMemory({ summary: "Use pnpm for the suite; npm test lacks the script in this repository.", aliases: [], triggerSignature: NPM_TEST_SIGNATURE, signatureKey: NPM_TEST_KEY }));
    expect(findNeighbour(memories, normalizedFixture({ summary: "Use pnpm for the suite; npm test lacks the script in this repository." }))?.id).toBe(signed.id);
  });

  test("among several matches the highest summary Jaccard wins, whatever rule matched", () => {
    const byKey = memories.create(autoMemory({ summary: "Deploys go through the release workflow only.", aliases: [], triggerSignature: NPM_TEST_SIGNATURE, signatureKey: NPM_TEST_KEY }));
    const byWording = memories.create(autoMemory({ summary: SUMMARY, aliases: [], triggerSignature: { ...NPM_TEST_SIGNATURE, pattern: "yarn test" }, signatureKey: "bash|command|cmd|yarn test" }));
    const match = findNeighbourMatch(memories, normalizedFixture({ summary: SUMMARY, signatureKey: NPM_TEST_KEY }));
    expect(match?.memory.id).toBe(byWording.id);
    expect(match?.rules).toEqual(["jaccard"]);
    expect(match?.score).toBe(1);
    expect(neighbourRules(normalizedFixture({ summary: SUMMARY, signatureKey: NPM_TEST_KEY }), byKey)).toEqual(["signature_key"]);
  });

  test("another type, a disjoint scope or a terminal row is never a neighbour", () => {
    const workflow = memories.create(autoMemory({ type: "workflow", summary: SUMMARY, aliases: [] }));
    const elsewhere = memories.create(autoMemory({ summary: SUMMARY, aliases: [], scopeGlob: "docs/**", activationClass: "scoped", lifecycleTriggers: ["before_model"] }));
    const rejected = memories.create(autoMemory({ summary: SUMMARY, aliases: [], status: "rejected" }));
    const normalized = normalizedFixture({ summary: SUMMARY, scopeGlob: "src/**" });
    expect(findNeighbour(memories, normalized)).toBeNull();
    expect(neighbourRules(normalized, workflow)).toEqual([]);
    expect(neighbourRules(normalized, elsewhere)).toEqual([]);
    expect(neighbourRules(normalized, rejected)).toEqual([]);
    // Human rows are neighbours like any live row of the type (the reinforce then only touches their counters).
    const human = memories.create(humanMemory({ type: "pitfall", summary: SUMMARY, scopeGlob: "**/*" }));
    expect(findNeighbour(memories, normalizedFixture({ summary: SUMMARY }))?.id).toBe(human.id);
  });
});

describe("the write path: a neighbour twin is reinforced, and the outcome names the rule", () => {
  test("a reworded claim with the same signature key reinforces the row it would have duplicated", () => {
    const seed = applyRun(db, { descriptor: descriptorFromLines(s01), lines: s01, output: outputFixture([factFixture({ evidence_refs: ["e1"] })]) });
    const id = seed.op.report.created[0]!;
    expect(memories.getById(id)).toMatchObject({ status: "active", signatureKey: NPM_TEST_KEY });

    const lines = bareFailureLines("p20", 2000);
    const again = applyRun(db, {
      descriptor: descriptorFromLines(lines, { sessionId: "session-b", turnKey: "p20" }),
      lines,
      output: outputFixture([factFixture({ summary: "Prefer pnpm test over npm test here; npm has no test script in this repository.", evidence_refs: ["e1"], aliases: [], knowledge_kind: "failure_resolution" })]),
      now: isoPlus(REPLAY_NOW, { hours: 1 }),
    });
    expect(again.op.report.created).toEqual([]);
    expect(again.op.report.reinforced).toEqual([id]);
    expect(again.op.report.outcomes[0]).toMatchObject({ outcome: "reinforced", memory_id: id });
    expect(again.op.report.outcomes[0]?.detail).toContain(`target=${id}; neighbour=signature_key`);
    expect(memories.getById(id)).toMatchObject({ evidenceCount: 2, distinctSessionCount: 2 });
    expect(memories.list({ status: LIVE_STATUSES })).toHaveLength(1);
  });

  test("a shared error code folds a signature-less restatement into the existing row", () => {
    // Signature-less pitfalls need a repository scope that the episode touched (V3), so both rows live under src/**.
    const seed = memories.create(
      autoMemory({
        status: "active",
        scopeGlob: "src/**",
        activationClass: "scoped",
        lifecycleTriggers: ["before_model"],
        knowledgeKind: "failure_resolution",
        summary: "The connector rejects a call with G006 when the tenant header is missing.",
        details: "Seen on the orders endpoint.",
        aliases: [],
      })
    );
    const lines: LedgerLine[] = [
      promptLine("call the orders endpoint", { seq: 2100, turn_key: "p21" }),
      toolOkLine("src/connector.ts", { seq: 2101, turn_key: "p21", tool: "read", host_tool: "Read", shell_dialect: null, scope_refs: ["src/connector.ts"] }),
      toolFailLine("curl -s https://api.example.test/orders", "HTTP 400: G006 tenant header missing", { seq: 2102, turn_key: "p21", program_token: "curl", exit_code: 22, failure_class: "exit_22" }),
      assistantLine("The connector answered G006: the tenant header is required.", { seq: 2103, turn_key: "p21" }),
    ];
    const result = applyRun(db, {
      descriptor: descriptorFromLines(lines, { sessionId: "session-c", turnKey: "p21" }),
      lines,
      output: outputFixture([
        factFixture({
          summary: "Send the tenant header on every connector call; the API answers G006 without it.",
          details: "",
          scope_glob: "src/**",
          trigger_signature: null,
          lifecycle_triggers: ["before_model"],
          knowledge_kind: "failure_resolution",
          evidence_refs: ["e3"],
          aliases: [],
        }),
      ]),
    });
    expect(result.op.report.outcomes[0]).toMatchObject({ outcome: "reinforced", memory_id: seed.id });
    expect(result.op.report.created).toEqual([]);
    expect(result.op.report.reinforced).toEqual([seed.id]);
    expect(result.op.report.outcomes[0]?.detail).toContain("neighbour=error_code");
  });

  test("a create that is its own claim (no rule matches) stays a new row", () => {
    memories.create(autoMemory({ status: "active", summary: "Deploy only through the release workflow; manual pushes to production are forbidden.", aliases: [] }));
    const result = applyRun(db, { descriptor: descriptorFromLines(s01), lines: s01, output: outputFixture([factFixture({ evidence_refs: ["e1"] })]) });
    expect(result.op.report.created).toHaveLength(1);
    expect(result.op.report.reinforced).toEqual([]);
    expect(result.op.report.outcomes[0]?.detail ?? "").not.toContain("neighbour=");
  });
});

describe("rc.2 birth columns (design §2–§3): precision, side effect and horizon on the created row", () => {
  test("side_effect and horizon reach the row; a task row is advise with the 7-day TTL under full", () => {
    const descriptor = descriptorFromLines(s01);
    const op = applyObjectRun({
      descriptor,
      lines: s01,
      output: outputFixture([factFixture({ trigger_signature: { ...NPM_TEST_SIGNATURE, side_effect: "write" }, horizon: "task", evidence_refs: ["e1"] })]),
    });
    const id = op.report.created[0]!;
    expect(op.report.activated).toEqual([id]);
    const row = memories.getById(id)!;
    // The three live in their own columns (migration 023); trigger_signature_json keeps the matcher fields only.
    expect(row).toMatchObject({ status: "active", enforcement: "advise", signaturePrecision: "mistake_exact", sideEffect: "write", horizon: "task" });
    expect(TASK_TTL_DAYS).toBe(7);
    expect(row.ttlExpiresAt).toBe(isoPlus(REPLAY_NOW, { days: 7 }));
    expect(row.revalidateAfter).toBe(isoPlus(REPLAY_NOW, { days: 3, hours: 12 }));
  });

  test("a signature-less fact stores NULL precision / side effect and the horizon", () => {
    const lines = bareFailureLines("p30", 3000);
    const op = applyObjectRun({
      descriptor: descriptorFromLines(lines, { sessionId: "session-n", turnKey: "p30" }),
      lines,
      output: outputFixture([
        factFixture({ type: "architecture_constraint", summary: "The package scripts of this repository are registered for pnpm only.", trigger_signature: null, lifecycle_triggers: ["before_model"], knowledge_kind: "convention", evidence_refs: ["e1"], horizon: "task", aliases: [] }),
      ]),
    });
    expect(op.report.created).toHaveLength(1);
    const row = memories.getById(op.report.created[0]!)!;
    expect(row).toMatchObject({ type: "architecture_constraint", status: "active", enforcement: "advise", signaturePrecision: null, sideEffect: null, horizon: "task" });
    // A task-horizon knowledge row: the 7-day TTL beats the 30-day knowledge TTL.
    expect(row.ttlExpiresAt).toBe(isoPlus(REPLAY_NOW, { days: 7 }));
  });

  test("silent-write birth (§3 rule 1): mistake_exact + write + durable + failure_resolution + evidence ≥ 2 → before_tool.auto_enforcement_silent_write", () => {
    expect(SILENT_WRITE_MIN_EVIDENCE).toBe(2);
    const lines = protectedPushLines("p31", 3100);
    const descriptor = descriptorFromLines(lines, { sessionId: "session-w", turnKey: "p31" });
    expect(descriptor.flags.resolution).toBe(1);
    expect(descriptor.evidence_weight).toBe(2);
    // Each variant is its own claim — its own pattern (no equal / substring key), its own wording, no shared alias or
    // error code — or the rc.2 neighbour rule would fold it into the first row instead of creating it.
    const pushFact = (summary: string, extra: { pattern?: string; details?: string; side_effect?: "read" | "write"; horizon?: "durable" | "task" } = {}) =>
      factFixture({
        summary,
        details: extra.details ?? "main is a protected branch; GH006 is the rejection.",
        trigger_signature: { tool: "bash", target: "command", pattern_kind: "cmd", pattern: extra.pattern ?? "git push origin main", side_effect: extra.side_effect ?? "write" },
        knowledge_kind: "failure_resolution",
        evidence_refs: ["e2", "e3"],
        aliases: [],
        ...(extra.horizon === undefined ? {} : { horizon: extra.horizon }),
      });

    const op = applyObjectRun({ descriptor, lines, output: outputFixture([pushFact("Never push straight to main in this repository; push the branch and open a pull request.")]) });
    const id = op.report.created[0]!;
    expect(op.report.activated).toEqual([id]);
    expect(op.report.escalated).toEqual([]);
    const row = memories.getById(id)!;
    expect(row).toMatchObject({ type: "pitfall", status: "active", authority: "auto", enforcement: "soft_deny", signaturePrecision: "mistake_exact", sideEffect: "write", horizon: "durable", evidenceScore: 2 });
    expect(row.ttlExpiresAt).toBe(isoPlus(REPLAY_NOW, { days: 30 }));
    expect(new TransitionRepository(db).listForMemory(id)).toEqual([expect.objectContaining({ fromStatus: "candidate", toStatus: "active", actor: "auto_rule" })]);

    // The same mistake read as a `task` horizon, as a read side effect, or with the rule switched off is born at advise.
    const cases = [
      {
        turnKey: "p32",
        seqBase: 3200,
        session: "session-w2",
        fact: pushFact("Pushing to master is refused for this task; push the fix branch and open a pull request.", { pattern: "git push origin master", details: "Task state: the release branch is frozen this week.", horizon: "task" }),
        config: DEFAULT_CONFIG,
        ttlDays: 7,
      },
      {
        turnKey: "p33",
        seqBase: 3300,
        session: "session-w3",
        fact: pushFact("Do not push to upstream main from this checkout; the fork's branch push is what works here.", { pattern: "git push upstream main", details: "The upstream remote is read-only for contributors.", side_effect: "read" }),
        config: DEFAULT_CONFIG,
        ttlDays: 30,
      },
      {
        turnKey: "p34",
        seqBase: 3400,
        session: "session-w4",
        fact: pushFact("Force pushes to main are refused in this repository; open a pull request from the fix branch.", { pattern: "git push --force origin main", details: "Branch protection rejects non-fast-forward updates." }),
        config: { ...DEFAULT_CONFIG, before_tool: { ...DEFAULT_CONFIG.before_tool, auto_enforcement_silent_write: "advise" as const } },
        ttlDays: 30,
      },
    ];
    for (const entry of cases) {
      const caseLines = protectedPushLines(entry.turnKey, entry.seqBase);
      const result = applyObjectRun({ descriptor: descriptorFromLines(caseLines, { sessionId: entry.session, turnKey: entry.turnKey }), lines: caseLines, output: outputFixture([entry.fact]), config: entry.config, now: isoPlus(REPLAY_NOW, { hours: 1 }) });
      expect(result.report.created, entry.turnKey).toHaveLength(1);
      expect(memories.getById(result.report.created[0]!), entry.turnKey).toMatchObject({ status: "active", enforcement: "advise" });
      expect(memories.getById(result.report.created[0]!)?.ttlExpiresAt, entry.turnKey).toBe(isoPlus(isoPlus(REPLAY_NOW, { hours: 1 }), { days: entry.ttlDays }));
    }
  });

  test("a reinforce leaves the stored precision / side effect / horizon untouched", () => {
    const seed = applyObjectRun({ descriptor: descriptorFromLines(s01), lines: s01, output: outputFixture([factFixture({ evidence_refs: ["e1"] })]) });
    const id = seed.report.created[0]!;
    expect(memories.getById(id)).toMatchObject({ signaturePrecision: "mistake_exact", sideEffect: "read", horizon: "durable" });

    const lines = bareFailureLines("p40", 4000);
    const again = applyObjectRun({
      descriptor: descriptorFromLines(lines, { sessionId: "session-r", turnKey: "p40" }),
      lines,
      output: outputFixture([factFixture({ action: "reinforce", target_memory_id: id, trigger_signature: { ...NPM_TEST_SIGNATURE, side_effect: "write" }, horizon: "task", knowledge_kind: "failure_resolution", evidence_refs: ["e1"] })]),
      now: isoPlus(REPLAY_NOW, { hours: 1 }),
    });
    expect(again.report.reinforced).toEqual([id]);
    const row = memories.getById(id)!;
    expect(row).toMatchObject({ signaturePrecision: "mistake_exact", sideEffect: "read", horizon: "durable", evidenceCount: 2 });
    // The ladder climbed it (two session blocks, mistake_exact): the stored columns were what it read.
    expect(again.report.escalated).toEqual([id]);
    expect(row.enforcement).toBe("soft_deny");
  });
});
