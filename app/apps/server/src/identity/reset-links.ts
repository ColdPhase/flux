import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { RESET_PASSWORD_PAGE, type ResetLink } from '@flux/contracts';
import { ConflictError, ForbiddenError, NotFoundError } from '@flux/core';
import { passwordResetLinks, type Database, type ResetLinkVia } from '@flux/db';
import { joinRateLimiter } from '../live/rate-limit.js';
import { securityEvent, type SecurityLogger } from '../security-log.js';
import type { SessionResolver } from './session.js';

/**
 * Password reset links (#1471; docs/development/access-policy.md#password-reset-links-1471). One mechanism for a mailed link, a link an
 * owner or admin makes in Settings › Company and `./flux reset-link`: a Better Auth `reset-password:` verification value, used by
 * `POST /api/auth/reset-password` like any reset, stored only as the SHA-256 of its identifier, single-use and short-lived.
 */

/** The identifier Better Auth stores for a reset token with `verification.storeIdentifier: 'hashed'`: SHA-256, base64url without padding. */
export function resetIdentifier(token: string): string {
  return createHash('sha256').update(`reset-password:${token}`).digest('base64url');
}

/** The link a token opens. The token is in the fragment, so no request line, log or Referer carries it. */
export const resetLinkOf = (publicOrigin: string, token: string) => `${publicOrigin}${RESET_PASSWORD_PAGE}#${token}`;

/** Makes a link for an account that has a password, recorded with how it was made; the account's earlier links stop working. */
export async function makeResetLink(db: Database, options: { publicOrigin: string; ttlSeconds: number; userId: string; via: ResetLinkVia;
  madeBy: string | null; now?: Date }): Promise<ResetLink> {
  // 144 random bits, as Better Auth's own reset token (`generateId(24)`).
  const token = randomBytes(18).toString('base64url');
  const identifier = resetIdentifier(token);
  const now = options.now ?? new Date();
  const expiresAt = new Date(now.getTime() + options.ttlSeconds * 1000);
  await db.transaction(async (tx) => {
    const links = passwordResetLinks(tx);
    await links.insertVerification(identifier, options.userId, expiresAt);
    await links.record({ userId: options.userId, identifier, via: options.via, madeBy: options.madeBy, expiresAt, now });
  });
  return { link: resetLinkOf(options.publicOrigin, token), expiresAt: expiresAt.toISOString() };
}

/** Who may make a link for whom: an owner for anyone else in the company, an admin for members and guests. */
export function resetLinkRefusal(maker: string | null, person: string | null, self: boolean, hasPassword: boolean): Error | null {
  if (maker !== 'owner' && maker !== 'admin') return new ForbiddenError('Only an owner or admin of the company makes reset links', 'FORBIDDEN');
  if (person === null) return new NotFoundError('Person', 'PERSON_NOT_FOUND');
  if (self) return new ConflictError('Change your own password in Settings › Account', 'OWN_ACCOUNT');
  if (maker === 'admin' && (person === 'owner' || person === 'admin')) return new ForbiddenError('Only an owner makes a reset link for an owner or admin', 'OWNER_REQUIRED');
  if (!hasPassword) return new ConflictError('This account signs in without a password', 'NO_PASSWORD');
  return null;
}

/** `POST /api/v1/people/:userId/reset-link`: an owner or admin makes a link next to a person in Settings › Company. Shown once. */
export function registerResetLinkRoutes(app: FastifyInstance, { db, sessions, publicOrigin, ttlSeconds, ssoOnly, log }: {
  db: Database; sessions: SessionResolver; publicOrigin: string; ttlSeconds: number; ssoOnly: boolean; log: SecurityLogger;
}) {
  // Per API process, like the invite link limits (F-035): a guard, not a global count.
  const limit = joinRateLimiter({ limit: 10, windowMs: 60_000, maxUsers: 10_000, message: 'Too many reset links in a short time; try again shortly', code: 'RESET_LINK_RATE_LIMITED' });
  app.post<{ Params: { userId: string } }>('/api/v1/people/:userId/reset-link', async (request, reply): Promise<ResetLink> => {
    const { principal } = await sessions.requirePrincipal(request);
    if (ssoOnly) throw new ConflictError('With single sign-on, passwords are the identity provider’s', 'RESET_LINKS_OFF_WITH_SSO');
    limit.take(`user:${principal.id}`);
    const { userId } = request.params;
    const { maker, person, hasPassword } = await passwordResetLinks(db).roles(principal.id, userId);
    const refused = resetLinkRefusal(maker, person, userId === principal.id, hasPassword);
    if (refused) throw refused;
    const made = await makeResetLink(db, { publicOrigin, ttlSeconds, userId, via: 'settings', madeBy: principal.id });
    securityEvent(log, { event: 'reset_link_created', outcome: 'success', reason: 'settings', userId, byUserId: principal.id, ip: request.ip, reqId: request.id });
    reply.code(201).header('cache-control', 'no-store');
    return made;
  });
}
