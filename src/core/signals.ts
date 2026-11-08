/**
 * Deterministic signal detection shared by the hooks (capture) and tests.
 *
 * These regexes only set FLAGS on ledger lines and episodes (correction, remember, decision marker)
 * and redact credentials before anything is written. They never create memory text (v0.5 R6).
 * Korean patterns avoid `\b`, which does not work for Hangul in JavaScript regexes.
 */

const CORRECTION_PATTERN =
  /(^|[^a-z])(don'?t|do not|never|instead|wrong|revert|undo that|not like that|stop (doing|using))([^a-z]|$)|아니(야|요|라|고|지|에요|예요)|하지 ?마|말고|대신|틀렸|되돌려|그게 아니|잘못/i;

const REMEMBER_ANYWHERE_PATTERN = /remember|from now on|going forward|기억|앞으로|절대/i;

/** `always` / `항상` count only at the start of a sentence or when paired with another cue. */
const ALWAYS_PATTERN = /(^|[.!?\n]\s*)(always|항상)([^a-z]|$)/i;
const ALWAYS_ANYWHERE_PATTERN = /always|항상/i;

const DECISION_MARKER_PATTERN =
  /(^|[^a-z])(decided|we'?ll use|we will use|switch(ed|ing)? to|going with|let'?s use|from now on)([^a-z]|$)|결정|이제부터|전환|하기로/i;

export function detectCorrection(text: string): boolean {
  return CORRECTION_PATTERN.test(text);
}

export function detectRemember(text: string): boolean {
  if (REMEMBER_ANYWHERE_PATTERN.test(text)) {
    return true;
  }
  if (ALWAYS_PATTERN.test(text)) {
    return true;
  }
  return ALWAYS_ANYWHERE_PATTERN.test(text) && detectCorrection(text);
}

export function detectDecisionMarker(text: string): boolean {
  return DECISION_MARKER_PATTERN.test(text);
}

interface RedactionPattern {
  readonly name: string;
  readonly regex: RegExp;
}

/** Credential shapes removed from ledger lines before they are written (§5.1). */
export const REDACTION_PATTERNS: readonly RedactionPattern[] = [
  { name: "private_key", regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { name: "anthropic_key", regex: /sk-ant-[A-Za-z0-9_-]{16,}/g },
  { name: "openai_key", regex: /sk-[A-Za-z0-9_-]{20,}/g },
  { name: "github_token", regex: /gh[pousr]_[A-Za-z0-9]{20,}/g },
  { name: "aws_access_key", regex: /AKIA[0-9A-Z]{16}/g },
  { name: "slack_token", regex: /xox[baprs]-[A-Za-z0-9-]{10,}/g },
  { name: "google_api_key", regex: /AIza[0-9A-Za-z_-]{35}/g },
  { name: "jwt", regex: /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  { name: "bearer", regex: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/gi },
  { name: "url_credentials", regex: /(https?:\/\/)[^\s/:@]+:[^\s/@]+@/gi },
  {
    name: "assignment",
    regex: /\b(password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret)(\s*[=:]\s*)(["']?)[^\s"'&;,]{6,}\3/gi,
  },
];

export const REDACTED = "<redacted>";

export function redactCredentials(text: string): string {
  let output = text;
  for (const { name, regex } of REDACTION_PATTERNS) {
    regex.lastIndex = 0;
    if (name === "url_credentials") {
      output = output.replace(regex, `$1${REDACTED}@`);
    } else if (name === "assignment") {
      output = output.replace(regex, `$1$2${REDACTED}`);
    } else {
      output = output.replace(regex, REDACTED);
    }
  }
  return output;
}
