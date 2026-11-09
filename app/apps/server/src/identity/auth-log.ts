import { redactedError } from '@flux/core';

/**
 * What Better Auth's own log lines are allowed to say (#1088, delta reviews of #1093 and #1098). Better Auth hands its logger whatever failed: a
 * failed statement is quoted with its parameters (the email and name of a sign-up that lost a race, a password hash), a token endpoint's refusal is
 * an object that also holds the request. So nothing is printed whole: a line's text has its addresses masked, and each thing it was given is
 * reduced to a short list of scalars that say why it failed and carry no personal data, secret or SQL parameter.
 *
 * - an error: its class, SQLSTATE and constraint (`redactedError`), an errno-style code (`ECONNREFUSED`, `ENOTFOUND`, ...) from it or its cause, and,
 *   unless it is a database error (its message is the statement with its parameters), its message with addresses masked;
 * - an object (an OAuth refusal, an issuer mismatch): `status`, `statusText`, an OAuth `error` code (RFC 6749 section 5.2), its description with
 *   addresses masked, `providerId`, `expected` / `received` (issuer URLs) and a code, also from the `error` object it nests;
 * - anything else (a string, an array, a number): not printed.
 */
export interface AuthLogEntry {
  level: 'info' | 'warn' | 'error';
  object: Record<string, unknown>;
  text: string;
}

const ADDRESS = /[^\s@"'`<>(),;:]+@[^\s@"'`<>(),;:]+/g;
const OAUTH_ERROR = /^[a-z_]{1,64}$/;
const IDENTIFIER = /^[A-Za-z0-9_.:-]{1,64}$/;
// Node's and undici's connection errors: ECONNREFUSED, ENOTFOUND, ETIMEDOUT, ECONNRESET, EAI_AGAIN, UND_ERR_CONNECT_TIMEOUT.
const ERRNO = /^(E[A-Z0-9_]{3,30}|UND_ERR_[A-Z_]{1,30})$/;

const masked = (value: string, limit: number) => value.replace(ADDRESS, '<email>').replace(/\s+/g, ' ').trim().slice(0, limit);
const record = (value: unknown): Record<string, unknown> | null => (typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null);

/** The errno-style code of an error, of its cause, or of the first error an AggregateError holds (a name that resolves to several addresses). */
function errnoCode(error: unknown, depth = 0): string | null {
  const value = record(error);
  if (!value || depth > 3) return null;
  if (typeof value.code === 'string' && ERRNO.test(value.code)) return value.code;
  const inner = Array.isArray(value.errors) ? value.errors[0] : undefined;
  return errnoCode(value.cause, depth + 1) ?? errnoCode(inner, depth + 1);
}

/** A database error's message is the statement with its parameters. */
function isDatabaseError(error: Error & { query?: unknown; params?: unknown }): boolean {
  return redactedError(error).sqlState !== null || error.name === 'DrizzleQueryError' || typeof error.query === 'string' || Array.isArray(error.params)
    || /^Failed query/.test(error.message);
}

function fromError(error: Error): Record<string, unknown> {
  const out: Record<string, unknown> = { error: redactedError(error).message };
  const code = errnoCode(error);
  if (code) out.code = code;
  if (!isDatabaseError(error) && typeof error.message === 'string' && error.message) out.errorMessage = masked(error.message, 200);
  return out;
}

function fromObject(value: Record<string, unknown>, depth = 0): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (typeof value.status === 'number' && Number.isFinite(value.status)) out.status = value.status;
  if (typeof value.statusText === 'string' && value.statusText) out.statusText = masked(value.statusText, 80);
  if (typeof value.error === 'string' && OAUTH_ERROR.test(value.error)) out.oauthError = value.error;
  if (typeof value.error_description === 'string' && value.error_description) out.oauthErrorDescription = masked(value.error_description, 200);
  for (const key of ['providerId', 'provider'] as const) if (typeof value[key] === 'string' && IDENTIFIER.test(value[key])) out.providerId = value[key];
  for (const key of ['expected', 'received'] as const) if (typeof value[key] === 'string' && value[key]) out[key] = masked(value[key], 200);
  const code = errnoCode(value);
  if (code) out.code = code;
  // betterFetch's failure nests the refusal one level down (`{ data: null, error: { status, error, error_description } }`).
  const nested = depth < 1 ? record(value.error) : null;
  return nested ? { ...fromObject(nested, depth + 1), ...out } : out;
}

export function authLogEntry(level: string, message: unknown, details: readonly unknown[]): AuthLogEntry {
  // An error passed as the message is one more thing the line was given, not its text.
  const given = typeof message === 'string' ? details : [message, ...details];
  const object: Record<string, unknown> = { channel: 'auth' };
  for (const detail of given) {
    const reduced = detail instanceof Error ? fromError(detail) : record(detail) ? fromObject(detail as Record<string, unknown>) : null;
    if (reduced) Object.assign(object, reduced);
  }
  return {
    level: level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'info',
    object,
    text: typeof message === 'string' ? masked(message, 240) : 'Auth error',
  };
}
