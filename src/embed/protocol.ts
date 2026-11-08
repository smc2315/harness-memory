/**
 * Wire protocol between the `prompt` hook and the idle-exit embedding helper (implementation plan
 * §4 B2): newline-delimited JSON over a Windows named pipe / POSIX socket. One request per line, one
 * response per line; the client closes the connection after the first answer.
 */

export const EMBED_PROTOCOL_VERSION = 1;

export type EmbedOp = "ping" | "topk" | "embed";

export interface EmbedRequest {
  op: EmbedOp;
  text?: string;
  k?: number;
}

export interface EmbedResponse {
  ok: boolean;
  ids?: string[];
  scores?: number[];
  vector?: number[];
  model?: string;
  dims?: number;
  rows?: number;
  error?: string;
}

/** Hook-side wait for an answer; the helper is warm after its first request, cold starts return null. */
export const EMBED_CLIENT_TIMEOUT_MS = 30;
/** `locks/embed-helper.spawn` younger than this suppresses another detached spawn. */
export const EMBED_SPAWN_INTERVAL_MS = 60_000;
export const EMBED_MAX_TEXT_CHARS = 4_000;
export const EMBED_MAX_K = 50;

export function encodeMessage(message: EmbedRequest | EmbedResponse): string {
  return `${JSON.stringify(message)}\n`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseRequest(line: string): EmbedRequest | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const op = parsed.op;
  if (op !== "ping" && op !== "topk" && op !== "embed") return null;
  const request: EmbedRequest = { op };
  if (typeof parsed.text === "string") request.text = parsed.text.slice(0, EMBED_MAX_TEXT_CHARS);
  if (typeof parsed.k === "number" && Number.isFinite(parsed.k)) request.k = Math.max(1, Math.min(EMBED_MAX_K, Math.floor(parsed.k)));
  return request;
}

export function parseResponse(line: string): EmbedResponse | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || typeof parsed.ok !== "boolean") return null;
  const response: EmbedResponse = { ok: parsed.ok };
  if (Array.isArray(parsed.ids)) response.ids = parsed.ids.filter((id): id is string => typeof id === "string");
  if (Array.isArray(parsed.scores)) response.scores = parsed.scores.filter((score): score is number => typeof score === "number");
  if (Array.isArray(parsed.vector)) response.vector = parsed.vector.filter((value): value is number => typeof value === "number");
  if (typeof parsed.model === "string") response.model = parsed.model;
  if (typeof parsed.dims === "number") response.dims = parsed.dims;
  if (typeof parsed.rows === "number") response.rows = parsed.rows;
  if (typeof parsed.error === "string") response.error = parsed.error;
  return response;
}
