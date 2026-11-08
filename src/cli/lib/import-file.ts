/**
 * `hm import` input side (spec §11, §5.6 import mode): a Markdown-ish file is split into bullets (list items,
 * numbered items, checkboxes; continuation lines joined; fenced code skipped) and every bullet becomes one
 * `import` episode descriptor — host `import`, close_reason `import`, `ledger_ref = import:<file>#L<n>`,
 * `tools = []`, `evidence_weight = 1`, `prompt_text` = the bullet text. Headings are not imported themselves;
 * the current heading is carried as uncitable context. Re-runs are idempotent: the turn key is the hash of
 * the normalized bullet text, so the episode id (and therefore the extraction run id) does not change.
 */

import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";

import { extractScopeRefs } from "../../activation/tool-vocabulary";
import { EPISODE_SCHEMA, type EpisodeDescriptor } from "../../core/episode-types";
import { episodeId, normalizeSummary } from "../../core/ids";
import { sessionKey } from "../../core/paths";

export const IMPORT_HOST = "import" as const;
/** Bullets shorter than this are skipped (the extraction schema needs ≥ 12-char summaries anyway). */
export const IMPORT_MIN_BULLET_CHARS = 8;

export interface ImportBullet {
  /** 1-based line number of the bullet's first line. */
  line: number;
  text: string;
  /** sha1(normalized text).slice(0, 16): the episode turn key. */
  hash: string;
  heading: string | null;
}

export interface ParsedImportFile {
  bullets: ImportBullet[];
  /** Non-empty lines that were neither bullets, headings nor continuation lines (paragraphs, tables, code). */
  skippedLines: number;
  headings: number;
}

const BULLET = /^(\s*)(?:[-*+]|\d+[.)])\s+(.*)$/;
const CHECKBOX = /^\[( |x|X)\]\s*/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const FENCE = /^\s*(```|~~~)/;

export function bulletHash(text: string): string {
  return createHash("sha1").update(normalizeSummary(text), "utf8").digest("hex").slice(0, 16);
}

export function parseImportBullets(content: string): ParsedImportFile {
  const lines = content.split(/\r?\n/);
  const bullets: ImportBullet[] = [];
  let skippedLines = 0;
  let headings = 0;
  let heading: string | null = null;
  let inFence = false;
  let current: { line: number; indent: number; parts: string[]; heading: string | null } | null = null;

  const flush = (): void => {
    if (current === null) return;
    const text = current.parts.join(" ").replace(/\s+/g, " ").trim();
    if (text.length >= IMPORT_MIN_BULLET_CHARS) {
      bullets.push({ line: current.line, text, hash: bulletHash(text), heading: current.heading });
    } else if (text.length > 0) {
      skippedLines += 1;
    }
    current = null;
  };

  lines.forEach((raw, index) => {
    const lineNo = index + 1;
    if (FENCE.test(raw)) {
      flush();
      inFence = !inFence;
      return;
    }
    if (inFence) return;
    if (raw.trim().length === 0) {
      flush();
      return;
    }
    const headingMatch = HEADING.exec(raw);
    if (headingMatch !== null) {
      flush();
      heading = headingMatch[2]!.trim();
      headings += 1;
      return;
    }
    const bulletMatch = BULLET.exec(raw);
    if (bulletMatch !== null) {
      flush();
      const body = bulletMatch[2]!.replace(CHECKBOX, "").trim();
      current = { line: lineNo, indent: bulletMatch[1]!.length, parts: [body], heading };
      return;
    }
    const indent = raw.length - raw.trimStart().length;
    if (current !== null && indent > current.indent) {
      current.parts.push(raw.trim());
      return;
    }
    flush();
    skippedLines += 1;
  });
  flush();

  return { bullets, skippedLines, headings };
}

/** Forward-slash path stored in `ledger_ref` / `source_ref`: project-relative inside the root, absolute otherwise. */
export function importSourcePath(root: string, file: string): string {
  const absolute = resolve(file);
  const rel = relative(resolve(root), absolute);
  const inside = rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel);
  return (inside ? rel : absolute).split("\\").join("/");
}

export function importSessionId(sourcePath: string): string {
  return `import:${sourcePath}`;
}

export function importSourceRef(sourcePath: string, line: number): string {
  return `import:${sourcePath}#L${String(line)}`;
}

/** `import:<sourcePath>#L` — prefix of every source_ref written for this file. */
export function importSourceRefPrefix(sourcePath: string): string {
  return `import:${sourcePath}#L`;
}

export function importEpisodeId(sourcePath: string, bullet: Pick<ImportBullet, "hash">): string {
  return episodeId(IMPORT_HOST, importSessionId(sourcePath), bullet.hash, 0);
}

export interface BuildImportDescriptorInput {
  sourcePath: string;
  bullet: ImportBullet;
  now: string;
  /** Project root used to make path-like tokens in the bullet repository-relative. */
  root: string;
  /** Uncitable context for the extractor; defaults to `(import) section: <heading>` when the bullet sits under a heading. */
  contextRef?: string | null;
}

export function buildImportDescriptor(input: BuildImportDescriptorInput): EpisodeDescriptor {
  const sessionId = importSessionId(input.sourcePath);
  return {
    schema: EPISODE_SCHEMA,
    id: importEpisodeId(input.sourcePath, input.bullet),
    host: IMPORT_HOST,
    session_id: sessionId,
    session_key: sessionKey(IMPORT_HOST, sessionId),
    turn_key: input.bullet.hash,
    segment: 0,
    started_at: input.now,
    closed_at: input.now,
    close_reason: "import",
    ledger_ref: importSourceRef(input.sourcePath, input.bullet.line),
    correction_for: null,
    context_ref: input.contextRef !== undefined ? input.contextRef : input.bullet.heading === null ? null : `(import) section: ${input.bullet.heading}`,
    scope_refs: extractScopeRefs(input.bullet.text, input.root),
    tools: [],
    failure_signatures: [],
    flags: {},
    fired: [],
    evidence_weight: 1,
    event_count: 1,
    prompt_text: input.bullet.text,
    last_assistant_message: null,
  };
}
