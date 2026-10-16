// Redaction of a committed answer (F-022 AIM-3 "Committed answer", F-027 AST-9). Before an answer is
// committed, token-shaped strings are removed: `sk-ant-…`, `sk-…`, JWT-shaped `eyJ…`, `refresh_token`,
// `access_token` and `id_token` with their values, bearer credentials, and the exact secrets the caller
// names (the run token). Each match becomes the same plain words, and the caller records that it happened.

export const REDACTED_SECRET = '[removed: looked like a secret]';

const PATTERNS: RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]+/g,
  /\bsk-[A-Za-z0-9_-]{8,}/g,
  /eyJ[A-Za-z0-9_-]{4,}(?:\.[A-Za-z0-9_-]*){0,2}/g,
  /\b(refresh_token|access_token|id_token)\b["':=\s]*[^\s"',}]*/gi,
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
];

export function redactSecrets(text: string, exact: readonly string[] = []): { text: string; changed: boolean } {
  let out = text;
  for (const secret of exact) if (secret.length >= 8) out = out.split(secret).join(REDACTED_SECRET);
  for (const pattern of PATTERNS) out = out.replace(pattern, REDACTED_SECRET);
  return { text: out, changed: out !== text };
}
