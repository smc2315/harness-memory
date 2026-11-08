/**
 * `hm memory:why --tool <name> --target <text> [--input <json>] [--session <key>] [--permission-mode <m>]`
 * (spec §11): runs the hooks' own before_tool decision (`decideBeforeTool`, §6.2 steps 5–9) over the snapshot
 * the hooks read and prints what would fire, what was suppressed and why (signature_mismatch, already_fired,
 * signature_required, scope_mismatch, type_balance_limit, budget_limit …), the policy rules and the host decision.
 * Without a snapshot file the same data is built from the database (read-only) and marked as such.
 */

import { existsSync } from "node:fs";

import { decideBeforeTool, type BeforeToolDecision } from "../../activation/before-tool";
import { compileSnapshotRegexes, readActiveSnapshot, type LoadedSnapshot } from "../../activation/snapshot-reader";
import { canonicalizeHostTool, pickTarget, type PickedTarget } from "../../activation/tool-vocabulary";
import { EXIT_CODES } from "../../core/errors";
import { LEDGER_LIMITS } from "../../core/ledger-types";
import { toolFamily, type CanonicalTool, type ShellDialect } from "../../core/vocabulary";
import { readSessionState } from "../../adapters/session-state";
import { buildSnapshotData } from "../../db/snapshot";
import { deriveTailState, readLedgerTailLines, type TailState } from "../../dream/ledger";
import type { CommandContext } from "../context";
import { flagString, type OptionSpecs } from "../lib/args";
import { guard, usageError } from "../lib/cli-error";
import { readDb } from "../lib/db-access";
import { shortId } from "../lib/lookup";
import { clip } from "../lib/memory-render";
import { resolveSessionRef } from "../lib/session-ref";

export const memoryWhyOptions: OptionSpecs = {
  tool: { type: "string", description: "Host tool name (Bash, Edit, Write, WebFetch, mcp__server__tool …) or canonical (bash, edit, …)", placeholder: "<name>" },
  target: { type: "string", description: "Command text, file path or URL the tool would receive", placeholder: "<text>" },
  input: { type: "string", description: "Raw tool_input JSON instead of --target", placeholder: "<json>" },
  session: { type: "string", description: "Session key: derive fired keys / last scope ref from its ledger tail", placeholder: "<key>" },
  "permission-mode": { type: "string", description: "Claude Code permission_mode (default | bypassPermissions | dontAsk …)", placeholder: "<m>" },
};

export interface MemoryWhyReport {
  tool: { host_name: string; canonical: CanonicalTool; dialect: ShellDialect | null };
  target: PickedTarget;
  tail: { session: string | null; fired_keys: string[]; last_scope_ref: string | null };
  snapshot: { source: "file" | "database"; built_at: string; db_generation: number; memories: number; rules: number };
  decision: BeforeToolDecision;
}

export function synthesizeToolInput(canonical: CanonicalTool, target: string | null): Record<string, unknown> {
  if (target === null) return {};
  switch (toolFamily(canonical)) {
    case "bash":
      return { command: target };
    case "edit":
    case "write":
    case "read":
    case "grep":
    case "glob":
      return { file_path: target };
    case "fetch":
      return { url: target };
    default: {
      try {
        const parsed: unknown = JSON.parse(target);
        if (typeof parsed === "object" && parsed !== null) return parsed as Record<string, unknown>;
      } catch {
        // plain text below
      }
      return { input: target };
    }
  }
}

async function loadSnapshotForWhy(ctx: CommandContext, now: string): Promise<{ loaded: LoadedSnapshot; source: "file" | "database" }> {
  const fromFile = existsSync(ctx.paths.snapshotActive) ? readActiveSnapshot(ctx.paths, { checkStale: false, spawnWorker: null }) : null;
  if (fromFile !== null) return { loaded: fromFile, source: "file" };
  const data = await readDb(ctx, (db) => buildSnapshotData(db, ctx.paths, { now, config: ctx.config }));
  const loaded: LoadedSnapshot = {
    snapshot: data.active,
    compiled: compileSnapshotRegexes(data.active.memories),
    stale: false,
    byId: new Map(data.active.memories.map((memory) => [memory.id, memory])),
  };
  return { loaded, source: "database" };
}

function tailStateFor(ctx: CommandContext, sessionRef: string | null): { tail: Pick<TailState, "firedKeys" | "lastScopeRef">; session: string | null } {
  if (sessionRef === null) return { tail: { firedKeys: new Set<string>(), lastScopeRef: null }, session: null };
  const session = resolveSessionRef(ctx.paths, sessionRef, { cwd: ctx.cwd });
  const state = readSessionState(session.statePath);
  const parsed = readLedgerTailLines(session.ledgerPath, LEDGER_LIMITS.tail_read_bytes);
  const tail = deriveTailState(parsed.lines, { turnStartOffset: state?.turn_start_offset ?? 0 });
  return { tail, session: `${session.host}-${session.key}` };
}

export function renderWhyReport(report: MemoryWhyReport): string[] {
  const d = report.decision;
  const lines = [
    `tool ${report.tool.canonical}${report.tool.dialect === null ? "" : ` (${report.tool.dialect})`} ← ${report.tool.host_name}; target kind ${report.target.kind}: ${report.target.target === null ? "(none)" : clip(report.target.target, 100)}`,
    `scope refs [${report.target.scopeRefs.join(", ")}]${report.target.programToken === null ? "" : `; program ${report.target.programToken}`}${report.tail.session === null ? "" : `; session ${report.tail.session} fired ${String(report.tail.fired_keys.length)} key(s), last scope ref ${report.tail.last_scope_ref ?? "-"}`}`,
    `snapshot from ${report.snapshot.source} (gen ${String(report.snapshot.db_generation)}, ${String(report.snapshot.memories)} active rows, ${String(report.snapshot.rules)} rules)`,
    `decision: ${d.decision}${d.enforcement === null ? "" : ` (${d.enforcement}${d.downgraded ? ", downgraded from confirm" : ""})`} delivery ${d.delivery}`,
  ];
  if (d.reason !== null) lines.push(`  reason: ${clip(d.reason, 300)}`);
  lines.push(`activated (${String(d.activated.length)}):`);
  for (const item of d.activated) {
    lines.push(`  ${shortId(item.id)} ${item.type} ${item.enforcement} ${item.authority}${item.signatureMatched ? " signature" : ` ${item.source}`} score ${item.score.toFixed(2)}  ${clip(item.summary, 90)}`);
  }
  if (d.activated.length === 0) lines.push("  none");
  if (d.rules.length > 0) {
    lines.push(`rules (${String(d.rules.length)}):`);
    for (const rule of d.rules) lines.push(`  ${rule.ruleCode} ${rule.enforcement} ${clip(rule.message, 90)}`);
  }
  lines.push(`suppressed (${String(d.suppressed.length)}):`);
  for (const entry of d.suppressed) lines.push(`  ${shortId(entry.id)} ${entry.kind}: ${clip(entry.reason, 110)}`);
  if (d.suppressed.length === 0) lines.push("  none");
  if (d.additionalContext !== null) {
    lines.push("additionalContext:");
    for (const line of d.additionalContext.split("\n")) lines.push(`  ${line}`);
  }
  if (d.systemMessage !== null) lines.push(`systemMessage: ${d.systemMessage}`);
  return lines;
}

export async function runMemoryWhy(ctx: CommandContext): Promise<number> {
  return guard(ctx, async () => {
    const toolName = flagString(ctx.args, "tool");
    if (toolName === null) throw usageError("--tool is required", "example: hm memory:why --tool Bash --target \"npm test\"");
    const target = flagString(ctx.args, "target");
    const inputRaw = flagString(ctx.args, "input");
    if (target === null && inputRaw === null) throw usageError("--target or --input is required");

    const { canonical, shellDialect } = canonicalizeHostTool("claude-code", toolName);
    let toolInput: Record<string, unknown>;
    if (inputRaw !== null) {
      try {
        const parsed: unknown = JSON.parse(inputRaw);
        if (typeof parsed !== "object" || parsed === null) throw new Error("not an object");
        toolInput = parsed as Record<string, unknown>;
      } catch (error) {
        throw usageError(`--input is not a JSON object: ${error instanceof Error ? error.message : String(error)}`);
      }
    } else {
      toolInput = synthesizeToolInput(canonical, target);
    }
    const picked = pickTarget(canonical, toolInput, { dialect: shellDialect, root: ctx.paths.root });
    const now = ctx.clock();
    const { loaded, source } = await loadSnapshotForWhy(ctx, now);
    const { tail, session } = tailStateFor(ctx, flagString(ctx.args, "session"));
    const decision = decideBeforeTool({
      loaded,
      tailState: tail,
      input: { canonical, dialect: shellDialect, targetKind: picked.kind, target: picked.target, scopeRefs: picked.scopeRefs, permissionMode: flagString(ctx.args, "permission-mode") },
      config: ctx.config,
      now,
    });
    const report: MemoryWhyReport = {
      tool: { host_name: toolName, canonical, dialect: shellDialect },
      target: picked,
      tail: { session, fired_keys: [...tail.firedKeys], last_scope_ref: tail.lastScopeRef },
      snapshot: { source, built_at: loaded.snapshot.built_at, db_generation: loaded.snapshot.db_generation, memories: loaded.snapshot.memories.length, rules: loaded.snapshot.rules.length },
      decision,
    };
    ctx.out.result(report, renderWhyReport);
    return EXIT_CODES.ok;
  });
}
