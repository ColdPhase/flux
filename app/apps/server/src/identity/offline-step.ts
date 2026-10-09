import { createHash, hkdfSync, randomBytes } from 'node:crypto';
import { AUTH_BASE_PATH } from '@flux/contracts';
import type { OidcConfig } from './config.js';
import { openToken, sealToken, type IdpStanding, type OfflineGrant } from './standing.js';

/**
 * The silent second step of a provider sign-in (F-024 S1, revised 2026-10-09 by founder direction).
 *
 * Keycloak 26.1+ deletes the person's online session at the code exchange when `offline_access` is the first
 * request of a new session (keycloak PR #34346), and it sends back-channel logout only to clients in the online
 * session. So the sign-in request asks only `openid email profile`. When its callback arrives, Flux holds it and
 * sends the browser back to the provider with `prompt=none` and `scope=openid offline_access`: the session now
 * has Flux's client session, so the provider keeps it. Flux redeems that code itself, then resumes the held
 * callback through Better Auth with the result. The step's state travels in a sealed, HttpOnly cookie limited to
 * the callback path, so any `api` replica can finish it. Same redirect URI: operators register nothing new.
 */
const STEP_TTL_MS = 5 * 60_000;
const STEP_KEY_INFO = 'flux-idp-offline-step-v1';
const STEP_AAD = 'offline-step';
/** Marks the silent step's own `state`, so its answer is never mistaken for a sign-in callback (no redirect loop). */
const STEP_STATE_PREFIX = 'flux-offline.';

interface PendingStep { state: string; nonce: string; verifier: string; query: string; expires: number }

export type OfflineStepAction =
  | { kind: 'pass' }
  /** Answer with a redirect to the provider's silent step, setting the step cookie. */
  | { kind: 'redirect'; location: string; cookie: string }
  /** Resume the held sign-in callback at `url` with the step's outcome; `cookie` clears the step cookie. */
  | { kind: 'resume'; url: URL; outcome: OfflineGrant; cookie: string };

export interface OfflineStep {
  callbackPath: string;
  intercept(url: URL, cookieHeader: string | undefined): Promise<OfflineStepAction>;
}

/**
 * Why a sign-in must be refused after the silent step, or null when it may go on. The step must have brought an
 * offline refresh token for the same subject as the sign-in, and for the same provider session when both name one.
 */
export function offlineStepProblem(subject: string, sid: string | undefined, outcome: OfflineGrant | undefined): string | null {
  if (!outcome) return 'no_offline_step';
  if ('error' in outcome) return outcome.error;
  if (outcome.subject !== subject) return 'another_subject';
  if (sid && outcome.sid && outcome.sid !== sid) return 'another_session';
  return null;
}

export function createOfflineStep(options: { oidc: OidcConfig; publicOrigin: string; authSecret: string; standing: IdpStanding; now?: () => number }): OfflineStep {
  const { oidc, publicOrigin, standing, now = Date.now } = options;
  const callbackPath = `${AUTH_BASE_PATH}/callback/${oidc.providerId}`;
  const redirectUri = `${publicOrigin}${callbackPath}`;
  const secure = publicOrigin.startsWith('https:');
  const cookieName = `${secure ? '__Secure-' : ''}flux.idp_offline_step`;
  const key = Buffer.from(hkdfSync('sha256', options.authSecret, 'flux-idp', STEP_KEY_INFO, 32));
  const attributes = `Path=${callbackPath}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
  const random = () => randomBytes(32).toString('base64url');

  const read = (header: string | undefined): PendingStep | null => {
    const raw = header?.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
    const opened = raw ? openToken(key, STEP_AAD, oidc.providerId, decodeURIComponent(raw)) : null;
    if (!opened) return null;
    try {
      const step = JSON.parse(opened) as PendingStep;
      return step.expires > now() ? step : null;
    } catch { return null; }
  };

  return {
    callbackPath,
    async intercept(url, cookieHeader) {
      const state = url.searchParams.get('state');
      const pending = read(cookieHeader);
      if (pending && state && state === pending.state) {
        // The provider's answer to the silent step: redeem it, then resume the held sign-in callback.
        const error = url.searchParams.get('error');
        const code = url.searchParams.get('code');
        const outcome: OfflineGrant = error ? { error: error.slice(0, 100) } : code
          ? await standing.redeemOffline({ code, verifier: pending.verifier, redirectUri, nonce: pending.nonce })
          : { error: 'no_code' };
        return { kind: 'resume', url: new URL(`${callbackPath}${pending.query}`, publicOrigin), outcome, cookie: `${cookieName}=; Max-Age=0; ${attributes}` };
      }
      // Only a successful sign-in callback is held; an error (a cancelled sign-in) goes to Better Auth as it is. So does
      // an answer to a silent step whose cookie is missing, expired or not ours: Better Auth refuses its unknown state.
      if (!state || !url.searchParams.get('code') || state.startsWith(STEP_STATE_PREFIX)) return { kind: 'pass' };
      const step: PendingStep = { state: `${STEP_STATE_PREFIX}${random()}`, nonce: random(), verifier: random(), query: url.search, expires: now() + STEP_TTL_MS };
      const location = await standing.offlineAuthorizationUrl({
        state: step.state, nonce: step.nonce, redirectUri, challenge: createHash('sha256').update(step.verifier).digest('base64url'),
      });
      if (!location) return { kind: 'resume', url, outcome: { error: 'provider_unreachable' }, cookie: '' };
      const sealed = encodeURIComponent(sealToken(key, STEP_AAD, oidc.providerId, JSON.stringify(step)));
      return { kind: 'redirect', location, cookie: `${cookieName}=${sealed}; Max-Age=${STEP_TTL_MS / 1000}; ${attributes}` };
    },
  };
}
