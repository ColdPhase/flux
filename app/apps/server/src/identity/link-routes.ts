import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { schema, type Database } from '@flux/db';
import type { SessionResolver } from './session.js';
import { linkCookie, type LinkIntents } from './link.js';

export const LINK_START_PATH = '/api/v1/identity/link';
export const LINK_STATE_PATH = '/api/v1/identity/links/:providerId';

export interface LinkRouteOptions {
  db: Database;
  sessions: SessionResolver;
  links: LinkIntents;
  provider: { providerId: string; issuer: string; label: string } | null;
  ssoMode: 'prepare' | 'sso';
  publicOrigin: string;
}

/**
 * Starts the owner's explicit link (F-024 S5b, #315): only in `prepare` mode, only from the account's own password
 * session. It sets the intent cookie; the browser then starts the provider sign-in, and the callback links the subject.
 */
export function registerLinkRoutes(app: FastifyInstance, { db, sessions, links, provider, ssoMode, publicOrigin }: LinkRouteOptions) {
  const secure = publicOrigin.startsWith('https:');
  app.post(LINK_START_PATH, async (request, reply) => {
    if (!provider) return reply.code(404).send({ error: 'No sign-on provider is configured', code: 'NO_PROVIDER' });
    if (ssoMode !== 'prepare') return reply.code(409).send({ error: 'Linking closes at cutover', code: 'LINK_CLOSED' });
    const context = await sessions.requirePrincipal(request);
    const [identity] = await db.select({ method: schema.authSessionIdentities.method }).from(schema.authSessionIdentities)
      .where(eq(schema.authSessionIdentities.sessionId, context.sessionId));
    if (identity?.method !== 'password') {
      return reply.code(403).send({ error: 'Link from a session that signed in with your password', code: 'PASSWORD_SESSION_REQUIRED' });
    }
    const token = await links.open(context.principal.id, context.sessionId, provider.providerId);
    reply.header('set-cookie', linkCookie(token, secure));
    return { providerId: provider.providerId, label: provider.label };
  });
  /** Whether the signed-in account is linked to the configured provider, for the Settings page (#315). */
  app.get<{ Params: { providerId: string } }>(LINK_STATE_PATH, async (request, reply) => {
    const context = await sessions.requirePrincipal(request);
    if (!provider || request.params.providerId !== provider.providerId) {
      return reply.code(404).send({ error: 'No such sign-in is linked', code: 'NOT_LINKED' });
    }
    const [link] = await db.select({ id: schema.authAccounts.id }).from(schema.authAccounts)
      .where(and(eq(schema.authAccounts.userId, context.principal.id), eq(schema.authAccounts.providerId, provider.providerId))).limit(1);
    return { providerId: provider.providerId, linked: link !== undefined };
  });
  /**
   * The owner cannot detach the configured provider identity (F-024 S5b, #315), in prepare or SSO-only mode, so the
   * account's provider link, its standing row and the audit trail stay as they are. Recovery is the audited operator
   * command (`./flux identity unlink`); the owner has no path to it.
   */
  app.delete<{ Params: { providerId: string } }>(LINK_STATE_PATH, async (request, reply) => {
    await sessions.requirePrincipal(request);
    if (!provider || request.params.providerId !== provider.providerId) {
      return reply.code(404).send({ error: 'No such sign-in is linked', code: 'NOT_LINKED' });
    }
    return reply.code(403).send({ error: `The ${provider.label} sign-in can only be removed by the host operator (audited recovery)`, code: 'PROVIDER_IDENTITY_OPERATOR_ONLY' });
  });
}
