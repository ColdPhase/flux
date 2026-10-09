import type { FastifyInstance } from 'fastify';
import { CLAIM_COOKIE, CLAIM_PATH, type EmailClaims } from './claim.js';

/** The claim secret travels only to the claim endpoint, never to the app or to the provider. */
export function claimCookie(token: string, secure: boolean, maxAgeSeconds = 900) {
  return `${CLAIM_COOKIE}=${token}; Path=${CLAIM_PATH}; Max-Age=${maxAgeSeconds}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}

function cookieValue(header: string | undefined, name: string) {
  for (const part of (header ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=') || null;
  }
  return null;
}

export interface ClaimRouteOptions { claims: EmailClaims; publicOrigin: string }

/**
 * The claim page's two calls (F-024 S5a, #313). Both need the cookie set when the provider sign-in found the
 * address held by an unverified account; without it, or after 15 minutes, there is nothing to claim.
 */
export function registerClaimRoutes(app: FastifyInstance, { claims, publicOrigin }: ClaimRouteOptions) {
  const secure = publicOrigin.startsWith('https:');
  app.get(CLAIM_PATH, async (request, reply) => {
    const token = cookieValue(request.headers.cookie, CLAIM_COOKIE);
    const pending = token ? await claims.pending(token) : null;
    if (!pending) return reply.code(404).send({ error: 'There is no address to claim', code: 'CLAIM_NOT_FOUND' });
    return { email: pending.email, expiresAt: pending.expiresAt.toISOString() };
  });
  app.post(CLAIM_PATH, async (request, reply) => {
    const token = cookieValue(request.headers.cookie, CLAIM_COOKIE);
    const result = token ? await claims.claim(token) : { refused: 'unknown' as const };
    if ('refused' in result) {
      const code = result.refused === 'held' ? 'ADDRESS_HELD' : result.refused === 'expired' ? 'CLAIM_EXPIRED' : 'CLAIM_NOT_FOUND';
      return reply.code(result.refused === 'held' ? 409 : 404).send({ error: 'This address cannot be claimed', code });
    }
    // The audit trail: the released account, the provider identity that claimed, when. Also in auth_email_claims.
    request.log.warn({ releasedUserId: result.claimed.releasedUserId, providerId: result.claimed.providerId }, 'An email address was claimed from an unverified account');
    reply.header('set-cookie', claimCookie('', secure, 0));
    return { providerId: result.claimed.providerId };
  });
}
