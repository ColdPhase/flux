// Error text from the runtime is redacted before it is logged (F-022 "Secrets and honesty"): the
// manager and supervisor never log PTY or CLI output, and an error message that could carry a vendor
// credential is cut down to its safe parts.

const PATTERNS: RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]+/g,
  /\bsk-[A-Za-z0-9_-]{8,}/g,
  /eyJ[A-Za-z0-9_-]{4,}(?:\.[A-Za-z0-9_-]*){0,2}/g,
  /\b(refresh_token|access_token|id_token)\b["':=\s]*[^\s"',}]*/gi,
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
];

export const REDACTED = '[removed: looked like a secret]';

export function redactSecrets(textValue: string, extra: string[] = []): string {
  let out = textValue;
  for (const secret of extra) if (secret.length >= 8) out = out.split(secret).join(REDACTED);
  for (const pattern of PATTERNS) out = out.replace(pattern, REDACTED);
  return out;
}
