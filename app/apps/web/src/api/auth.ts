import { AUTH_BASE_PATH, IDENTITY_CAPABILITIES_PATH, ME_PATH, type IdentityCapabilities, type MeResponse } from '@flux/contracts';
import { ApiError, request } from './client';

export type { MeResponse };

/** The signed-in person, or null when there is no live session. Other failures propagate. */
export async function getMe(signal?: AbortSignal): Promise<MeResponse | null> {
  try {
    return await request<MeResponse>(ME_PATH, { signal });
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return null;
    throw error;
  }
}

export function getCapabilities(signal?: AbortSignal) {
  return request<IdentityCapabilities>(IDENTITY_CAPABILITIES_PATH, { signal });
}

/** With verified sign-up the mailed link lands on the sign-in page (#313); otherwise the person is signed in at once. */
export function signUp(input: { name: string; email: string; password: string }) {
  return request<{ token: string | null }>(`${AUTH_BASE_PATH}/sign-up/email`, { method: 'POST', body: { ...input, callbackURL: '/sign-in?notice=email-verified' } });
}

/** The address a provider sign-in found held by an unverified account (#313), or null without a pending claim. */
export async function getPendingClaim(signal?: AbortSignal) {
  try {
    return await request<{ email: string; expiresAt: string }>('/api/v1/identity/claim', { signal });
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

/** Releases the address from the unverified account; the provider sign-in can then be repeated. */
export function claimAddress() {
  return request<{ providerId: string }>('/api/v1/identity/claim', { method: 'POST' });
}

export function signIn(input: { email: string; password: string; oauth_query?: string }) {
  return request<unknown>(`${AUTH_BASE_PATH}/sign-in/email`, { method: 'POST', body: { ...input, rememberMe: true } });
}

/**
 * Starts the operator's single sign-on (#113). The identity provider returns to `next` on success
 * and to the sign-in page with `sso=failed` otherwise; the browser follows the returned address.
 *
 * On the MCP authorization path (#310) `oauthQuery` is the signed request. The server carries it through
 * the provider round trip and resumes the authorization after sign-in; a failure returns to `/login` with
 * the same signed request, so the person can try again without restarting the agent client.
 */
/** The owner starts linking the provider to this password account (#315). The browser then runs the provider sign-in. */
export function startLink() {
  return request<{ providerId: string; label: string }>('/api/v1/identity/link', { method: 'POST' });
}

export function startSso(providerId: string, next: string, oauthQuery?: string) {
  const failure = oauthQuery ? `/login?${oauthQuery}&sso=failed` : '/sign-in?sso=failed';
  return request<{ url: string }>(`${AUTH_BASE_PATH}/sign-in/social`, {
    method: 'POST',
    body: { provider: providerId, callbackURL: next, errorCallbackURL: failure, newUserCallbackURL: next, disableRedirect: true,
      ...(oauthQuery ? { oauth_query: oauthQuery } : {}) },
  });
}

/** The mailed link returns to `${origin}/reset-password?token=…` (or `?error=INVALID_TOKEN`). */
export function requestPasswordReset(email: string) {
  return request<unknown>(`${AUTH_BASE_PATH}/request-password-reset`, {
    method: 'POST',
    body: { email, redirectTo: `${window.location.origin}/reset-password` },
  });
}

export function resetPassword(token: string, newPassword: string) {
  return request<unknown>(`${AUTH_BASE_PATH}/reset-password`, { method: 'POST', body: { token, newPassword } });
}

/** Minimum length enforced by the identity service (Better Auth default). */
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;
