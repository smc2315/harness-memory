/**
 * What every `hm` command receives: parsed arguments, the resolved project paths and config, the
 * printer (text or `--json`), process facts (cwd, env, node binary) and the seams tests replace
 * (version detection, npm, hook self-test, extraction provider).
 */

import type { HarnessConfig } from "../core/config";
import type { HarnessPaths } from "../core/paths";
import type { ExtractionProvider } from "../dream/extract/providers/types";
import type { ParsedArgs } from "./lib/args";
import type { Printer } from "./lib/output";
import type { SelfTestOptions, SelfTestResult } from "./lib/selftest";

export interface NpmRunResult {
  ok: boolean;
  output: string;
}

export interface CliSeams {
  /** `claude --version` → "2.1.172" | null. */
  detectClaudeVersion?: () => string | null;
  /** Git Bash location on Windows (null elsewhere / when absent). */
  findGitBash?: () => string | null;
  /** Absolute `dist/hook.js` to register (default: the one next to this bundle). */
  hookScript?: string;
  /** Runs the hook once; return null to report "skipped". */
  selfTest?: (options: SelfTestOptions) => SelfTestResult | null;
  /** `npm install …` in the package root (`--with-embeddings`). */
  runNpm?: (args: readonly string[], cwd: string) => NpmRunResult;
  /** Extraction provider for the install probe; `undefined` → selectProvider(config), `null` → none. */
  provider?: ExtractionProvider | null;
  /** Wall clock in ms for relative times (default Date.now). */
  nowMs?: () => number;
}

export interface CommandContext {
  name: string;
  args: ParsedArgs;
  cwd: string;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  /** Node binary this CLI runs on (`process.execPath`); install records it in the hooks. */
  execPath: string;
  json: boolean;
  out: Printer;
  stderr: (text: string) => void;
  isTTY: boolean;
  /** y/N prompt on a TTY; always false when stdin is not a terminal (commands then need `--yes`). */
  confirm: (question: string) => Promise<boolean>;
  clock: () => string;
  nowMs: () => number;
  seams: CliSeams;
  paths: HarnessPaths;
  config: HarnessConfig;
  packageRoot: string | null;
  version: string;
  debug: boolean;
}

export type CommandRunner = (ctx: CommandContext) => Promise<number>;
