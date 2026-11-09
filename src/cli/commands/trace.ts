/**
 * `hm trace <session_key> [--limit <n>] [--host <h>]` (spec §11): the ledger timeline of one session —
 * every line of `ledger/<host>-<key>.jsonl` grouped by turn, the session state file and the episodes the
 * worker made from it. The ledger is the only input the hooks write, so this is the audit trail for
 * "why did that fire / why was nothing learned".
 */

import { existsSync, statSync } from "node:fs";
import type { Database as SqlJsDatabase } from "sql.js";

import type { LedgerLine, SessionState } from "../../core/ledger-types";
import { EXIT_CODES } from "../../core/errors";
import { HOSTS, type Host } from "../../core/vocabulary";
import { readSessionState } from "../../adapters/session-state";
import { EpisodeRepository, type EpisodeRecord } from "../../db/repositories/episodes";
import { readLedgerRangeLines, type OffsetLedgerLine } from "../../dream/ledger";
import type { CommandContext } from "../context";
import { flagNumber, flagString, type OptionSpecs } from "../lib/args";
import { guard, usageError } from "../lib/cli-error";
import { openStore } from "../lib/db-access";
import { shortId } from "../lib/lookup";
import { clip } from "../lib/memory-render";
import { parseEnum, requirePositional } from "../lib/options";
import { resolveSessionRef } from "../lib/session-ref";

export const traceOptions: OptionSpecs = {
  limit: { type: "number", description: "Only the last <n> ledger lines", placeholder: "<n>" },
  host: { type: "string", description: "Host the key belongs to when ambiguous (default claude-code)", placeholder: "<h>" },
};

export interface TraceReport {
  host: Host;
  session_key: string;
  file: string;
  bytes: number;
  bad_lines: number;
  state: SessionState | null;
  lines: OffsetLedgerLine[];
  total_lines: number;
  episodes: EpisodeRecord[];
}

export function describeLedgerLine(line: LedgerLine): string {
  switch (line.kind) {
    case "prompt":
      return `prompt${line.correction === 1 ? " [correction]" : ""}${line.remember === 1 ? " [remember]" : ""}: ${clip(line.text, 110)}`;
    case "fired":
      return `fired ${line.tool} ${line.decision}/${line.enforcement ?? "-"} ${line.delivery} memories [${line.memory_ids.map(shortId).join(", ")}]${line.rule_codes.length > 0 ? ` rules [${line.rule_codes.join(", ")}]` : ""} ${clip(line.target_digest, 60)}`;
    case "tool_ok":
      return `tool_ok ${line.tool}${line.shell_dialect === null ? "" : `(${line.shell_dialect})`}: ${clip(line.input_digest, 90)}${line.resolution_of === null ? "" : `  resolves ${line.resolution_of}`}`;
    case "tool_fail":
      return `tool_fail ${line.tool}${line.shell_dialect === null ? "" : `(${line.shell_dialect})`}: ${clip(line.input_digest, 70)}  ${line.failure_class}: ${clip(line.error, 80)}`;
    case "assistant":
      return `assistant${line.stop_hook_active === true ? " [stop_hook_active]" : ""}: ${clip(line.text, 110)}`;
    case "marker":
      return `marker ${line.marker}${line.detail === undefined ? "" : ` ${clip(line.detail, 80)}`}`;
  }
}

export function renderTrace(report: TraceReport): string[] {
  const lines = [
    `session ${report.host}-${report.session_key}: ${report.file} (${String(report.bytes)} bytes, ${String(report.total_lines)} lines${report.bad_lines > 0 ? `, ${String(report.bad_lines)} unparsable` : ""})`,
  ];
  if (report.state !== null) {
    lines.push(
      `state: session_id ${report.state.session_id} turn ${report.state.turn_key ?? "none"} segment ${String(report.state.segment)} offset ${String(report.state.turn_start_offset)}${report.state.correction_for === undefined ? "" : ` corrects ${shortId(report.state.correction_for)}`}${report.state.last_episode_id === undefined ? "" : ` last episode ${shortId(report.state.last_episode_id)}`}`
    );
  }
  if (report.lines.length < report.total_lines) lines.push(`(showing the last ${String(report.lines.length)} lines)`);
  let turn: string | null = null;
  for (const line of report.lines) {
    if (line.turn_key !== turn) {
      turn = line.turn_key;
      lines.push(`--- turn ${turn} ---`);
    }
    lines.push(`  ${line.ts} @${String(line.offset)}${line.agent_id === undefined ? "" : ` [agent ${line.agent_id}]`} ${describeLedgerLine(line)}`);
  }
  if (report.lines.length === 0) lines.push("  (empty ledger)");
  if (report.episodes.length > 0) {
    lines.push("", `episodes (${String(report.episodes.length)}):`);
    for (const episode of report.episodes) {
      lines.push(`  ${shortId(episode.id)} turn ${episode.turnKey} seg ${String(episode.segment)} ${episode.status}${episode.extractionRunId === null ? "" : ` run ${shortId(episode.extractionRunId)}`} weight ${String(episode.evidenceWeight)} closed ${episode.closedAt} (${episode.closeReason})`);
    }
  }
  return lines;
}

async function episodesForSession(ctx: CommandContext, host: Host, sessionId: string | null): Promise<EpisodeRecord[]> {
  if (sessionId === null || !existsSync(ctx.paths.db)) return [];
  try {
    return await openStore(ctx).read((db: SqlJsDatabase, read) => (read.migrationNeeded || read.newerThanCode ? [] : new EpisodeRepository(db).listForSession(host, sessionId)));
  } catch {
    return [];
  }
}

export async function runTrace(ctx: CommandContext): Promise<number> {
  return guard(ctx, async () => {
    const ref = requirePositional(ctx, 0, "session_key");
    const hostRaw = flagString(ctx.args, "host");
    const host = hostRaw === null ? undefined : parseEnum<Host>(hostRaw, HOSTS, "--host");
    const limit = flagNumber(ctx.args, "limit");
    if (limit !== null && (!Number.isInteger(limit) || limit < 1)) throw usageError("--limit must be a positive integer");

    const session = resolveSessionRef(ctx.paths, ref, { host, cwd: ctx.cwd });
    const bytes = statSync(session.ledgerPath).size;
    const parsed = readLedgerRangeLines(session.ledgerPath, 0, bytes);
    const state = readSessionState(session.statePath);
    const episodes = await episodesForSession(ctx, session.host, state?.session_id ?? null);
    const lines = limit === null ? parsed.lines : parsed.lines.slice(-limit);
    const report: TraceReport = {
      host: session.host,
      session_key: session.key,
      file: session.ledgerPath,
      bytes,
      bad_lines: parsed.badLines,
      state,
      lines,
      total_lines: parsed.lines.length,
      episodes,
    };
    ctx.out.result(report, renderTrace);
    return EXIT_CODES.ok;
  });
}
