/**
 * Credential redaction (spec §5.1: 자격 증명 패턴은 기록 전에 `<redacted>`). `redactCredentials` is the only
 * barrier between tool output / prompt text and the ledger, the extraction prompt and provenance excerpts,
 * so the table below is the contract: env-var style keys, quoted JSON keys, any-scheme URL credentials,
 * header / CLI forms and the value-shaped tokens must all go; identifiers that merely contain a keyword,
 * `$VAR` references and ordinary URLs must survive.
 */

import { describe, expect, test } from "vitest";

import { REDACTED, REDACTION_PATTERNS, redactCredentials } from "../src/core/signals";

const R = REDACTED;

// Key-shaped fixtures are assembled at runtime so the file itself never carries a token that GitHub push protection
// (or a downstream scanner) would flag; the redaction patterns see the joined string exactly as they would in a ledger.
const STRIPE_LIVE = ["sk", "live", "51Hqabcdefghijklmnopqrstuvwxyz"].join("_");
const STRIPE_TEST = ["sk", "test", "abcdefghijklmnopqrstuvwxyz"].join("_");

describe("redactCredentials", () => {
  test.each<[string, string]>([
    // env-var style keys: the keyword follows `_`, which `\b` could never see
    ["AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", `AWS_SECRET_ACCESS_KEY=${R}`],
    [`STRIPE_SECRET_KEY=${STRIPE_LIVE}`, `STRIPE_SECRET_KEY=${R}`],
    ["JWT_SECRET=supersecretvalue123", `JWT_SECRET=${R}`],
    ["NPM_TOKEN=npm_abcdefghijklmnopqrstuvwxyz0123456789", `NPM_TOKEN=${R}`],
    ["DB_PASSWORD=hunter22supersecret", `DB_PASSWORD=${R}`],
    ["export DB_PASSWORD=hunter2hunter2", `export DB_PASSWORD=${R}`],
    ["MY_API_KEY=abcdefghijkl", `MY_API_KEY=${R}`],
    ["ACCESS_TOKEN=abcdefghijkl", `ACCESS_TOKEN=${R}`],
    ['secret_key = "abcdefghijkl"', `secret_key = ${R}`],
    ["DB_PASSWORD: hunter22\nAPI_KEY: abcdefgh", `DB_PASSWORD: ${R}\nAPI_KEY: ${R}`],
    ["x-api-key: abcdefghijkl", `x-api-key: ${R}`],
    ["$env:DB_PASSWORD = 'hunter22'", `$env:DB_PASSWORD = ${R}`],
    // quoted JSON keys and camelCase compounds
    ['"password": "hunter22"', `"password": ${R}`],
    ['{"apiKey":"abcdefghijkl","clientSecret":"zyxwvutsrq"}', `{"apiKey":${R},"clientSecret":${R}}`],
    ["accessToken: abcdefghijklmnop", `accessToken: ${R}`],
    // the bare forms keep working
    ["token=abcdefghijkl password=hunter22", `token=${R} password=${R}`],
    ["?token=abcdefghijkl&x=1", `?token=${R}&x=1`],
    // URL credentials in any scheme; the host survives
    ["DATABASE_URL=postgres://admin:hunter22@db.internal:5432/app", `DATABASE_URL=postgres://${R}@db.internal:5432/app`],
    ["MONGO=mongodb+srv://u:pass123@cluster0.example.net/db", `MONGO=mongodb+srv://${R}@cluster0.example.net/db`],
    ["REDIS_URL=redis://:pw12345@cache:6379", `REDIS_URL=redis://${R}@cache:6379`],
    ["git clone https://user:ghp_token@github.com/x/y.git", `git clone https://${R}@github.com/x/y.git`],
    // header and CLI forms
    ["Authorization: Basic dXNlcjpwYXNzd29yZA==", `Authorization: Basic ${R}`],
    ["curl -H 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz'", `curl -H 'Authorization: ${R}'`],
    ["curl -u admin:S3cretPass https://api.example.com", `curl -u ${R} https://api.example.com`],
    ["curl --user admin:S3cretPass https://api.example.com", `curl --user ${R} https://api.example.com`],
    ["mysql -uroot -pS3cretPass mydb", `mysql -uroot -p${R} mydb`],
    ["pg_dump --password S3cretPass mydb", `pg_dump --password ${R} mydb`],
    // value-shaped tokens
    ["github_pat_11ABCDEFG0abcdefghijklmnopqrstuvwxyz0123456789", R],
    ["glpat-abcdefghijklmnopqrst", R],
    ["xapp-1-A0123456789-abcdefghij", R],
    [STRIPE_TEST, R],
    ["use key sk-ant-abcdefghijklmnopqrstuvwxyz0123456789 now", `use key ${R} now`],
  ])("%j → %j", (input, expected) => {
    expect(redactCredentials(input)).toBe(expected);
  });

  test.each([
    "tokenizer = parser.nextToken()",
    "https://example.com:8080/path?x=a@b",
    "go test -parallel 4 ./...",
    "authority=human enforcement=advise",
    "python -u C:\\work\\script.py",
    "git push -u origin feature:main",
    "rsync -u user@host:/path .",
    "see /etc/passwd for users",
    "The password is in 1Password.",
    "token: abc",
    "OLDPWD=/home/user",
    "password_min_length=8",
    "input_tokens=12345 output_tokens=678",
    "Basic authentication is required for this endpoint",
    "Error: connect ECONNREFUSED 127.0.0.1:5432",
    "mysql -u root -p mydb",
    // references to a secret are not the secret
    "GITHUB_TOKEN=$GITHUB_TOKEN npm publish",
    "PASSWORD: ${DB_PASSWORD}",
    "TOKEN=$(cat ~/.token)",
  ])("leaves %j untouched", (input) => {
    expect(redactCredentials(input)).toBe(input);
  });

  test("a `cat .env` dump keeps every key and host and loses every value", () => {
    const env = [
      "DATABASE_URL=postgres://admin:hunter22@db.internal:5432/app",
      `STRIPE_SECRET_KEY=${STRIPE_LIVE}`,
      "AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE",
      "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      "OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz0123",
      "NODE_ENV=production",
    ].join("\n");
    const out = redactCredentials(env);
    expect(out).toBe(
      [
        `DATABASE_URL=postgres://${R}@db.internal:5432/app`,
        `STRIPE_SECRET_KEY=${R}`,
        `AWS_ACCESS_KEY_ID=${R}`,
        `AWS_SECRET_ACCESS_KEY=${R}`,
        `OPENAI_API_KEY=${R}`,
        "NODE_ENV=production",
      ].join("\n"),
    );
    for (const secret of ["hunter22", "sk_live_", "wJalr", "AKIAIOSFODNN7EXAMPLE", "sk-abcdef"]) expect(out).not.toContain(secret);
  });

  test("is idempotent and every pattern is global", () => {
    for (const { regex } of REDACTION_PATTERNS) expect(regex.global).toBe(true);
    const once = redactCredentials("DATABASE_URL=postgres://admin:hunter22@db password=hunter22 curl -u a2:b3 mysql -pS3cret1 Authorization: Basic abcdefgh");
    expect(redactCredentials(once)).toBe(once);
  });

  test("stays linear on long inputs (redaction runs on the raw text before clipping)", () => {
    const inputs = ["A".repeat(200_000), "mysql ".repeat(30_000), "a://".repeat(50_000), `${"A".repeat(200_000)}token${"_x".repeat(5_000)}`];
    const started = performance.now();
    for (const input of inputs) redactCredentials(input);
    // the unbounded scheme/prefix variants of these patterns took ~25 s on the first input
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});
