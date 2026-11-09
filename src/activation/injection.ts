/**
 * The host-neutral shape of one injected memory and its text rendering, shared by the four read-path
 * triggers (§6.1 budgets, §7.2 reason text, §8.6 example output). Budgets are applied on UTF-8 bytes
 * of the rendered text so a 3 KB `additionalContext` means 3 KB on the wire.
 */

import { HOOK_IO_LIMITS } from "../core/hook-types";
import type { SnapshotMemory } from "../core/snapshot-types";
import type { Authority, Enforcement, Host, MemoryType } from "../core/vocabulary";

export type InjectionSource =
  | "baseline"
  | "startup"
  | "lexical"
  | "dense"
  | "hybrid"
  | "signature"
  | "scope"
  | "rule"
  | "failure_index";

export interface InjectedItem {
  id: string;
  type: MemoryType;
  summary: string;
  details: string;
  authority: Authority;
  enforcement: Enforcement;
  score: number;
  source: InjectionSource;
  /** Human advise row with an open contradicting proposal supported by ≥ 2 sessions (§6.1). */
  contested: boolean;
  /** Imported with `--yes` and not yet confirmed by a person. */
  unconfirmed: boolean;
  /** Set when a trigger signature matched the current tool call. */
  signatureMatched: boolean;
  /** Compiled signature key of the row (for `fired.signature_keys`), '' when it has none. */
  signatureKey: string;
  /** Rendered text of this item (one line) and its UTF-8 size. */
  text: string;
  bytes: number;
}

export const ITEM_DETAILS_CHARS = 240;
export const ITEM_SUMMARY_CHARS = 200;
export const INJECTION_PREFIX = "[harness-memory]";

const ANSI_CSI_SEQUENCE = /\u001b\[[0-?]*[ -/]*[@-~]/g;
/** C0 / C1 controls other than the `\s` whitespace (`\t \n \v \f \r`) that `oneLine` collapses. */
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000e-\u001f\u007f-\u009f]/g;

/**
 * Removes ANSI escape sequences and C0/C1 control characters so a stored row renders as its visible text:
 * an extractor quoting coloured tool output must not be able to erase or overwrite what a person sees.
 */
export function stripControlCharacters(text: string): string {
  return text.replace(ANSI_CSI_SEQUENCE, "").replace(CONTROL_CHARACTERS, "");
}

function oneLine(text: string, max: number): string {
  const flat = stripControlCharacters(text).replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, Math.max(0, max - 1))}…`;
}

export function typeLabel(type: MemoryType): string {
  switch (type) {
    case "architecture_constraint":
      return "CONSTRAINT";
    default:
      return type.toUpperCase();
  }
}

export function authorityLabel(item: Pick<InjectedItem, "authority" | "unconfirmed">): string {
  if (item.authority === "human") return item.unconfirmed ? "human, unconfirmed import" : "human";
  return "auto, provisional";
}

/** `[harness-memory] PITFALL (auto, provisional): <summary> — <details>` (+ `(contested)`). */
export function renderItemText(item: Pick<InjectedItem, "type" | "authority" | "unconfirmed" | "summary" | "details" | "contested">): string {
  const summary = oneLine(item.summary, ITEM_SUMMARY_CHARS);
  const details = oneLine(item.details, ITEM_DETAILS_CHARS);
  const head = `${INJECTION_PREFIX} ${typeLabel(item.type)} (${authorityLabel(item)}${item.contested ? ", contested" : ""}): ${summary}`;
  return details.length > 0 && details !== summary ? `${head} — ${details}` : head;
}

export interface ItemOptions {
  score: number;
  source: InjectionSource;
  signatureMatched?: boolean;
}

export function itemFromSnapshotMemory(memory: SnapshotMemory, options: ItemOptions): InjectedItem {
  const partial = {
    type: memory.type,
    authority: memory.authority,
    unconfirmed: memory.import_unconfirmed === 1,
    summary: memory.summary,
    details: memory.details,
    contested: memory.contested === 1 && memory.authority === "human" && memory.enforcement === "advise",
  };
  const text = renderItemText(partial);
  return {
    id: memory.id,
    ...partial,
    enforcement: memory.enforcement,
    score: options.score,
    source: options.source,
    signatureMatched: options.signatureMatched ?? false,
    signatureKey: memory.signature?.signature_key ?? "",
    text,
    bytes: Buffer.byteLength(text, "utf8"),
  };
}

export interface BudgetedInjection {
  included: InjectedItem[];
  /** Items that did not fit (count or bytes), in input order. */
  dropped: InjectedItem[];
  text: string | null;
  bytes: number;
}

/** Keeps items in order while they fit `maxItems` and `maxBytes` (newline-joined rendering). */
export function applyBudget(items: readonly InjectedItem[], maxItems: number, maxBytes: number): BudgetedInjection {
  const included: InjectedItem[] = [];
  const dropped: InjectedItem[] = [];
  let bytes = 0;
  for (const item of items) {
    const separator = included.length > 0 ? 1 : 0;
    if (included.length >= maxItems || bytes + separator + item.bytes > maxBytes) {
      dropped.push(item);
      continue;
    }
    included.push(item);
    bytes += separator + item.bytes;
  }
  return {
    included,
    dropped,
    text: included.length === 0 ? null : included.map((item) => item.text).join("\n"),
    bytes,
  };
}

/** Reason text for `permissionDecisionReason` (≤ 600 chars) with the enforcement-specific tail. */
export function renderReason(item: InjectedItem, enforcement: Enforcement): string {
  let tail = "";
  if (enforcement === "soft_deny") tail = " If this does not apply, call the tool again to proceed.";
  else if (enforcement === "confirm") tail = " Confirm to proceed.";
  else if (enforcement === "deny") tail = " This action is blocked by a human-set policy.";
  const max = HOOK_IO_LIMITS.reason_chars;
  const body = item.text.length + tail.length <= max ? item.text : `${item.text.slice(0, Math.max(0, max - tail.length - 1))}…`;
  return `${body}${tail}`;
}

/** `harness-memory: pitfall 3f9a1b2c fired (soft_deny)` — only for confirm / soft_deny / deny (§7.2). */
export function renderSystemMessage(item: Pick<InjectedItem, "id" | "type">, enforcement: Enforcement): string | null {
  if (enforcement === "advise") return null;
  return `harness-memory: ${item.type} ${item.id.slice(0, 8)} fired (${enforcement})`;
}

const CLAUDE_FILES = /^(claude(\.local)?\.md)$/i;
const AGENTS_FILES = /^agents(\.local)?\.md$/i;
/** Claude Code loads `<config>/projects/<slug>/memory/MEMORY.md` (its auto-memory index) every session; the topic files beside it are not loaded by default. */
const AUTO_MEMORY_INDEX = /(^|\/)memory\/memory\.md$/i;

/**
 * Native de-duplication (§6.1): rows imported from a file the host loads by itself are not injected on
 * `session_start` / `before_model`. Claude Code loads CLAUDE.md; Codex and OpenCode load AGENTS.md.
 */
export function isHostLoadedFile(host: Host, sourceFile: string | null): boolean {
  if (sourceFile === null || sourceFile.length === 0) return false;
  const normalized = sourceFile.replace(/\\/g, "/");
  const base = normalized.split("/").pop() ?? sourceFile;
  switch (host) {
    case "claude-code":
      return CLAUDE_FILES.test(base) || AUTO_MEMORY_INDEX.test(normalized);
    case "codex":
    case "opencode":
      return AGENTS_FILES.test(base);
    default:
      return false;
  }
}

/** `expires_at < now` → true (null never expires). */
export function isTtlExpired(ttlExpiresAt: string | null, nowMs: number): boolean {
  if (ttlExpiresAt === null) return false;
  const expiresMs = Date.parse(ttlExpiresAt);
  return !Number.isNaN(expiresMs) && expiresMs < nowMs;
}
