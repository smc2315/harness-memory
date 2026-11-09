/**
 * Session references for `hm trace` and `hm memory:why --session`: a 16-hex session key, `<host>-<key>`,
 * a ledger file path, or a raw host session id (hashed with core/paths.sessionKey). Resolves to the ledger and
 * state files of that session.
 */

import { existsSync, readdirSync } from "node:fs";
import { basename, resolve } from "node:path";

import { ledgerFile, sessionKey, stateFile, type HarnessPaths } from "../../core/paths";
import { HOSTS, type Host } from "../../core/vocabulary";
import { CliInputError } from "./cli-error";

export interface SessionRef {
  host: Host;
  key: string;
  ledgerPath: string;
  statePath: string;
}

const KEY = /^[0-9a-f]{16}$/i;
const LEDGER_NAME = /^(.+)-([0-9a-f]{16})\.jsonl$/i;

export function listSessionLedgers(paths: Pick<HarnessPaths, "ledgerDir">): Array<{ host: string; key: string; file: string }> {
  try {
    return readdirSync(paths.ledgerDir)
      .map((name) => {
        const match = LEDGER_NAME.exec(name);
        return match === null ? null : { host: match[1]!, key: match[2]!.toLowerCase(), file: name };
      })
      .filter((entry): entry is { host: string; key: string; file: string } => entry !== null)
      .sort((left, right) => left.file.localeCompare(right.file));
  } catch {
    return [];
  }
}

function asHost(value: string, fallback: Host): Host {
  return (HOSTS as readonly string[]).includes(value) ? (value as Host) : fallback;
}

/** Resolves `ref`; when the ledger does not exist the error lists the sessions that do. */
export function resolveSessionRef(paths: HarnessPaths, ref: string, options: { host?: Host; cwd?: string; mustExist?: boolean } = {}): SessionRef {
  const defaultHost: Host = options.host ?? "claude-code";
  const trimmed = ref.trim();
  if (trimmed.length === 0) throw new CliInputError("missing <session_key>", { exitCode: 2 });

  let host: Host = defaultHost;
  let key: string | null = null;

  const fileMatch = LEDGER_NAME.exec(basename(trimmed));
  if (fileMatch !== null && (trimmed.endsWith(".jsonl") || existsSync(resolve(options.cwd ?? process.cwd(), trimmed)))) {
    host = asHost(fileMatch[1]!, defaultHost);
    key = fileMatch[2]!.toLowerCase();
  } else if (KEY.test(trimmed)) {
    key = trimmed.toLowerCase();
  } else {
    const dash = trimmed.lastIndexOf("-");
    const tail = dash === -1 ? "" : trimmed.slice(dash + 1);
    if (dash !== -1 && KEY.test(tail) && (HOSTS as readonly string[]).includes(trimmed.slice(0, dash))) {
      host = trimmed.slice(0, dash) as Host;
      key = tail.toLowerCase();
    }
  }
  if (key === null) key = sessionKey(host, trimmed);

  const resolved: SessionRef = { host, key, ledgerPath: ledgerFile(paths, host, key), statePath: stateFile(paths, host, key) };
  if (options.mustExist !== false && !existsSync(resolved.ledgerPath)) {
    const known = listSessionLedgers(paths);
    const other = known.find((entry) => entry.key === key);
    if (other !== undefined) {
      return { host: asHost(other.host, host), key, ledgerPath: ledgerFile(paths, other.host, key), statePath: stateFile(paths, other.host, key) };
    }
    throw new CliInputError(`no ledger for session ${trimmed} (${resolved.ledgerPath})`, {
      hint: known.length === 0 ? "no sessions recorded yet" : `known sessions: ${known.map((entry) => `${entry.host}-${entry.key}`).join(", ")}`,
    });
  }
  return resolved;
}
