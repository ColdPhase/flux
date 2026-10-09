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
import { createSignIns } from './sign-in.js';
import { createConfirmation, type Confirmation } from './confirmation.js';
import { createEmailClaims } from './claim.js';
import { registerClaimRoutes } from './claim-routes.js';
import { cachedReachability, waitForDiscovery } from './discovery.js';
import { registerAgentOauthContext } from './oauth-context.js';
import { registerIdentityRoutes } from './routes.js';
import { createSessionResolver, type SessionResolver } from './session.js';
import { createIdpStanding, type IdpStanding } from './standing.js';

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
  confirmation: Confirmation;
  /** Null without a provider or with FLUX_OIDC_STANDING=off. */
  standing: IdpStanding | null;
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
  const signIns = createSignIns();
  const idpStanding = config.oidc ? createIdpStanding({ db, oidc: config.oidc, authSecret: config.secret, log: app.log }) : null;
  const standing = config.oidc?.standing === 'refresh' ? idpStanding : null;
  const confirmation = createConfirmation(db, config.oidc);
  const claims = createEmailClaims(db);
  const auth = createAuth({ db, config, mailer, oauthRequests, signIns, standing, confirmation, claims, log: app.log, onMailError: (error) => app.log.error({ error }, 'Password reset mail failed') });
  // OAuth resource seeding runs during Better Auth initialization. Complete it before
  // accepting requests or allowing an in-process server to close its database pool.
  // The provider reads its discovery document while Better Auth initializes, so an identity provider that
  // starts a little after Flux is waited for with backoff rather than leaving sign-on off (#310 AC-4).
  app.addHook('onReady', async () => {
    if (config.oidc && !await waitForDiscovery(config.oidc)) app.log.warn({ issuer: config.oidc.issuer }, 'The identity provider did not answer; single sign-on is reported as not reachable');
    await auth.$context;
    // Accounts without a stored token (a restore left none) refuse until the person signs in again; with the check off no row may refuse anyone.
    await idpStanding?.reconcile();
    standing?.start();
  });
  app.addHook('onClose', async () => standing?.stop());
  // With an active sole provider, ordinary authentication is single sign-on only (F-024 S5a, #313).
  const sessions = createSessionResolver(auth, standing, confirmation, config.oidc ? { db, providerId: config.oidc.providerId } : null);
  const passwordReset: IdentityCapabilities['passwordReset'] = mailer && !config.oidc ? 'available' : 'unavailable';

  app.addHook('onRequest', async (request, reply) => {
    const violation = originViolation(request.method, request.headers, config.publicOrigin);
    if (violation) {
      request.log.warn({ violation, origin: request.headers.origin }, 'Rejected cross-origin state change');
      return reply.code(403).send({ error: 'Forbidden', code: 'ORIGIN_REJECTED', reason: violation } satisfies ApiError & { reason: string });
    }
  });

  registerAuthBridge(app, { auth, publicOrigin: config.publicOrigin, passwordReset, oauthRequests, signIns, sessions });
  const reachable = config.oidc ? cachedReachability(config.oidc) : null;
  const sso = async (): Promise<IdentityCapabilities['sso']> =>
    config.oidc && reachable ? { providerId: config.oidc.providerId, label: config.oidc.label, reachable: await reachable() } : null;
  // Operators register this exact redirect URI with their identity provider (#113).
  if (config.oidc) app.log.info({ issuer: config.oidc.issuer, redirectUri: `${config.publicOrigin}/api/auth/callback/${config.oidc.providerId}` }, 'Single sign-on is on');
  registerIdentityRoutes(app, { sessions, store: createSessionRepository(db), passwordReset, signup: config.signup, sso });
  registerClaimRoutes(app, { claims, publicOrigin: config.publicOrigin });
  if (config.signupRequested !== config.signup) app.log.warn({ requested: config.signupRequested }, 'FLUX_SIGNUP=verified needs email (FLUX_SMTP_URL), and a sign-on provider closes password sign-up, so password sign-up is closed');
  registerAgentOauthContext(app, db, sessions, auth, config.publicOrigin);

  return { ...sessions, passwordReset, auth, standing, confirmation };
}
