// Secret redaction for anything leaving the bridge toward Hermes.
//
// This is defence in depth, not a guarantee. Transcripts are 3.8 GB of arbitrary
// text; a regex set cannot promise it caught every credential. It exists so that
// the common, high-value shapes (provider keys, PATs, bearer tokens, private keys)
// do not travel, and so that N1.5 has something concrete to mutate.
//
// Ordering matters: longer/more-specific patterns run first so a generic rule does
// not chew a prefix off a token a specific rule would have matched whole.

const RULES = [
  // Private key blocks — match the whole PEM body, not just the header.
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED:private-key]"],

  // Anthropic / OpenAI style.
  [/\bsk-ant-[A-Za-z0-9_-]{16,}/g, "[REDACTED:anthropic-key]"],
  [/\bsk-proj-[A-Za-z0-9_-]{16,}/g, "[REDACTED:openai-key]"],
  [/\bsk-[A-Za-z0-9]{32,}/g, "[REDACTED:api-key]"],

  // GitHub. github_pat_ first: it would otherwise be partly eaten by the ghp_ rule.
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, "[REDACTED:github-pat]"],
  [/\bgh[pousr]_[A-Za-z0-9]{16,}/g, "[REDACTED:github-token]"],

  // Slack, Google, AWS.
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/g, "[REDACTED:slack-token]"],
  [/\bAIza[A-Za-z0-9_-]{30,}/g, "[REDACTED:google-key]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED:aws-key-id]"],
  [/\bASIA[0-9A-Z]{16}\b/g, "[REDACTED:aws-sts-key-id]"],

  // JWTs — three base64url segments.
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[REDACTED:jwt]"],

  // Bearer headers, however they were written.
  [/\b[Bb]earer\s+[A-Za-z0-9._~+/=-]{16,}/g, "Bearer [REDACTED]"],

  // Named assignments: FOO_TOKEN=..., "apiKey": "...", password: ...
  // The value class deliberately excludes quotes/whitespace so we stop at the
  // end of the value rather than swallowing the rest of the line.
  [/\b([A-Za-z0-9_]*(?:API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)S?)\b(\s*[:=]\s*)"?[^\s"',}\]]{6,}"?/gi,
    (_m, name, sep) => `${name}${sep}[REDACTED]`],

  // Anything that called itself a hash of a password (scrypt/bcrypt/argon).
  [/\$(?:2[aby]|argon2[id]{1,2}|scrypt)\$[^\s"']{16,}/g, "[REDACTED:password-hash]"],
];

/** Redact secrets from a string. Non-strings pass through untouched. */
export function redact(input) {
  if (typeof input !== "string") return input;
  let out = input;
  for (const [pattern, replacement] of RULES) out = out.replace(pattern, replacement);
  return out;
}

/** Deep-redact every string in a JSON-ish value. Arrays/objects rebuilt, not mutated. */
export function redactDeep(value) {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactDeep(v);
    return out;
  }
  return value;
}
