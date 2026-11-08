/**
 * Remember-as-human (A′, docs/redesign/positioning-2026-11.md §8): what the user explicitly asked to remember
 * ("기억해", "remember this", "from now on always …") is the approval itself. The extractor still proposes the rule and
 * V6 / V8 / V12 still reject unsafe, restated or wrong-signature facts, but a `create` fact of a remember episode
 * that cites the remember prompt line becomes a human-authority row, active immediately with the type's human
 * default enforcement, instead of a candidate waiting in `hm review`. Facts of the same episode that cite only
 * tool lines, and every reinforce / propose_* fact, follow the normal automatic path.
 *
 * Two detectors, two jobs. The hook's `detectRemember` (src/core/signals.ts) is the EVIDENCE-WEIGHT signal: it is
 * deliberately broad (`remember|from now on|going forward|기억|앞으로|절대`, weight 3) and flags "I don't remember
 * whether this repo uses npm or pnpm", "앞으로 3일 안에 끝내야 해" or "이 함수 기억나?" as well as a request — a probe of
 * nine such prompts flagged eight. That flag must not hand the LLM's proposal human authority on its own, so the
 * human path is gated by `detectRememberRequest` below: an imperative request in the prompt text itself. Explicit ⊂
 * broad — every cue here also sets the weight flag, so a prompt the hook did not flag never reaches the human path.
 *
 * Pure helpers only — no SQLite, no file system: the reconciler applies them inside its savepoint and the
 * SessionStart hook renders the notice from the snapshot (hooks never open the database). The one database write
 * of the remember path that is not a status transition lives in transitions.ts (`adoptActiveMemory`).
 */

import type { HarnessConfig } from "../core/config";
import type { EpisodeFlags } from "../core/episode-types";
import type { FactAction } from "../core/extraction-types";
import type { LedgerLine } from "../core/ledger-types";
import { detectCorrection } from "../core/signals";
import type { SnapshotMemory } from "../core/snapshot-types";
import type { Enforcement, MemoryType } from "../core/vocabulary";

/** `memories.status_reason` of a row born from the user's own request (also in STATUS_REASONS). */
export const REMEMBER_STATUS_REASON = "remember";
/** Prefix of the memory_transitions.reason written when a remember turn promotes or adopts an existing row. */
export const REMEMBER_TRANSITION_REASON = "remember";
/**
 * At most this many `create` facts of one remember turn become human rows; later ones follow the automatic path.
 * A "기억해" turn states one rule, occasionally two — never a whole list the model invented around it.
 */
export const REMEMBER_MAX_PER_EPISODE = 2;
/** SessionStart names remember rows remembered within this window (one notice per session-day, like the digest). */
export const REMEMBER_NOTICE_WINDOW_MS = 24 * 60 * 60 * 1000;
/** At most this many rules are spelled out; the rest are counted. */
export const REMEMBER_NOTICE_MAX_RULES = 3;
const NOTICE_SUMMARY_CHARS = 100;
/** Same prefix length `hm memory:*` resolves (src/cli/lib/lookup.ts SHORT_ID_CHARS). */
const UNDO_ID_CHARS = 8;

/** `remember:episode <id>` — the transition reason of a twin promoted / adopted by a remember turn. */
export function rememberTransitionReason(episodeId: string): string {
  return `${REMEMBER_TRANSITION_REASON}:episode ${episodeId}`;
}

/** The episode id of a `remember:episode <id>` transition reason, else null. */
export function rememberEpisodeOfReason(reason: string): string | null {
  const prefix = `${REMEMBER_TRANSITION_REASON}:episode `;
  return reason.startsWith(prefix) && reason.length > prefix.length ? reason.slice(prefix.length).trim() : null;
}

// ---------------------------------------------------------------------------------------------
// Explicit request detection
// ---------------------------------------------------------------------------------------------

const SENTENCE_BREAK = /[.!?\n]+/;

/**
 * Recall talk removed before the cues are tested: negated or questioned memory ("don't / can't remember",
 * "do you remember", "remember where …", "I remember we …", "기억나", "기억 안 나", "기억해?"). Removing instead of
 * vetoing keeps "I can't remember, but from now on always use pnpm" a request.
 */
const RECALL_TALK: readonly RegExp[] = [
  /\b(?:don'?t|do not|can'?t|cannot|couldn'?t|didn'?t|doesn'?t|won'?t|wouldn'?t|never|not|hardly|barely|vaguely|still|no longer)\s+(?:quite\s+|really\s+|even\s+)?remember(?:ed|ing|s)?\b/gi,
  /\b(?:do|did|does)\s+(?:you|we|i|he|she|they|anyone)\s+(?:still\s+|even\s+)?remember\b/gi,
  /\b(?:i|we|he|she|they)\s+(?:still\s+|all\s+|both\s+)?remember(?:ed)?\b/gi,
  /\bremember(?:ed|ing|s)?\s+(?:whether|where|if|what|how|when|which|who|whom|why|the\s+time|that\s+time|last\s+time)\b/gi,
  /\bremember\s*\?/gi,
  /기억(?:이|을|은|도)?\s*(?:안|못|없|잘)/g,
  /기억\s*나/g,
  /기억하(?:니|냐|나요|세요|십니까|시나요|는지)\s*\?/g,
  /기억해\s*\?/g,
];

/** Imperative request cues (English: an object or a sentence-initial `remember`; Korean: the -해 imperative family). */
const EXPLICIT_REQUEST: readonly RegExp[] = [
  /\bremember\s+(?:this|that|it|these|those|to)\b/i,
  /\bremember\s*[:\-—–]/i,
  /\bplease\s+remember\b/i,
  /^\s*(?:please\s+|also\s+|and\s+|so\s+|just\s+|now\s+|oh\s+|ok,?\s+|okay,?\s+)?remember\b/i,
  /[;:,]\s*(?:please\s+|also\s+|and\s+|just\s+)?remember\b/i,
  /기억해/,
  /기억하(?:세요|십시오|시오|라고|도록|고\s*있어|여\s*주)/,
  /기억\s+해\s*(?:줘|주|둬|두|라)/,
];

/** "from now on" / "going forward" / "앞으로(는)" — a standing-rule marker, a request only with a rule cue. (`이제부터` is a decision marker, not a hook remember signal, so it is not one.) */
const STANDING_MARKER = /\bfrom now on\b|\bgoing forward\b|앞으로(?:는|도|부터)?/i;
/** Plan talk ("going forward let's look at the auth module first") is not a rule. */
const PLAN_TALK = /\blet'?s\b|\blet us\b/i;
const STANDING_CUE_EN = /\b(?:always|never|must|do not|don'?t|instead|make sure|ensure|only|no longer|avoid|prefer|skip|stop|use|run)\b/i;
const STANDING_CUE_KO = /항상|절대|반드시|꼭|무조건|지\s*마|지\s*말|말고|대신|않도록|금지|안\s*돼|안\s*된다|하지\s*않/;

function stripRecallTalk(sentence: string): string {
  let output = sentence;
  for (const pattern of RECALL_TALK) {
    pattern.lastIndex = 0;
    output = output.replace(pattern, " ");
  }
  return output;
}

/**
 * True when the prompt explicitly asks to remember a rule — the gate of the human path. Recall talk is stripped from
 * the whole text first (its question forms need the `?` that a sentence split would take away), then per sentence
 * either an imperative `remember` / `기억해` cue remains, or a standing-rule marker ("from now on", "앞으로") stands
 * with a rule cue (`always`, `never`, `don't`, `instead`, `use`, `run`, `항상`, `절대`, `꼭`, `-지 마`, `말고`, …) or a
 * correction and without plan talk (`let's`). Deterministic; never produces memory text.
 */
export function detectRememberRequest(text: string): boolean {
  for (const sentence of stripRecallTalk(text).split(SENTENCE_BREAK)) {
    if (sentence.trim().length === 0) continue;
    if (EXPLICIT_REQUEST.some((pattern) => pattern.test(sentence))) return true;
    if (STANDING_MARKER.test(sentence) && !PLAN_TALK.test(sentence) && (STANDING_CUE_EN.test(sentence) || STANDING_CUE_KO.test(sentence) || detectCorrection(sentence))) {
      return true;
    }
  }
  return false;
}

export interface RememberFactInput {
  action: FactAction;
  evidence_refs: readonly string[];
}

/**
 * True when the episode is a remember turn (`flags.remember === 1`), the fact is a `create`, and at least one
 * evidence ref resolves to a prompt line the hook flagged `remember = 1` WHOSE TEXT IS AN EXPLICIT REQUEST
 * (`detectRememberRequest`). The hook's flag alone is the evidence-weight signal and is not enough: "I don't remember
 * whether this repo uses npm" carries it too. A fact citing only tool lines is the agent's own observation, not the
 * user's words, and stays on the normal path.
 */
export function citesRememberPrompt(flags: EpisodeFlags, fact: RememberFactInput, seqMap: ReadonlyMap<string, LedgerLine>): boolean {
  if (flags.remember !== 1 || fact.action !== "create") return false;
  return fact.evidence_refs.some((ref) => {
    const line = seqMap.get(ref);
    return line !== undefined && line.kind === "prompt" && line.remember === 1 && detectRememberRequest(line.text);
  });
}

/**
 * Human default enforcement for a remembered rule (the §7.3 table seen from the user's side): a policy with a
 * signature is a hard policy (`before_tool.hard_policy`, confirm), a pitfall with a signature blocks the first
 * attempt (soft_deny — what the user asked for when they said "never run that here", and what an auto pitfall
 * reaches after two sessions), everything else — including any row without a signature — advises. `deny` stays a
 * manual `hm memory:enforce` decision.
 */
export function rememberEnforcement(type: MemoryType, hasSignature: boolean, config: Pick<HarnessConfig, "before_tool">): Enforcement {
  if (!hasSignature) return "advise";
  if (type === "policy") return config.before_tool.hard_policy;
  if (type === "pitfall") return "soft_deny";
  return "advise";
}

// ---------------------------------------------------------------------------------------------
// SessionStart notice
// ---------------------------------------------------------------------------------------------

export type RememberNoticeRow = Pick<SnapshotMemory, "id" | "summary" | "status" | "authority" | "created_at"> & Partial<Pick<SnapshotMemory, "status_reason" | "last_verified_at">>;

/**
 * When the user's request took effect, in ms: the later of `created_at` and `last_verified_at`. A row born from the
 * request has both at the remember episode; a twin the request adopted (an older candidate / stale / active row) keeps
 * its `created_at` but the reinforce that follows every adoption sets `last_verified_at` to that episode's close.
 * A later reinforce of a remembered claim moves it again and re-announces the rule for a day (the user restated it).
 * NaN when neither parses.
 */
export function rememberedAtMs(memory: Pick<RememberNoticeRow, "created_at" | "last_verified_at">): number {
  const created = Date.parse(memory.created_at);
  const verified = memory.last_verified_at === null || memory.last_verified_at === undefined ? Number.NaN : Date.parse(memory.last_verified_at);
  if (Number.isFinite(created) && Number.isFinite(verified)) return Math.max(created, verified);
  return Number.isFinite(created) ? created : verified;
}

/** An active human row whose status_reason is `remember`, remembered within `windowMs` before `nowMs` (never in the future). */
export function isRecentRememberRow(memory: RememberNoticeRow, nowMs: number, windowMs: number = REMEMBER_NOTICE_WINDOW_MS): boolean {
  if (memory.status !== "active" || memory.authority !== "human" || memory.status_reason !== REMEMBER_STATUS_REASON) return false;
  const rememberedMs = rememberedAtMs(memory);
  if (!Number.isFinite(rememberedMs) || rememberedMs > nowMs) return false;
  return nowMs - rememberedMs <= windowMs;
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/**
 * `harness-memory: 1 rule from your request is active — Run pnpm lint before every git commit (undo: hm memory:demote 66ffa056)`
 * Newest first; more than `maxRules` rows are counted (`; +2 more (hm memory:list)`). Null when nothing is recent.
 */
export function buildRememberNotice(
  memories: readonly RememberNoticeRow[],
  now: string,
  options: { windowMs?: number; maxRules?: number } = {}
): string | null {
  const nowMs = Date.parse(now);
  const windowMs = options.windowMs ?? REMEMBER_NOTICE_WINDOW_MS;
  const maxRules = options.maxRules ?? REMEMBER_NOTICE_MAX_RULES;
  const recent = memories
    .filter((memory) => isRecentRememberRow(memory, nowMs, windowMs))
    .sort((left, right) => rememberedAtMs(right) - rememberedAtMs(left) || left.id.localeCompare(right.id));
  if (recent.length === 0) return null;
  const shown = recent.slice(0, maxRules);
  const rules = shown.map((memory) => `${oneLine(memory.summary, NOTICE_SUMMARY_CHARS)} (undo: hm memory:demote ${memory.id.slice(0, UNDO_ID_CHARS)})`);
  const more = recent.length > shown.length ? `; +${String(recent.length - shown.length)} more (hm memory:list)` : "";
  const count = recent.length;
  return `harness-memory: ${String(count)} rule${count === 1 ? "" : "s"} from your request ${count === 1 ? "is" : "are"} active — ${rules.join("; ")}${more}`;
}
