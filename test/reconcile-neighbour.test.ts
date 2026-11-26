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
import { buildExtractionPrompt, eventIdMap } from "../src/dream/extract/prompt";
import { validateExtraction, type ValidatedFact } from "../src/dream/extract/validate";
import {
  ERROR_CODE_STOPLIST,
  NEIGHBOUR_CORROBORATION_JACCARD,
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
 * `applyRun`'s twin for recorded outputs given as OBJECTS: validateExtraction over the object, no JSON round trip
 * through src/dream/extract/schema.ts. The raw parser carries `trigger_signature.side_effect` and `horizon` too — the
 * silent-write birth case below runs through `applyRun` to exercise that path — so this helper only keeps the other
 * birth-column cases independent of the parser.
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
    // As the worker does: every line of the episode for the precision rule, no corrected turn here.
    precisionLines: eventIdMap(options.lines),
    contextLines: null,
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
  test("equal keys, and cmd patterns the same matcher fires on; nothing across tools, targets, kinds, negation, empty or unparsable keys", () => {
    expect(signatureKeysTwin(NPM_TEST_KEY, NPM_TEST_KEY)).toBe("signature_key");
    // `npm test` ⊂ `npm test --coverage`: a stored `npm test` already fires on the coverage run (the matcher is
    // order-insensitive after the program token), so the two keys name one mistake.
    expect(signatureKeysTwin(NPM_TEST_KEY, "bash|command|cmd|npm test --coverage")).toBe("signature_substring");
    expect(signatureKeysTwin("bash|command|cmd|npm test --coverage", NPM_TEST_KEY)).toBe("signature_substring");
    expect(signatureKeysTwin("bash|command|cmd|npm test --coverage", "bash|command|cmd|npm --coverage test")).toBe("signature_substring");
    // Sibling scripts are two mistakes although the raw key text of one contains the other's.
    expect(signatureKeysTwin(NPM_TEST_KEY, "bash|command|cmd|npm test:e2e")).toBeNull();
    expect(signatureKeysTwin(NPM_TEST_KEY, "bash|command|cmd|npm test:latency")).toBeNull();
    expect(signatureKeysTwin(NPM_TEST_KEY, "bash|command|cmd|npm build")).toBeNull();
    // A negated key is never the twin of a plain one.
    expect(signatureKeysTwin(NPM_TEST_KEY, `${NPM_TEST_KEY}|!`)).toBeNull();
    expect(signatureKeysTwin(`${NPM_TEST_KEY}|!`, `${NPM_TEST_KEY}|!`)).toBe("signature_key");
    // `sh|command|cmd|npm test` is a substring of the bash key but names another tool; `pnpm test` another manager;
    // the family word `pm test` pins no manager while `npm test` does (the matchers differ: null vs a pinned program).
    expect(signatureKeysTwin("sh|command|cmd|npm test", NPM_TEST_KEY)).toBeNull();
    expect(signatureKeysTwin(NPM_TEST_KEY, "bash|command|cmd|pnpm test")).toBeNull();
    expect(signatureKeysTwin(NPM_TEST_KEY, "bash|command|cmd|pm test")).toBeNull();
    expect(signatureKeysTwin(NPM_TEST_KEY, "bash|any|cmd|npm test")).toBeNull();
    // A pinned two-token program is one program, not program + argument: `pnpm dlx vitest run` fires on no `pnpm
    // vitest run` call and the other way round (compileSignatureKey: program `pnpm dlx` / `pnpm`, tokens `bin …` /
    // `pm …`), likewise `npm exec` / `npm`, `yarn dlx` / `yarn`, and `npx` is not `pnpm dlx`.
    expect(signatureKeysTwin("bash|command|cmd|pnpm dlx vitest run", "bash|command|cmd|pnpm vitest run")).toBeNull();
    expect(signatureKeysTwin("bash|command|cmd|pnpm vitest run", "bash|command|cmd|pnpm dlx vitest run")).toBeNull();
    expect(signatureKeysTwin("bash|command|cmd|npm exec vitest", "bash|command|cmd|npm vitest")).toBeNull();
    expect(signatureKeysTwin("bash|command|cmd|yarn dlx vitest", "bash|command|cmd|yarn vitest")).toBeNull();
    expect(signatureKeysTwin("bash|command|cmd|npx vitest run", "bash|command|cmd|pnpm dlx vitest run")).toBeNull();
    // The same pinned two-token program with a flag added is still one mistake (the stored matcher fires on it).
    expect(signatureKeysTwin("bash|command|cmd|pnpm dlx vitest run", "bash|command|cmd|pnpm dlx vitest run --coverage")).toBe("signature_substring");
    // Unfolded programs pin nothing on either side: `git push` fires on `git push --force` too.
    expect(signatureKeysTwin("bash|command|cmd|git push", "bash|command|cmd|git push --force")).toBe("signature_substring");
    expect(signatureKeysTwin("bash|command|cmd|git push origin main", "bash|command|cmd|git push origin master")).toBeNull();
    expect(signatureKeysTwin("", NPM_TEST_KEY)).toBeNull();
    expect(signatureKeysTwin(NPM_TEST_KEY, "")).toBeNull();
    expect(signatureKeysTwin("", "")).toBeNull();
    expect(signatureKeysTwin(NPM_TEST_KEY, "edit|path|glob|**/.env")).toBeNull();
    expect(signatureKeysTwin("npm test", NPM_TEST_KEY)).toBeNull();
  });

  test("substring keys are twins when one contains the other; glob and regex keys only when equal", () => {
    expect(signatureKeysTwin("bash|command|substring|select emial", "bash|command|substring|select emial from users")).toBe("signature_substring");
    expect(signatureKeysTwin("bash|command|substring|set nmae", "bash|command|substring|select emial")).toBeNull();
    expect(signatureKeysTwin("edit|path|glob|**/.env", "edit|path|glob|**/.env")).toBe("signature_key");
    expect(signatureKeysTwin("edit|path|glob|**/.env", "edit|path|glob|**/.env.example")).toBeNull();
    expect(signatureKeysTwin("bash|command|regex|^git push", "bash|command|regex|^git push")).toBe("signature_key");
    expect(signatureKeysTwin("bash|command|regex|^git push", "bash|command|regex|^git push --force")).toBeNull();
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
    // A sibling script (`npm test:e2e`) is another mistake: the raw key contains `…|npm test` but the tokens differ.
    expect(findNeighbour(memories, normalizedFixture({ summary: "End-to-end runs are pnpm-only in this repository.", signatureKey: "bash|command|cmd|npm test:e2e" }))).toBeNull();
  });

  test("two shared aliases (case-folded, trimmed) make a twin; one does not", () => {
    const seed = memories.create(autoMemory({ summary: SUMMARY, aliases: ["PNPM Test", " 테스트 실행 "] }));
    const twin = normalizedFixture({ summary: "The package scripts of this repository are registered for pnpm only.", aliases: ["pnpm test", "테스트 실행"] });
    expect(findNeighbourMatch(memories, twin)).toMatchObject({ memory: { id: seed.id }, rules: ["aliases"] });
    expect(findNeighbour(memories, normalizedFixture({ summary: "The package scripts of this repository are registered for pnpm only.", aliases: ["pnpm test", "lint"] }))).toBeNull();
  });

  test("a shared error-code token over summary + details makes a twin when the wording corroborates it; a shared year or SHA256 does not", () => {
    const seed = memories.create(autoMemory({ summary: "The connector rejects a call when the tenant header is missing.", details: "The API answers G006; seen on the orders endpoint in FY2026.", aliases: [] }));
    const twin = normalizedFixture({ summary: "Send the tenant header on every connector call; the API answers G006 without it." });
    // Jaccard 0.294: under the twin threshold, over the corroboration one.
    const score = jaccard(summaryTokens(twin.fact.summary), summaryTokens(seed.summary));
    expect(score).toBeGreaterThanOrEqual(NEIGHBOUR_CORROBORATION_JACCARD);
    expect(score).toBeLessThan(NEIGHBOUR_JACCARD);
    expect(findNeighbourMatch(memories, twin)).toMatchObject({ memory: { id: seed.id }, rules: ["error_code"], score });
    expect(findNeighbour(memories, normalizedFixture({ summary: "Budget planning for FY2026 happens in the finance sheet." }))).toBeNull();
    expect(findNeighbour(memories, normalizedFixture({ summary: "Hash uploads with SHA256 before the connector call." }))).toBeNull();
  });

  test("an error-code shape shared by two unrelated rows (a Jira key, a JWT algorithm) is no match on its own; one shared alias corroborates it", () => {
    expect(NEIGHBOUR_CORROBORATION_JACCARD).toBe(0.2);
    const decision = (summary: string, details: string, aliases: string[] = []) => autoMemory({ type: "decision", status: "active", summary, details, aliases, lifecycleTriggers: ["session_start", "before_model"] });
    const jira = memories.create(decision("The API contract is versioned in the openapi folder, not in code comments.", "Tracked as PROJ-1234 in the backlog.", ["backlog"]));
    const probe = normalizedFixture({ type: "decision", summary: "Database migrations run in CI before the application image is built.", details: "Agreed under PROJ-1234 during the platform review." });
    expect([...errorCodeTokens(probe.fact.details)]).toEqual(["PROJ-1234"]);
    const score = jaccard(summaryTokens(probe.fact.summary), summaryTokens(jira.summary));
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(NEIGHBOUR_CORROBORATION_JACCARD);
    expect(findNeighbour(memories, probe)).toBeNull();
    expect(neighbourRules(probe, jira)).toEqual([]);
    // One shared alias (under NEIGHBOUR_MIN_SHARED_ALIASES, so no "aliases" rule) is enough corroboration for the code.
    const corroborated = normalizedFixture({ type: "decision", summary: probe.fact.summary, details: probe.fact.details, aliases: ["Backlog"] });
    expect(findNeighbourMatch(memories, corroborated)).toMatchObject({ memory: { id: jira.id }, rules: ["error_code"] });

    const jwt = memories.create(decision("Access tokens are signed with RS256; the public key is served at the JWKS endpoint.", "Chosen over HS256 so services never share a secret."));
    const unrelated = normalizedFixture({ type: "decision", summary: "Release notes are generated from the merged pull request titles.", details: "The signing step uses RS256 for the provenance attestation." });
    expect(errorCodeTokens(`${jwt.summary}\n${jwt.details}`).has("RS256")).toBe(true);
    expect(findNeighbour(memories, unrelated)).toBeNull();
    expect(neighbourRules(unrelated, jwt)).toEqual([]);
  });

  test("two distinct signatures of one kind are never folded by shared aliases (P1: the npm build row is its own claim)", () => {
    const seed = memories.create(autoMemory({ status: "active", summary: SUMMARY, aliases: ["pnpm", "패키지 매니저"], triggerSignature: NPM_TEST_SIGNATURE, signatureKey: NPM_TEST_KEY }));
    const build = normalizedFixture({ summary: "Build with pnpm build; npm run build breaks without the workspace flags.", aliases: ["PNPM", "패키지 매니저"], signatureKey: "bash|command|cmd|npm build" });
    expect(sharedAliasCount(build.fact.aliases, seed.aliases)).toBe(NEIGHBOUR_MIN_SHARED_ALIASES);
    expect(signatureKeysTwin(build.signatureKey, seed.signatureKey)).toBeNull();
    expect(findNeighbour(memories, build)).toBeNull();
    expect(neighbourRules(build, seed)).toEqual([]);
    // The same aliases still fold a signature-less restatement into the row (§5.7), and still count next to a twin key.
    expect(findNeighbourMatch(memories, normalizedFixture({ summary: "The package scripts of this repository are registered for pnpm only.", aliases: ["pnpm", "패키지 매니저"] }))).toMatchObject({ memory: { id: seed.id }, rules: ["aliases"] });
    expect(findNeighbourMatch(memories, normalizedFixture({ summary: "Coverage runs are pnpm-only in this repository.", aliases: ["pnpm", "패키지 매니저"], signatureKey: "bash|command|cmd|npm test --coverage" }))).toMatchObject({ memory: { id: seed.id }, rules: ["signature_substring", "aliases"] });
  });

  test("two distinct signatures of one kind are never folded by a shared error code either (P3: two SQL typos quoting ERROR 1054)", () => {
    const seed = memories.create(
      autoMemory({
        status: "active",
        summary: "The UPDATE must SET name; column nmae does not exist in users.",
        details: "MySQL answers ERROR 1054 (42S22): Unknown column 'nmae' in 'field list'.",
        aliases: [],
        triggerSignature: { tool: "bash", target: "command", pattern_kind: "substring", pattern: "set nmae" },
        signatureKey: "bash|command|substring|set nmae",
      })
    );
    const probe = normalizedFixture({
      summary: "The SELECT must read email; column emial does not exist in users.",
      details: "MySQL answers ERROR 1054 (42S22): Unknown column 'emial' in 'field list'.",
      signatureKey: "bash|command|substring|select emial",
    });
    expect(errorCodeTokens(probe.fact.details).has("ERROR 1054")).toBe(true);
    // The wording alone would corroborate the code (0.5 ≥ 0.2) — the two signatures are what keeps the rows apart.
    const score = jaccard(summaryTokens(probe.fact.summary), summaryTokens(seed.summary));
    expect(score).toBeGreaterThanOrEqual(NEIGHBOUR_CORROBORATION_JACCARD);
    expect(score).toBeLessThan(NEIGHBOUR_JACCARD);
    expect(findNeighbour(memories, probe)).toBeNull();
    expect(neighbourRules(probe, seed)).toEqual([]);
    // Without a signature on the fact the corroborated code still folds the restatement into the row.
    expect(findNeighbourMatch(memories, normalizedFixture({ summary: probe.fact.summary, details: probe.fact.details }))).toMatchObject({ memory: { id: seed.id }, rules: ["error_code"] });
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
    // Human rows are neighbours like any live row of the type (the reinforce then only touches their counters). Probed
    // under src/** so the docs/** row above is out of scope: with a global probe both would score 1.0 and the tie
    // would fall to id order, which the file's fixture counter decides.
    const human = memories.create(humanMemory({ type: "pitfall", summary: SUMMARY, scopeGlob: "**/*" }));
    expect(findNeighbour(memories, normalizedFixture({ summary: SUMMARY, scopeGlob: "src/**" }))?.id).toBe(human.id);
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

  test("a second mistake of the same kind (npm run build) becomes its own row instead of reinforcing the npm test row through shared aliases (P1)", () => {
    const seed = applyRun(db, { descriptor: descriptorFromLines(s01), lines: s01, output: outputFixture([factFixture({ evidence_refs: ["e1"], aliases: ["pnpm", "패키지 매니저"] })]) });
    const testId = seed.op.report.created[0]!;
    expect(memories.getById(testId)).toMatchObject({ status: "active", signatureKey: NPM_TEST_KEY });

    const lines: LedgerLine[] = [
      promptLine("build it", { seq: 2200, turn_key: "p22" }),
      toolFailLine("npm run build", "Exit code 1\nnpm ERR! Missing script: \"build\"", { seq: 2201, turn_key: "p22", program_token: "pm build", exit_code: 1, failure_class: "exit_1" }),
      assistantLine("npm run build failed; the build script is registered for pnpm.", { seq: 2202, turn_key: "p22" }),
    ];
    const result = applyRun(db, {
      descriptor: descriptorFromLines(lines, { sessionId: "session-d", turnKey: "p22" }),
      lines,
      output: outputFixture([
        factFixture({
          summary: "Build with pnpm build; npm run build breaks without the workspace flags.",
          details: "npm run build exits with a missing-script error; the build script is registered for pnpm.",
          trigger_signature: { tool: "bash", target: "command", pattern_kind: "cmd", pattern: "npm run build" },
          knowledge_kind: "failure_resolution",
          evidence_refs: ["e2"],
          aliases: ["PNPM", "패키지 매니저"],
        }),
      ]),
      now: isoPlus(REPLAY_NOW, { hours: 1 }),
    });
    expect(result.op.report.reinforced).toEqual([]);
    expect(result.op.report.created).toHaveLength(1);
    const buildId = result.op.report.created[0]!;
    expect(buildId).not.toBe(testId);
    expect(result.op.report.outcomes[0]?.detail ?? "").not.toContain("neighbour=");
    expect(memories.getById(buildId)).toMatchObject({ signatureKey: "bash|command|cmd|npm build" });
    expect(memories.getById(testId)).toMatchObject({ signatureKey: NPM_TEST_KEY, evidenceCount: 1 });
    expect(memories.list({ status: LIVE_STATUSES })).toHaveLength(2);
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
    // Each variant is its own mistake: a cmd pattern that is no twin of the others (signatureKeysTwin — `git push
    // --force origin main` would be one, the first row's matcher fires on it) and its own wording. The fixture's shared
    // aliases and the GH006 code they all quote no longer fold two distinct signatures into one row.
    const pushFact = (summary: string, extra: { pattern?: string; details?: string; side_effect?: "read" | "write"; horizon?: "durable" | "task" } = {}) =>
      factFixture({
        summary,
        details: extra.details ?? "main is a protected branch; GH006 is the rejection.",
        trigger_signature: { tool: "bash", target: "command", pattern_kind: "cmd", pattern: extra.pattern ?? "git push origin main", side_effect: extra.side_effect ?? "write" },
        knowledge_kind: "failure_resolution",
        evidence_refs: ["e2", "e3"],
        ...(extra.horizon === undefined ? {} : { horizon: extra.horizon }),
      });

    // Through the raw path (applyRun → validateRawExtraction → schema.ts): the parser carries side_effect, so the row is born `write`.
    const op = applyRun(db, { descriptor, lines, output: outputFixture([pushFact("Never push straight to main in this repository; push the branch and open a pull request.")]) }).op;
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
        fact: pushFact("Pushes to the release branch are refused in this repository; open a pull request from the fix branch.", { pattern: "git push origin release", details: "Branch protection covers release as well as main." }),
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
