/**
 * Canonical tool vocabulary (spec §8.5) and target selection for the before_tool hook (§6.2 step 2).
 *
 * Pure module: no database, no I/O. Host adapters call `canonicalizeHostTool` on every tool event;
 * the pre-tool hook calls `pickTarget` to obtain the string a signature is matched against and the
 * path-like tokens used for scope intersection.
 */

import { HOOK_IO_LIMITS } from "../core/hook-types";
import {
  CANONICAL_TOOL_FAMILIES,
  isCanonicalTool,
  toolFamily,
  type CanonicalTool,
  type Host,
  type ShellDialect,
  type SignatureTarget,
} from "../core/vocabulary";
import { primaryProgramToken } from "./signature";

export interface HostToolCanonicalization {
  canonical: CanonicalTool;
  shellDialect: ShellDialect | null;
}

const CLAUDE_CODE_TOOLS: Readonly<Record<string, CanonicalTool>> = {
  bash: "bash",
  powershell: "bash",
  edit: "edit",
  multiedit: "edit",
  notebookedit: "edit",
  write: "write",
  read: "read",
  notebookread: "read",
  grep: "grep",
  glob: "glob",
  webfetch: "fetch",
  websearch: "other",
  task: "task",
  agent: "task",
};

const CODEX_TOOLS: Readonly<Record<string, CanonicalTool>> = {
  bash: "bash",
  shell: "bash",
  shell_command: "bash",
  exec_command: "bash",
  local_shell: "bash",
  apply_patch: "edit",
  edit: "edit",
  write: "write",
  read: "read",
  read_file: "read",
  grep: "grep",
  glob: "glob",
  web_search: "other",
  websearch: "other",
  web_fetch: "fetch",
  fetch: "fetch",
  task: "task",
  spawn_agent: "task",
};

const OPENCODE_TOOLS: Readonly<Record<string, CanonicalTool>> = {
  bash: "bash",
  edit: "edit",
  multiedit: "edit",
  patch: "edit",
  write: "write",
  read: "read",
  grep: "grep",
  glob: "glob",
  list: "other",
  webfetch: "fetch",
  websearch: "other",
  task: "task",
  todowrite: "other",
  todoread: "other",
  question: "other",
  skill: "other",
};

const MCP_HOST_NAME = /^mcp__(.+?)__(.+)$/;

/**
 * §8.5: Claude Code `Bash|PowerShell → bash` (dialect recorded separately so one stored `bash`
 * memory fires on both), `Edit|MultiEdit|NotebookEdit → edit`, `WebFetch → fetch`, `WebSearch → other`,
 * `Task|Agent → task`, `mcp__server__tool → mcp:server/tool`, anything unknown → `other`.
 */
export function canonicalizeHostTool(host: Host, hostToolName: string): HostToolCanonicalization {
  const name = hostToolName.trim();
  const lower = name.toLowerCase();

  const mcp = MCP_HOST_NAME.exec(name);
  if (mcp !== null) {
    return { canonical: `mcp:${mcp[1]!.toLowerCase()}/${mcp[2]!.toLowerCase()}`, shellDialect: null };
  }

  if (host === "claude-code") {
    const canonical = CLAUDE_CODE_TOOLS[lower];
    if (canonical !== undefined) {
      const shellDialect: ShellDialect | null = lower === "bash" ? "bash" : lower === "powershell" ? "powershell" : null;
      return { canonical, shellDialect };
    }
    return { canonical: "other", shellDialect: null };
  }

  if (host === "codex") {
    const canonical = CODEX_TOOLS[lower];
    if (canonical !== undefined) {
      return { canonical, shellDialect: canonical === "bash" ? "bash" : null };
    }
    return { canonical: "other", shellDialect: null };
  }

  if (host === "opencode") {
    const canonical = OPENCODE_TOOLS[lower];
    if (canonical !== undefined) {
      return { canonical, shellDialect: canonical === "bash" ? "bash" : null };
    }
    return { canonical: "other", shellDialect: null };
  }

  // import / unknown hosts: canonical names pass through unchanged.
  if (isCanonicalTool(lower)) {
    return { canonical: lower, shellDialect: null };
  }
  return { canonical: "other", shellDialect: null };
}

// ---------------------------------------------------------------------------------------------
// Scope refs
// ---------------------------------------------------------------------------------------------

const MAX_SCOPE_REFS = 50;
const URL_TOKEN = /^[a-z][a-z0-9+.-]*:\/\//i;
const DRIVE_PATH = /^[A-Za-z]:\//;
const GIT_BASH_DRIVE = /^\/([A-Za-z])\/(.*)$/;
const FILE_LIKE = /^[\w@.-]+\.[A-Za-z][A-Za-z0-9]{0,7}$/;
const DOTFILE_LIKE = /^\.[A-Za-z][\w.-]*$/;
const TOKEN_DELIMITERS = new Set([" ", "\t", "\n", "\r", ",", ";", "=", "(", ")", "{", "}", "[", "]", "<", ">", "|", "&"]);

function splitTokens(text: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: string | null = null;
  const push = (): void => {
    if (current.length > 0) tokens.push(current);
    current = "";
  };
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (quote !== null) {
      if (ch === quote) {
        quote = null;
        push();
        continue;
      }
      if (ch === "\\" && quote === '"' && text[i + 1] === '"') {
        current += '"';
        i += 1;
        continue;
      }
      current += ch;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      push();
      quote = ch;
      continue;
    }
    if (TOKEN_DELIMITERS.has(ch)) {
      push();
      continue;
    }
    current += ch;
  }
  push();
  return tokens;
}

function normalizeSlashes(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
}

function normalizeRoot(root: string): string {
  let normalized = normalizeSlashes(root.trim()).replace(/\/+$/, "");
  const gitBash = GIT_BASH_DRIVE.exec(normalized);
  if (gitBash !== null) normalized = `${gitBash[1]!.toUpperCase()}:/${gitBash[2]!}`;
  return normalized;
}

function isAbsoluteLike(value: string): boolean {
  return value.startsWith("/") || value.startsWith("~") || DRIVE_PATH.test(value);
}

/** Makes an absolute path repository-relative when it lies under `root`; null when it is outside. */
export function relativizeToRoot(absolute: string, root: string | undefined): string | null {
  if (root === undefined) return null;
  let candidate = normalizeSlashes(absolute);
  const gitBash = GIT_BASH_DRIVE.exec(candidate);
  if (gitBash !== null) candidate = `${gitBash[1]!.toUpperCase()}:/${gitBash[2]!}`;
  const normalizedRoot = normalizeRoot(root);
  const caseInsensitive = DRIVE_PATH.test(normalizedRoot) || DRIVE_PATH.test(candidate);
  const left = caseInsensitive ? candidate.toLowerCase() : candidate;
  const right = caseInsensitive ? normalizedRoot.toLowerCase() : normalizedRoot;
  if (left === right) return null;
  if (!left.startsWith(`${right}/`)) return null;
  return candidate.slice(normalizedRoot.length + 1);
}

function cleanToken(raw: string): string {
  let token = raw.trim();
  token = token.replace(/^[(\[{<"'`]+/, "").replace(/[)\]}>"'`.,;:!?]+$/, "");
  token = token.replace(/#L?\d+(?:-L?\d+)?$/, "");
  token = token.replace(/:\d+(?::\d+)?$/, "");
  return token;
}

function stripGlobTail(value: string): string {
  const segments = value.split("/");
  const firstMagic = segments.findIndex((segment) => /[*?]/.test(segment));
  if (firstMagic === -1) return value;
  return segments.slice(0, firstMagic).join("/");
}

/**
 * Repository-relative, forward-slash, path-like tokens in free text (commands, JSON tool input).
 * Quotes, `./`, flags, trailing punctuation and `:line:col` suffixes are stripped; URLs, variables,
 * `..` segments and absolute paths outside `root` are dropped; glob tails are cut (`src/**` → `src`).
 */
export function extractScopeRefs(text: string, root?: string): string[] {
  const refs: string[] = [];
  const seen = new Set<string>();
  for (const raw of splitTokens(text)) {
    const token = cleanToken(raw);
    if (token.length === 0 || token.startsWith("-") || token.includes("$") || URL_TOKEN.test(token)) continue;
    const hadSlash = /[\\/]/.test(token);
    let value = normalizeSlashes(token);
    if (isAbsoluteLike(value)) {
      if (value.startsWith("~")) continue;
      const relative = relativizeToRoot(value, root);
      if (relative === null) continue;
      value = relative;
    }
    value = value.replace(/^(\.\/)+/, "");
    value = stripGlobTail(value);
    value = value.replace(/\/+$/, "");
    if (value.length === 0 || value === "." || value === "..") continue;
    if (value.split("/").includes("..")) continue;
    if (!/[A-Za-z0-9]/.test(value)) continue;
    const pathLike = hadSlash || FILE_LIKE.test(value) || DOTFILE_LIKE.test(value);
    if (!pathLike) continue;
    if (!hadSlash && !value.startsWith(".")) {
      const dot = value.lastIndexOf(".");
      const base = value.slice(0, dot);
      const ext = value.slice(dot + 1);
      if (base.length <= 1 && ext.length <= 1) continue; // `e.g`, `i.e`
    }
    if (seen.has(value)) continue;
    seen.add(value);
    refs.push(value);
    if (refs.length >= MAX_SCOPE_REFS) break;
  }
  return refs;
}

// ---------------------------------------------------------------------------------------------
// Target selection (§6.2 step 2)
// ---------------------------------------------------------------------------------------------

export interface PickedTarget {
  kind: SignatureTarget;
  /** Command text (≤ 4,000 chars), repository-relative path, URL or JSON digest (≤ 2,000 chars). */
  target: string | null;
  scopeRefs: string[];
  /** Canonical program token for commands (`pm test`, `git`), null for other tools. */
  programToken: string | null;
}

export interface PickTargetOptions {
  dialect?: ShellDialect | null;
  /** Project root used to make absolute paths repository-relative. */
  root?: string;
}

function readString(input: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function digestJson(value: unknown): string | null {
  try {
    const json = JSON.stringify(value);
    if (json === undefined) return null;
    return json.length > HOOK_IO_LIMITS.mcp_input_chars ? json.slice(0, HOOK_IO_LIMITS.mcp_input_chars) : json;
  } catch {
    return null;
  }
}

/**
 * bash → `command`; edit/write/read/glob/grep → `file_path` | `path` | `notebook_path`; fetch → `url`;
 * mcp/task/other → `JSON.stringify(input).slice(0, 2000)` as `any`.
 */
export function pickTarget(canonical: CanonicalTool, toolInput: unknown, options: PickTargetOptions = {}): PickedTarget {
  const input = asRecord(toolInput);
  const family = toolFamily(canonical);

  switch (family) {
    case "bash": {
      const command = readString(input, ["command", "cmd", "script"]);
      if (command === null) return { kind: "command", target: null, scopeRefs: [], programToken: null };
      const target = command.length > HOOK_IO_LIMITS.target_chars ? command.slice(0, HOOK_IO_LIMITS.target_chars) : command;
      return {
        kind: "command",
        target,
        scopeRefs: extractScopeRefs(command, options.root),
        programToken: primaryProgramToken(command, options.dialect ?? null),
      };
    }
    case "edit":
    case "write":
    case "read":
    case "glob":
    case "grep": {
      const path = readString(input, ["file_path", "path", "notebook_path", "filePath", "file"]);
      if (path === null) return { kind: "path", target: null, scopeRefs: [], programToken: null };
      let target = normalizeSlashes(path.trim());
      if (isAbsoluteLike(target)) {
        const relative = relativizeToRoot(target, options.root);
        if (relative !== null) target = relative;
      } else {
        target = target.replace(/^(\.\/)+/, "");
      }
      return { kind: "path", target, scopeRefs: extractScopeRefs(path, options.root), programToken: null };
    }
    case "fetch": {
      const url = readString(input, ["url", "uri"]);
      return { kind: "url", target: url, scopeRefs: [], programToken: null };
    }
    case "mcp":
    case "task":
    case "other": {
      const digest = digestJson(toolInput);
      return { kind: "any", target: digest, scopeRefs: digest === null ? [] : extractScopeRefs(digest, options.root), programToken: null };
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Tool globs
// ---------------------------------------------------------------------------------------------

function escapeRegex(value: string): string {
  return value.replace(/[.+?^${}()|[\]\\/]/g, "\\$&");
}

/**
 * Tool glob over canonical names: `*`, alternatives `a|b`, prefix globs like `mcp:server/*`, exact
 * names; the bare family `mcp` matches every `mcp:<server>/<tool>`.
 */
export function toolGlobMatches(pattern: string, canonical: string): boolean {
  const tool = canonical.trim().toLowerCase();
  for (const rawAlternative of pattern.split("|")) {
    const alternative = rawAlternative.trim().toLowerCase();
    if (alternative.length === 0) continue;
    if (alternative === "*" || alternative === tool) return true;
    if (alternative === "mcp" && tool.startsWith("mcp:")) return true;
    if (alternative.includes("*")) {
      const source = `^${alternative.split("*").map(escapeRegex).join(".*")}$`;
      if (new RegExp(source).test(tool)) return true;
    }
  }
  return false;
}

/** Canonical families a tool glob can resolve to (used by V11 reachability). */
export function toolGlobFamilies(pattern: string): string[] {
  const families = new Set<string>();
  for (const rawAlternative of pattern.split("|")) {
    const alternative = rawAlternative.trim().toLowerCase();
    if (alternative.length === 0) continue;
    if (alternative === "mcp" || alternative.startsWith("mcp:")) {
      families.add("mcp");
      continue;
    }
    for (const family of CANONICAL_TOOL_FAMILIES) {
      const probe = family === "mcp" ? "mcp:server/tool" : family;
      if (toolGlobMatches(alternative, probe)) families.add(family);
    }
  }
  return CANONICAL_TOOL_FAMILIES.filter((family) => families.has(family));
}
