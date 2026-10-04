import type { FastifyInstance } from 'fastify';
import { createSessionRepository } from '@flux/db';
import type { Database } from '@flux/core';
import type { ApiError, IdentityCapabilities } from '@flux/contracts';
import { createAuth, type FluxAuth } from './auth.js';
import { registerAuthBridge } from './bridge.js';
import type { IdentityConfig } from './config.js';
import { createSmtpMailer, type Mailer } from './mailer.js';
import { originViolation } from './origin.js';
import { createOauthRequests } from './oauth-flow.js';
import { registerAgentOauthContext } from './oauth-context.js';
import { registerIdentityRoutes } from './routes.js';
import { createSessionResolver, type SessionResolver } from './session.js';

export { loadIdentityConfig, type IdentityConfig } from './config.js';
export { UnauthenticatedError, type SessionContext, type SessionResolver } from './session.js';

export interface IdentityOptions {
  db: Database;
  config: IdentityConfig;
  /** Defaults to SMTP from config; pass null to force password reset unavailable. */
  mailer?: Mailer | null;
}

export interface Identity extends SessionResolver {
  passwordReset: IdentityCapabilities['passwordReset'];
  auth: FluxAuth;
}

/**
 * Registers the origin guard, the Better Auth bridge and Flux session routes. Call it before
 * other routes so the origin guard hook applies to every state-changing request.
 */
export function registerIdentity(app: FastifyInstance, options: IdentityOptions): Identity {
  const { db, config } = options;
  const mailer = options.mailer === undefined ? (config.smtp ? createSmtpMailer(config.smtp) : null) : options.mailer;
  if (mailer) app.addHook('onClose', async () => mailer.close());
  const oauthRequests = createOauthRequests();
  const auth = createAuth({ db, config, mailer, oauthRequests, onMailError: (error) => app.log.error({ error }, 'Password reset mail failed') });
  // OAuth resource seeding runs during Better Auth initialization. Complete it before
  // accepting requests or allowing an in-process server to close its database pool.
  app.addHook('onReady', async () => { await auth.$context; });
  const sessions = createSessionResolver(auth);
  const passwordReset: IdentityCapabilities['passwordReset'] = mailer ? 'available' : 'unavailable';

  app.addHook('onRequest', async (request, reply) => {
    const violation = originViolation(request.method, request.headers, config.publicOrigin);
    if (violation) {
      request.log.warn({ violation, origin: request.headers.origin }, 'Rejected cross-origin state change');
      return reply.code(403).send({ error: 'Forbidden', code: 'ORIGIN_REJECTED', reason: violation } satisfies ApiError & { reason: string });
    }
  });

  registerAuthBridge(app, { auth, publicOrigin: config.publicOrigin, passwordReset, oauthRequests });
  const sso: IdentityCapabilities['sso'] = config.oidc ? { providerId: config.oidc.providerId, label: config.oidc.label } : null;
  // Operators register this exact redirect URI with their identity provider (#113).
  if (config.oidc) app.log.info({ issuer: config.oidc.issuer, redirectUri: `${config.publicOrigin}/api/auth/callback/${config.oidc.providerId}` }, 'Single sign-on is on');
  registerIdentityRoutes(app, { sessions, store: createSessionRepository(db), passwordReset, sso });
  registerAgentOauthContext(app, db, sessions, auth, config.publicOrigin);

  return { ...sessions, passwordReset, auth };
}
