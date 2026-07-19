import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import test from "node:test";

import { toTelegramSafeText } from "../src/redaction.mjs";

const privateKeyBegin = ["-----", "BEGIN PRIVATE KEY", "-----"].join("");
const privateKeyEnd = ["-----", "END PRIVATE KEY", "-----"].join("");
const syntheticSecret = (...parts) => parts.join("");

function expectRedactionInput(value) {
  assert.throws(
    () => toTelegramSafeText(value),
    (error) => error?.message === "REDACTION_INPUT" && error?.code === "REDACTION_INPUT",
  );
}

test("rejects non-string input with a stable non-leaking error", () => {
  for (const value of [null, undefined, 42, {}, ["secret"]]) expectRedactionInput(value);
});

test("redacts labelled credentials while preserving useful context", () => {
  const cases = [
    ["Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456", "Authorization: [REDACTED]"],
    ["authorization: basic dXNlcjpwYXNzd29yZA==", "authorization: [REDACTED]"],
    ["X-API-Key: api-value-1234567890", "X-API-Key: [REDACTED]"],
    ["token=token-value-1234567890", "token=[REDACTED]"],
    ["API_KEY='api-value-1234567890'", "API_KEY='[REDACTED]'"],
    ['{"password":"password-value-1234567890"}', '{"password":"[REDACTED]"}'],
    ["secret: secret-value-1234567890", "secret: [REDACTED]"],
    ["credential = credential-value-123", "credential = [REDACTED]"],
    ["client_secret: client-secret-value-123", "client_secret: [REDACTED]"],
    ["OPENAI_API_KEY=openai-value-1234567890", "OPENAI_API_KEY=[REDACTED]"],
    ["$env:TELEGRAM_BOT_TOKEN='telegram-value-1234567890'", "$env:TELEGRAM_BOT_TOKEN='[REDACTED]'"],
    ["AWS_SECRET_ACCESS_KEY=aws-secret-value-1234567890", "AWS_SECRET_ACCESS_KEY=[REDACTED]"],
    ["DB_PASSWORD=db-password-value-1234567890", "DB_PASSWORD=[REDACTED]"],
  ];

  for (const [input, expected] of cases) assert.equal(toTelegramSafeText(input), expected, input);
});

test("redacts common unlabelled token shapes without partial disclosure", () => {
  const secrets = [
    syntheticSecret("sk-", "abcdefghijklmnopqrstuvwxyz123456"),
    syntheticSecret("ghp_", "abcdefghijklmnopqrstuvwxyz1234567890"),
    syntheticSecret("github_", "pat_11AA22BB33_abcdefghijklmnopqrstuvwxyz"),
    syntheticSecret("AKIA", "IOSFODNN7EXAMPLE"),
  ];

  for (const secret of secrets) {
    const output = toTelegramSafeText(`before ${secret} after`);
    assert.equal(output, "before [REDACTED] after");
    assert.equal(output.includes(secret.slice(-6)), false);
  }
});

test("redacts URL userinfo, sensitive query parameters, and private key bodies", () => {
  const privateKey = [
    privateKeyBegin,
    "fixturePrivateKeyMaterial1234567890",
    privateKeyEnd,
  ].join("\n");
  const input = [
    "https://alice:hunter2@example.test/path?mode=safe&token=query-secret-123456&password=hunter2#part",
    privateKey,
  ].join("\n");

  const output = toTelegramSafeText(input);
  assert.equal(output.includes("hunter2"), false);
  assert.equal(output.includes("query-secret-123456"), false);
  assert.equal(output.includes("fixturePrivateKeyMaterial"), false);
  assert.match(output, /https:\/\/\[REDACTED\]@example\.test\/path\?mode=safe&token=\[REDACTED\]&password=\[REDACTED\]#part/u);
  assert.equal(output.includes(`${privateKeyBegin}\n[REDACTED]\n${privateKeyEnd}`), true);
});

test("preserves safe Unicode, newlines, and ordinary security vocabulary", () => {
  const safe = [
    "Готово 🧵",
    "token budget: 12k",
    "password policy review",
    "tests/secret-redaction.test.mjs",
    "docs/credential-handling.md",
  ].join("\n");
  assert.equal(toTelegramSafeText(safe), safe);
});

test("is deterministic and idempotent", () => {
  const input = "Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456\nAPI_KEY=another-secret-123456";
  const once = toTelegramSafeText(input);
  assert.equal(toTelegramSafeText(input), once);
  assert.equal(toTelegramSafeText(once), once);
  assert.equal(toTelegramSafeText("token=[REDACTED]"), "token=[REDACTED]");
});

test("redacts the full remainder of credential headers including quotes and spaces", () => {
  for (const [input, expected] of [
    ['Authorization: Bearer "abc def ghi" suffix-that-must-not-leak', "Authorization: [REDACTED]"],
    ["authorization: Basic dXNlcjpwYXNz trailing", "authorization: [REDACTED]"],
    ['X-API-Key: "key with spaces" trailing', "X-API-Key: [REDACTED]"],
  ]) assert.equal(toTelegramSafeText(input), expected);
});

test("scans escaped quoted assignments and boundary-matched sensitive names", () => {
  const cases = [
    ['{"password":"abc\\\"def\\\\ghi","safe":1}', '{"password":"[REDACTED]","safe":1}'],
    ["$env:ACCESS_TOKEN='access value'", "$env:ACCESS_TOKEN='[REDACTED]'"],
    ["ENV.API_KEY=api-value", "ENV.API_KEY=[REDACTED]"],
    ["passphrase: words with spaces", "passphrase: [REDACTED]"],
    ["SECRET_KEY=secret-key-value", "SECRET_KEY=[REDACTED]"],
    ["private_key = private-key-value", "private_key = [REDACTED]"],
    ["credentials=credential-value", "credentials=[REDACTED]"],
    ["CLIENT_SECRET_VALUE=client-value", "CLIENT_SECRET_VALUE=[REDACTED]"],
    ["TOKEN=prefix,suffix with spaces", "TOKEN=[REDACTED]"],
  ];
  for (const [input, expected] of cases) assert.equal(toTelegramSafeText(input), expected, input);
  for (const safe of ["protoken=value", "notpassword=value", "token budget", "password policy"])
    assert.equal(toTelegramSafeText(safe), safe);
});

test("uses the last URL userinfo delimiter and redacts signature query keys", () => {
  const input = "https://alice:p@ss@host.test/path?safe=1&x-amz-signature=abcdef123456&sig=tailsecret&signature=lastsecret";
  assert.equal(
    toTelegramSafeText(input),
    "https://[REDACTED]@host.test/path?safe=1&x-amz-signature=[REDACTED]&sig=[REDACTED]&signature=[REDACTED]",
  );
});

test("redacts standalone Telegram, JWT, Slack, OpenAI, GitHub and AWS token families", () => {
  const tokens = [
    syntheticSecret("123456789", ":AAabcdefghijklmnopqrstuvwxyz123456789"),
    syntheticSecret("eyJhbGciOiJIUzI1NiJ9", ".eyJzdWIiOiIxMjM0NTY3ODkwIn0", ".abcdefghijklmnopqrstuvwxyz123456"),
    syntheticSecret("xoxb-", "123456789012-123456789012-abcdefghijklmnopqrstuvwxyz"),
    syntheticSecret("sk-", "proj-abcdefghijklmnopqrstuvwxyz1234567890"),
    syntheticSecret("github_", "pat_11AA22BB33_abcdefghijklmnopqrstuvwxyz"),
    syntheticSecret("AKIA", "IOSFODNN7EXAMPLE"),
  ];
  for (const token of tokens) assert.equal(toTelegramSafeText(`before ${token} after`), "before [REDACTED] after", token);
  const telegram = tokens[0];
  assert.equal(
    toTelegramSafeText(`https://api.telegram.org/bot${telegram}/sendMessage`),
    "https://api.telegram.org/bot[REDACTED]/sendMessage",
  );
});

test("redacts unmatched private-key blocks fail-safe", () => {
  const unmatchedMarker = ["-----", "BEGIN OPENSSH PRIVATE KEY", "-----"].join("");
  assert.equal(
    toTelegramSafeText(`prefix\n${unmatchedMarker}\nunmatched-secret-material\nmore`),
    `prefix\n${unmatchedMarker}\n[REDACTED]`,
  );
});

test("rejects oversized input with a stable non-leaking error", () => {
  assert.throws(
    () => toTelegramSafeText("x".repeat(1024 * 1024 + 1)),
    (error) => error?.message === "REDACTION_TOO_LARGE" && error?.code === "REDACTION_TOO_LARGE",
  );
});

test("redacts Authorization fields in JSON, inline logs and assignments", () => {
  const cases = [
    ['{"Authorization":"Bearer abc def ghi","safe":1}', '{"Authorization":"[REDACTED]","safe":1}'],
    ["prefix log Authorization: Bearer abc def ghi", "prefix log Authorization: [REDACTED]"],
    ["AUTHORIZATION=Basic dXNlcjpwYXNz trailing", "AUTHORIZATION=[REDACTED]"],
  ];
  for (const [input, expected] of cases) assert.equal(toTelegramSafeText(input), expected);
  assert.equal(toTelegramSafeText("proauthorization=Bearer safe"), "proauthorization=Bearer safe");
});

test("redacts Telegram tokens at all safe delimiters without trailing remnants", () => {
  const token = syntheticSecret("123456789", ":AAabcdefghijklmnopqrstuvwxyz123456789-");
  for (const suffix of ["/send", "?x=1", "#part", " ", ".", ""]) {
    const output = toTelegramSafeText(`https://api.telegram.org/bot${token}${suffix}`);
    assert.equal(output, `https://api.telegram.org/bot[REDACTED]${suffix}`);
    assert.equal(output.includes(token.slice(-8)), false);
  }
  assert.equal(toTelegramSafeText(`(${token})`), "([REDACTED])");
});

test("redacts only JWT-like three-segment tokens", () => {
  const jwt = syntheticSecret("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9", ".eyJzdWIiOiIxMjM0NTY3ODkwIn0", ".abcdefghijklmnopqrstuvwxyz123456-");
  assert.equal(toTelegramSafeText(`jwt=${jwt}`), "jwt=[REDACTED]");
  for (const safe of ["example.com.example", "alpha12345.beta12345.gamma12345", "eyJub3QiOiJqd3QifQ.payload.segment"])
    assert.equal(toTelegramSafeText(safe), safe);
});

test("keeps adversarial escaped quotes bounded and unchanged", () => {
  function timed(size) {
    const value = ('"\\"arbitrary-safe-text').repeat(Math.ceil(size / 21)).slice(0, size);
    const start = performance.now();
    assert.equal(toTelegramSafeText(value), value);
    return performance.now() - start;
  }
  const small = timed(64 * 1024);
  const large = timed(128 * 1024);
  assert.ok(large < Math.max(3000, small * 6 + 250), `small=${small} large=${large}`);
});
