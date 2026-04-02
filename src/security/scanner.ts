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

const PROMPT_INJECTION_PATTERNS: readonly RegexThreatPattern[] = [
  {
    name: "ignore_previous_instructions",
    category: "prompt_injection",
    severity: "block",
    regex: /\b(?:ignore\s+previous\s+instructions|ignore\s+all\s+previous|disregard\s+your\s+rules)\b/gi,
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
    regex: /\bpassword\s*[:=]\s*\S+/gi,
  },
  {
    name: "generic_secret_assignment",
    category: "credential_pattern",
    severity: "block",
    regex: /\bsecret\s*[:=]\s*\S+/gi,
  },
  {
    name: "generic_token_assignment",
    category: "credential_pattern",
    severity: "block",
    regex: /\btoken\s*[:=]\s*\S+/gi,
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

const BLOCK_REGEX_PATTERNS: readonly RegexThreatPattern[] = [
  {
    name: "invisible_unicode_character",
    category: "invisible_unicode",
    severity: "block",
    regex: INVISIBLE_UNICODE_REGEX,
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
        match: prefixedMatch(field, matchResult[0]),
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

  addRegexThreats("summary", summary, threats);
  addRegexThreats("details", details, threats);

  addFormatAnomalies("summary", summary, maxContentLength, threats);
  addFormatAnomalies("details", details, maxContentLength, threats);

  return {
    safe: !threats.some((threat) => threat.severity === "block"),
    threats,
  };
}
