/**
 * Per-session files the hooks own (spec §3.2, §5.2, §9.1): `state/<host>-<key>.json` (tmp + rename,
 * written only by the host-serialized hooks), `queue/<episode_id>.json` (tmp + rename) and the
 * worker → prompt notification `state/<host>-<key>.notify.json` (consumed by the next prompt hook).
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { EpisodeDescriptor } from "../core/episode-types";
import type { NotifyFile, SessionState } from "../core/ledger-types";
import { queueFile, type HarnessPaths } from "../core/paths";
import type { Host } from "../core/vocabulary";

export const STATE_SCHEMA = "state.v1";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isSessionState(value: unknown): value is SessionState {
  return (
    isRecord(value) &&
    value.schema === STATE_SCHEMA &&
    typeof value.host === "string" &&
    typeof value.session_id === "string" &&
    typeof value.session_key === "string" &&
    (value.turn_key === null || typeof value.turn_key === "string") &&
    typeof value.turn_start_offset === "number" &&
    typeof value.segment === "number"
  );
}

/** Null when the file is missing or not a valid state file (a corrupt state is treated as "no open turn"). */
export function readSessionState(file: string): SessionState | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    return isSessionState(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** tmp + rename so a parallel reader never sees a torn file. */
export function writeJsonAtomic(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(value), "utf8");
  try {
    renameSync(tmp, file);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      // nothing else to clean
    }
    throw error;
  }
}

export function writeSessionState(file: string, state: SessionState): void {
  writeJsonAtomic(file, state);
}

export function createSessionState(host: Host, sessionId: string, sessionKey: string, now: string): SessionState {
  return {
    schema: STATE_SCHEMA,
    host,
    session_id: sessionId,
    session_key: sessionKey,
    turn_key: null,
    turn_start_offset: 0,
    segment: 0,
    updated_at: now,
  };
}

/** Writes `queue/<episode_id>.json` atomically and returns its path. */
export function writeQueueFile(paths: Pick<HarnessPaths, "queueDir">, descriptor: EpisodeDescriptor): string {
  const file = queueFile(paths as HarnessPaths, descriptor.id);
  writeJsonAtomic(file, descriptor);
  return file;
}

/** True when `queue/` holds at least one descriptor file. */
export function queueHasFiles(paths: Pick<HarnessPaths, "queueDir">): boolean {
  try {
    return readdirSync(paths.queueDir).some((name) => name.endsWith(".json"));
  } catch {
    return false;
  }
}

/** Reads and deletes the notify file; returns its messages (empty when absent or malformed). */
export function consumeNotify(file: string): string[] {
  let messages: string[] = [];
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (isRecord(parsed) && parsed.schema === "notify.v1" && Array.isArray(parsed.messages)) {
      const notify = parsed as unknown as NotifyFile;
      messages = notify.messages.filter((message): message is string => typeof message === "string");
    }
  } catch {
    return [];
  }
  try {
    unlinkSync(file);
  } catch {
    // a parallel reader may have removed it already
  }
  return messages;
}

export function ledgerSize(file: string): number {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
}

/** `state/*.json` session files (not the `.notify.json` companions). */
export function listStateFiles(stateDir: string): string[] {
  if (!existsSync(stateDir)) return [];
  try {
    return readdirSync(stateDir)
      .filter((name) => name.endsWith(".json") && !name.endsWith(".notify.json"))
      .map((name) => join(stateDir, name));
  } catch {
    return [];
  }
}

/** Directories a hook touches; created lazily so a fresh install never fails on a missing folder. */
export function ensureHookDirectories(paths: Pick<HarnessPaths, "ledgerDir" | "stateDir" | "queueDir" | "logsDir">): void {
  for (const dir of [paths.ledgerDir, paths.stateDir, paths.queueDir, paths.logsDir]) {
    try {
      mkdirSync(dir, { recursive: true });
    } catch {
      // a later write reports the real error
    }
  }
}
