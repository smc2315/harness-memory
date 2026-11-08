import { CREDENTIAL_VALUE_NOT_REFERENCE, credentialKeySource } from "../core/signals";

export interface ScanThreat {
  pattern: string;
  severity: "block" | "warn";
  match: string;
  category: ScanThreatCategory;
}

export type ScanThreatCategory =
  | "invisible_unicode"
  | "prompt_injection"
  | "credential_pattern"
  | "malicious_instruction"
  | "format_anomaly";

export interface ScanResult {
  safe: boolean;
  threats: ScanThreat[];
}

export interface ScanOptions {
  maxContentLength?: number;
}

type ThreatSeverity = ScanThreat["severity"];
type FieldName = "summary" | "details";

interface RegexThreatPattern {
  readonly name: string;
  readonly category: ScanThreatCategory;
  readonly severity: ThreatSeverity;
  readonly regex: RegExp;
}

const DEFAULT_MAX_CONTENT_LENGTH = 50_000;
const MAX_MATCH_LENGTH = 100;

const INVISIBLE_UNICODE_REGEX = /[\u200B\u200C\u200D\uFEFF\u202A-\u202E\u2060\u2066-\u2069\u00AD\u200E\u200F]/g;

/** C0/C1 controls other than tab/newline/CR: terminal escapes and other invisible payloads have no place in memory text. */
const CONTROL_CHARACTER_REGEX = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;

/**
 * Scanning happens on NFKD-normalized text, which decomposes Hangul syllables into conjoining jamo, so a
 * Korean pattern must be decomposed the same way or it never matches. No `\b` (meaningless for Hangul).
 */
function koreanPattern(source: string): RegExp {
  return new RegExp(source.normalize("NFKD"), "g");
}

const PROMPT_INJECTION_PATTERNS: readonly RegexThreatPattern[] = [
  {
    name: "ignore_previous_instructions",
    category: "prompt_injection",
    severity: "block",
    regex:
      /\b(?:(?:ignore|disregard|forget)\s+(?:all\s+|any\s+|the\s+|your\s+)?(?:previous|prior|preceding|earlier|above)\s+(?:instructions|directions|guidelines|prompts?|constraints)|ignore\s+all\s+previous|disregard\s+your\s+rules)\b/gi,
  },
  {
    name: "ignore_previous_instructions_ko",
    category: "prompt_injection",
    severity: "block",
    regex: koreanPattern("(?:\uC774\uC804|\uC55E\uC120|\uC55E\uC758|\uC704\uC758|\uC704\uC5D0|\uBAA8\uB4E0|\uAE30\uC874|\uC2DC\uC2A4\uD15C)\\s*(?:\uC9C0\uC2DC|\uC9C0\uCE68|\uBA85\uB839|\uADDC\uCE59|\uD504\uB86C\uD504\uD2B8)(?:\uC0AC\uD56D|\uB4E4)?(?:\uC744|\uB97C|\uC740|\uB294)?\\s*(?:\uBB34\uC2DC|\uC78A)"),
  },
  {
    name: "user_override",
    category: "prompt_injection",
    severity: "block",
    regex: /\bdo\s+not\s+(?:follow|obey|listen\s+to)\s+the\s+user\b/gi,
  },
  {
    name: "identity_override_ko",
    category: "prompt_injection",
    severity: "block",
    regex: koreanPattern("(?:\uC9C0\uAE08\uBD80\uD130|\uC774\uC81C\uBD80\uD130)\\s*(?:\uB108|\uB2F9\uC2E0|\uB10C)(?:\uB294|\uC740)|(?:\uB108|\uB2F9\uC2E0)(?:\uB294|\uC740)\\s*(?:\uC774\uC81C|\uC9C0\uAE08)(?:\uBD80\uD130)?\\s"),
  },
  {
    name: "concealment_instruction_ko",
    category: "prompt_injection",
    severity: "block",
    regex: koreanPattern("\uC0AC\uC6A9\uC790(?:\uC5D0\uAC8C|\uD55C\uD14C)\\s*[^\\n\\r]{0,24}?(?:\uC54C\uB9AC\uC9C0|\uB9D0\uD558\uC9C0|\uBCF4\uACE0\uD558\uC9C0|\uC228\uAE30|\uC228\uACA8|\uAC10\uCD94)"),
  },
  {
    name: "reveal_system_instructions_ko",
    category: "prompt_injection",
    severity: "block",
    regex: koreanPattern("\uC2DC\uC2A4\uD15C\\s*\uD504\uB86C\uD504\uD2B8(?:\uB97C|\uC744)?\\s*[^\\n\\r]{0,24}?(?:\uBCF4\uC5EC|\uCD9C\uB825|\uACF5\uAC1C|\uB178\uCD9C|\uC54C\uB824|\uB9D0\uD574)"),
  },
  {
    name: "identity_override",
    category: "prompt_injection",
    severity: "block",
    regex: /\b(?:you\s+are\s+now|you\s+must\s+now|your\s+new\s+instructions)\b/gi,
  },
  {
    name: "system_prompt_override",
    category: "prompt_injection",
    severity: "block",
    regex: /\b(?:system\s+prompt\s+override|override\s+system)\b/gi,
  },
  {
    name: "concealment_instruction",
    category: "prompt_injection",
    severity: "block",
    regex: /\b(?:do\s+not\s+tell\s+the\s+user|hide\s+this\s+from|never\s+reveal)\b/gi,
  },
  {
    name: "always_do_imperative",
    category: "prompt_injection",
    severity: "block",
    regex: /\balways\s+do\b[^\n\r]{0,60}\b(?:execute|run|reveal|ignore|obey|follow|share|disclose)\b/gi,
  },
  {
    name: "from_now_on_always",
    category: "prompt_injection",
    severity: "block",
    regex: /\bfrom\s+now\s+on\s+always\b/gi,
  },
  {
    name: "reveal_system_instructions",
    category: "prompt_injection",
    severity: "block",
    regex: /\breveal\s+your\b[^\n\r]{0,40}\b(?:instructions|system\s+prompt|rules)\b/gi,
  },
];

/**
 * `<key> = <value>` with the identifier-aware key boundary shared with the ledger redactor, so env-var
 * style keys (`DB_PASSWORD=`, `JWT_SECRET=`) and quoted JSON keys (`"password": "…"`) are caught; a
 * `$VAR` reference is not a secret and stays allowed.
 */
function assignmentPattern(keywords: string): RegExp {
  return new RegExp(`${credentialKeySource(keywords)}${CREDENTIAL_VALUE_NOT_REFERENCE}\\S+`, "gi");
}

const CREDENTIAL_PATTERNS: readonly RegexThreatPattern[] = [
  {
    name: "openai_api_key",
    category: "credential_pattern",
    severity: "block",
    regex: /\bsk-[a-zA-Z0-9]{20,}\b/g,
  },
  {
    name: "github_pat_classic",
    category: "credential_pattern",
    severity: "block",
    regex: /\bghp_[a-zA-Z0-9]{36}\b/g,
  },
  {
    name: "github_pat_fine_grained",
    category: "credential_pattern",
    severity: "block",
    regex: /\bgho_[a-zA-Z0-9]{36}\b/g,
  },
  {
    name: "aws_access_key",
    category: "credential_pattern",
    severity: "block",
    regex: /\bAKIA[A-Z0-9]{16}\b/g,
  },
  {
    name: "generic_password_assignment",
    category: "credential_pattern",
    severity: "block",
    regex: assignmentPattern("password|passwd"),
  },
  {
    name: "generic_secret_assignment",
    category: "credential_pattern",
    severity: "block",
    regex: assignmentPattern("secret"),
  },
  {
    name: "generic_token_assignment",
    category: "credential_pattern",
    severity: "block",
    regex: assignmentPattern("token"),
  },
  {
    name: "generic_api_key_assignment",
    category: "credential_pattern",
    severity: "block",
    regex: assignmentPattern("api[_-]?key|access[_-]?key|private[_-]?key"),
  },
  {
    name: "bearer_token",
    category: "credential_pattern",
    severity: "block",
    regex: /\bBearer\s+[a-zA-Z0-9._\-]{20,}\b/g,
  },
];

const MALICIOUS_INSTRUCTION_PATTERNS: readonly RegexThreatPattern[] = [
  {
    name: "curl_credential_exfiltration",
    category: "malicious_instruction",
    severity: "block",
    regex: /\bcurl[^\n\r]*\$\{?[A-Z_]*KEY\b/gi,
  },
  {
    name: "wget_credential_exfiltration",
    category: "malicious_instruction",
    severity: "block",
    regex: /\bwget[^\n\r]*\$\{?[A-Z_]*KEY\b/gi,
  },
  {
    name: "sensitive_file_read",
    category: "malicious_instruction",
    severity: "block",
    regex: /\bcat\s+(?:\/etc\/shadow|~\/\.ssh|\.env|credentials)\b/gi,
  },
  {
    name: "ssh_backdoor_authorized_keys",
    category: "malicious_instruction",
    severity: "block",
    regex: /\bauthorized_keys\b/gi,
  },
  {
    name: "ssh_private_key_reference",
    category: "malicious_instruction",
    severity: "block",
    regex: /\bid_rsa\b/gi,
  },
];

const REPETITIVE_CONTENT_REGEX = /(.{20,100}?)\1{9,}/gs;

// Base64 pattern: at least 40 chars of valid base64 with optional padding
const BASE64_CONTENT_REGEX = /[A-Za-z0-9+/]{40,}={0,2}/g;

// Common Unicode confusable mappings (Cyrillic → Latin)
// These characters look identical to Latin but have different codepoints
const CONFUSABLE_MAP: ReadonlyMap<number, string> = new Map([
  [0x0430, "a"],  // Cyrillic а → Latin a
  [0x0435, "e"],  // Cyrillic е → Latin e
  [0x043E, "o"],  // Cyrillic о → Latin o
  [0x0440, "p"],  // Cyrillic р → Latin p
  [0x0441, "c"],  // Cyrillic с → Latin c
  [0x0443, "y"],  // Cyrillic у → Latin y
  [0x0445, "x"],  // Cyrillic х → Latin x
  [0x0456, "i"],  // Cyrillic і → Latin i
  [0x0458, "j"],  // Cyrillic ј → Latin j
  [0x04BB, "h"],  // Cyrillic һ → Latin h
  [0x0501, "d"],  // Cyrillic ԁ → Latin d
  [0xFF41, "a"],  // Fullwidth ａ → Latin a
  [0xFF45, "e"],  // Fullwidth ｅ → Latin e
  [0xFF49, "i"],  // Fullwidth ｉ → Latin i
  [0xFF4F, "o"],  // Fullwidth ｏ → Latin o
  [0xFF55, "u"],  // Fullwidth ｕ → Latin u
]);

/** Normalize text by replacing known confusable characters with Latin equivalents */
function normalizeConfusables(text: string): string {
  let result = "";
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    const replacement = CONFUSABLE_MAP.get(code);
    result += replacement ?? text[i];
  }
  return result;
}

const BLOCK_REGEX_PATTERNS: readonly RegexThreatPattern[] = [
  {
    name: "invisible_unicode_character",
    category: "invisible_unicode",
    severity: "block",
    regex: INVISIBLE_UNICODE_REGEX,
  },
  {
    name: "control_character",
    category: "invisible_unicode",
    severity: "block",
    regex: CONTROL_CHARACTER_REGEX,
  },
  ...PROMPT_INJECTION_PATTERNS,
  ...CREDENTIAL_PATTERNS,
  ...MALICIOUS_INSTRUCTION_PATTERNS,
];

function truncateMatch(value: string): string {
  return value.slice(0, MAX_MATCH_LENGTH);
}

function prefixedMatch(field: FieldName, matched: string): string {
  return truncateMatch(`${field}: ${matched}`);
}

function addRegexThreats(field: FieldName, text: string, threats: ScanThreat[]): void {
  for (const pattern of BLOCK_REGEX_PATTERNS) {
    pattern.regex.lastIndex = 0;

    let matchResult: RegExpExecArray | null = pattern.regex.exec(text);
    while (matchResult !== null) {
      threats.push({
        pattern: pattern.name,
        severity: pattern.severity,
        category: pattern.category,
        // NFC so a match on decomposed Hangul reads as text (identity for ASCII).
        match: prefixedMatch(field, matchResult[0].normalize("NFC")),
      });

      matchResult = pattern.regex.exec(text);
    }
  }
}

function isPrintableCharacter(charCode: number): boolean {
  if (charCode === 9 || charCode === 10 || charCode === 13) {
    return true;
  }

  if (charCode === 127) {
    return false;
  }

  return charCode >= 32;
}

function countNonPrintableCharacters(text: string): number {
  let nonPrintable = 0;

  for (let index = 0; index < text.length; index += 1) {
    if (!isPrintableCharacter(text.charCodeAt(index))) {
      nonPrintable += 1;
    }
  }

  return nonPrintable;
}

function addFormatAnomalies(
  field: FieldName,
  text: string,
  maxContentLength: number,
  threats: ScanThreat[]
): void {
  if (text.length > maxContentLength) {
    threats.push({
      pattern: "content_length_exceeded",
      severity: "warn",
      category: "format_anomaly",
      match: prefixedMatch(field, `length=${String(text.length)} max=${String(maxContentLength)}`),
    });
  }

  if (text.length > 0) {
    const nonPrintableCount = countNonPrintableCharacters(text);
    if (nonPrintableCount / text.length > 0.5) {
      threats.push({
        pattern: "non_printable_ratio_high",
        severity: "warn",
        category: "format_anomaly",
        match: prefixedMatch(
          field,
          `non_printable_ratio=${(nonPrintableCount / text.length).toFixed(2)}`
        ),
      });
    }
  }

  REPETITIVE_CONTENT_REGEX.lastIndex = 0;
  const repetitiveMatch = REPETITIVE_CONTENT_REGEX.exec(text);
  if (repetitiveMatch !== null) {
    threats.push({
      pattern: "repetitive_content",
      severity: "warn",
      category: "format_anomaly",
      match: prefixedMatch(field, repetitiveMatch[0]),
    });
  }
}

export function scanMemoryContent(
  summary: string,
  details: string,
  options?: ScanOptions
): ScanResult {
  const maxContentLength = options?.maxContentLength ?? DEFAULT_MAX_CONTENT_LENGTH;
  const threats: ScanThreat[] = [];

  // Phase 1: Unicode normalization — defeats homoglyph attacks
  // NFKD handles composed chars; confusable map handles Cyrillic/fullwidth lookalikes
  const normalizedSummary = normalizeConfusables(summary.normalize("NFKD"));
  const normalizedDetails = normalizeConfusables(details.normalize("NFKD"));

  // Phase 2: Per-field regex scanning on normalized text
  addRegexThreats("summary", normalizedSummary, threats);
  addRegexThreats("details", normalizedDetails, threats);

  // Phase 3: Cross-field injection detection
  // Attacks may split patterns across summary+details boundary
  const crossFieldText = `${normalizedSummary} ${normalizedDetails}`;
  const crossFieldThreats: ScanThreat[] = [];
  addRegexThreats("summary", crossFieldText, crossFieldThreats);
  // Add any cross-field threats not already found in per-field scan
  for (const crossThreat of crossFieldThreats) {
    const isDuplicate = threats.some(
      (t) => t.pattern === crossThreat.pattern && t.category === crossThreat.category
    );
    if (!isDuplicate) {
      threats.push({
        ...crossThreat,
        match: truncateMatch(`cross-field: ${crossThreat.match}`),
      });
    }
  }

  // Phase 4: Base64 credential detection
  // Decode Base64 strings and scan the decoded content for credentials
  for (const fieldText of [normalizedSummary, normalizedDetails]) {
    BASE64_CONTENT_REGEX.lastIndex = 0;
    let b64Match = BASE64_CONTENT_REGEX.exec(fieldText);
    while (b64Match !== null) {
      try {
        const decoded = Buffer.from(b64Match[0], "base64").toString("utf-8");
        // Check if decoded content contains credential patterns
        const decodedThreats: ScanThreat[] = [];
        addRegexThreats("details", decoded, decodedThreats);
        const credentialThreats = decodedThreats.filter(
          (t) => t.category === "credential_pattern"
        );
        for (const ct of credentialThreats) {
          threats.push({
            pattern: `base64_encoded_${ct.pattern}`,
            severity: "block",
            category: "credential_pattern",
            match: truncateMatch(`base64-decoded: ${ct.match}`),
          });
        }
      } catch {
        // Invalid base64 — skip
      }
      b64Match = BASE64_CONTENT_REGEX.exec(fieldText);
    }
  }

  // Phase 5: Format anomaly checks on original text
  addFormatAnomalies("summary", summary, maxContentLength, threats);
  addFormatAnomalies("details", details, maxContentLength, threats);

  return {
    safe: !threats.some((threat) => threat.severity === "block"),
    threats,
  };
}
