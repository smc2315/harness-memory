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
  /** Replacement template; `$1` keeps the non-secret part (key, scheme, flag). Defaults to the bare marker. */
  readonly replacement?: string;
}

export const REDACTED = "<redacted>";

/**
 * Key boundary shared with the memory scanner (src/security/scanner.ts): a credential keyword may start
 * an identifier or follow `_`, `-`, a quote or whitespace (`DB_PASSWORD`, `"password"`, `x-api-key`),
 * never another letter or digit (`tokenizer`, `OLDPWD`). `\b` cannot express this because `_` is a word
 * character, which is why `AWS_SECRET_ACCESS_KEY=…` used to pass through unredacted.
 */
export const CREDENTIAL_KEY_BOUNDARY = "(?<![A-Za-z0-9])";

/** `_SEGMENT` suffixes (`SECRET_ACCESS_KEY`), an optional closing quote of a JSON/YAML key, then `=` or `:`. */
export const CREDENTIAL_KEY_TAIL = `(?:[_-][A-Za-z0-9]+)*["']?\\s*[=:]\\s*`;

/** `$VAR`, `${VAR}` and `$(cmd)` are references to a secret, not the secret itself. */
export const CREDENTIAL_VALUE_NOT_REFERENCE = String.raw`(?!\$[{(A-Za-z_])`;

/** Keywords of the ledger redactor. camelCase compounds (`accessToken`) have no `_` boundary, so they are spelled out. */
export const CREDENTIAL_KEYWORDS =
  "password|passwd|pwd|secret(?:[_-]?key)?|(?:access|refresh|auth|id|session|api|csrf|xsrf|bearer)?[_-]?token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|signing[_-]?key|encryption[_-]?key";

/** Regex source matching `<key><sep>` for a keyword alternation: `DB_PASSWORD=`, `"password": `, `x-api-key:`. */
export function credentialKeySource(keywords: string): string {
  return `${CREDENTIAL_KEY_BOUNDARY}(?:${keywords})${CREDENTIAL_KEY_TAIL}`;
}

/**
 * Credential shapes removed from ledger lines before they are written (§5.1). Value-shaped tokens first,
 * then URL / header / CLI forms, then the generic `<key> = <value>` assignment (last, so a redacted URL
 * keeps its host). Every pattern is linear in the input: redaction runs on the raw text before clipping.
 */
export const REDACTION_PATTERNS: readonly RedactionPattern[] = [
  { name: "private_key", regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { name: "anthropic_key", regex: /sk-ant-[A-Za-z0-9_-]{16,}/g },
  { name: "openai_key", regex: /sk-[A-Za-z0-9_-]{20,}/g },
  { name: "stripe_key", regex: /(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g },
  { name: "github_token", regex: /gh[pousr]_[A-Za-z0-9]{20,}/g },
  { name: "github_fine_grained_token", regex: /github_pat_[A-Za-z0-9_]{20,}/g },
  { name: "gitlab_token", regex: /glpat-[A-Za-z0-9_-]{20,}/g },
  { name: "npm_token", regex: /npm_[A-Za-z0-9]{36}/g },
  { name: "aws_access_key", regex: /AKIA[0-9A-Z]{16}/g },
  { name: "slack_token", regex: /xox[baprs]-[A-Za-z0-9-]{10,}/g },
  { name: "slack_app_token", regex: /xapp-[0-9]-[A-Za-z0-9-]{10,}/g },
  { name: "google_api_key", regex: /AIza[0-9A-Za-z_-]{35}/g },
  { name: "jwt", regex: /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  { name: "bearer", regex: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/gi },
  { name: "basic_auth_header", regex: /(authorization\s*[:=]\s*["']?basic\s+)[A-Za-z0-9+/=_-]{8,}/gi, replacement: `$1${REDACTED}` },
  // Any scheme (`postgres://`, `mongodb+srv://`, `redis://:pw@`), not only http(s). The scheme is anchored
  // and bounded so a long alphanumeric run cannot make the scan quadratic.
  {
    name: "url_credentials",
    regex: /((?<![A-Za-z0-9+.-])[a-z][a-z0-9+.-]{0,30}:\/\/)[^\s/:@]*:[^\s/@]+@/gi,
    replacement: `$1${REDACTED}@`,
  },
  // `curl -u user:pass`, `--user user:pass`; a 2-char minimum user part leaves `-u C:\path` alone.
  { name: "cli_user_password", regex: /((?:^|\s)(?:-u|--user)(?:=|\s+))[^\s:@/\\]{2,}:[^\s@/\\][^\s@]*/g, replacement: `$1${REDACTED}` },
  { name: "cli_password_flag", regex: /(--password\s+)(["']?)(?!-)[^\s"']{6,}\2/g, replacement: `$1${REDACTED}` },
  { name: "mysql_password_flag", regex: /(\bmysql\w*\b[^\n\r]{0,200}?\s-p)[^\s-]\S{5,}/g, replacement: `$1${REDACTED}` },
  {
    name: "assignment",
    regex: new RegExp(`(${credentialKeySource(CREDENTIAL_KEYWORDS)})(["']?)${CREDENTIAL_VALUE_NOT_REFERENCE}[^\\s"'&;,]{6,}\\2`, "gi"),
    replacement: `$1${REDACTED}`,
  },
];

export function redactCredentials(text: string): string {
  let output = text;
  for (const { regex, replacement } of REDACTION_PATTERNS) {
    regex.lastIndex = 0;
    output = output.replace(regex, replacement ?? REDACTED);
  }
  return output;
}
