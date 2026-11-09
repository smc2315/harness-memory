/**
 * Claude Code hook registration (spec §8.2, §8.7; m0-facts #10, #15). Builds the per-event entries,
 * merges them idempotently into a settings file (`.claude/settings.local.json` or `~/.claude/settings.json`)
 * and strips them again on uninstall. Entries are recognised as ours by shape — a command whose script
 * is `hook.js` followed by one of our event words — so a moved package or an older install is replaced,
 * while every other hook in the file is preserved byte for byte.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { resolveClaudeBinary } from "../../core/process";
import { HOOK_EVENTS, type HookEvent } from "../../core/vocabulary";
import { CLAUDE_CODE_EVENT_NAMES } from "../../adapters/hosts/claude-code";

export type HookForm = "exec" | "shell";
export type HookShell = "bash" | "powershell";

/** Exec-form `{command, args}` hooks need at least this Claude Code version (m0-facts #10, inference). */
export const EXEC_FORM_MIN_VERSION = "2.1.139";

export interface HookRegistration {
  event: HookEvent;
  claudeEvent: string;
  matcher: string | null;
  /** Seconds (Claude Code's unit). */
  timeout: number;
}

/** §8.2 table: matchers and timeouts per event; `Interrupt` is Codex-only and not registered. */
export const HOOK_REGISTRATIONS: readonly HookRegistration[] = [
  { event: "session-start", claudeEvent: CLAUDE_CODE_EVENT_NAMES["session-start"], matcher: null, timeout: 10 },
  { event: "prompt", claudeEvent: CLAUDE_CODE_EVENT_NAMES.prompt, matcher: null, timeout: 10 },
  { event: "pre-tool", claudeEvent: CLAUDE_CODE_EVENT_NAMES["pre-tool"], matcher: "Bash|PowerShell|Edit|MultiEdit|Write|NotebookEdit|WebFetch|mcp__.*", timeout: 5 },
  { event: "post-tool", claudeEvent: CLAUDE_CODE_EVENT_NAMES["post-tool"], matcher: ".*", timeout: 5 },
  { event: "post-tool-failure", claudeEvent: CLAUDE_CODE_EVENT_NAMES["post-tool-failure"], matcher: ".*", timeout: 5 },
  { event: "stop", claudeEvent: CLAUDE_CODE_EVENT_NAMES.stop, matcher: null, timeout: 10 },
  { event: "stop-failure", claudeEvent: CLAUDE_CODE_EVENT_NAMES["stop-failure"], matcher: null, timeout: 10 },
  { event: "precompact", claudeEvent: CLAUDE_CODE_EVENT_NAMES.precompact, matcher: "manual|auto", timeout: 10 },
  { event: "session-end", claudeEvent: CLAUDE_CODE_EVENT_NAMES["session-end"], matcher: null, timeout: 1 },
];

export interface HookCommand {
  type: "command";
  command: string;
  args?: string[];
  timeout?: number;
  shell?: HookShell;
}

export interface HookGroup {
  matcher?: string;
  hooks: HookCommand[];
}

export type SettingsObject = Record<string, unknown>;

export interface HookCommandSpec {
  /** Absolute node binary (`process.execPath`), never a bare `node` (nvm/volta moves, npm `.cmd` shims). */
  execPath: string;
  /** Absolute `dist/hook.js`. */
  hookScript: string;
  form: HookForm;
  /**
   * Shell for shell-form entries on Windows (`bash` when Git Bash exists, else `powershell`); null elsewhere.
   * PowerShell gets the call operator (`& "<node>" "<hook.js>" <event>`): a statement that starts with a quoted
   * string only prints it (Claude Code's hooks reference says the same).
   */
  shell: HookShell | null;
}

function quoteForShell(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}

export function buildHookCommand(spec: HookCommandSpec, registration: HookRegistration): HookCommand {
  if (spec.form === "exec") {
    return { type: "command", command: spec.execPath, args: [spec.hookScript, registration.event], timeout: registration.timeout };
  }
  const command: HookCommand = {
    type: "command",
    command: `${spec.shell === "powershell" ? "& " : ""}${quoteForShell(spec.execPath)} ${quoteForShell(spec.hookScript)} ${registration.event}`,
    timeout: registration.timeout,
  };
  if (spec.shell !== null) command.shell = spec.shell;
  return command;
}

export function buildHookGroup(spec: HookCommandSpec, registration: HookRegistration): HookGroup {
  const group: HookGroup = { hooks: [buildHookCommand(spec, registration)] };
  if (registration.matcher !== null) group.matcher = registration.matcher;
  return group;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const HOOK_SCRIPT_PATTERN = /(?:^|[\\/])hook\.(?:js|mjs|cjs)$/i;
const EVENT_WORDS = new Set<string>(HOOK_EVENTS);

/**
 * True for a hook entry harness-memory wrote: exec form `args = ["…/hook.js", "<event>"]`, or shell form
 * `"<node>" "…/hook.js" <event>` (PowerShell: `& "<node>" …`). The event word is what distinguishes it from
 * someone else's `hook.js`.
 */
export function isHarnessHookCommand(value: unknown): value is HookCommand {
  if (!isRecord(value) || value.type !== "command") return false;
  const args = value.args;
  if (Array.isArray(args)) {
    if (args.length < 2) return false;
    const script = args[0];
    const event = args[args.length - 1];
    return typeof script === "string" && HOOK_SCRIPT_PATTERN.test(script) && typeof event === "string" && EVENT_WORDS.has(event);
  }
  if (typeof value.command !== "string") return false;
  const match = value.command.match(/hook\.(?:js|mjs|cjs)["']?\s+([a-z-]+)\s*$/i);
  return match !== null && EVENT_WORDS.has(match[1]!);
}

export interface HarnessHookEntry {
  claudeEvent: string;
  matcher: string | null;
  command: HookCommand;
  /** Event word carried by the entry (`pre-tool`), when recognisable. */
  event: HookEvent | null;
  /** Script path carried by the entry (`…/dist/hook.js`), when recognisable. */
  script: string | null;
  /** Node binary the entry runs (exec form: `command`; shell form: the first quoted token). */
  node: string | null;
}

function eventOf(command: HookCommand): HookEvent | null {
  const candidate = Array.isArray(command.args) ? command.args[command.args.length - 1] : command.command.match(/\s([a-z-]+)\s*$/)?.[1];
  return typeof candidate === "string" && EVENT_WORDS.has(candidate) ? (candidate as HookEvent) : null;
}

function scriptOf(command: HookCommand): string | null {
  if (Array.isArray(command.args)) return typeof command.args[0] === "string" ? command.args[0] : null;
  const match = command.command.match(/"([^"]*hook\.(?:js|mjs|cjs))"/i) ?? command.command.match(/(\S*hook\.(?:js|mjs|cjs))/i);
  return match === null ? null : match[1]!;
}

function nodeOf(command: HookCommand): string | null {
  if (Array.isArray(command.args)) return command.command;
  const match = command.command.match(/^(?:&\s+)?"([^"]+)"/) ?? command.command.match(/^(?:&\s+)?(\S+)/);
  return match === null ? null : match[1]!;
}

/** Every harness-memory entry found in `settings.hooks`, across all events. */
export function listHarnessHooks(settings: SettingsObject): HarnessHookEntry[] {
  const hooks = settings.hooks;
  if (!isRecord(hooks)) return [];
  const found: HarnessHookEntry[] = [];
  for (const [claudeEvent, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (!isRecord(group) || !Array.isArray(group.hooks)) continue;
      for (const command of group.hooks) {
        if (!isHarnessHookCommand(command)) continue;
        found.push({
          claudeEvent,
          matcher: typeof group.matcher === "string" ? group.matcher : null,
          command,
          event: eventOf(command),
          script: scriptOf(command),
          node: nodeOf(command),
        });
      }
    }
  }
  return found;
}

export interface StripResult {
  settings: SettingsObject;
  removed: number;
}

/** Removes every harness-memory entry; empty groups and an empty `hooks` object disappear with them. */
export function stripHarnessHooks(settings: SettingsObject): StripResult {
  const next: SettingsObject = { ...settings };
  const hooks = settings.hooks;
  if (!isRecord(hooks)) return { settings: next, removed: 0 };
  let removed = 0;
  const nextHooks: Record<string, unknown> = {};
  for (const [claudeEvent, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) {
      nextHooks[claudeEvent] = groups;
      continue;
    }
    const keptGroups: unknown[] = [];
    for (const group of groups) {
      if (!isRecord(group) || !Array.isArray(group.hooks)) {
        keptGroups.push(group);
        continue;
      }
      const keptHooks = group.hooks.filter((command) => {
        const ours = isHarnessHookCommand(command);
        if (ours) removed += 1;
        return !ours;
      });
      if (keptHooks.length === 0) continue;
      keptGroups.push({ ...group, hooks: keptHooks });
    }
    if (keptGroups.length > 0) nextHooks[claudeEvent] = keptGroups;
  }
  if (Object.keys(nextHooks).length === 0) delete next.hooks;
  else next.hooks = nextHooks;
  return { settings: next, removed };
}

export interface MergeResult {
  settings: SettingsObject;
  /** Harness entries that were replaced (an earlier install). */
  replaced: number;
  /** Entries written by this merge. */
  written: number;
}

/** Strip, then append one group per registration at the end of each event's list (deterministic order). */
export function mergeHarnessHooks(settings: SettingsObject, spec: HookCommandSpec, registrations: readonly HookRegistration[] = HOOK_REGISTRATIONS): MergeResult {
  const stripped = stripHarnessHooks(settings);
  const hooks: Record<string, unknown> = isRecord(stripped.settings.hooks) ? { ...stripped.settings.hooks } : {};
  for (const registration of registrations) {
    const existing = hooks[registration.claudeEvent];
    const groups = Array.isArray(existing) ? [...existing] : [];
    groups.push(buildHookGroup(spec, registration));
    hooks[registration.claudeEvent] = groups;
  }
  return { settings: { ...stripped.settings, hooks }, replaced: stripped.removed, written: registrations.length };
}

export interface SettingsFile {
  settings: SettingsObject;
  existed: boolean;
}

export class SettingsParseError extends Error {
  constructor(
    public readonly file: string,
    cause: string
  ) {
    super(`${file} is not a JSON object (${cause}); fix or move it before installing`);
    this.name = "SettingsParseError";
  }
}

/** Missing file → `{}`; invalid JSON throws SettingsParseError (we never clobber a file we cannot parse). */
export function readSettingsFile(file: string): SettingsFile {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return { settings: {}, existed: false };
  }
  if (raw.trim().length === 0) return { settings: {}, existed: true };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new SettingsParseError(file, error instanceof Error ? error.message : String(error));
  }
  if (!isRecord(parsed)) throw new SettingsParseError(file, "top level is not an object");
  return { settings: parsed, existed: true };
}

export function serializeSettings(settings: SettingsObject): string {
  return `${JSON.stringify(settings, null, 2)}\n`;
}

/** tmp + rename so a concurrent Claude Code file watcher never sees a half-written file. */
export function writeSettingsFile(file: string, settings: SettingsObject): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${String(process.pid)}`;
  writeFileSync(tmp, serializeSettings(settings), "utf8");
  renameSync(tmp, file);
}

export function compareVersions(left: string, right: string): number {
  const parse = (value: string): number[] => (value.match(/\d+/g) ?? []).map((part) => Number(part));
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const delta = (a[index] ?? 0) - (b[index] ?? 0);
    if (delta !== 0) return delta < 0 ? -1 : 1;
  }
  return 0;
}

export type VersionDetector = () => string | null;

export interface VersionSpawn {
  command: string;
  args: string[];
  shell: boolean;
}

/**
 * How `<binary> --version` is spawned. Directly when possible. Windows `.cmd`/`.bat` shims (an npm install of
 * Claude Code) cannot be spawned without a shell (Node refuses them with EINVAL), so they go to cmd.exe as one
 * quoted command string: never a bare path plus an args array, which cmd.exe would split at the first space
 * (`C:\Program Files\…` runs `C:\Program`) and which Node deprecates (DEP0190).
 */
export function claudeVersionSpawn(binary: string, viaShell: boolean): VersionSpawn {
  return viaShell ? { command: `"${binary}" --version`, args: [], shell: true } : { command: binary, args: ["--version"], shell: false };
}

export function isWindowsShim(binary: string, platform: NodeJS.Platform = process.platform): boolean {
  return platform === "win32" && /\.(?:cmd|bat)$/i.test(binary);
}

/** `claude --version` → `2.1.172`; null when the binary is missing or does not answer within 5 s. */
export function detectClaudeVersion(): string | null {
  const binary = resolveClaudeBinary();
  if (binary === null) return null;
  const spawn = claudeVersionSpawn(binary, isWindowsShim(binary));
  try {
    const run = spawnSync(spawn.command, spawn.args, { encoding: "utf8", timeout: 5_000, windowsHide: true, shell: spawn.shell });
    const text = `${run.stdout ?? ""}\n${run.stderr ?? ""}`;
    const match = text.match(/(\d+\.\d+\.\d+)/);
    return match === null ? null : match[1]!;
  } catch {
    return null;
  }
}

/** `auto`: exec form unless the detected version is older than EXEC_FORM_MIN_VERSION (unknown → exec, m0-facts #10). */
export function chooseHookForm(version: string | null, override: HookForm | "auto" = "auto"): HookForm {
  if (override !== "auto") return override;
  if (version === null) return "exec";
  return compareVersions(version, EXEC_FORM_MIN_VERSION) >= 0 ? "exec" : "shell";
}

/** Git Bash on Windows (Claude Code's `Bash` tool needs it; without it the host uses `PowerShell`). */
export function findGitBash(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | null {
  if (platform !== "win32") return null;
  const explicit = env.CLAUDE_CODE_GIT_BASH_PATH;
  if (explicit !== undefined && explicit.length > 0 && existsSync(explicit)) return explicit;
  const roots = [env.ProgramFiles, env["ProgramFiles(x86)"], env.ProgramW6432, env.LOCALAPPDATA === undefined ? undefined : join(env.LOCALAPPDATA, "Programs")]
    .filter((value): value is string => typeof value === "string" && value.length > 0);
  for (const root of roots) {
    for (const candidate of [join(root, "Git", "bin", "bash.exe"), join(root, "Git", "usr", "bin", "bash.exe")]) {
      if (existsSync(candidate)) return candidate;
    }
  }
  const pathValue = env.PATH ?? env.Path ?? "";
  for (const dir of pathValue.split(";")) {
    if (dir.length === 0 || /system32/i.test(dir)) continue;
    const candidate = join(dir, "bash.exe");
    if (existsSync(candidate)) return candidate;
  }
  return null;
}
