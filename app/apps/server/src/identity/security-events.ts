import type { SecurityEvent } from '../security-log.js';

/** The code of a failed Better Auth answer (an `APIError`), or null when the answer succeeded. Never its message. */
export function failureCode(returned: unknown): string | null {
  const error = returned as { statusCode?: unknown; body?: { code?: unknown; error?: unknown } } | null | undefined;
  if (!error || typeof error !== 'object' || typeof error.statusCode !== 'number' || error.statusCode < 400) return null;
  const code = error.body?.code ?? error.body?.error;
  return typeof code === 'string' ? code : String(error.statusCode);
}

const REASONS: Record<string, string> = {
  INVALID_EMAIL_OR_PASSWORD: 'bad_credentials',
  INVALID_PASSWORD: 'bad_current_password',
  EMAIL_NOT_VERIFIED: 'email_not_verified',
  INVALID_TOKEN: 'invalid_token',
};

/**
 * What a Better Auth route that just ran means to an operator, or null for a route that is not security-relevant. `userId` is the person the
 * route acted for when it is known (a session that signed in, the owner of a changed password). The body is read only for `accept`,
 * `grant_type` and the OAuth client id; nothing else of it, and no password, token or address, is ever copied into an event.
 */
export function authSecurityEvent(input: { path: string; body: unknown; returned: unknown; userId?: string }): SecurityEvent | null {
  const body = (input.body ?? {}) as Record<string, unknown>;
  const code = failureCode(input.returned);
  const reason = code === null ? undefined : (REASONS[code] ?? code);
  const outcome = code === null ? 'success' : 'failure';
  const base = { userId: input.userId, reason } as const;
  switch (input.path) {
    case '/sign-in/email': return { event: 'sign_in', outcome, ...base };
    case '/request-password-reset': case '/forget-password': return { event: 'password_reset_requested', outcome, ...base };
    case '/reset-password': return { event: 'password_reset', outcome, ...base };
    case '/change-password': return { event: 'password_changed', outcome, ...base };
    case '/change-email': return { event: 'email_changed', outcome, ...base };
    case '/oauth2/consent': {
      if (code !== null) return { event: 'oauth_consent', outcome: 'refused', ...base, clientId: clientOf(body) };
      return { event: 'oauth_consent', outcome: body.accept === true ? 'allowed' : 'denied', userId: input.userId, clientId: clientOf(body) };
    }
    // The code exchange and the refresh grant: only a refusal is an event (a success is the connection already in use).
    case '/oauth2/token': {
      if (code === null) return null;
      return { event: 'oauth_token', outcome: 'refused', reason: `${typeof body.grant_type === 'string' && /^[a-z_]{1,32}$/.test(body.grant_type) ? body.grant_type : 'unknown'}:${reason}`,
        clientId: typeof body.client_id === 'string' ? body.client_id.slice(0, 200) : undefined };
    }
    default: return null;
  }
}

/** The client a signed consent request is for. The request is Better Auth's signed query; its `client_id` is public. */
function clientOf(body: Record<string, unknown>): string | undefined {
  if (typeof body.oauth_query !== 'string') return undefined;
  const id = new URLSearchParams(body.oauth_query).get('client_id');
  return id ? id.slice(0, 200) : undefined;
}
