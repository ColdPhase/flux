import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { schema } from '@flux/db';
import type { Database } from '@flux/core';
import type { SessionResolver } from './session.js';
import { linkCookie, type LinkIntents } from './link.js';

export const LINK_START_PATH = '/api/v1/identity/link';

export interface LinkRouteOptions {
  db: Database;
  sessions: SessionResolver;
  links: LinkIntents;
  provider: { providerId: string; label: string } | null;
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
}
