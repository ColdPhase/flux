import type { FastifyInstance } from 'fastify';
import { createSessionRepository, type DbExecutor } from '@flux/db';
import type { ApiError, IdentityCapabilities } from '@flux/contracts';
import { createAuth } from './auth.js';
import { registerAuthBridge } from './bridge.js';
import type { IdentityConfig } from './config.js';
import { createSmtpMailer, type Mailer } from './mailer.js';
import { originViolation } from './origin.js';
import { registerIdentityRoutes } from './routes.js';
import { createSessionResolver, type SessionResolver } from './session.js';

export { loadIdentityConfig, type IdentityConfig } from './config.js';
export { UnauthenticatedError, type SessionContext, type SessionResolver } from './session.js';

export interface IdentityOptions {
  db: DbExecutor;
  config: IdentityConfig;
  /** Defaults to SMTP from config; pass null to force password reset unavailable. */
  mailer?: Mailer | null;
}

export interface Identity extends SessionResolver {
  passwordReset: IdentityCapabilities['passwordReset'];
}

/**
 * Registers the origin guard, the Better Auth bridge and Flux session routes. Call it before
 * other routes so the origin guard hook applies to every state-changing request.
 */
export function registerIdentity(app: FastifyInstance, options: IdentityOptions): Identity {
  const { db, config } = options;
  const mailer = options.mailer === undefined ? (config.smtp ? createSmtpMailer(config.smtp) : null) : options.mailer;
  if (mailer) app.addHook('onClose', async () => mailer.close());
  const auth = createAuth({ db, config, mailer, onMailError: (error) => app.log.error({ error }, 'Password reset mail failed') });
  const sessions = createSessionResolver(auth);
  const passwordReset: IdentityCapabilities['passwordReset'] = mailer ? 'available' : 'unavailable';

  app.addHook('onRequest', async (request, reply) => {
    const violation = originViolation(request.method, request.headers, config.publicOrigin);
    if (violation) {
      request.log.warn({ violation, origin: request.headers.origin }, 'Rejected cross-origin state change');
      return reply.code(403).send({ error: 'Forbidden', code: 'ORIGIN_REJECTED', reason: violation } satisfies ApiError & { reason: string });
    }
  });

  registerAuthBridge(app, { auth, publicOrigin: config.publicOrigin, passwordReset });
  registerIdentityRoutes(app, { sessions, store: createSessionRepository(db), passwordReset });

  return { ...sessions, passwordReset };
}
