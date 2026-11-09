/**
 * Deterministic identifiers and normalization shared by writers and tests (spec §3.4, §4.1, §5.7).
 */

import { createHash } from "node:crypto";

import { createDeterministicId } from "../memory/utils";
import { EXTRACTOR_VERSION } from "./extraction-types";
import { GLOBAL_SCOPE, isGlobalScope } from "./vocabulary";

export { createDeterministicId };

/** Same segment re-closed → same id; a later segment of the same turn → a different episode. */
export function episodeId(host: string, sessionId: string, turnKey: string, segment: number): string {
  return createDeterministicId(`episode:${host}:${sessionId}:${turnKey}:${segment}`);
}

/** Excludes the prompt hash on purpose: the prompt embeds existing memories that change between retries. */
export function extractionRunId(episode: string, extractorVersion: string = EXTRACTOR_VERSION): string {
  return createDeterministicId(`run:${episode}:${extractorVersion}`);
}

/** NFKC, lower-case, whitespace-collapsed, trailing punctuation removed. */
export function normalizeSummary(summary: string): string {
  return summary
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[\s.。!?…,;:]+$/g, "")
    .trim();
}

/** Forward slashes, no leading dot-slash, no trailing slash; every global spelling becomes GLOBAL_SCOPE. */
export function normalizeScopeGlob(scopeGlob: string): string {
  let value = scopeGlob.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  if (value === "" || isGlobalScope(value)) value = GLOBAL_SCOPE;
  return value;
}

/** sha256(type|scope_glob|signature_key|normalize(summary)) — the live-uniqueness key of a fact. */
export function semanticKey(type: string, scopeGlob: string, signatureKey: string, summary: string): string {
  return createHash("sha256")
    .update(`${type}|${normalizeScopeGlob(scopeGlob)}|${signatureKey}|${normalizeSummary(summary)}`, "utf8")
    .digest("hex");
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Short digest for ledger lines (command / path / url), capped in characters, never the full input. */
export function digestText(text: string, maxChars: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= maxChars ? flat : `${flat.slice(0, maxChars - 1)}…`;
}

export function nowIso(): string {
  return new Date().toISOString();
}
