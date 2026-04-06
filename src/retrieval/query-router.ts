export type QueryMode = "default" | "temporal" | "cross_session";

const TEMPORAL_QUERY_PATTERN =
  /\b(when|changed|before|after|history|evolution|switched|timeline|순서|변경|이전|이후)\b/i;
const CROSS_SESSION_QUERY_PATTERN =
  /\b(across sessions?|different sessions?|always|every time|consistently|매번|항상)\b/i;

export function classifyQueryType(text: string): QueryMode {
  if (TEMPORAL_QUERY_PATTERN.test(text)) {
    return "temporal";
  }

  if (CROSS_SESSION_QUERY_PATTERN.test(text)) {
    return "cross_session";
  }

  return "default";
}
