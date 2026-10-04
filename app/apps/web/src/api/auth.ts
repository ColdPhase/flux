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

export function signUp(input: { name: string; email: string; password: string }) {
  return request<unknown>(`${AUTH_BASE_PATH}/sign-up/email`, { method: 'POST', body: input });
}

export function signIn(input: { email: string; password: string; oauth_query?: string }) {
  return request<unknown>(`${AUTH_BASE_PATH}/sign-in/email`, { method: 'POST', body: { ...input, rememberMe: true } });
}

/**
 * Starts the operator's single sign-on (#113). The identity provider returns to `next` on success
 * and to the sign-in page with `sso=failed` otherwise; the browser follows the returned address.
 */
export function startSso(providerId: string, next: string) {
  return request<{ url: string }>(`${AUTH_BASE_PATH}/sign-in/social`, {
    method: 'POST',
    body: { provider: providerId, callbackURL: next, errorCallbackURL: '/sign-in?sso=failed', newUserCallbackURL: next, disableRedirect: true },
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
