/**
 * Better Auth names its cookies `<prefix>.session_token`, with `__Secure-` in front over https: Flux's session cookie is
 * `flux.session_token`. One place for the name and for reading the cookie, so what reads it for the API rate limit (#838, #1022) cannot
 * drift from what sets it and from what Better Auth reads.
 */
export const SESSION_COOKIE_PREFIX = 'flux';

/** The one name of the session cookie Better Auth sets and reads: `__Secure-` in front over https, never both names. */
export function sessionCookieName(secure: boolean): string {
  return `${secure ? '__Secure-' : ''}${SESSION_COOKIE_PREFIX}.session_token`;
}

/**
 * The session token a `Cookie` header names, read the way Better Auth reads it (better-call's `parseCookies` and `getSignedCookie`): only the
 * cookie called `name`, the first one of that name when the header has several (a decoy placed before the real cookie is the one that
 * counts, and so it is for Better Auth), its value trimmed, unquoted and percent-decoded, and the token the part before the last dot (the
 * signature follows it). Without the signature, so the few ways of writing the same signature (its last base64 character carries bits
 * that are ignored) are one key. Null when there is no such cookie or it is empty. A value without a dot is returned whole: Better Auth
 * refuses it, so nothing ever resolves it.
 */
export function sessionCookieToken(cookieHeader: unknown, name: string): string | null {
  if (typeof cookieHeader !== 'string') return null;
  for (const part of cookieHeader.split(';')) {
    const equals = part.indexOf('=');
    if (equals === -1 || part.slice(0, equals).trim() !== name) continue;
    let value = part.slice(equals + 1).trim();
    if (value.codePointAt(0) === 34) value = value.slice(1, -1);
    if (value.includes('%')) {
      try { value = decodeURIComponent(value); } catch { /* kept as it is, as Better Auth does */ }
    }
    if (!value) return null;
    const dot = value.lastIndexOf('.');
    return dot > 0 ? value.slice(0, dot) : value;
  }
  return null;
}
